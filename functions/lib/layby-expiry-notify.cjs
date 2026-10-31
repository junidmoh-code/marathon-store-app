// ─── LAYBY EXPIRY NOTIFY — WhatsApp 3 days before a layby expires ───────────
// Run: cd functions && npm test -- test/layby-expiry-notify.test.cjs
//
// Daily (scheduler, 09:00 SAST). For every ACTIVE layby whose dueDate is
// EXACTLY three days from today (SAST) and that has a customer phone, enqueue
// ONE Meta template message, layby_expiry_3d:
//
//   "… your layby {{1}} at Marathon Club {{3}} expires on {{2}} …"
//   {{1}} invoice number   {{2}} expiry date   {{3}} store name
//
// ── ELIGIBILITY IS A DATE, NOT A RANGE ───────────────────────────────────────
// dueDate === today+3 (SAST calendar). Never "≤ 3 days": a layby already
// inside three days, or past due, on the day this is deployed is never
// messaged — it can only ever match on the one day it is exactly 3 out.
//
// ACTIVE is PR #228's definition, verbatim: status not in {collected, returned,
// expiredReturnedToStock} AND balanceRemaining > 0, an unknown balance failing
// open. The query is /laybys orderByChild("dueDate").equalTo(target) — indexed
// once /laybys carries ".indexOn": ["dueDate"]; the record is then re-read by
// key so the decision is made on its current state, not the query snapshot.
//
// ── TEMPLATE APPROVAL IS CHECKED EVERY RUN ───────────────────────────────────
// Before anything is claimed, the template's status is read from the WhatsApp
// Business Account. Not APPROVED (pending, rejected, missing, unreadable) →
// log the reason and send nothing. No crash, no free-text fallback.
//
// ── ONE LAYBY, ONE MESSAGE, EVER ─────────────────────────────────────────────
// The create-once claim proven in #385/#386, keyed on layby id + "expiry_3d":
//   /layby_notify/{laybyId}_expiry_3d = { claimedAt, … }
// Only the run that wins the transaction may enqueue. A claim already present
// is never taken over, at any age (#386's reasoning: a slow claimant is
// indistinguishable from a dead one and the producer's dedupe is not atomic).
// A FAILED claim transaction is rethrown (#386), never a silent return: the
// rest of the laybys are still processed, then the run throws so it is red in
// Cloud Logging and the scheduler's retry re-drives it — safe, because a claim
// that was not won enqueued nothing.
//
// Enqueue failures: an unusable phone is TERMINAL (failedAt stamped, claim
// kept); anything else RELEASES the claim and fails the run for a retry. Once
// the producer has answered, the claim is never released.
//
// The outbox write is enqueueWhatsApp — the same producer, the same
// whatsapp_outbox doc, the same 90s dedupe as every other customer message;
// outboxInstantSend delivers it from the Meta-registered number.

const TEMPLATE = "layby_expiry_3d";
const TEMPLATE_LANGUAGE = "en";
const KIND = "expiry_3d";
const DAYS_AHEAD = 3;
const SA_OFFSET_MS = 2 * 60 * 60 * 1000; // Africa/Johannesburg, no DST
const TERMINAL = new Set(["collected", "returned", "expiredReturnedToStock"]);
const STORE_NAMES = {
  "marathon-pe": "PE",
  "trophy": "Trophy",
  "marathon-pine": "Pine",
  "concrete": "Concrete",
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The SAST calendar date (YYYY-MM-DD) `days` after the one containing nowMs. */
function saDatePlus(nowMs, days) {
  const d = new Date(nowMs + SA_OFFSET_MS);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "2026-11-04" → "4 November 2026" (null when not a date). */
function expiryLabel(dueDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dueDate || ""));
  if (!m || +m[2] < 1 || +m[2] > 12) return null;
  return `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}`;
}

/** PR #228: not terminal AND still owing; an unknown balance fails open. */
function isActiveLayby(layby) {
  if (!layby || TERMINAL.has(layby.status)) return false;
  const bal = layby.balanceRemaining;
  return Number.isFinite(bal) ? bal > 0 : true;
}

function storeNameOf(layby) {
  return STORE_NAMES[layby?.issuingStore] || STORE_NAMES[layby?.originStore] || null;
}

/** Why this layby is NOT eligible today (null = eligible). */
function ineligibleReason(layby, target) {
  if (!layby) return "layby_gone";
  if (layby.dueDate !== target) return "not_due_in_3_days";
  if (!isActiveLayby(layby)) return "not_active";
  if (!String(layby.customerPhone || "").trim()) return "no_phone";
  if (!layby.invoiceNo) return "no_invoice_number";
  if (!storeNameOf(layby)) return "unknown_store";
  if (!expiryLabel(layby.dueDate)) return "bad_due_date";
  return null;
}

/**
 * Template status from the WABA. Resolves { approved, reason } — never throws.
 * fetchTemplates() → the Graph API's JSON for
 * /{waba}/message_templates?name=layby_expiry_3d.
 */
async function templateApproval(fetchTemplates) {
  let body;
  try { body = await fetchTemplates(); } catch (e) { return { approved: false, reason: `template status unreadable: ${e.message}` }; }
  if (!body || body.error) return { approved: false, reason: `template status unreadable: ${body?.error?.message || "empty answer"}` };
  const rows = (Array.isArray(body.data) ? body.data : []).filter((t) => t && t.name === TEMPLATE && t.language === TEMPLATE_LANGUAGE);
  if (!rows.length) return { approved: false, reason: `template ${TEMPLATE}/${TEMPLATE_LANGUAGE} not registered` };
  const st = rows[0].status;
  return st === "APPROVED" ? { approved: true, reason: null } : { approved: false, reason: `template ${TEMPLATE} is ${st}` };
}

/**
 * One daily run.
 * @param db               admin.database()
 * @param enqueueWhatsApp  the outbox producer (functions/index.js)
 * @param fetchTemplates   async () => Graph API JSON (see templateApproval)
 * @param nowMs            injectable clock
 * @returns { target, approved, sent, skipped: {reason: n}, laybyIds }
 */
async function runLaybyExpiryNotify({ db, enqueueWhatsApp, fetchTemplates, nowMs = Date.now() }) {
  const target = saDatePlus(nowMs, DAYS_AHEAD);
  const now = new Date(nowMs).toISOString();
  const out = { target, approved: false, sent: 0, skipped: {}, laybyIds: [] };
  const skip = (r) => { out.skipped[r] = (out.skipped[r] || 0) + 1; };

  const approval = await templateApproval(fetchTemplates);
  if (!approval.approved) {
    console.warn("laybyExpiryNotify: NOT sending —", approval.reason, JSON.stringify({ target }));
    out.skipReason = approval.reason;
    return out;
  }
  out.approved = true;

  const snap = await db.ref("laybys").orderByChild("dueDate").equalTo(target).get();
  const ids = [];
  snap.forEach((c) => { ids.push(c.key); });

  const failures = [];
  for (const laybyId of ids) {
    // Re-read by key: decide on the record as it is now.
    const layby = (await db.ref(`laybys/${laybyId}`).get()).val();
    const why = ineligibleReason(layby, target);
    if (why) { skip(why); continue; }

    const claimRef = db.ref(`layby_notify/${laybyId}_${KIND}`);
    let claimed = false;
    try {
      const res = await claimRef.transaction((cur) => (cur == null
        ? { laybyId, kind: KIND, dueDate: target, claimedAt: now }
        : undefined));
      claimed = res.committed && res.snapshot.val()?.claimedAt === now;
    } catch (err) {
      // RETHROW (#386) — after the others, so one bad claim does not starve them.
      console.error("laybyExpiryNotify: claim transaction failed:", laybyId, err.message);
      failures.push(err);
      continue;
    }
    if (!claimed) { skip("already_claimed"); continue; }

    let result;
    try {
      result = await enqueueWhatsApp({
        templateName:   TEMPLATE,
        recipientPhone: layby.customerPhone,
        templateParams: [layby.invoiceNo, expiryLabel(layby.dueDate), storeNameOf(layby)],
      });
    } catch (err) {
      const terminal = !!(err && err.code === "invalid-argument" && err.details && err.details.unusableRecipient);
      const msg = String((err && err.message) || err).slice(0, 300);
      if (terminal) {
        await claimRef.update({ failedAt: now, error: msg })
          .catch((e) => console.error("laybyExpiryNotify: could not stamp failure:", laybyId, e.message));
        console.error("laybyExpiryNotify: unusable phone, NOT sent (terminal):", laybyId);
        skip("unusable_recipient");
        continue;
      }
      // Nothing was enqueued — release so the retry can claim again.
      await claimRef.remove()
        .catch((e) => console.error("laybyExpiryNotify: could not release claim:", laybyId, e.message));
      console.error("laybyExpiryNotify: enqueue failed, claim released:", laybyId, msg);
      failures.push(err);
      continue;
    }

    // The producer answered: a doc exists. Never release from here.
    await claimRef.update({ notifiedAt: now, outboxId: (result && result.outboxId) || null })
      .catch((e) => console.error("laybyExpiryNotify: ENQUEUED but could not stamp notifiedAt (claim kept):", laybyId, e.message));
    out.sent += 1;
    out.laybyIds.push(laybyId);
  }

  console.log("laybyExpiryNotify: run", JSON.stringify({ target, candidates: ids.length, sent: out.sent, skipped: out.skipped, failed: failures.length }));
  if (failures.length) {
    const e = new Error(`laybyExpiryNotify: ${failures.length} layby(s) failed (${failures.map((f) => f.message).join("; ").slice(0, 400)})`);
    e.failures = failures;
    throw e;
  }
  return out;
}

module.exports = {
  runLaybyExpiryNotify, templateApproval, ineligibleReason, isActiveLayby,
  saDatePlus, expiryLabel, storeNameOf, TEMPLATE, TEMPLATE_LANGUAGE, KIND, DAYS_AHEAD,
};

// ─── STORE CREDIT WHATSAPP — the returns desk's slip (Junid, 25 Nov 2026) ────
// Run: cd functions && npm test -- test/credit-whatsapp-notify.test.cjs
//
// The Concrete iPad ("Jafer Till", marathon-pos-app's returns-only login) has
// no slip printer. After it issues a store credit, the POS pushes ONE entry:
//
//   /pos/credit_whatsapp_queue/{pushId} = { ledgerId, customerId, phone,
//     firstName, amountCents, storeName, customerCode, createdAt, createdByUid }
//
// and this module sends the customer the Meta template store_credit_issued
// (docs/meta-templates/store_credit_issued.json) through enqueueWhatsApp —
// the same whatsapp_outbox every customer message uses, delivered by
// outboxInstantSend from the Meta-registered API number. Not the gateway, not
// a personal number: there is no other send path here.
//
//   "Hi {{1}}, R{{2}} store credit has been added to your account at {{3}}. …
//    Your customer code is {{4}}. …"   + button "Show barcode" → /code/{{1}}
//   {{1}} first name  {{2}} amount ("1,250")  {{3}} store  {{4}} customer code
//
// Two callers, one function (processEntry):
//   • creditWhatsAppNotify — onValueCreated on the queue path (the moment it lands);
//   • creditWhatsAppSweep  — every 15 minutes, the backlog: entries left queued
//     while the template awaited approval, or after a transient failure.
//
// ── THE QUEUE HOLDS ONLY WHAT IS STILL OWED ──────────────────────────────────
// An entry is DELETED once it is settled (sent, refused, expired, or already
// sent by someone else). So the sweep reads the queue key-ordered with a
// limit — never the whole node, never an index — and everything it reads is
// work. The record of what happened lives at
//   /pos/credit_whatsapp_sent/{ledgerId}    (the dedupe claim, below)
// and in Cloud Logging.
//
// ── WHO MAY SEND: THE HARD RULE ──────────────────────────────────────────────
// Only store credits issued by the "Jafer Till" login send a message. The POS
// only pushes for that login, but the queue is client-writable, so the rule is
// enforced HERE: the entry's createdByUid must hold, right now,
//   /users/{uid}/posAccess = { isActive: true, role: "returnsOnly", creditWhatsApp: true }
// (the console rule binds createdByUid to auth.uid). Anything else is deleted
// unsent and logged. And the credit must be REAL: the ledger txn named by
// ledgerId must exist under that customer, as a credit of exactly amountCents,
// written by that same login, and the phone and code must be the customer
// record's. A ledger txn not there yet leaves the entry queued; any entry older
// than MAX_AGE_MS (7 days) is dropped unsent.
//
// ── ONE CREDIT, ONE MESSAGE, EVER ────────────────────────────────────────────
// The layby notify's create-once claim (#385/#386), keyed on the LEDGER id:
//   /pos/credit_whatsapp_sent/{ledgerId} = { claimedAt, queueId, … }
// Only the caller that wins the transaction may enqueue. A claim already
// present is never taken over at any age. A retried push, a re-delivered
// trigger, the trigger racing the sweep, an offline till resyncing — every
// one of them meets the claim and sends nothing. And the outbox doc id is
// fixed per credit (credit_{ledgerId}, created with create()), so even a claim
// taken over from a dead claimant (no outcome after 10 minutes) cannot enqueue
// the credit twice. A claim that is settled
// (notifiedAt / failedAt) also clears its duplicate queue entry; a claim in
// flight leaves it alone (its owner deletes it, or releases the claim on a
// transient failure so the next sweep re-claims).
//
// ── TEMPLATE APPROVAL IS CHECKED BEFORE ANY CLAIM ────────────────────────────
// Not APPROVED (pending, rejected, missing, unreadable) → nothing is claimed,
// nothing is sent, the entry stays queued and the sweep sends it the run after
// approval lands. No free-text fallback.
"use strict";

const TEMPLATE = "store_credit_issued";
const TEMPLATE_LANGUAGE = "en";
const QUEUE = "pos/credit_whatsapp_queue";
const SENT = "pos/credit_whatsapp_sent";
const RETURNS_ONLY_ROLE = "returnsOnly";
const SWEEP_LIMIT = 100;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// A claim with no outcome this long after it was taken is a dead claimant (a
// crash between claim and enqueue). Taking it over is safe: the outbox doc id
// is fixed per credit (outboxDocId) and created with create(), so a doc the
// dead claimant DID write is found, never written twice.
const STALE_CLAIM_MS = 10 * 60 * 1000;
const outboxDocId = (ledgerId) => `credit_${ledgerId}`;

// R1,250 style, without the R (the template carries it): whole rands bare,
// cents only when there are some. Integer cents in, string out; null when the
// amount is not a positive whole number of cents.
function formatRand(amountCents) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) return null;
  const rands = Math.floor(amountCents / 100);
  const cents = amountCents % 100;
  const whole = String(rands).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return cents ? `${whole}.${String(cents).padStart(2, "0")}` : whole;
}

// "+27821234567" only — a South African MOBILE in E.164 (06x, 07x, 081–084).
function isSaMobileE164(phone) {
  return typeof phone === "string" && /^\+27(6\d|7\d|8[1-4])\d{7}$/.test(phone);
}

// "C-2291" → "2291" (the barcode page's path; the barcode reads MCUST-2291).
function codeDigits(customerCode) {
  const m = /^C-(\d+)$/i.exec(String(customerCode || "").trim());
  return m ? m[1] : null;
}

/** Why this entry can never be sent (null = its shape is sendable). */
function entryProblem(e) {
  if (!e || typeof e !== "object") return "not_an_entry";
  if (typeof e.ledgerId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(e.ledgerId)) return "bad_ledger_id";
  if (typeof e.customerId !== "string" || !e.customerId || /[.#$[\]/]/.test(e.customerId)) return "bad_customer";
  if (typeof e.createdByUid !== "string" || !e.createdByUid || /[.#$[\]/]/.test(e.createdByUid)) return "no_creator";
  if (!isSaMobileE164(e.phone)) return "unusable_recipient";
  if (!formatRand(e.amountCents)) return "bad_amount";
  if (typeof e.firstName !== "string" || !e.firstName.trim() || e.firstName.length > 60) return "bad_first_name";
  if (typeof e.storeName !== "string" || !e.storeName.trim() || e.storeName.length > 60) return "bad_store";
  if (!codeDigits(e.customerCode)) return "bad_customer_code";
  return null;
}

/** The template's parameters for a sendable entry. */
function templateRequest(e) {
  return {
    templateName:   TEMPLATE,
    recipientPhone: e.phone,
    templateParams: [e.firstName.trim(), formatRand(e.amountCents), e.storeName.trim(), String(e.customerCode).trim().toUpperCase()],
    buttonUrlParam: codeDigits(e.customerCode),
  };
}

/**
 * Template status from the WABA. Resolves { approved, reason } — never throws.
 * fetchTemplates() → the Graph API's JSON for /{waba}/message_templates?name=store_credit_issued.
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

/** May this login's credits send? Read fresh, every time. */
async function creatorAllowed(db, uid) {
  const pa = (await db.ref(`users/${uid}/posAccess`).get()).val();
  return !!(pa && pa.isActive === true && pa.role === RETURNS_ONLY_ROLE && pa.creditWhatsApp === true);
}

/**
 * The ledger txn behind the entry: "ok" | "missing" | "mismatch".
 * A credit of exactly amountCents, written by the same login.
 */
async function ledgerState(db, e) {
  const txn = (await db.ref(`pos/creditLedger/${e.customerId}/txns/${e.ledgerId}`).get()).val();
  if (txn == null) return "missing";
  if (txn.amount !== e.amountCents || txn.kind !== "credit" || txn.staffUid !== e.createdByUid) return "mismatch";
  return "ok";
}

// "+27…" for any shape a stored phone takes; null when not an SA mobile.
function saMobile(raw) {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 13 && d.startsWith("0027")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("27")) d = "0" + d.slice(2);
  else if (d.length === 9 && !d.startsWith("0")) d = "0" + d;
  return /^0(6\d|7\d|8[1-4])\d{7}$/.test(d) ? "+27" + d.slice(1) : null;
}

/**
 * The recipient and code are the CUSTOMER'S, not whatever the entry says: the
 * phone must be the record's phone (or, with none on the record, the phone
 * the customer is keyed by), and the code must be the record's code when it
 * has one. Null = matches; else the reason.
 */
async function customerMismatch(db, e) {
  const rec = (await db.ref(`customers/${e.customerId}`).get()).val();
  const phones = new Set([saMobile(rec && rec.phone), saMobile(e.customerId)].filter(Boolean));
  if (rec && rec.phone && saMobile(rec.phone)) { if (saMobile(rec.phone) !== e.phone) return "phone_not_the_customers"; }
  else if (!phones.has(e.phone)) return "phone_not_the_customers";
  // The code (message text + the barcode link) must BE the record's — never
  // taken on the entry's word, so a customer with no code on record gets none.
  if (!rec || typeof rec.code !== "string" || rec.code.trim().toUpperCase() !== String(e.customerCode).trim().toUpperCase()) return "code_not_the_customers";
  return null;
}

/**
 * Settle ONE queue entry. Never throws for a per-entry problem; returns
 *   { outcome, reason? }   outcome ∈ sent | queued | dropped | duplicate | failed
 * "failed" is a TRANSIENT failure: the claim is released, the entry stays,
 * and `error` is set so a caller can report it.
 */
async function processEntry({ db, enqueueWhatsApp, queueId, approval, nowMs = Date.now(), log = console }) {
  const entryRef = db.ref(`${QUEUE}/${queueId}`);
  const entry = (await entryRef.get()).val();
  if (entry == null) return { outcome: "duplicate", reason: "entry_gone" };
  const drop = async (reason, level = "warn") => {
    log[level](`creditWhatsApp: dropped ${queueId} unsent — ${reason}`, JSON.stringify({ ledgerId: entry.ledgerId ?? null, createdByUid: entry.createdByUid ?? null }));
    await entryRef.remove();
    return { outcome: "dropped", reason };
  };

  const problem = entryProblem(entry);
  if (problem) return drop(problem);
  // Too old to say "has been added" any more (and never left to clog the
  // head of the key-ordered sweep): dropped in every state.
  if (Number.isFinite(entry.createdAt) && nowMs - entry.createdAt > MAX_AGE_MS) return drop("too_old");
  // THE HARD RULE — before anything else is read or claimed.
  if (!(await creatorAllowed(db, entry.createdByUid))) return drop("creator_not_allowed", "error");

  // A settled claim on this ledger id → this entry is a duplicate.
  const claimRef = db.ref(`${SENT}/${entry.ledgerId}`);
  const existing = (await claimRef.get()).val();
  let staleClaimedAt = null;
  if (existing != null) {
    if (existing.notifiedAt || existing.failedAt) { await entryRef.remove(); return { outcome: "duplicate", reason: "already_settled" }; }
    const at = Date.parse(existing.claimedAt);
    if (!(Number.isFinite(at) && nowMs - at > STALE_CLAIM_MS)) return { outcome: "queued", reason: "claimed_in_flight" };
    staleClaimedAt = existing.claimedAt;   // a dead claimant — taken over below
  }

  const ledger = await ledgerState(db, entry);
  if (ledger === "mismatch") return drop("ledger_mismatch", "error");
  if (ledger === "missing") return { outcome: "queued", reason: "ledger_not_yet_written" };
  const notHers = await customerMismatch(db, entry);
  if (notHers) return drop(notHers, "error");

  if (!approval || !approval.approved) return { outcome: "queued", reason: approval?.reason || "template_not_approved" };

  const now = new Date(nowMs).toISOString();
  let claimed = false;
  try {
    const res = await claimRef.transaction((cur) => (cur == null || (staleClaimedAt && cur.claimedAt === staleClaimedAt && !cur.notifiedAt && !cur.failedAt)
      ? { ledgerId: entry.ledgerId, queueId, customerId: entry.customerId, amountCents: entry.amountCents, claimedAt: now, ...(staleClaimedAt ? { tookOverFrom: staleClaimedAt } : {}) }
      : undefined));
    claimed = res.committed && res.snapshot.val()?.claimedAt === now && res.snapshot.val()?.queueId === queueId;
  } catch (err) {
    log.error("creditWhatsApp: claim transaction failed:", queueId, err.message);
    return { outcome: "failed", reason: "claim_failed", error: err };
  }
  if (!claimed) return { outcome: "queued", reason: "claimed_elsewhere" };

  let result;
  try {
    result = await enqueueWhatsApp(templateRequest(entry), { docId: outboxDocId(entry.ledgerId) });
  } catch (err) {
    const terminal = !!(err && err.code === "invalid-argument" && err.details && err.details.unusableRecipient);
    const msg = String((err && err.message) || err).slice(0, 300);
    if (terminal) {
      await claimRef.update({ failedAt: now, error: msg })
        .catch((e) => log.error("creditWhatsApp: could not stamp failure:", queueId, e.message));
      await entryRef.remove().catch((e) => log.error("creditWhatsApp: could not clear entry:", queueId, e.message));
      log.error("creditWhatsApp: unusable phone, NOT sent (terminal):", queueId);
      return { outcome: "dropped", reason: "unusable_recipient" };
    }
    // Nothing was enqueued — release so the next sweep can claim again.
    // Release only OUR claim: after a takeover the claim may be someone else's.
    // (null on the cold first pass: RTDB runs the function against the cached
    // value first, and an undefined there would abort before the real read.)
    await claimRef.transaction((cur) => (cur == null || (cur.queueId === queueId && cur.claimedAt === now) ? null : undefined))
      .catch((e) => log.error("creditWhatsApp: could not release claim:", queueId, e.message));
    log.error("creditWhatsApp: enqueue failed, claim released:", queueId, msg);
    return { outcome: "failed", reason: "enqueue_failed", error: err };
  }

  // The producer answered: an outbox doc exists. The claim is never released
  // from here; the entry is settled.
  await claimRef.update({ notifiedAt: now, outboxId: (result && result.outboxId) || null })
    .catch((e) => log.error("creditWhatsApp: ENQUEUED but could not stamp notifiedAt (claim kept):", queueId, e.message));
  await entryRef.remove()
    .catch((e) => log.error("creditWhatsApp: ENQUEUED but could not clear the entry (the claim blocks a resend):", queueId, e.message));
  log.log("creditWhatsApp: sent", JSON.stringify({ queueId, ledgerId: entry.ledgerId, outboxId: (result && result.outboxId) || null }));
  return { outcome: "sent" };
}

/**
 * The trigger: one new entry. Throws nothing; a transient failure is left
 * for the sweep (the entry is still queued and the claim released).
 */
async function notifyOne({ db, enqueueWhatsApp, fetchTemplates, queueId, nowMs = Date.now(), log = console }) {
  const approval = await templateApproval(fetchTemplates);
  if (!approval.approved) log.warn(`creditWhatsApp: ${queueId} stays queued — ${approval.reason}`);
  return processEntry({ db, enqueueWhatsApp, queueId, approval, nowMs, log });
}

/**
 * The sweep: the queued backlog, key-ordered, bounded. Approval is read once;
 * not approved → nothing is read past the approval and the run says why.
 * Throws after the run when any entry failed transiently (red in Cloud
 * Logging); safe, because claims make a re-run idempotent.
 */
async function runSweep({ db, enqueueWhatsApp, fetchTemplates, nowMs = Date.now(), log = console, limit = SWEEP_LIMIT }) {
  const approval = await templateApproval(fetchTemplates);
  const out = { approved: approval.approved, counts: {}, scanned: 0 };
  if (!approval.approved) {
    log.warn("creditWhatsAppSweep: not sending —", approval.reason);
    out.skipReason = approval.reason;
    return out;
  }
  const snap = await db.ref(QUEUE).orderByKey().limitToFirst(limit).get();
  const ids = [];
  snap.forEach((c) => { ids.push(c.key); });
  out.scanned = ids.length;
  const failures = [];
  for (const queueId of ids) {
    let r;
    try {
      r = await processEntry({ db, enqueueWhatsApp, queueId, approval, nowMs, log });
    } catch (err) {
      r = { outcome: "failed", reason: "read_failed", error: err };
    }
    out.counts[r.outcome] = (out.counts[r.outcome] || 0) + 1;
    if (r.outcome === "failed") failures.push(r.error || new Error(r.reason));
  }
  log.log("creditWhatsAppSweep: run", JSON.stringify({ scanned: out.scanned, counts: out.counts }));
  if (failures.length) {
    const e = new Error(`creditWhatsAppSweep: ${failures.length} entr${failures.length === 1 ? "y" : "ies"} failed (${failures.map((f) => f.message).join("; ").slice(0, 400)})`);
    e.failures = failures;
    throw e;
  }
  return out;
}

module.exports = {
  processEntry, notifyOne, runSweep, templateApproval, entryProblem, templateRequest,
  formatRand, isSaMobileE164, codeDigits, creatorAllowed, ledgerState, customerMismatch, outboxDocId,
  TEMPLATE, STALE_CLAIM_MS, TEMPLATE_LANGUAGE, QUEUE, SENT, RETURNS_ONLY_ROLE, SWEEP_LIMIT, MAX_AGE_MS,
};

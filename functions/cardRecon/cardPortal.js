// ─── THE SIMPLYBLU PORTAL → CARD RECON (cardBatchCapture action "portalDay") ──
// The decisions are lib/card-portal.cjs; this is the IO around them, and it is
// deliberately the same IO every other capture does:
//   • the duplicate guard (readBatchKeysFor → resolveBatchWrite) and an
//     append-only, create-only transaction on the exact key — an existing
//     record is never overwritten; a changed day lands beside it as -rN;
//   • the expected card figure from the POS ledger (computeExpectedCard) over
//     the record's window, on the till the machine STOOD on (reconTerminalFor);
//   • the transaction match (matchBatch) when the totals disagree;
//   • buildBatchRecord — the one record shape the POS report reads.
//
// CALLER: tools/sb-portal-recon on the Mac mini, as the mailbox poller's
// identity (card_recon + card_recon_intake, assertEmailIntake) — the same
// identity that files emailed FNB reports, so nothing new is granted.
//
// The staff slip for a portal till is KEPT, never recorded as the figure
// (keepPortalSlip): onto the day's portal record if it is in, else HELD under
// card_batch_overrides/portal/held until the portal record takes it.

"use strict";

const admin = require("firebase-admin");
const { CARD_TERMINALS_PATH, CARD_BATCHES_PATH, PHOTO_STORAGE_PREFIX, resolveBatchWrite, buildBatchRecord } = require("../lib/card-recon.cjs");
const { computeExpectedCard, cardLegsInWindow } = require("../lib/card-expected.cjs");
const { STORAGE_BUCKET } = require("../lib/photo-scope.cjs");
const { sastDayStartMs, sastDayYmd, isDayYmd } = require("../lib/card-unread.cjs");
const { slipTradingDay } = require("../lib/card-staff-slip-log.cjs");
const {
  SUPPORTING_FIELD, MAX_SUPPORTING_SLIPS, buildSupportingSlip, carriedSlips,
} = require("../lib/card-supporting-slips.cjs");
const P = require("../lib/card-portal.cjs");
const { isPortalRecordTerminal } = require("../lib/card-terminals.cjs");

const reject = (reason) => ({ ok: false, reason });
const MAX_SOURCES = 10;
const clean = (v) => JSON.parse(JSON.stringify(v));
// Lazily: cardRecon.js requires this file too.
const core = () => require("./cardRecon.js");

const heldDayPath = (storeId, tid, dayYmd) => {
  if (!P.SAFE_KEY.test(String(storeId)) || !P.SAFE_KEY.test(String(tid)) || !isDayYmd(dayYmd)) {
    throw new Error(`card-portal: refusing an unsafe held path (${storeId}/${tid}/${dayYmd})`);
  }
  return `${P.PORTAL_HELD_PATH}/${storeId}/${tid}/${dayYmd}`;
};

// ─── THE STAFF SLIP FOR A PORTAL TILL ────────────────────────────────────────
/**
 * A staff (or manager) slip for a till whose record is the portal: stored as a
 * supporting slip — onto today's portal record when it is in, otherwise held
 * for it. Never a batch record, never a figure the verdict reads. `cents` is
 * the typed total, or null for a photo-only slip.
 */
async function keepPortalSlip(db, request, { terminal, picked, photos, cents = null, nowMs, bucket: bucketDep = null }) {
  const dayYmd = slipTradingDay(nowMs);
  const tidPath = `${CARD_BATCHES_PATH}/${terminal.storeId}/${picked}`;
  // THE DAY'S PORTAL RECORD, found by its own day — not "the highest batch",
  // which a day recorded late would make the wrong one (Sonnet review, #837).
  const last = await portalRecordOn(db, tidPath, dayYmd);
  const onRecord = !!last;
  const holdPath = heldDayPath(terminal.storeId, picked, dayYmd);
  const slipId = db.ref(holdPath).push().key;
  const bucket = bucketDep || admin.storage().bucket(STORAGE_BUCKET);
  const paths = [];
  const cleanup = async () => { for (const p of paths) { try { await bucket.file(p).delete(); } catch { /* best effort */ } } };
  let full = false;
  try {
    for (let i = 0; i < photos.length; i++) {
      const path = `${PHOTO_STORAGE_PREFIX}/slip-${slipId}/photo-${i}.jpg`;
      paths.push(path);
      await bucket.file(path).save(photos[i].buffer, {
        resumable: false, contentType: "image/jpeg",
        metadata: { cacheControl: "private, max-age=31536000, immutable" },
      });
    }
    const entry = clean(buildSupportingSlip({
      slipId, cents: Number.isInteger(cents) ? cents : null, photos: paths,
      byUid: request.auth.uid, byEmail: request.auth.token?.email || null, nowMs, dayYmd,
    }));
    const target = onRecord ? `${tidPath}/${last.key}` : null;
    const txn = onRecord
      ? await db.ref(target).transaction((cur) => {
        if (cur === null) return null;
        const have = cur[SUPPORTING_FIELD] || {};
        full = Object.keys(have).length >= MAX_SUPPORTING_SLIPS;
        return full ? undefined : { ...cur, [SUPPORTING_FIELD]: { ...have, [slipId]: entry } };
      })
      : await db.ref(holdPath).transaction((cur) => {
        const have = cur || {};
        full = Object.keys(have).length >= MAX_SUPPORTING_SLIPS;
        return full ? undefined : { ...have, [slipId]: { ...entry, held: true } };
      });
    if (!txn.committed) {
      await cleanup();
      return reject(full
        ? "This till's slip has already been sent many times today — nothing more was kept. Tell Junid."
        : "This till's record changed while the slip was being sent — nothing was kept. Send it again.");
    }
  } catch (err) {
    await cleanup();
    throw err;
  }
  if (onRecord) await core().propagateSlips(db, tidPath, last.key);
  else {
    // The portal record may have been written while this slip was being held:
    // if it is there now, move the held slips onto it.
    const now = await portalRecordOn(db, tidPath, dayYmd);
    if (now) await sweepHeld(db, { storeId: terminal.storeId, tid: picked, dayYmd, key: now.key });
  }
  console.log(`cardBatchCapture: portal till slip ${onRecord ? `attached to ${last.key}` : "held for the portal record"} picked=${picked} slip=${slipId} by=${request.auth.uid}`);
  const receipt = await core().logStaffSlip(db, request, {
    kind: onRecord ? "supporting" : "held", terminal, picked, nowMs, photos: paths,
    batchKey: onRecord ? last.key : null, slipId,
  });
  return { ok: true, received: true, receipt };
}

/** The day's portal record in force (latest revision of its batch), or null. */
async function portalRecordOn(db, tidPath, dayYmd) {
  const win = P.portalDayWindow(dayYmd);
  if (!win) return null;
  const v = (await db.ref(tidPath).orderByChild("slip/closedAt").startAt(win.openedAt).endAt(win.closedAt).once("value")).val() || {};
  const recs = Object.entries(v).filter(([, r]) => r && typeof r === "object").map(([key, record]) => ({ key, record }));
  const p = recs.find((r) => P.isPortalRecord(r.record));
  if (!p) return null;
  const chain = recs.filter((r) => Number(r.record.batchNo) === Number(p.record.batchNo))
    .sort((a, b) => (Number(a.record.revision) || 1) - (Number(b.record.revision) || 1));
  return chain.at(-1);
}

/** Held slips for the day not yet on a record → onto `key` (one transaction), marked takenInto. */
async function sweepHeld(db, { storeId, tid, dayYmd, key }) {
  const hp = heldDayPath(storeId, tid, dayYmd);
  const held = (await db.ref(hp).once("value")).val() || {};
  const todo = Object.entries(held).filter(([, s]) => s && typeof s === "object" && !s.takenInto);
  if (!todo.length) return 0;
  const tidPath = `${CARD_BATCHES_PATH}/${storeId}/${tid}`;
  await db.ref(`${tidPath}/${key}`).transaction((cur) => {
    if (cur === null) return null;
    const have = { ...(cur[SUPPORTING_FIELD] || {}) };
    let changed = false;
    for (const [id, s] of todo) {
      if (have[id]) continue;
      const { held: _h, takenInto: _t, ...rest } = s;
      have[id] = rest; changed = true;
    }
    return changed ? clean({ ...cur, [SUPPORTING_FIELD]: have }) : undefined;
  });
  const marks = {};
  for (const [id] of todo) marks[`${hp}/${id}/takenInto`] = key;
  await db.ref().update(marks);
  await core().propagateSlips(db, tidPath, key);
  return todo.length;
}

// ─── ONE TERMINAL, ONE DAY ───────────────────────────────────────────────────
async function writePortalDay(db, request, { tid, row, dayYmd, extraction, merchantNo, business, nowMs, deps = {}, growOnly = false, elsewhere = [] }) {
  const { storeId } = row;
  const tidPath = `${CARD_BATCHES_PATH}/${storeId}/${tid}`;
  const dayRecordsVal = (await db.ref(tidPath).orderByChild("slip/closedAt")
    .startAt(extraction.openedAt).endAt(extraction.closedAt).once("value")).val() || {};
  const dayRecords = Object.entries(dayRecordsVal)
    .filter(([, r]) => r && typeof r === "object")
    .map(([key, record]) => ({ key, record: { ...record, batchKey: record.batchKey || key } }));
  const last = await core().readLastBatchFor(db, storeId, tid);
  const plan = P.planPortalWrite({ dayRecords, lastBatchNo: last.batchNo, extraction, portalIsRecord: isPortalRecordTerminal(row), growOnly });
  // A CROSS-CHECK (from 7 Nov 2026): the portal's figure beside the record in
  // force, or — no record yet — only on the day's status; never a record.
  if (plan.action === "check") {
    if (!plan.key) return { outcome: "awaiting-photo", totalCents: extraction.totalCents, txnCount: extraction.txnCount };
    // Two leaf reads and one child write — never the record's whole roll.
    const base = `${tidPath}/${plan.key}`;
    if (!(await db.ref(`${base}/batchKey`).once("value")).exists()) return { outcome: "awaiting-photo", totalCents: extraction.totalCents, txnCount: extraction.txnCount };
    const recordTotal = (await db.ref(`${base}/slip/totalCents`).once("value")).val();
    const check = P.portalCheckOf({ extraction, recordTotalCents: Number.isInteger(recordTotal) ? recordTotal : null, merchantNo, nowMs });
    const differs = check.differsCents;
    await db.ref(`${base}/portalCheck`).set(JSON.parse(JSON.stringify(check)));
    return { outcome: "checked", key: plan.key, totalCents: extraction.totalCents, txnCount: extraction.txnCount, differsCents: differs };
  }
  // Which POS card legs the portal does not have: one bounded read of the day.
  const gapNow = async () => {
    const { recon } = core().reconTerminalFor({ ...row, tid }, extraction.openedAt, extraction.closedAt);
    const legs = await (deps.cardLegsInWindow || cardLegsInWindow)(db, { startMs: extraction.openedAt, endMs: extraction.closedAt });
    return P.portalGapOf({ lines: extraction.lines, legs, storeId: recon.storeId, tillId: recon.tillId, elsewhere });
  };
  if (plan.action === "noop") {
    // The POS side can change after the portal's has settled (a sale rung up
    // late), so the unchanged record's gap is refreshed: a derived note beside
    // its figures, which are not touched. Junid's own correction is left alone.
    const swept = await sweepHeld(db, { storeId, tid, dayYmd, key: plan.key });
    // (`kept`: this pull's lines were not taken, so they say nothing about the record.)
    if (!plan.correctionStands && !plan.kept) {
      try {
        const gap = await gapNow();
        const ref = db.ref(`${tidPath}/${plan.key}/portalGap`);
        const cur = (await ref.once("value")).val();
        if (cur?.missingCount !== gap.missingCount || cur?.missingCents !== gap.missingCents
          || Object.keys(cur?.elsewhere || {}).length !== gap.elsewhere.length) await ref.set(clean(gap));
      } catch (err) { console.warn(`cardBatchCapture: portal gap not refreshed ${tid} ${dayYmd}: ${err && err.message}`); }
    }
    return { outcome: "unchanged", key: plan.key, ...(plan.correctionStands ? { note: "Junid's correction stands" } : {}), ...(swept ? { sweptSlips: swept } : {}) };
  }

  const existingKeys = await core().readBatchKeysFor(db, storeId, tid, plan.batchNo);
  // THE WHOLE CHAIN DECIDES, not the day's slice of it (CodeRabbit, #862): a
  // photographed report that took this portal record over may have closed on
  // a LATER day (PE Till 2's #562, 3→5 Nov, over the portal's 4 Nov), so the
  // day's records cannot see it. A revision over it would put the portal back
  // in force. If anything has superseded the portal record, it stands, and the
  // pull writes nothing (its cross-check belongs to that record's own day).
  if (plan.action === "revise" && existingKeys.length && existingKeys.at(-1) !== plan.supersedes) {
    return { outcome: "superseded", key: existingKeys.at(-1), totalCents: extraction.totalCents, txnCount: extraction.txnCount };
  }
  const write = resolveBatchWrite({ existingKeys, batchNo: plan.batchNo, correction: plan.action === "revise" });
  if (!write.ok) return { outcome: "refused", reason: write.reason };
  const ex = { ...extraction, batchNo: String(plan.batchNo) };

  const { recon, moved } = core().reconTerminalFor({ ...row, tid }, ex.openedAt, ex.closedAt);
  const expected = await (deps.computeExpectedCard || computeExpectedCard)(db, {
    storeId: recon.storeId, tillId: recon.tillId, startMs: ex.openedAt, endMs: ex.closedAt, edgeMs: 0,
  });
  const agree = ex.totalCents === expected.cardCents;
  const match = agree ? null : await core().matchBatch(db, { extraction: ex, terminal: recon });
  const superseded = write.supersedes
    ? (dayRecords.find((d) => d.key === write.supersedes)?.record
      || (await db.ref(`${tidPath}/${write.supersedes}`).once("value")).val())
    : null;
  const gap = await gapNow();
  const warnings = P.portalWarnings({
    extraction: ex, merchantNo, gap,
    replacing: write.supersedes ? (P.isPortalRecord(superseded) ? "portal" : "other") : null,
    supersededKey: write.supersedes,
  });
  if (moved) warnings.push("The machine was moved to another till during this day; the expected figure uses its registered till. The owner's Card Recon splits the day by where the machine stood.");
  const token = request.auth?.token || {};
  const record = buildBatchRecord({
    extraction: ex,
    terminal: { storeId, tillId: row.tillId, label: row.label ?? null },
    tid, batchKey: write.key, revision: write.revision, supersedes: write.supersedes, autoSuperseded: false,
    photoPaths: null, summaryOnly: false, warnings, expected, cashiers: expected.cashiers, match,
    reconciledByTotals: agree,
    submittedBy: { uid: request.auth?.uid || null, email: token.email || null },
    submittedAt: nowMs, draftId: null, ocr: null,
    capturedVia: P.PORTAL_SOURCE,
  });
  record.portalGap = gap;
  record.portal = { dayYmd, merchantNo: merchantNo || null, business: business || null, pulledAt: nowMs, source: P.PORTAL_SOURCE };

  // THE SLIPS: whatever the replaced record carried (and the replaced record
  // itself, when it was a staff slip), and every slip held for this day.
  const supporting = { ...((superseded && carriedSlips(superseded, write.supersedes, record)) || {}) };
  const held = (await db.ref(heldDayPath(storeId, tid, dayYmd)).once("value")).val() || {};
  for (const [slipId, s] of Object.entries(held)) {
    if (!s || typeof s !== "object" || supporting[slipId]) continue;
    const { held: _h, takenInto: _t, ...rest } = s;
    supporting[slipId] = rest;
  }
  if (Object.keys(supporting).length) record[SUPPORTING_FIELD] = supporting;

  const txn = await db.ref(`${tidPath}/${write.key}`).transaction((cur) => (cur !== null ? undefined : clean(record)));
  if (!txn.committed) return { outcome: "refused", reason: `${write.key} was written by something else a moment ago — the next pull will settle it.` };
  if (write.supersedes) await core().syncCarried(db, tidPath, write.supersedes, write.key);
  // Held slips now on the record say where they went (kept, never deleted).
  const marks = {};
  for (const slipId of Object.keys(held)) marks[`${heldDayPath(storeId, tid, dayYmd)}/${slipId}/takenInto`] = write.key;
  if (Object.keys(marks).length) await db.ref().update(marks);
  console.log(`cardBatchCapture: portal ${storeId}/${tid} ${dayYmd} → ${write.key}${write.supersedes ? ` (supersedes ${write.supersedes})` : ""} total=${ex.totalCents} txns=${ex.txnCount} expected=${expected.cardCents}`);
  return { outcome: "recorded", key: write.key, supersedes: write.supersedes ?? null, totalCents: ex.totalCents, txnCount: ex.txnCount, expectedCents: expected.cardCents };
}

// ─── THE CALL ────────────────────────────────────────────────────────────────
/**
 * data: { dayYmd, sources: [{ business: { name, merchantNo }, tids: [..], cols: [..], rows: [[..]] }] }
 * One run of the fetcher for one SAST day. Answers per terminal what happened.
 */
async function handlePortalDay(db, request, deps = {}) {
  const now = deps.now || Date.now;
  const nowMs = now();
  const data = request.data || {};
  const dayYmd = data.dayYmd;
  if (!isDayYmd(dayYmd) || sastDayStartMs(dayYmd) === null) return reject("dayYmd must be YYYY-MM-DD.");
  // The floor for every terminal; each machine's own start (`portalFrom`) is
  // applied per terminal in portalTerminalsOn — one before its start is not
  // a portal till that day and is left alone.
  if (dayYmd < P.PORTAL_EARLIEST_YMD) return reject(`Nothing is taken from the portal before ${P.PORTAL_EARLIEST_YMD}; ${dayYmd} is before that.`);
  if (sastDayStartMs(dayYmd) > nowMs) return reject("That day has not started yet.");
  const sources = Array.isArray(data.sources) ? data.sources : null;
  if (!sources || !sources.length) return reject("No portal data was sent.");
  if (sources.length > MAX_SOURCES) return reject(`${sources.length} portal stores were sent; at most ${MAX_SOURCES} are taken in one call — nothing was recorded.`);

  // The registry is eight rows; mapping a TID by its forgiving form needs all of them.
  const registry = (await db.ref(CARD_TERMINALS_PATH).once("value")).val() || {};
  const portalRows = P.portalTerminalsOn(registry, dayYmd);
  const byKey = new Map(); // registry key → { txns, merchantNo, business }
  const linked = new Set();
  const unassigned = [];
  const sourceSummaries = [];
  let unattributed = { txns: 0, cents: 0 };
  const merchantOf = new Map();
  const merchantActive = new Map();

  for (const src of sources) {
    const business = src && src.business && typeof src.business === "object"
      ? { name: String(src.business.name || "").slice(0, 80) || null, merchantNo: String(src.business.merchantNo || "").replace(/\D/g, "").slice(0, 20) || null }
      : { name: null, merchantNo: null };
    const parsed = P.parsePortalRows({ cols: src && src.cols, rows: src && src.rows });
    if (!parsed.ok) {
      sourceSummaries.push({ ...business, ok: false, reason: parsed.reason });
      continue;
    }
    const listed = Array.isArray(src.tids) ? src.tids.map(String) : [];
    const seen = [...listed, ...parsed.txns.map((t) => t.tid)];
    const { mapped, unassigned: un } = P.mapPortalTids(seen, registry);
    for (const k of Object.values(mapped)) { linked.add(k); merchantOf.set(k, business.merchantNo || business.name || "?"); }
    merchantActive.set(business.merchantNo || business.name || "?", (merchantActive.get(business.merchantNo || business.name || "?") || 0) + parsed.txns.length);
    for (const raw of un) unassigned.push({ raw, business, txns: parsed.txns.filter((t) => t.tid === raw) });
    for (const t of parsed.txns) {
      const k = mapped[t.tid];
      if (!k) {
        if (!P.isTidLike(t.tid)) { unattributed = { txns: unattributed.txns + 1, cents: unattributed.cents + t.amountCents }; }
        continue;
      }
      if (!byKey.has(k)) byKey.set(k, { txns: [], ...business });
      byKey.get(k).txns.push(t);
    }
    sourceSummaries.push({ ...business, ok: true, tids: Object.keys(mapped).concat(un), rows: Array.isArray(src.rows) ? src.rows.length : 0, kept: parsed.txns.length, skipped: parsed.skipped });
  }
  // A source that failed to parse must not turn its terminals into "zero
  // transactions" — those terminals are simply not linked this run.
  const results = {};
  // A ZERO DAY IS ONLY WRITTEN WHEN IT CAN BE TRUE: the day is over, or the
  // machine's merchant shows activity today. A portal that is merely behind
  // must not put a false SHORT on today (Sonnet architect review, #837).
  const isToday = dayYmd >= sastDayYmd(nowMs);
  // A till whose record IS the portal is final from the 18:20 pull: the owner
  // sees the figure or the specific error then, not "awaiting" until tomorrow
  // (Junid, 8 Nov 2026). A later pull revises it if SimplyBLU catches up.
  const pullTimePassed = Math.floor(((nowMs + 2 * 60 * 60 * 1000) % (24 * 60 * 60 * 1000)) / 60000) >= P.PORTAL_PULL_MINUTE;
  for (const [tid, row] of Object.entries(portalRows)) {
    if (!linked.has(tid)) { results[tid] = { outcome: "awaiting", reason: "not in the portal's terminal list (merchant not linked yet, or no transaction ever)" }; continue; }
    const got = byKey.get(tid) || { txns: [], merchantNo: null, name: null };
    if (!got.txns.length && isToday && !(merchantActive.get(merchantOf.get(tid)) > 0) && !(isPortalRecordTerminal(row) && pullTimePassed)) {
      results[tid] = { outcome: "awaiting", reason: "no transactions on the portal today for this merchant yet — a zero day is recorded at the 18:20 pull (a portal till) or once the day is over" };
      continue;
    }
    const extraction = P.portalExtraction({ tid, mid: row.mid || null, dayYmd, txns: got.txns });
    // This store's other machines' payments that day: a POS leg answered by one is not missing.
    const elsewhere = [...byKey].filter(([k]) => k !== tid && registry[k]?.storeId === row.storeId)
      .flatMap(([k, v]) => v.txns.map((t) => ({ at: t.at, amountCents: t.amountCents, tid: k, tillId: registry[k].tillId })));
    try {
      results[tid] = await writePortalDay(db, request, {
        tid, row, dayYmd, extraction, merchantNo: got.merchantNo || row.mid || null, business: got.name || null, nowMs, deps, growOnly: data.growOnly === true, elsewhere,
      });
    } catch (err) {
      console.error(`cardBatchCapture: portal write failed ${tid} ${dayYmd}: ${err && err.message}`);
      results[tid] = { outcome: "error", reason: String(err && err.message || err).slice(0, 300) };
    }
  }
  // Linked terminals the registry knows but are not Standard Bank portal tills
  // (an FNB key the portal happens to list) are left alone — said, not written.
  for (const k of linked) if (!portalRows[k]) results[k] = results[k] || { outcome: "ignored", reason: "registered, but not a Standard Bank portal till on this day" };

  // UNASSIGNED: kept for Junid with the mapping editor. First seen is kept.
  for (const u of unassigned) {
    const key = P.unassignedKey(u.raw);
    if (!key) continue;
    const dayCents = u.txns.reduce((s, t) => s + t.amountCents, 0);
    await db.ref(`${P.PORTAL_UNASSIGNED_PATH}/${key}`).transaction((cur) => clean({
      ...(cur || {}),
      tid: u.raw,
      merchantNo: u.business.merchantNo || (cur && cur.merchantNo) || null,
      business: u.business.name || (cur && cur.business) || null,
      firstSeenAt: (cur && cur.firstSeenAt) || nowMs,
      lastSeenAt: nowMs,
      days: { ...((cur && cur.days) || {}), [dayYmd]: { txns: u.txns.length, cents: dayCents } },
    }));
    results[`unassigned:${u.raw}`] = { outcome: "unassigned", txns: u.txns.length, cents: dayCents };
  }

  const dayStatus = {};
  for (const [k, r] of Object.entries(results)) {
    if (!P.SAFE_KEY.test(k.replace(":", "_"))) continue;
    dayStatus[k.replace(":", "_")] = { at: nowMs, ...r };
  }
  await db.ref(`${P.PORTAL_DAYS_PATH}/${dayYmd}`).update(clean(dayStatus));
  await db.ref(P.PORTAL_STATUS_PATH).set(clean({
    lastRunAt: nowMs, dayYmd, sources: sourceSummaries, unattributed,
    linked: [...linked], awaiting: Object.entries(results).filter(([, r]) => r.outcome === "awaiting").map(([k]) => k),
  }));
  return { ok: true, dayYmd, results, sources: sourceSummaries, unattributed };
}

module.exports = { handlePortalDay, writePortalDay, keepPortalSlip, heldDayPath };

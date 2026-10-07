// ─── cardBatchManualEntry — JUNID TYPES THE FIGURES (POS → Reports → Card recon)
// The plan (what is recorded and why) is lib/card-manual-entry.cjs; this is the
// IO around it, and it is deliberately the same IO a capture's submit does:
//   • one registry row, never the registry;
//   • the duplicate guard (resolveWriteFor) and an append-only transaction on
//     the exact key — an existing record is never overwritten; a correction
//     lands beside it as {batchNo}-rN with `supersedes`;
//   • the expected card figure from the POS ledger (computeExpectedCard) over
//     the record's window, on the till the machine stood on;
//   • buildBatchRecord — the one record shape the POS report reads.
// Then the audit row (/card_batch_overrides/manual_audit) and, if that till/day
// was Unread, its marker is answered.
//
// GATE: Junid's own verified Google login, and nothing else — not card_recon,
// not stockRole, not an admin flag (Junid, 7 Oct 2026: "Manual entry is
// Junid-only"). The POS hides the form from every other login; this is the
// half that holds when someone calls it anyway.
//
// action "reread": a till/day that went Unread because the READER was out
// (credit, overload) can be read again once it is back — its kept photos are
// queued once more for the background reader. Same gate.
//
// DEPLOY BY NAME (functions/ is shared with marathon-pos-app):
//   firebase deploy --only functions:cardBatchManualEntry

"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const {
  CARD_TERMINALS_PATH, CARD_BATCHES_PATH, normaliseTid, validateExtraction, buildBatchRecord,
} = require("../lib/card-recon.cjs");
const { computeExpectedCard } = require("../lib/card-expected.cjs");
const { placementAt } = require("../lib/card-terminal-placements.cjs");
const { mayEnterManually, planManualEntry } = require("../lib/card-manual-entry.cjs");
const {
  MANUAL_AUDIT_PATH, unreadPath, resolveUnreadMarker, isDayYmd,
} = require("../lib/card-unread.cjs");
const { JOBS_PATH, DUE_PATH, dueKey } = require("../lib/card-read-jobs.cjs");
// The capture path's own duplicate guard — the same function its submit calls.
const { resolveWriteFor } = require("./cardRecon.js");

if (!admin.apps.length) {
  admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
}

const reject = (reason) => ({ ok: false, reason });
const KEY_RE = /^[0-9]{1,8}(-r[0-9]{1,3})?$/;

/** The latest settlement on this terminal that closed before `beforeMs`, or null. */
async function prevRecord(db, storeId, tid, beforeMs) {
  const snap = await db.ref(`${CARD_BATCHES_PATH}/${storeId}/${tid}`)
    .orderByChild("slip/closedAt").endAt(beforeMs - 1).limitToLast(1).once("value");
  const v = snap.val();
  return v ? Object.values(v)[0] : null;
}

/** The revision keys a batch has, by probing the only keys that can exist. */
async function revisionKeys(db, storeId, tid, batchNo) {
  const keys = [];
  for (let r = 1; r <= 20; r++) {
    const key = r === 1 ? String(batchNo) : `${batchNo}-r${r}`;
    const has = (await db.ref(`${CARD_BATCHES_PATH}/${storeId}/${tid}/${key}/batchNo`).once("value")).val();
    if (has === null || has === undefined) { if (r > 1) break; continue; }
    keys.push(key);
  }
  return keys;
}

async function handleManualEntry(db, request, deps = {}) {
  const now = deps.now || Date.now;
  const input = request.data || {};
  const tid = normaliseTid(input.tid);
  if (!tid) return reject("Pick the till first.");
  // This one terminal's row, never the whole registry.
  const row = (await db.ref(`${CARD_TERMINALS_PATH}/${tid}`).once("value")).val();
  if (!row || !row.storeId || !row.tillId) return reject(`Terminal ${tid} is not registered — nothing was recorded.`);
  const storeId = row.storeId; // the FILING key
  const nowMs = now();

  let replaced = null, replacedIsLatest = true;
  if (input.replaces !== undefined && input.replaces !== null && input.replaces !== "") {
    if (typeof input.replaces !== "string" || !KEY_RE.test(input.replaces)) return reject("That batch key is not one this report wrote.");
    replaced = (await db.ref(`${CARD_BATCHES_PATH}/${storeId}/${tid}/${input.replaces}`).once("value")).val();
    if (replaced) {
      replaced = { ...replaced, batchKey: input.replaces, tid };
      const keys = await revisionKeys(db, storeId, tid, Number(replaced.batchNo));
      replacedIsLatest = keys.length > 0 && keys[keys.length - 1] === input.replaces;
    }
  }
  // The previous settlement, for the default window: read AFTER the close is
  // known, so plan once for the close, then once more with the neighbour.
  const first = planManualEntry({ input, nowMs, replaced, replacedIsLatest });
  if (!first.ok) return first;
  const prev = await prevRecord(db, storeId, tid, first.extraction.closedAt);
  const plan = planManualEntry({
    input, nowMs, replaced, replacedIsLatest,
    prevClosedAt: prev && Number.isFinite(prev.slip?.closedAt) ? prev.slip.closedAt : null,
  });
  if (!plan.ok) return plan;
  const { extraction, batchNo, correction, warnings, manual } = plan;

  const verdict = validateExtraction(extraction, { summaryOnly: true, source: "manual", declaredTotal: true });
  if (!verdict.ok) return reject(verdict.reason);

  // ── WHERE THE MACHINE STOOD ───────────────────────────────────────────────
  // With a placement in force at the close, the record stamps the registry till
  // like every capture does today and the report places it. Before a
  // terminal's first placement the report reads the record's OWN stamp, so it
  // must be the till the machine was on then — the stamp on the settlement
  // before it (0000HP1X was PE Till 1 until 18 Sep).
  const placed = placementAt(row, extraction.closedAt);
  const stampTill = placed ? row.tillId
    : (prev && prev.storeId === storeId && prev.tillId) || row.tillId;
  const stampLabel = placed ? (row.label ?? null)
    : (prev && prev.terminalLabel) || row.label || null;
  const terminal = { storeId, tillId: stampTill, label: stampLabel };
  const ledgerTill = placed ? { storeId: placed.storeId, tillId: placed.tillId } : { storeId, tillId: stampTill };

  const { write } = await resolveWriteFor(db, { storeId, tid, batchNo, correction, lines: [] });
  if (!write.ok) {
    return reject(/already captured/.test(write.reason)
      ? `Batch #${batchNo} is already on file for this terminal. To change its figures, open that batch in the report and use "Correct these figures".`
      : write.reason);
  }
  if (correction && write.supersedes !== replaced.batchKey) {
    return reject(`Batch #${batchNo} changed while you were typing — reload the report and correct the latest capture.`);
  }

  const expected = await (deps.computeExpectedCard || computeExpectedCard)(db, {
    ...ledgerTill, startMs: extraction.openedAt, endMs: extraction.closedAt, edgeMs: 0,
  });
  const token = request.auth.token || {};
  const byEmail = token.email || null;
  const unread = unreadPath({ storeId, tid, dayYmd: manual.dayYmd });
  const marker = unread ? (await db.ref(unread).once("value")).val() : null;
  // The evidence that exists goes with the figures: the kept photos of an
  // unread day, or the record being corrected's own.
  const photos = (marker && marker.photos) || (replaced && replaced.photos) || null;

  const record = buildBatchRecord({
    extraction, terminal, tid, match: null, reconciledByTotals: false,
    batchKey: write.key, revision: write.revision, supersedes: write.supersedes, autoSuperseded: false,
    photoPaths: Array.isArray(photos) ? photos : (photos && typeof photos === "object" ? Object.values(photos) : null),
    summaryOnly: true,
    warnings: [...warnings, ...verdict.warnings],
    expected, cashiers: expected.cashiers,
    submittedBy: { uid: request.auth.uid, email: byEmail },
    submittedAt: nowMs,
    draftId: null, ocr: null,
    capturedVia: "manual",
    declaredTotal: { cents: extraction.totalCents, ocrReadCents: null, byUid: request.auth.uid, byEmail, at: nowMs },
  });
  record.manual = {
    ...manual,
    byUid: request.auth.uid, byEmail, at: nowMs,
    unreadPath: marker ? unread : null,
    typed: {
      totalCents: extraction.totalCents, purchasesCents: extraction.purchasesCents,
      refundsCents: extraction.refundsCents, cashCents: extraction.cashCents, txnCount: extraction.txnCount,
      openedAt: Number.isFinite(input.openedAt) ? input.openedAt : null,
      closedAt: Number.isFinite(input.closedAt) ? input.closedAt : null,
    },
  };

  const txn = await db.ref(`${CARD_BATCHES_PATH}/${storeId}/${tid}/${write.key}`).transaction((cur) => {
    if (cur !== null) return undefined; // exists → abort, never overwrite
    return JSON.parse(JSON.stringify(record));
  });
  if (!txn.committed) return reject(`Batch #${batchNo} was captured by something else a moment ago — reload the report.`);

  // ── THE AUDIT TRAIL ──────────────────────────────────────────────────────
  // The record carries `manual.original` too; this is the list of every hand
  // entry in one place, in the order they were made.
  await db.ref(MANUAL_AUDIT_PATH).push().set(JSON.parse(JSON.stringify({
    at: nowMs, byUid: request.auth.uid, byEmail,
    storeId, tid, dayYmd: manual.dayYmd, reason: manual.reason, note: manual.note,
    batchKey: write.key, supersedes: write.supersedes ?? null,
    before: manual.original,
    after: {
      totalCents: extraction.totalCents, purchasesCents: extraction.purchasesCents,
      refundsCents: extraction.refundsCents, cashCents: extraction.cashCents, txnCount: extraction.txnCount,
      openedAt: extraction.openedAt, closedAt: extraction.closedAt, windowSource: extraction.windowSource,
    },
  })));
  if (marker) {
    await db.ref(unread).transaction((cur) => (cur === null ? null
      : resolveUnreadMarker(cur, { via: "manual", batchKey: write.key, byEmail, nowMs })));
  }
  console.log(`cardBatchManualEntry: ${byEmail} ${storeId}/${tid} ${manual.dayYmd} → ${write.key}${write.supersedes ? ` (supersedes ${write.supersedes})` : ""}`);
  return { ok: true, batchKey: write.key, supersedes: write.supersedes ?? null };
}

/** Read an Unread day again: its kept photos go back to the background reader. */
async function handleReread(db, request, deps = {}) {
  const now = deps.now || Date.now;
  const tid = normaliseTid(request.data?.tid);
  const dayYmd = request.data?.dayYmd;
  if (!tid || !isDayYmd(dayYmd)) return reject("Pick the till and the day.");
  const row = (await db.ref(`${CARD_TERMINALS_PATH}/${tid}`).once("value")).val();
  if (!row || !row.storeId) return reject(`Terminal ${tid} is not registered.`);
  const marker = (await db.ref(unreadPath({ storeId: row.storeId, tid, dayYmd })).once("value")).val();
  if (!marker || marker.status !== "unread") return reject("That day is not waiting to be read.");
  const jobIds = Object.entries(marker.jobs || {})
    .sort((a, b) => Number(b[1] && b[1].at) - Number(a[1] && a[1].at)).map(([k]) => k);
  const jobId = jobIds.find((k) => /^[A-Za-z0-9_-]{10,40}$/.test(k));
  if (!jobId) return reject("No slip photo was ever received for that day, so there is nothing to read again — type the figures in.");
  const job = (await db.ref(`${JOBS_PATH}/${jobId}`).once("value")).val();
  if (!job || !job.photoPaths) return reject("The photo for that day is no longer on file — type the figures in.");
  if (job.status !== "unread") return reject("That photo is already being read.");
  const t = now();
  const key = dueKey(t, jobId);
  await db.ref().update({
    [`${JOBS_PATH}/${jobId}/status`]: "retry",
    [`${JOBS_PATH}/${jobId}/attempts`]: 0,
    [`${JOBS_PATH}/${jobId}/refusedReads`]: 0,
    [`${JOBS_PATH}/${jobId}/dueAt`]: t,
    [`${JOBS_PATH}/${jobId}/dueKey`]: key,
    [`${JOBS_PATH}/${jobId}/rereadAt`]: t,
    [`${DUE_PATH}/${key}`]: jobId,
  });
  return { ok: true, queued: jobId };
}

exports.cardBatchManualEntry = onCall(
  { region: "europe-west1", timeoutSeconds: 60, memory: "256MiB" },
  async (request) => {
    if (!mayEnterManually(request.auth?.token)) {
      throw new HttpsError("permission-denied", "Only Junid can enter batch figures by hand.");
    }
    const db = admin.database();
    const action = request.data?.action || "enter";
    if (action === "enter") return handleManualEntry(db, request);
    if (action === "reread") return handleReread(db, request);
    throw new HttpsError("invalid-argument", "action must be 'enter' or 'reread'.");
  },
);

exports.handleManualEntry = handleManualEntry;
exports.handleReread = handleReread;

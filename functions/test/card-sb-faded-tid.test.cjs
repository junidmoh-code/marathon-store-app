// ─── A STANDARD BANK REPORT WHOSE TID LINE PRINTED TOO FAINTLY (7 Nov 2026) ──
// Marathon PE Till 2's #564 (6 Nov 17:05:55 → 7 Nov 16:38:33, 89 transactions,
// R71,015.00) was photographed by Yasmin and by Junid and refused six times:
// "No terminal ID could be read off the slip". The PAX printer left the
// MID/TID/S/N lines almost blank; everything else printed crisply. The till's
// own chain proves it: #563 (read off its own paper, TID and all) closed at
// 17:05:58 — the moment #564 opened. lib/card-sb-photo.cjs sequenceTidProof.
//
// The figures below are the real slip's; the photo itself stays off git.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { sequenceTidProof, SEQUENCE_JOIN_MS } = require("../lib/card-sb-photo.cjs");
const { handleSlip, processReadJob } = require("../cardRecon/cardRecon.js");
const { validateExtraction } = require("../lib/card-recon.cjs");

const SAST = (s) => Date.parse(`${s}+02:00`);
const HP1X = "0000HP1X", Z4M6 = "0000Z4M6", FNB = "67377843";
const sb = { bank: "standard-bank" };
const TERMINALS = {
  [HP1X]: { storeId: "pe", tillId: "till-2", label: "Marathon Till 2", mid: "000000004977890", ...sb, activeFrom: SAST("2026-09-18T14:00:00") },
  [Z4M6]: { storeId: "trophy", tillId: "till-2", label: "Trophy Till 2", mid: "000000004977890", ...sb, activeFrom: SAST("2026-09-18T14:00:00") },
  [FNB]: { storeId: "pe", tillId: "till-1", label: "Marathon Till 1", mid: "100000002453164", capture: "both" },
};
const YASMIN = { uid: "u-yasmin", token: { email: "yasmin@marathon.internal" } };
const PHOTO = { base64: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg")]).toString("base64") };
const bucket = () => ({ file() { return { save: async () => {}, delete: async () => {} }; } });
const node = async (db, p) => (await db.ref(p).once("value")).val();

const rec = (batchNo, opened, closed, cents, over = {}) => ({
  batchKey: String(batchNo), batchNo, revision: 1, capturedVia: "photo", tid: HP1X, storeId: "pe", tillId: "till-2",
  slip: { openedAt: SAST(opened), closedAt: SAST(closed), totalCents: cents, format: "printed", windowSource: "printed" }, ...over,
});
// The real chain: the portal's synthetic 561–563, and the photographed reports over them.
const B560 = rec(560, "2026-11-01T14:50:22", "2026-11-02T17:01:42", 3837500);
const B563R2 = { ...rec(563, "2026-11-05T16:53:40", "2026-11-06T17:05:58", 4650000), batchKey: "563-r2", revision: 2, supersedes: "563" };
const P563_LIVE = rec(563, "2026-11-05T00:00:00", "2026-11-05T23:59:59", 0, { capturedVia: "simplyblu-portal" });
const P563 = { ...P563_LIVE, displacedBy: "562-r2" };

const report564 = (over = {}) => ({
  mid: null, tid: null, batchNo: "564",
  opened: "2026/11/06 17:05:55", closed: "2026/11/07 16:38:33", printed: "2026/11/07 16:40:33",
  txnCount: 89, purchases: "R71,015.00", cash: "R0.00", refunds: "R0.00", total: "R71,015.00",
  reconLine: "500 - Reconciled, in balance",
  confidence: { mid: 0.1, tid: 0.1, batchNo: 0.95, opened: 0.99, closed: 0.99, txnCount: 0.99, purchases: 0.99, refunds: 0.99, total: 0.99 },
  transactions: [], ...over,
});

function world(batches, { tid = HP1X } = {}) {
  const t = TERMINALS[tid];
  return makeFakeDb({
    config: { cardTerminals: TERMINALS },
    users: { [YASMIN.uid]: { cardSlipTills: { [t.storeId]: { [t.tillId]: true } } } },
    card_batches: { pe: { [HP1X]: batches } },
    pos: { paymentEvents: {} },
    network: { pe: { tills: { "till-1": { label: "Till 1" }, "till-2": { label: "Till 2" } } }, trophy: { tills: { "till-2": { label: "Till 2" } } } },
  });
}
async function sendAndRead(db, parsed, at, tid = HP1X) {
  const sent = await handleSlip(db, { auth: YASMIN, data: { action: "slip", pickedTid: tid, photos: [PHOTO] } }, { now: () => at, bucket: bucket() });
  assert.equal(sent.ok, true, sent.reason);
  const job = Object.values(await node(db, "card_batch_jobs")).sort((a, b) => a.receivedAt - b.receivedAt).at(-1);
  const out = await processReadJob(db, job.jobId, { now: () => at + 60000, onArrival: true, loadPhotos: async () => [PHOTO],
    ocr: async () => ({ parsed, model: "t", attempts: 1, tokensIn: 1, tokensOut: 1 }) });
  return { ...out, job: await node(db, `card_batch_jobs/${job.jobId}`) };
}

// ── pure ─────────────────────────────────────────────────────────────────────

test("proof: the till's own previous report closing as this one opens", () => {
  const ok = sequenceTidProof({ printedBatchNo: 564, openedAt: SAST("2026-11-06T17:05:55"), label: "Marathon Till 2",
    candidates: [{ key: "563-r2", record: B563R2 }, { key: "563", record: P563 }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.prevKey, "563-r2");
  assert.match(ok.note, /too faintly to read.*Marathon Till 2.*#564 follows that till's own #563 \(563-r2\), which closed 2026-11-06 17:05:58/);
});

test("no proof: a synthetic, typed or displaced #N-1; a number that does not follow; a gap in time", () => {
  const at = SAST("2026-11-06T17:05:55");
  const portalOnly = sequenceTidProof({ printedBatchNo: 564, openedAt: at, candidates: [{ key: "563", record: { ...P563_LIVE, slip: { ...P563_LIVE.slip, closedAt: at } } }] });
  assert.equal(portalOnly.ok, false);
  const typed = sequenceTidProof({ printedBatchNo: 564, openedAt: at, candidates: [{ key: "563", record: { ...B563R2, capturedVia: "typed", batchKey: "563", revision: 1 } }] });
  assert.equal(typed.ok, false);
  const displaced = sequenceTidProof({ printedBatchNo: 564, openedAt: at, candidates: [{ key: "563-r2", record: { ...B563R2, displacedBy: "x" } }] });
  assert.equal(displaced.ok, false);
  const skip = sequenceTidProof({ printedBatchNo: 565, openedAt: at, candidates: [{ key: "563-r2", record: B563R2 }] });
  assert.equal(skip.ok, false);
  assert.match(skip.reason, /batch #565 does not follow on from a report already read/);
  const late = sequenceTidProof({ printedBatchNo: 564, openedAt: SAST("2026-11-06T17:05:58") + SEQUENCE_JOIN_MS + 1000, candidates: [{ key: "563-r2", record: B563R2 }] });
  assert.equal(late.ok, false);
  const blind = sequenceTidProof({ printedBatchNo: null, openedAt: at, candidates: [{ key: "563-r2", record: B563R2 }] });
  assert.equal(blind.ok, false);
  assert.match(blind.reason, /batch number or Opened time could not be read/);
});

test("the TID confidence gate stands down only for a proven TID", () => {
  const ex = { tid: HP1X, batchNo: "564", totalCents: 7101500, purchasesCents: 7101500, refundsCents: 0, cashCents: 0, txnCount: 89,
    openedAt: SAST("2026-11-06T17:05:55"), closedAt: SAST("2026-11-07T16:38:33"), printedAt: SAST("2026-11-07T16:40:33"),
    confidence: { tid: 0.1, batchNo: 0.95, totalCents: 0.99, openedAt: 0.99, closedAt: 0.99, purchasesCents: 0.99, txnCount: 0.99 }, lines: [] };
  assert.equal(validateExtraction(ex, { summaryOnly: true }).ok, false);
  assert.equal(validateExtraction({ ...ex, tidProven: "sb-sequence" }, { summaryOnly: true }).ok, true);
});

// ── the whole read ───────────────────────────────────────────────────────────

test("PE Till 2's real #564: TID line blank, recorded under the till by its chain — one card, said on the record", async () => {
  const db = world({ 560: B560, 563: P563, "563-r2": B563R2 });
  const out = await sendAndRead(db, report564(), SAST("2026-11-07T16:41:46"));
  assert.equal(out.final, "recorded", out.job.lastReason);
  const r = await node(db, `card_batches/pe/${HP1X}/564`);
  assert.equal(r.slip.totalCents, 7101500);
  assert.equal(r.tid, HP1X);
  assert.ok(r.warnings.some((w) => /too faintly to read.*follows that till's own #563 \(563-r2\)/.test(w)), r.warnings.join(" | "));
  // Junid's second photo of the same paper is a duplicate, never a second card.
  assert.equal((await sendAndRead(db, report564(), SAST("2026-11-07T21:54:20"))).final, "duplicate");
  assert.equal(await node(db, `card_batches/pe/${HP1X}/564-r2`), null);
});

test("no read report before it: refused by name, not filed", async () => {
  const db = world({ 560: B560, 563: P563_LIVE });
  const out = await sendAndRead(db, report564(), SAST("2026-11-07T16:41:46"));
  assert.equal(out.final, null, "refused reads are retried before Unread");
  assert.match(out.job.lastReason, /terminal-ID line on this slip is too faint to read, and batch #564 does not follow on/);
  assert.equal(await node(db, `card_batches/pe/${HP1X}/564`), null);
});

test("a DIFFERENT TID read off the paper is still the wrong slip", async () => {
  const db = world({ 560: B560, "563-r2": B563R2 });
  const out = await sendAndRead(db, report564({ tid: "0000Z4M6", confidence: { ...report564().confidence, tid: 0.99 } }), SAST("2026-11-07T16:41:46"));
  assert.match(out.job.lastReason, /prints TID 0000Z4M6, not the till you picked \(that slip belongs to Trophy Till 2\)/);
  assert.equal(await node(db, `card_batches/pe/${HP1X}/564`), null);
});

test("FNB is never asked: a blank TID on an FNB till refuses exactly as before", async () => {
  const db = world({}, { tid: FNB });
  const out = await sendAndRead(db, report564(), SAST("2026-11-07T16:41:46"), FNB);
  assert.equal(out.job.lastReason, "No terminal ID could be read off the slip — retake the header photo.");
});

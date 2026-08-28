// ─── THE CROSS-REPO RECORD CONTRACT ──────────────────────────────────────────
// /pos/card_batches is written HERE (buildBatchRecord in lib/card-recon.cjs)
// and read THERE — marathon-pos-app's Card reconciliation tab. The two halves
// were built by separate sessions, and the POS side read this repo's record
// shape while it was still uncommitted and moving. A rename on this side that
// nobody notices does not crash anything over there: the field simply reads
// undefined, the matcher runs with less evidence, and the screen shows a
// CONFIDENT WRONG VARIANCE against a named person's till. That is the failure
// this file exists to make impossible.
//
// So: every field the POS half actually touches is pinned below, by name and
// type, with the POS file that touches it. Renaming or retyping one of them
// fails here — in this repo, at build time — instead of silently in a report
// that accuses someone.
//
// Audited against marathon-pos-app @ 36bd1df (PR #265), 2026-08-28:
//   src/reports/cardrecon/batchData.js      latestRevisions, adaptBatchLines,
//                                           computeOutstandingRows
//   src/reports/cardrecon/useCardRecon.js   the two indexed queries
//   src/reports/cardrecon/CardReconTab.jsx  the row + the evidence panel
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildBatchRecord } = require("../lib/card-recon.cjs");

const EXTRACTION = {
  tid: "0000HP1X", mid: "000000004977890", batchNo: "494",
  openedAt: 1787763004000, closedAt: 1787849404000, printedAt: 1787900000000,
  openedText: "2026/08/26 18:50:04", closedText: "2026/08/27 18:50:04",
  txnCount: 2,
  purchasesCents: 5035500, cashCents: 0, refundsCents: 4800, totalCents: 5030700,
  reconLine: "500 - Reconciled, in balance",
  confidence: { tid: 0.99, batchNo: 0.98, totalCents: 0.97 },
  lines: [
    { tsn: 101, at: 1787770931000, date: "2026/08/26", time: "19:02:11", uti: "U1", rrn: "R1", authCode: "A1", pan: "************1111", type: "purchase", amountCents: 5035500 },
    { tsn: 102, at: 1787814900000, date: "2026/08/27", time: "09:15:00", uti: "U2", rrn: "R2", authCode: "A2", pan: "************2222", type: "refund", amountCents: -4800 },
  ],
};
const TERMINAL = { storeId: "pe", tillId: "till-1", label: "PE Till 1" };
const EXPECTED = { cardCents: 5030700, legs: 2, byKind: { sale: { cents: 5030700, legs: 2 } } };

function record(over = {}) {
  return buildBatchRecord({
    extraction: EXTRACTION, terminal: TERMINAL, tid: EXTRACTION.tid,
    batchKey: "494", revision: 1, supersedes: null,
    photoPaths: ["cardRecon/draft1/photo-0.jpg", "cardRecon/draft1/photo-1.jpg"],
    summaryOnly: false, warnings: [], expected: EXPECTED, cashiers: [],
    submittedBy: { uid: "u1", email: "a@b.c" }, submittedAt: 1787900000001,
    draftId: "draft1", ocr: null,
    ...over,
  });
}

// ── The row: store, till, terminal, batch identity, window, declared total ───
test("CONTRACT: the fields CardReconTab renders on the batch row", () => {
  const r = record();
  // CardReconTab.jsx BatchRow — storeLabel(b.storeId) / tillLabel(b.storeId, b.tillId)
  assert.equal(typeof r.storeId, "string");
  assert.equal(typeof r.tillId, "string");
  // `b.terminalLabel || b.tid`
  assert.equal(typeof r.tid, "string");
  assert.equal(typeof r.terminalLabel, "string");
  // `#{b.batchNo}` and the `r{b.revision}` badge. batchNo MUST be a NUMBER:
  // useCardRecon.js completes a batch's revision set with
  // query(orderByChild("batchNo"), equalTo(<number>)) — a string here matches
  // nothing and a superseded record would render as current.
  assert.equal(typeof r.batchNo, "number");
  assert.equal(r.batchNo, 494);
  assert.equal(typeof r.revision, "number");
  // latestRevisions annotates by batchKey; the record carries its own.
  assert.equal(typeof r.batchKey, "string");
  // The window IS the slip's own Opened→Closed, never a trading day.
  assert.equal(typeof r.slip.openedAt, "number");
  assert.equal(typeof r.slip.closedAt, "number");
  // summarizeBatch({ declaredCents: b.slip.totalCents })
  assert.equal(typeof r.slip.totalCents, "number");
  // The `summary only` badge and the whole line-match branch hang off this.
  assert.equal(typeof r.linesCaptured, "boolean");
});

// ── useCardRecon's two indexed queries ──────────────────────────────────────
test("CONTRACT: the two children the POS queries order by exist at those paths", () => {
  const r = record();
  // orderByChild("slip/closedAt") — the range subscription per terminal.
  assert.ok(Number.isFinite(r.slip.closedAt), "slip/closedAt must be a number");
  // orderByChild("batchNo") — the revision-completion fetch.
  assert.ok(Number.isFinite(r.batchNo), "batchNo must be a number");
  // Both are indexed live at /pos/card_batches/$storeId/$tid
  // (".indexOn": ["slip/closedAt", "batchNo"] — applied 2026-08-28).
});

// ── The detail roll adaptBatchLines walks ───────────────────────────────────
test("CONTRACT: lines are keyed by TSN and carry every field the evidence table prints", () => {
  const r = record();
  // adaptBatchLines: Object.entries(record.lines), object children only.
  assert.deepEqual(Object.keys(r.lines).sort(), ["101", "102"]);
  const l = r.lines["101"];
  // TerminalLineTable prints: time, amount, masked PAN, auth code, RRN, TSN, UTI.
  // matcher.js needs tsn + atMs + amountCents and will not guess without them.
  assert.equal(typeof l.tsn, "number");
  assert.equal(typeof l.at, "number");        // → line.atMs
  assert.equal(typeof l.amountCents, "number"); // SIGNED integer cents
  assert.equal(typeof l.pan, "string");
  assert.equal(typeof l.authCode, "string");
  assert.equal(typeof l.rrn, "string");
  assert.equal(typeof l.uti, "string");
  assert.equal(typeof l.date, "string");      // fallback when `at` is null
  assert.equal(typeof l.time, "string");
  assert.equal(typeof l.type, "string");
  // A refund keeps its sign, so it can only ever match a refund leg.
  assert.equal(r.lines["102"].amountCents, -4800);
  // The key is the TSN as a string — RTDB may hand a dense run back as an
  // array with null holes, which adaptBatchLines filters to object children.
  assert.equal(Number(Object.keys(r.lines)[0]), r.lines["101"].tsn);
});

// ── The states that must stay distinguishable, not merely falsy ─────────────
test("CONTRACT: a summary-only capture is flagged and carries no lines", () => {
  const r = record({ summaryOnly: true });
  assert.equal(r.linesCaptured, false);
  assert.equal(r.lines, null);          // RTDB drops it; `!record.lines` short-circuits
  assert.equal(r.lineCount, 0);
  // The declared total is still there — a summary batch is compared on totals.
  assert.equal(typeof r.slip.totalCents, "number");
});

test("CONTRACT: warnings are an array of strings or null, never a map", () => {
  assert.equal(record({ warnings: [] }).warnings, null); // POS: Array.isArray(b.warnings)
  const r = record({ warnings: ["lines sum ≠ slip total"] });
  assert.ok(Array.isArray(r.warnings));
  assert.equal(typeof r.warnings[0], "string");
});

test("CONTRACT: photos are Storage PATHS under cardRecon/, as a plain array", () => {
  const r = record();
  // SlipPhotos resolves each with storageRef(storage, p) → getDownloadURL.
  assert.ok(Array.isArray(r.photos));
  for (const p of r.photos) {
    assert.equal(typeof p, "string");
    assert.ok(p.startsWith("cardRecon/"), `photo path must live under cardRecon/: ${p}`);
  }
});

// ── computeOutstandingRows keys coverage by store AND tid ───────────────────
test("CONTRACT: the record carries the store+tid pair the outstanding sweep keys on", () => {
  const r = record();
  // coveredDays key is `${b.storeId}|${b.tid}` — a batch for one store's
  // terminal must never mark another store's same-named terminal as covered.
  assert.equal(r.storeId, "pe");
  assert.equal(r.tid, "0000HP1X");
  // And the day bucket comes off slip.closedAt.
  assert.ok(Number.isFinite(r.slip.closedAt));
});

// ── The evidence the POS half does NOT read, but must keep ──────────────────
test("CONTRACT: the recorded expectation stays on the record even though POS recomputes", () => {
  const r = record();
  // CardReconTab recomputes POS card takings live from /pos/paymentEvents, so
  // a leg voided AFTER capture changes the displayed figure. The figure that
  // was true at the moment of record must survive on the record itself — it is
  // the evidence, the live recompute is the current view.
  assert.equal(r.expected.cardCents, 5030700);
  assert.equal(r.expected.windowStartMs, r.slip.openedAt);
  assert.equal(r.expected.windowEndMs, r.slip.closedAt);
  assert.equal(r.varianceCents, r.slip.totalCents - r.expected.cardCents);
  assert.equal(typeof r.submittedBy.uid, "string");
  assert.equal(typeof r.submittedAt, "number");
});

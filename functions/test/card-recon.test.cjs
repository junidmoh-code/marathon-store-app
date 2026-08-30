// Tests for functions/lib/card-recon.cjs — the pure batch-slip model.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseSlipTimestamp, parseRandsToCents, formatCents,
  normaliseTid, normaliseBatchNo, resolveBatchWrite,
  checkTsnContiguity, validateExtraction, buildBatchRecord,
  SAST_OFFSET_MS,
} = require("../lib/card-recon.cjs");

// ── slip timestamps (SAST, no DST) ───────────────────────────────────────────
test("thousand separators must GROUP correctly — a mis-grouped figure is refused", () => {
  // "R50,307,00.5" used to parse as R5,030,700.50: every comma was stripped
  // before the shape was tested, so the grouping was never checked and a
  // mangled figure became a large, wrong one. This function's contract is that
  // a mangled figure is refused and never coerced — the grouping is part of
  // what must parse. Found while building the PDF path, and it applies to the
  // photo path just as much.
  for (const good of ["R50,355.00", "R50 355.00", "R1,234,567.89", "50355", "R0.50", "R48"]) {
    assert.notEqual(parseRandsToCents(good), null, `${good} must still parse`);
  }
  for (const bad of ["R50,307,00.5", "R50,30,700.00", "R50,3070.00", "R5O,307.00", "R50,307.000"]) {
    assert.equal(parseRandsToCents(bad), null, `${bad} must be refused, not coerced`);
  }
  assert.equal(parseRandsToCents("R1,234,567.89"), 123456789);
});

test("parseSlipTimestamp reads SA local time as UTC+2", () => {
  const ms = parseSlipTimestamp("2026/08/26 18:50:04");
  assert.equal(ms, Date.UTC(2026, 7, 26, 18, 50, 4) - SAST_OFFSET_MS);
});

test("parseSlipTimestamp refuses malformed and rolled-over dates", () => {
  assert.equal(parseSlipTimestamp("2026/02/30 10:00:00"), null); // Feb 30 must not roll to March
  assert.equal(parseSlipTimestamp("26/08/2026 18:50:04"), null);
  assert.equal(parseSlipTimestamp("2026/08/26"), null);
  assert.equal(parseSlipTimestamp(null), null);
});

// ── money ────────────────────────────────────────────────────────────────────
test("parseRandsToCents handles the slip's formats", () => {
  assert.equal(parseRandsToCents("R50,355.00"), 5035500);
  assert.equal(parseRandsToCents("50 355.00"), 5035500);
  assert.equal(parseRandsToCents("R0.00"), 0);
  assert.equal(parseRandsToCents("(R48.00)"), -4800);
  assert.equal(parseRandsToCents("-R48.00"), -4800);
  assert.equal(parseRandsToCents("R1,234.5"), 123450);
  assert.equal(parseRandsToCents("garbage"), null);
  assert.equal(parseRandsToCents(""), null);
  assert.equal(parseRandsToCents("R1.234.00"), null);
});

test("formatCents round-trips for messages", () => {
  assert.equal(formatCents(5035500), "R50,355.00");
  assert.equal(formatCents(-4800), "-R48.00");
});

// ── identifiers ──────────────────────────────────────────────────────────────
test("TID and batch number normalisation", () => {
  assert.equal(normaliseTid(" 0000hp1x "), "0000HP1X");
  assert.equal(normaliseTid("no spaces!"), null);
  assert.equal(normaliseBatchNo("#494"), "494");
  assert.equal(normaliseBatchNo("0494"), "494");
  assert.equal(normaliseBatchNo("A494"), null);
});

// ── duplicates and corrections ───────────────────────────────────────────────
test("first capture writes the bare batch number", () => {
  const r = resolveBatchWrite({ existingKeys: [], batchNo: "494", correction: false });
  assert.deepEqual(r, { ok: true, key: "494", revision: 1, supersedes: null });
});

test("a duplicate batchNo for the same TID is rejected, not overwritten", () => {
  const r = resolveBatchWrite({ existingKeys: ["494"], batchNo: "494", correction: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /already captured/);
});

test("a correction supersedes and keeps both", () => {
  const r = resolveBatchWrite({ existingKeys: ["494"], batchNo: "494", correction: true });
  assert.deepEqual(r, { ok: true, key: "494-r2", revision: 2, supersedes: "494" });
  const r3 = resolveBatchWrite({ existingKeys: ["494", "494-r2"], batchNo: "494", correction: true });
  assert.deepEqual(r3, { ok: true, key: "494-r3", revision: 3, supersedes: "494-r2" });
});

test("a correction of a never-captured batch is refused", () => {
  const r = resolveBatchWrite({ existingKeys: ["493"], batchNo: "494", correction: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not been captured/);
});

// ── TSN contiguity ───────────────────────────────────────────────────────────
test("contiguous TSNs pass; gaps and duplicates are named", () => {
  assert.equal(checkTsnContiguity([3, 1, 2, 4]).ok, true);
  const gap = checkTsnContiguity([1, 2, 4]);
  assert.equal(gap.ok, false);
  assert.deepEqual(gap.gaps, [3]);
  const dup = checkTsnContiguity([1, 2, 2, 3]);
  assert.equal(dup.ok, false);
  assert.deepEqual(dup.duplicates, [2]);
  assert.equal(checkTsnContiguity([]).ok, false);
});

// ── extraction validation ────────────────────────────────────────────────────
const CONF = { tid: 0.99, batchNo: 0.98, totalCents: 0.97, openedAt: 0.95, closedAt: 0.95, purchasesCents: 0.95, txnCount: 0.95 };
function goodExtraction(overrides = {}) {
  return {
    tid: "0000HP1X", mid: "000000004977890", batchNo: "494",
    openedAt: parseSlipTimestamp("2026/08/26 18:50:04"),
    closedAt: parseSlipTimestamp("2026/08/27 18:50:04"),
    printedAt: parseSlipTimestamp("2026/08/28 08:52:38"),
    txnCount: 3,
    purchasesCents: 100000, cashCents: 0, refundsCents: 5000, totalCents: 95000,
    confidence: { ...CONF },
    lines: [
      { tsn: 101, amountCents: 40000, at: 1, pan: "****1111" },
      { tsn: 102, amountCents: 60000, at: 2, pan: "****2222" },
      { tsn: 103, amountCents: -5000, at: 3, pan: "****3333", type: "refund" },
    ],
    ...overrides,
  };
}

test("a clean extraction passes with no warnings", () => {
  const v = validateExtraction(goodExtraction());
  assert.equal(v.ok, true);
  assert.deepEqual(v.warnings, []);
});

test("low confidence on a key field is a refusal, not a guess", () => {
  const v = validateExtraction(goodExtraction({ confidence: { ...CONF, totalCents: 0.4 } }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /card TOTAL/);
});

test("slip arithmetic must hold: purchases + cash − refunds = total", () => {
  const v = validateExtraction(goodExtraction({ totalCents: 90000 }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /don't add up/);
});

test("cash category participates in the slip arithmetic", () => {
  const v = validateExtraction(goodExtraction({ cashCents: 5000, totalCents: 100000 }));
  assert.equal(v.ok, true);
});

test("line count must equal the printed Transactions figure — no silent partial capture", () => {
  const ex = goodExtraction();
  ex.lines = ex.lines.slice(0, 2);
  const v = validateExtraction(ex);
  assert.equal(v.ok, false);
  assert.match(v.reason, /3 transactions but 2 lines/);
});

test("a TSN gap is a refusal", () => {
  const ex = goodExtraction();
  ex.lines[1].tsn = 105; // 101, 105, 103 → gaps
  const v = validateExtraction(ex);
  assert.equal(v.ok, false);
  assert.match(v.reason, /not contiguous/);
});

test("Closed must be after Opened", () => {
  const v = validateExtraction(goodExtraction({ closedAt: parseSlipTimestamp("2026/08/26 18:00:00") }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /Closed time/);
});

test("a garbled cash or refunds figure (null) is refused, never treated as zero", () => {
  const vCash = validateExtraction(goodExtraction({ cashCents: null }));
  assert.equal(vCash.ok, false);
  assert.match(vCash.reason, /cash figure/);
  const vRef = validateExtraction(goodExtraction({ refundsCents: null }));
  assert.equal(vRef.ok, false);
  assert.match(vRef.reason, /refunds figure/);
});

test("a window longer than 7 days is a misread date, refused before any ledger query", () => {
  const v = validateExtraction(goodExtraction({ openedAt: parseSlipTimestamp("2020/08/26 18:50:04") }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /longer than 7 days/);
});

test("the correction chain caps at MAX_REVISIONS", () => {
  const keys = ["494", ...Array.from({ length: 19 }, (_, i) => `494-r${i + 2}`)];
  const r = resolveBatchWrite({ existingKeys: keys, batchNo: "494", correction: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a correction chain/);
});

test("summary-only skips line checks but carries the flag warning", () => {
  const v = validateExtraction(goodExtraction({ lines: [] }), { summaryOnly: true });
  assert.equal(v.ok, true);
  assert.match(v.warnings[0], /Summary only/);
});

test("a line-sum mismatch on an otherwise consistent slip is a warning, not a rejection", () => {
  const ex = goodExtraction();
  ex.lines[0].amountCents = 39000; // sum 94000 ≠ 95000, slip totals still consistent
  const v = validateExtraction(ex);
  assert.equal(v.ok, true);
  assert.match(v.warnings[0], /sum to R940\.00.*slip total is R950\.00/);
});

// ── record builder ───────────────────────────────────────────────────────────
test("buildBatchRecord derives variance and never accepts a typed total", () => {
  const ex = goodExtraction();
  const rec = buildBatchRecord({
    extraction: ex,
    terminal: { storeId: "pe", tillId: "till-1", label: "PE Till 1" },
    tid: "0000HP1X", batchKey: "494", revision: 1, supersedes: null,
    photoPaths: ["cardRecon/d1/photo-0.jpg"],
    summaryOnly: false, warnings: [],
    expected: { cardCents: 96000, legs: 4, byKind: { sale: 4 } },
    cashiers: [{ uid: "u1", name: "Ikraan", firstAt: 1, lastAt: 2, legs: 3 }],
    submittedBy: { uid: "u9", name: "manager@marathon.internal" },
    submittedAt: 1787000000000, draftId: "d1",
    ocr: { model: "gemini-3.6-flash", costUSD: 0.001 },
  });
  assert.equal(rec.varianceCents, 95000 - 96000);
  assert.equal(rec.slip.totalCents, 95000);
  assert.equal(rec.linesCaptured, true);
  assert.equal(rec.lineCount, 3);
  assert.equal(rec.lines["103"].type, "refund");
  assert.equal(rec.expected.windowStartMs, ex.openedAt);
  assert.equal(rec.batchNo, 494);
  // Append-only evidence: the record has no field a client could have typed a
  // total into — every money figure sits under slip/ or expected/.
  assert.equal(Object.keys(rec).some((k) => /manual|typed|entered/i.test(k)), false);
});

test("summary-only record nulls lines and flags itself", () => {
  const rec = buildBatchRecord({
    extraction: goodExtraction({ lines: [] }),
    terminal: { storeId: "pe", tillId: "till-2" },
    tid: "0000HP2X", batchKey: "12", revision: 1, supersedes: null,
    photoPaths: ["cardRecon/d2/photo-0.jpg"], summaryOnly: true,
    warnings: ["Summary only"], expected: { cardCents: 95000, legs: 1, byKind: {} },
    cashiers: [], submittedBy: { uid: "u9" }, submittedAt: 1, draftId: "d2",
  });
  assert.equal(rec.lines, null);
  assert.equal(rec.linesCaptured, false);
  assert.equal(rec.lineCount, 0);
  assert.equal(rec.varianceCents, 0);
});

// ─── THE VARIANCE IS WHAT THE MATCH COULD NOT ACCOUNT FOR ────────────────────
// Not the till-scoped subtraction. A card machine that spent the morning at
// another shop had its sales rung on that shop's till, and the subtraction
// called R3,500 of good takings missing while saying nothing about which.
test("buildBatchRecord takes its variance from the MATCH, not the till subtraction", () => {
  const ex = goodExtraction();                       // slip total 95000
  const base = {
    extraction: ex,
    terminal: { storeId: "pe", tillId: "till-1", label: "PE Till 1" },
    tid: "0000HP1X", batchKey: "494", revision: 1, supersedes: null,
    photoPaths: [], summaryOnly: false, warnings: [],
    // The till itself only saw 60000 of it — the rest was rung elsewhere.
    expected: { cardCents: 60000, legs: 2, byKind: {} },
    cashiers: [], submittedBy: { uid: "u9" }, submittedAt: 1, draftId: "d1", ocr: null,
  };
  const rec = buildBatchRecord({
    ...base,
    match: {
      matches: [{}, {}, {}], matchedCents: 95000,
      onTillCents: 60000, offTillCents: 35000,
      offTill: { "trophy/till-1": { legs: 1, cents: 35000 } },
      unmatchedTxns: [], unmatchedTxnCents: 0,
      unmatchedLegsOnTill: [], unmatchedLegCents: 0,
    },
  });
  assert.equal(rec.varianceCents, 0, "everything was accounted for, so nothing is missing");
  assert.equal(rec.varianceOnTillCents, 95000 - 60000,
    "…and the old subtraction is kept, so batches stay comparable");
  assert.equal(rec.match.offTillCents, 35000);
  assert.deepEqual(rec.match.offTill, { "trophy/till-1": { legs: 1, cents: 35000 } },
    "the record says WHERE, so a moved machine reads as information");
});

test("…and the variance IS the unmatched transactions", () => {
  const ex = goodExtraction();                       // slip total 95000
  const rec = buildBatchRecord({
    extraction: ex,
    terminal: { storeId: "pe", tillId: "till-1" },
    tid: "0000HP1X", batchKey: "494", revision: 1, supersedes: null,
    photoPaths: [], summaryOnly: false, warnings: [],
    expected: { cardCents: 88000, legs: 3, byKind: {} },
    match: {
      matches: [{}, {}], matchedCents: 88000, onTillCents: 88000, offTillCents: 0, offTill: {},
      unmatchedTxns: [{ tsn: 7 }], unmatchedTxnCents: 7000,
      // A card sale the machine has no record of. A DIFFERENT question, and it
      // must not cancel against the 7000.
      unmatchedLegsOnTill: [{}], unmatchedLegCents: 5000,
    },
    cashiers: [], submittedBy: { uid: "u9" }, submittedAt: 1, draftId: "d1", ocr: null,
  });
  assert.equal(rec.varianceCents, 7000, "money on the machine that no sale accounts for");
  assert.equal(rec.match.unmatchedLegCents, 5000, "…reported apart from the sale with no machine record");
  assert.notEqual(rec.varianceCents, 2000, "the two findings must never be netted together");
});

test("with no match at all the old subtraction still stands", () => {
  // A summary-only capture has no transactions to match, so there is nothing
  // better than the till-scoped figure.
  const rec = buildBatchRecord({
    extraction: goodExtraction({ lines: [] }),
    terminal: { storeId: "pe", tillId: "till-2" },
    tid: "0000HP2X", batchKey: "12", revision: 1, supersedes: null,
    photoPaths: [], summaryOnly: true, warnings: [],
    expected: { cardCents: 90000, legs: 1, byKind: {} },
    cashiers: [], submittedBy: { uid: "u9" }, submittedAt: 1, draftId: "d2", ocr: null,
  });
  assert.equal(rec.match, null);
  assert.equal(rec.varianceCents, 95000 - 90000);
  assert.equal(rec.varianceOnTillCents, 95000 - 90000);
});

// ─── THE SUMMARY SETTLES IT FIRST ────────────────────────────────────────────
// If the terminal's total and the till's card total agree, the batch is done
// and the transactions are never walked. Recorded as `reconciledBy: "totals"`
// so a clean batch is visibly clean rather than merely silent.
test("a batch whose totals agree is settled by the summary alone", () => {
  const rec = buildBatchRecord({
    extraction: goodExtraction(),                    // slip total 95000
    terminal: { storeId: "pe", tillId: "till-1" },
    tid: "0000HP1X", batchKey: "494", revision: 1, supersedes: null,
    photoPaths: [], summaryOnly: false, warnings: [],
    expected: { cardCents: 95000, legs: 3, byKind: {} },
    match: null, reconciledByTotals: true,
    cashiers: [], submittedBy: { uid: "u9" }, submittedAt: 1, draftId: "d1", ocr: null,
  });
  assert.equal(rec.reconciledBy, "totals");
  assert.equal(rec.varianceCents, 0);
  assert.equal(rec.match, null, "no catalogue was read");
});

test("a batch whose totals disagree is settled by the match", () => {
  const rec = buildBatchRecord({
    extraction: goodExtraction(),                    // slip total 95000
    terminal: { storeId: "pe", tillId: "till-1" },
    tid: "0000HP1X", batchKey: "494", revision: 1, supersedes: null,
    photoPaths: [], summaryOnly: false, warnings: [],
    expected: { cardCents: 60000, legs: 2, byKind: {} },
    match: {
      matches: [{}, {}, {}], matchedCents: 95000, onTillCents: 60000, offTillCents: 35000,
      offTill: { "trophy/till-1": { legs: 1, cents: 35000 } },
      unmatchedTxns: [], unmatchedTxnCents: 0,
      unmatchedLegsOnTill: [], unmatchedLegCents: 0,
    },
    reconciledByTotals: false,
    cashiers: [], submittedBy: { uid: "u9" }, submittedAt: 1, draftId: "d1", ocr: null,
  });
  assert.equal(rec.reconciledBy, "match", "the summaries disagreed, so the catalogue was read");
  assert.equal(rec.varianceCents, 0, "…and it explained the difference: the machine had moved");
  assert.equal(rec.match.offTillCents, 35000);
});

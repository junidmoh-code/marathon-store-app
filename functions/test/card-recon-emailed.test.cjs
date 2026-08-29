// ─── THE BANK'S EMAILED BANKING REPORT ───────────────────────────────────────
// The second PDF format. Same batch, stated differently — and two of those
// differences change what the CHECKS may conclude, which is what most of this
// file is about. See the block comment above parseEmailedReport.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseSlipPdf, detectReportFormat, tidy,
} = require("../lib/card-recon-pdf.cjs");
const { validateExtraction, checkTsnContiguity } = require("../lib/card-recon.cjs");
const { emailedLines, slipLines, REAL_TSNS, makeSlipPdf, makeSlipPdfFragmented } = require("./fixtures/makeSlipPdf.cjs");
const { pdfToLines } = require("../cardRecon/pdfText.js");

const rowsOf = (lines) => lines.map(tidy).filter(Boolean);
const parse = (lines) => parseSlipPdf(lines);

// ── FORMAT DETECTION ─────────────────────────────────────────────────────────
test("the two formats are told apart before either is read", () => {
  assert.equal(detectReportFormat(rowsOf(emailedLines().lines)), "emailed");
  assert.equal(detectReportFormat(rowsOf(slipLines())), "printed");
});

test("a banking report is still recognised without its title line", () => {
  // "APPROVED TRANSACTIONS" + "Items:" are marks the printed slip never carries.
  const lines = emailedLines().lines.filter((l) => !/^Banking Report/.test(l));
  assert.equal(detectReportFormat(rowsOf(lines)), "emailed");
  const out = parse(lines);
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.extraction.tid, "67365901", "the Terminal: row carries it when the title is gone");
  assert.equal(out.extraction.batchNo, "59");
});

test("a PDF in NEITHER format is refused, and the refusal says so", () => {
  const out = parse(["AN INVOICE", "Bill to: someone", "Amount due R400.00", "Thank you"]);
  assert.equal(out.ok, false);
  assert.match(out.reason, /neither a terminal batch slip nor an emailed banking report/);
  assert.match(out.reason, /photograph the slip/);
});

// ── READING IT ───────────────────────────────────────────────────────────────
test("the real report's shape reads exactly", () => {
  const { truth, lines } = emailedLines();
  const out = parse(lines);
  assert.equal(out.ok, true, out.reason);
  const ex = out.extraction;
  assert.equal(ex.format, "emailed");
  assert.equal(ex.tid, "67365901");
  assert.equal(ex.batchNo, "59");
  assert.equal(ex.txnCount, 40, 'the count comes from "Items:", not "Transactions"');
  assert.equal(ex.lines.length, 40);
  assert.equal(ex.mid, "000000004977890");
  assert.equal(ex.purchasesCents, truth.purchasesCents);
  assert.equal(ex.totalCents, truth.totalCents);
  assert.equal(ex.lines.reduce((a, l) => a + l.amountCents, 0), truth.totalCents);
});

test("ZAR amounts read as rands, and a mangled one still refuses", () => {
  const { lines } = emailedLines();
  assert.equal(parse(lines).extraction.totalCents % 100, 0);
  // The strictness is unchanged by the new currency mark.
  const bad = lines.map((l) => l.replace(/^Total   ZAR ([\d,]+)\.00$/, "Total   ZAR $1O.00"));
  const out = parse(bad);
  assert.equal(out.ok, false, "a letter O in the total must refuse, ZAR or R");
});

test("the Batch column is not mistaken for the TSN", () => {
  // Its columns are …TSN, Batch, PAN…, so "the last integer before the PAN"
  // would take the batch number off all forty rows: forty identical TSNs.
  const { lines } = emailedLines({ batchColumn: true });
  const ex = parse(lines).extraction;
  assert.deepEqual(ex.lines.map((l) => l.tsn), REAL_TSNS);
  assert.notEqual(ex.lines[0].tsn, 59, "that is the batch number, not a sequence number");
});

test("…and a report WITHOUT a batch column reads its TSNs just as well", () => {
  const { lines } = emailedLines({ batchColumn: false });
  const ex = parse(lines).extraction;
  assert.deepEqual(ex.lines.map((l) => l.tsn), REAL_TSNS);
});

test("a refund row is signed negative and folds into the totals", () => {
  const { truth, lines } = emailedLines({ refundTsns: [7] });
  const ex = parse(lines).extraction;
  const refundLine = ex.lines.find((l) => l.tsn === 7);
  assert.equal(refundLine.type, "refund");
  assert.ok(refundLine.amountCents < 0);
  assert.equal(ex.refundsCents, truth.refundsCents, "recorded as a positive magnitude by contract");
  assert.equal(ex.lines.reduce((a, l) => a + l.amountCents, 0), truth.totalCents);
});

test("the title and the labelled rows must agree about the terminal", () => {
  const lines = emailedLines().lines.map((l) => l.replace(/^Terminal: 67365901$/, "Terminal: 67365902"));
  const out = parse(lines);
  assert.equal(out.ok, false, "two different terminals on one report must not be chosen between");
  assert.match(out.reason, /title says terminal/);
});

test("…and about the batch number", () => {
  const lines = emailedLines().lines.map((l) => l.replace(/^Batch: 59$/, "Batch: 60"));
  const out = parse(lines);
  assert.equal(out.ok, false);
  assert.match(out.reason, /title says batch/);
});

// ── CHECK 1: TSN CONTIGUITY IS FORMAT-DEPENDENT ──────────────────────────────
test("the real report's TSN gaps are NOT a refusal — they are expected", () => {
  // 2,3,4 then no 5; 21-24, 30-31, 33-34 and 43 absent. This report lists
  // approved transactions only, so a decline simply is not there.
  assert.equal(checkTsnContiguity(REAL_TSNS).ok, false, "the sequence genuinely has gaps");
  const ex = parse(emailedLines().lines).extraction;
  const v = validateExtraction(ex, { source: "pdf" });
  assert.equal(v.ok, true, `a banking report was refused for its gaps: ${v.reason}`);
  assert.ok(v.warnings.some((w) => /not in this report/.test(w)), "the gaps are still stated, not hidden");
  assert.ok(v.warnings.some((w) => /approved transactions only/.test(w)), "…and explained");
});

test("the SAME gap on a printed slip is still a refusal", () => {
  // The printed roll shows every attempt, so there a gap means a missed line —
  // the one thing this feature exists to catch. Keeping that is the point.
  const ex = parse(slipLines()).extraction;
  Object.assign(ex, {
    lines: [
      { tsn: 1, amountCents: 1000, at: ex.openedAt + 1 },
      { tsn: 3, amountCents: 1000, at: ex.openedAt + 2 },
    ],
    txnCount: 2, purchasesCents: 2000, totalCents: 2000, refundsCents: 0, cashCents: 0,
  });
  const v = validateExtraction(ex, { source: "pdf" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /not contiguous/);
  assert.match(v.reason, /TSN 2 is missing/);
});

test("a DUPLICATE TSN is refused in both formats — a repeat is never expected", () => {
  for (const format of ["emailed", "printed"]) {
    const ex = parse(format === "emailed" ? emailedLines().lines : slipLines()).extraction;
    Object.assign(ex, {
      lines: [
        { tsn: 5, amountCents: 1000, at: ex.openedAt + 1 },
        { tsn: 5, amountCents: 1000, at: ex.openedAt + 2 },
      ],
      txnCount: 2, purchasesCents: 2000, totalCents: 2000, refundsCents: 0, cashCents: 0,
    });
    const v = validateExtraction(ex, { source: "pdf" });
    assert.equal(v.ok, false, `${format}: a duplicate TSN must refuse`);
    assert.match(v.reason, /repeat/);
  }
});

// ── CHECK 2: THE WINDOW IS DERIVED, AND SAYS SO ──────────────────────────────
test("the window is the span of the transactions, and is marked as derived", () => {
  const ex = parse(emailedLines().lines).extraction;
  const times = ex.lines.map((l) => l.at);
  assert.equal(ex.windowSource, "transactions");
  assert.equal(ex.openedAt, Math.min(...times), "the window opens at the first transaction");
  assert.equal(ex.closedAt, Math.max(...times) + 1, "…and closes one ms after the last");
  assert.equal(ex.openedText, null, "this format prints no Opened line");
  assert.equal(ex.closedText, null, "…and no Closed line");
});

test("the closing +1ms is load-bearing: the window is half-open", () => {
  // [start, end) — a batch's closing instant belongs to the NEXT batch. Without
  // the millisecond the LAST transaction of this batch falls outside its own
  // window, and its till leg would never be counted.
  const ex = parse(emailedLines().lines).extraction;
  const last = Math.max(...ex.lines.map((l) => l.at));
  assert.ok(last >= ex.openedAt && last < ex.closedAt,
    "the last transaction must fall inside the window derived from it");
});

test("a printed slip keeps its declared window and is marked as such", () => {
  const ex = parse(slipLines()).extraction;
  assert.equal(ex.windowSource, "printed");
  assert.equal(ex.openedText, "2026/08/26 18:50:04");
});

test("a single-transaction report still yields a usable window", () => {
  const { lines } = emailedLines({ tsns: [7] });
  const ex = parse(lines).extraction;
  assert.equal(ex.closedAt, ex.openedAt + 1, "one transaction is still a window, not a zero-width one");
  assert.equal(validateExtraction(ex, { source: "pdf" }).ok, true);
});

test("transactions spanning more than 7 days are refused, without mentioning a header", () => {
  const { lines } = emailedLines();
  const stretched = lines.map((l) => l.replace(/^2026\/08\/27 (2[0-9]|1[0-9]):/, "2026/09/27 $1:"));
  assert.ok(stretched.some((l, i) => l !== lines[i]), "the fixture edit did nothing — this test proves nothing");
  const out = parse(stretched);
  assert.equal(out.ok, true, `the READ should succeed; the window check is what refuses: ${out.reason}`);
  const v = validateExtraction(out.extraction, { source: "pdf" });
  assert.equal(v.ok, false, "a month-long span is not one batch");
  assert.match(v.reason, /more than 7 days/);
  // A report that prints no header must never be told to re-photograph one.
  assert.doesNotMatch(v.reason, /header/i);
  assert.doesNotMatch(v.reason, /Opened/);
});

// ── EVERYTHING ELSE HOLDS ────────────────────────────────────────────────────
test("the line count is checked against the printed Items figure", () => {
  const { lines } = emailedLines();
  const wrong = lines.map((l) => (/^Items: 40$/.test(l) ? "Items: 41" : l));
  const out = parse(wrong);
  assert.equal(out.ok, true, out.reason);
  const v = validateExtraction(out.extraction, { source: "pdf" });
  assert.equal(v.ok, false, "41 items and 40 rows must refuse");
  assert.match(v.reason, /41 transactions but 40 lines/);
});

test("arithmetic that does not hold is refused", () => {
  const { lines } = emailedLines();
  const wrong = lines.map((l) => l.replace(/^Total   ZAR 43,800\.00$/, "Total   ZAR 43,900.00"));
  const out = parse(wrong);
  assert.equal(out.ok, true, out.reason);
  assert.equal(validateExtraction(out.extraction, { source: "pdf" }).ok, false);
});

test("lines that do not sum to the printed total are refused on this format too", () => {
  const { lines } = emailedLines();
  // Move R10 from one row into both the purchases and total figures, so the
  // slip's own arithmetic still holds but the rows no longer add up to it.
  const wrong = lines.map((l) => l
    .replace(/^Purchases   ZAR 43,800\.00$/, "Purchases   ZAR 43,810.00")
    .replace(/^Total   ZAR 43,800\.00$/, "Total   ZAR 43,810.00"));
  const out = parse(wrong);
  assert.equal(out.ok, true, out.reason);
  const v = validateExtraction(out.extraction, { source: "pdf" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /read exactly/);
});

test("a banking report is never summary-only — one file is the whole report", () => {
  const ex = parse(emailedLines().lines).extraction;
  assert.ok(ex.lines.length > 0);
  assert.equal(validateExtraction(ex, { source: "pdf" }).ok, true);
});

// ── THROUGH A REAL PDF, NOT JUST AN ARRAY OF STRINGS ──────────────────────────
test("the whole thing survives a real PDF's fragment-and-position round trip", async () => {
  const { truth, lines } = emailedLines();
  const t = await pdfToLines(makeSlipPdf(lines));
  assert.equal(t.ok, true, t.reason);
  const out = parseSlipPdf(t.lines);
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.extraction.tid, "67365901");
  assert.equal(out.extraction.totalCents, truth.totalCents);
  assert.equal(out.extraction.lines.length, 40);
  assert.deepEqual(out.extraction.lines.map((l) => l.tsn), REAL_TSNS);
});

test("one TSN that happens to equal the batch number is not a batch column", () => {
  // The layout is decided across ALL rows for exactly this reason. A report
  // with no batch column, one of whose TSNs coincidentally equals the batch
  // number, must not be read as though every row carried one — that would take
  // the RRN as the TSN on all of them.
  const tsns = [57, 58, 59, 61];               // 59 is also the batch number
  const { lines } = emailedLines({ batchColumn: false, batchNo: 59, tsns });
  const out = parse(lines);
  assert.equal(out.ok, true, out.reason);
  assert.deepEqual(out.extraction.lines.map((l) => l.tsn), tsns,
    "a single coincidence must not decide the layout for every row");
});

// ─── DECIDING THE LAYOUT WITH VERY LITTLE EVIDENCE ───────────────────────────
// "Every row carries the batch number" is not enough on its own: over a SINGLE
// row it is satisfied the moment that row's TSN happens to equal the batch
// number. A batch column also ADDS an integer, and that is the condition that
// carries the one-row case.
const LAYOUTS = [
  ["one row, no batch column, its TSN equals the batch", { batchColumn: false, batchNo: 59, tsns: [59] }, [59]],
  ["one row, with a batch column", { batchColumn: true, batchNo: 59, tsns: [7] }, [7]],
  ["one row, no batch column, ordinary TSN", { batchColumn: false, batchNo: 59, tsns: [7] }, [7]],
  ["many rows, no column, one coincidence", { batchColumn: false, batchNo: 59, tsns: [57, 58, 59, 61] }, [57, 58, 59, 61]],
  ["many rows, with a batch column", { batchColumn: true, batchNo: 59, tsns: [4, 9, 11] }, [4, 9, 11]],
  // A SHORT RRN puts two candidate integers before the PAN with no batch
  // column present, so the count alone cannot decide — only the batch number
  // itself separates "TSN then Batch" from "RRN then TSN".
  ["short RRN, no batch column", { batchColumn: false, shortRrn: true, batchNo: 59, tsns: [4, 9, 11] }, [4, 9, 11]],
  ["short RRN, with a batch column", { batchColumn: true, shortRrn: true, batchNo: 59, tsns: [4, 9, 11] }, [4, 9, 11]],
  ["short RRN, one row, TSN equals the batch", { batchColumn: false, shortRrn: true, batchNo: 59, tsns: [59] }, [59]],
  // Terminals print different column sets, and both directions matter here.
  // An EXTRA alphanumeric column makes a one-row report reach five tokens
  // without a second integer — the token count alone would call that a batch
  // column and then find no sequence number at all.
  ["an extra column, one row, TSN equals the batch",
    { batchColumn: false, extraColumn: true, batchNo: 59, tsns: [59] }, [59]],
  // A MISSING column takes a genuine batch-column report down to four tokens —
  // demanding five of every report would then read the batch number as the TSN.
  ["a missing UTI column, with a batch column",
    { batchColumn: true, noUti: true, batchNo: 59, tsns: [4, 9, 11] }, [4, 9, 11]],
  ["a missing UTI column, no batch column",
    { batchColumn: false, noUti: true, batchNo: 59, tsns: [4, 9, 11] }, [4, 9, 11]],
];
for (const [name, opts, expected] of LAYOUTS) {
  test(`the TSNs are read correctly: ${name}`, () => {
    const out = parse(emailedLines(opts).lines);
    assert.equal(out.ok, true, `a legitimate report was refused: ${out.reason}`);
    assert.deepEqual(out.extraction.lines.map((l) => l.tsn), expected);
  });
}

test("…and survives a PDF whose fragments arrive shuffled", async () => {
  // The emailed report goes through the same line reassembly as the printed
  // slip, and it has MORE columns per row — so a lost left-to-right sort would
  // scramble the row into a different reading rather than failing outright.
  const { truth, lines } = emailedLines();
  const t = await pdfToLines(makeSlipPdfFragmented(lines, { seed: 31 }));
  assert.equal(t.ok, true, t.reason);
  const out = parseSlipPdf(t.lines);
  assert.equal(out.ok, true, out.reason);
  const ex = out.extraction;
  assert.equal(ex.format, "emailed");
  assert.equal(ex.tid, "67365901");
  assert.equal(ex.batchNo, "59");
  assert.equal(ex.txnCount, 40);
  assert.equal(ex.totalCents, truth.totalCents);
  assert.equal(ex.purchasesCents, truth.purchasesCents);
  assert.deepEqual(ex.lines.map((l) => l.tsn), REAL_TSNS);
  assert.equal(ex.lines.reduce((a, l) => a + l.amountCents, 0), truth.totalCents);
  assert.equal(validateExtraction(ex, { source: "pdf" }).ok, true);
});

test("row order does not affect the derived window", () => {
  // The window is min/max of the transaction times, so a report printed newest
  // first must produce the same window as one printed oldest first. Cheap to
  // assert, and the alternative (first row to last row) would look correct on
  // every fixture written in reading order.
  const { truth, lines } = emailedLines();
  const isTxn = (x) => /^20\d\d\//.test(x);
  const reversed = lines.filter(isTxn).reverse();
  let k = 0;
  const out = parse(lines.map((x) => (isTxn(x) ? reversed[k++] : x)));
  assert.equal(out.ok, true, out.reason);
  const ex = out.extraction;
  const times = ex.lines.map((l) => l.at);
  assert.equal(ex.openedAt, Math.min(...times));
  assert.equal(ex.closedAt, Math.max(...times) + 1);
  assert.equal(ex.totalCents, truth.totalCents);
  assert.equal(validateExtraction(ex, { source: "pdf" }).ok, true);
});

test("a batch crossing midnight is one window, not two days", () => {
  const { lines } = emailedLines();
  const crossed = lines.map((x) => (/^20\d\d\//.test(x) ? x.replace(/^2026\/08\/27 (2[0-3]):/, "2026/08/28 0$1:") : x));
  const out = parse(crossed);
  assert.equal(out.ok, true, out.reason);
  const hours = (out.extraction.closedAt - out.extraction.openedAt) / 3600000;
  assert.ok(hours > 0 && hours < 24, `a batch over midnight came out as ${hours}h`);
  assert.equal(validateExtraction(out.extraction, { source: "pdf" }).ok, true);
});

// ─── A CARD NUMBER PRINTED IN GROUPS ─────────────────────────────────────────
// "4111 11** **** 1111" rather than "************1111". Only the middle groups
// carry mask characters, so the leading "4111" sits exactly where a sequence
// number would — and was read as one, putting the batch number in the TSN.
// Which style FNB uses could not be confirmed without the real file, so both
// are handled; the absorption only fires when two or more tokens carry masks,
// which leaves an unsplit number byte-identical.
for (const opts of [{ batchColumn: true }, { batchColumn: false }]) {
  test(`a grouped card number does not shift the columns (batch column: ${opts.batchColumn})`, () => {
    const { truth, lines } = emailedLines({ ...opts, groupedPan: true, tsns: [4, 9, 11] });
    const out = parse(lines);
    assert.equal(out.ok, true, out.reason);
    assert.deepEqual(out.extraction.lines.map((l) => l.tsn), [4, 9, 11],
      "the leading group of a split card number is not a sequence number");
    assert.equal(out.extraction.totalCents, truth.totalCents);
    assert.ok(/\*/.test(out.extraction.lines[0].pan), "…and the card number is still captured");
    assert.match(out.extraction.lines[0].pan, /^4111 .* \d{4}$/, "…whole, not just its middle");
  });
}

test("two Items counts that disagree are refused, not chosen between", () => {
  // The report prints the count twice — under APPROVED TRANSACTIONS and again
  // under TOTALS SUMMARY. It is the figure the line-count check measures a
  // missed row against, so preferring one silently would defeat that check
  // rather than trip it. The money fields already refuse on disagreement.
  const { lines } = emailedLines();
  assert.equal(lines.filter((l) => /^Items: /.test(l)).length, 2, "the fixture must print it twice");
  let seen = 0;
  const wrong = lines.map((l) => (/^Items: /.test(l) && seen++ === 1 ? "Items: 39" : l));
  const out = parse(wrong);
  assert.equal(out.ok, false);
  assert.match(out.reason, /Items count more than once/);
  assert.match(out.reason, /40 and 39/);
});

test("…but the same count printed twice is not a disagreement", () => {
  const out = parse(emailedLines().lines);
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.extraction.txnCount, 40);
});

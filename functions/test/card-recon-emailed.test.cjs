// ─── THE BANK'S EMAILED BANKING REPORT ───────────────────────────────────────
// The second PDF format. Same batch, stated differently — and two of those
// differences change what the CHECKS may conclude, which is what most of this
// file is about. See the block comment above parseEmailedReport.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseSlipPdf, detectReportFormat, tidy, TXN_RE,
} = require("../lib/card-recon-pdf.cjs");
const { validateExtraction, checkTsnContiguity, parseRandsToCents } = require("../lib/card-recon.cjs");
const {
  emailedLines, slipLines, REAL_TSNS, makeSlipPdf, makeSlipPdfFragmented,
  realReportLines, REAL_REPORT, FNB_FURNITURE, makeSlipPdfPaged,
} = require("./fixtures/makeSlipPdf.cjs");
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

// ═══ THE REAL REPORT ═════════════════════════════════════════════════════════
// Till2FNB-Txn-Notification.pdf: batch 59, terminal 67365901, 40 items,
// ZAR 30120.00, first 09:07:23 / ZAR 900.00 / TSN 2, last 16:09:09 /
// ZAR 350.00 / TSN 51 — the owner's figures, read off the file.
//
// SEVEN PAGES, with FNB's address block and page footers interleaved BETWEEN
// the transactions. That furniture carries money labels followed by digits
// ("Total pages 7", "Refunds enquiries 0860 12 34 56"), and it is what broke
// the first version of this reader: the figure search fell back to the whole
// document and read a footer as the refunds total, refusing the report.

test("the real report's own figures, end to end", () => {
  const { lines } = realReportLines();
  const out = parse(lines);
  assert.equal(out.ok, true, `the real report was REFUSED: ${out.reason}`);
  const ex = out.extraction;

  assert.equal(ex.format, "emailed");
  assert.equal(ex.tid, REAL_REPORT.tid, "terminal");
  assert.equal(ex.batchNo, String(REAL_REPORT.batchNo), "batch");
  assert.equal(ex.txnCount, REAL_REPORT.items, "the printed Items count");
  assert.equal(ex.lines.length, REAL_REPORT.items, "…and the rows actually read");
  assert.equal(ex.totalCents, REAL_REPORT.totalCents, "ZAR 30120.00");
  assert.equal(ex.lines.reduce((a, l) => a + l.amountCents, 0), REAL_REPORT.totalCents,
    "the rows must sum to the printed total");

  const first = ex.lines[0], last = ex.lines.at(-1);
  assert.equal(first.tsn, REAL_REPORT.firstTsn);
  assert.equal(first.time, REAL_REPORT.firstTime);
  assert.equal(first.amountCents, REAL_REPORT.firstCents);
  assert.equal(last.tsn, REAL_REPORT.lastTsn);
  assert.equal(last.time, REAL_REPORT.lastTime);
  assert.equal(last.amountCents, REAL_REPORT.lastCents);

  const v = validateExtraction(ex, { source: "pdf" });
  assert.equal(v.ok, true, `the real report failed validation: ${v.reason}`);
});

test("the real report has NO purchases figure distinct from its total", () => {
  // Both blocks print Purchase and Total as the same figure, and there is no
  // Payment Type Summary. The arithmetic (purchases + cash − refunds = total)
  // therefore holds with refunds and cash absent, which is what makes this
  // shape acceptable rather than a special case.
  const { lines } = realReportLines();
  const ex = parse(lines).extraction;
  assert.equal(ex.purchasesCents, ex.totalCents, "purchase equals total on this report");
  assert.equal(ex.refundsCents, 0, "no refunds line, so zero — not a refusal");
  assert.equal(ex.cashCents, 0, "no cash line either");
  assert.equal(ex.purchasesCents + ex.cashCents - ex.refundsCents, ex.totalCents);
  assert.ok(!lines.some((l) => /payment type summary/i.test(l)), "this format has no PTS block");
});

test("page furniture between transactions is not read as a figure", () => {
  // Each of these sat mid-roll in the real document. Every one carries a money
  // label followed by digits, and every one must be walked past.
  const { lines } = realReportLines();
  const furniture = FNB_FURNITURE(3);
  assert.ok(furniture.some((l) => /^Total pages/.test(l)), "the fixture must carry the poisonous lines");
  assert.ok(furniture.some((l) => /^Refunds enquiries/.test(l)));

  const ex = parse(lines).extraction;
  assert.equal(ex.refundsCents, 0, '"Refunds enquiries 0860 12 34 56" is not a refunds figure');
  assert.equal(ex.totalCents, REAL_REPORT.totalCents, '"Total pages 7" is not a total');

  // …and none of it became a transaction row.
  assert.equal(ex.lines.length, REAL_REPORT.items);
  const furnitureCount = lines.filter((l) => furniture.includes(l)).length;
  assert.ok(furnitureCount > 20, `only ${furnitureCount} furniture lines — the fixture is not interleaved`);
});

test("furniture is survived wherever it lands, including inside the totals blocks", () => {
  const { lines } = realReportLines();
  const spots = [
    0,
    lines.findIndex((l) => /^2026\//.test(l)) + 1,
    lines.findIndex((l) => /^TOTALS SUMMARY/.test(l)) + 1,
    lines.findIndex((l) => /^CARD TOTALS/.test(l)) + 1,
    lines.length,
  ];
  for (const spot of spots) {
    for (const junk of ["Total pages 7", "Refunds enquiries 0860 12 34 56", "Cash enquiries 0860 12 34 56", "Purchase queries 0860 12 34 56", "Page 4 of 7"]) {
      const poisoned = lines.slice();
      poisoned.splice(spot, 0, junk);
      const out = parse(poisoned);
      assert.equal(out.ok, true, `"${junk}" at ${spot} refused the report: ${out.reason}`);
      assert.equal(out.extraction.totalCents, REAL_REPORT.totalCents, `"${junk}" at ${spot} moved the total`);
      assert.equal(out.extraction.refundsCents, 0, `"${junk}" at ${spot} invented a refund`);
      assert.equal(out.extraction.lines.length, REAL_REPORT.items, `"${junk}" at ${spot} changed the row count`);
    }
  }
});

test("…but a real conflicting figure in the totals blocks is still refused", () => {
  // The furniture tolerance must not become tolerance for a second, DIFFERENT
  // total — that is the ambiguity this path refuses rather than choosing.
  const { lines } = realReportLines();
  const poisoned = lines.slice();
  poisoned.splice(lines.findIndex((l) => /^CARD TOTALS/.test(l)) + 1, 0, "Total   ZAR 0.00");
  const out = parse(poisoned);
  assert.equal(out.ok, false, "two different totals must not be chosen between");
  assert.match(out.reason, /appears twice/);
});

test("the real report survives a genuine SEVEN-PAGE PDF round trip", async () => {
  // Really seven pages, not one long one. The single-page writer silently loses
  // everything past about line sixty-six — it runs off the bottom of the
  // MediaBox — so a 112-line document came back as 67 and this test would have
  // been checking a truncated report. It also means pdfToLines' per-page
  // grouping is exercised: identical Y coordinates on different pages must not
  // collapse into one row.
  const { lines } = realReportLines();
  const t = await pdfToLines(makeSlipPdfPaged(lines, { perPage: 18 }));
  assert.equal(t.ok, true, t.reason);
  assert.equal(t.pages, 7, "the fixture must actually be seven pages");
  assert.equal(t.lines.length, lines.length, "no page may be dropped or merged");
  assert.equal(t.lines[0], lines[0], "…and the pages must come back in order");
  assert.equal(t.lines.at(-1), lines.at(-1));

  const out = parseSlipPdf(t.lines);
  assert.equal(out.ok, true, out.reason);
  const ex = out.extraction;
  assert.equal(ex.tid, REAL_REPORT.tid);
  assert.equal(ex.batchNo, String(REAL_REPORT.batchNo));
  assert.equal(ex.txnCount, REAL_REPORT.items);
  assert.equal(ex.totalCents, REAL_REPORT.totalCents);
  assert.equal(ex.refundsCents, 0);
  assert.equal(ex.lines.length, REAL_REPORT.items);
  assert.deepEqual(ex.lines.map((l) => l.tsn), REAL_TSNS);
  assert.equal(ex.lines[0].time, REAL_REPORT.firstTime);
  assert.equal(ex.lines.at(-1).time, REAL_REPORT.lastTime);
  assert.equal(ex.lines.reduce((a, l) => a + l.amountCents, 0), REAL_REPORT.totalCents);
  assert.equal(validateExtraction(ex, { source: "pdf" }).ok, true);
});

test("a per-page subtotal mid-document is not the batch total", () => {
  // A seven-page report can carry running figures in its furniture. These are
  // well-formed amounts, so `looksLikeAmount` cannot reject them — only the
  // totals region can, by not looking there at all. Without it these become a
  // second, different TOTAL and the whole report is refused as ambiguous.
  const { lines } = realReportLines();
  const at = lines.findIndex((l) => /^2026\//.test(l)) + 3;
  for (const junk of ["Total   ZAR 5,400.00", "Refunds   ZAR 0.00", "Purchase   ZAR 5,400.00", "Cash   ZAR 12.00"]) {
    const poisoned = lines.slice();
    poisoned.splice(at, 0, junk);
    const out = parse(poisoned);
    assert.equal(out.ok, true, `"${junk}" mid-roll refused the report: ${out.reason}`);
    assert.equal(out.extraction.totalCents, REAL_REPORT.totalCents, `"${junk}" moved the total`);
    assert.equal(out.extraction.refundsCents, 0, `"${junk}" invented a refund`);
    assert.equal(out.extraction.cashCents, 0, `"${junk}" invented a cash figure`);
  }
});

test("TOTALS SUMMARY and CARD TOTALS disagreeing is refused, not resolved", () => {
  // The two blocks state the same figures. If they ever disagree, something is
  // wrong with the report and choosing one is a guess — so the region begins at
  // whichever block comes FIRST, putting both in scope of the ambiguity rule.
  // Anchoring it to CARD TOTALS alone would silently prefer the later block.
  const { lines } = realReportLines();
  const summaryIdx = lines.findIndex((l) => /^TOTALS SUMMARY/.test(l));
  const cardIdx = lines.findIndex((l) => /^CARD TOTALS/.test(l));
  assert.ok(summaryIdx >= 0 && cardIdx > summaryIdx, "the fixture must print both blocks, summary first");

  const disagreeing = lines.slice();
  // Change the SUMMARY block's total only.
  disagreeing[summaryIdx + 2] = "Total   ZAR 29,000.00";
  const out = parse(disagreeing);
  assert.equal(out.ok, false, "two blocks disagreeing about the total must refuse");
  assert.match(out.reason, /appears twice/);
  assert.match(out.reason, /R29,000\.00/);
});

// ─── LABEL AND AMOUNT VARIATIONS THE REAL FILE MAY CARRY ─────────────────────
// The PDF is not in the repository, so these are the shapes it plausibly uses.
// Each must read the same figure — or, for the prose cases, no figure at all.
const TOTALS_SHAPES = {
  "as described":            (l) => l,
  "plural Purchases":        (l) => l.map((x) => x.replace(/^Purchase {3}/, "Purchases   ")),
  "a suffixed label":        (l) => l.map((x) => x.replace(/^(Purchase|Total) {3}/, "$1 Amount   ")),
  "colons after labels":     (l) => l.map((x) => x.replace(/^(Purchase|Total) {3}/, "$1: ")),
  "no space after ZAR":      (l) => l.map((x) => x.replace(/ZAR /g, "ZAR")),
  "R instead of ZAR":        (l) => l.map((x) => x.replace(/ZAR /g, "R")),
  "no currency mark at all": (l) => l.map((x) => x.replace(/ZAR /g, "")),
};
for (const [name, shape] of Object.entries(TOTALS_SHAPES)) {
  test(`the real report reads the same with ${name}`, () => {
    const out = parse(shape(realReportLines().lines));
    assert.equal(out.ok, true, `refused: ${out.reason}`);
    assert.equal(out.extraction.totalCents, REAL_REPORT.totalCents);
    assert.equal(out.extraction.purchasesCents, REAL_REPORT.totalCents);
    assert.equal(out.extraction.lines.length, REAL_REPORT.items, "the ROWS must still read too");
    assert.equal(out.extraction.lines[0].amountCents, REAL_REPORT.firstCents);
    assert.equal(out.extraction.lines.reduce((a, l) => a + l.amountCents, 0), REAL_REPORT.totalCents);
  });
}

test("a label suffix does not let prose back in", () => {
  // Accepting "Purchase Amount   ZAR 30120.00" must not also accept "Total
  // pages 7". The second attempt requires a STRICT amount — one carrying a
  // currency mark or its cents — with nothing but label words before it.
  const { lines } = realReportLines();
  for (const junk of ["Total pages 7", "Total for 7 pages ZAR 100.00", "Refunds enquiries 0860 12 34 56", "Purchase queries 0860 12 34 56"]) {
    const poisoned = lines.slice();
    poisoned.splice(lines.findIndex((l) => /^TOTALS SUMMARY/.test(l)) + 1, 0, junk);
    const out = parse(poisoned);
    assert.equal(out.ok, true, `"${junk}" refused the report: ${out.reason}`);
    assert.equal(out.extraction.totalCents, REAL_REPORT.totalCents, `"${junk}" moved the total`);
    assert.equal(out.extraction.refundsCents, 0, `"${junk}" invented a refund`);
  }
});

test("…and a mangled figure is still refused by name, not skipped", () => {
  const { lines } = realReportLines();
  const mangled = lines.map((l) => l.replace(/^Total {3}ZAR 30,?120\.00$/, "Total   ZAR 3O120.00"));
  assert.ok(mangled.some((l, i) => l !== lines[i]), "the fixture edit did nothing");
  const out = parse(mangled);
  assert.equal(out.ok, false);
  assert.match(out.reason, /not an amount this understands/);
});

test("a trailing number with ONE decimal is not an amount", () => {
  // The strict amount requires a currency mark or exactly two decimals. One
  // decimal is not a rand figure, but parseRandsToCents would happily read
  // "3.5" as R3.50 — so without the two-digit requirement a footer sentence
  // ending in a single-decimal number becomes a recorded figure.
  const { lines } = realReportLines();
  const at = lines.findIndex((l) => /^TOTALS SUMMARY/.test(l)) + 1;
  for (const junk of ["Refunds take up to 3.5", "Cash discount 2.5", "Purchase limit 9.9"]) {
    const poisoned = lines.slice();
    poisoned.splice(at, 0, junk);
    const out = parse(poisoned);
    assert.equal(out.ok, true, `"${junk}" refused the report: ${out.reason}`);
    assert.equal(out.extraction.refundsCents, 0, `"${junk}" became a refunds figure`);
    assert.equal(out.extraction.cashCents, 0, `"${junk}" became a cash figure`);
    assert.equal(out.extraction.purchasesCents, REAL_REPORT.totalCents, `"${junk}" moved purchases`);
    assert.equal(out.extraction.totalCents, REAL_REPORT.totalCents);
  }
});

test("an ambiguous row refuses rather than guessing where the amount starts", () => {
  // The row pattern anchors the amount at the END of the line, and the masked
  // PAN is what stops the capture reaching back into the identifier columns.
  // Strip the PAN and make every identifier numeric and the boundary genuinely
  // is ambiguous — "789012 345678 2 59 900.00" is as valid a reading as
  // "900.00". The amount then fails the thousand-separator grouping check and
  // the row is refused. That is the correct outcome: no reading is preferred,
  // and no figure is recorded.
  const ambiguous = "2026/08/27 09:07:23 123456 789012 345678 2 59 900.00 Purchase";
  const m = TXN_RE.exec(ambiguous);
  assert.ok(m, "the row still matches the pattern");
  assert.equal(parseRandsToCents(m[4]), null, "…but its amount must not resolve to a figure");

  // A currency mark removes the ambiguity, and then it reads exactly.
  const marked = "2026/08/27 09:07:23 123456 789012 345678 2 59 ZAR 900.00 Purchase";
  assert.equal(parseRandsToCents(TXN_RE.exec(marked)[4]), 90000);
});

// ─── PROSE THAT MENTIONS MONEY IS NOT A FIGURE ───────────────────────────────
// The label-suffix attempt was added so "Purchase Amount   ZAR 30120.00" reads.
// Guarded only by "no digits between the label and the number", it also read
// ordinary boilerplate: a fee schedule sentence became a cash figure, and a
// bracketed aside became a NEGATIVE total. Prose has no digits either — the
// word count is what separates a label from a sentence.
const PROSE = [
  "Total surcharge rate is 12.00",
  "Cash advance fees are subject to a service charge of 2.50",
  "Purchases made after hours incur a surcharge of 5.00",
  "Total excludes certain bank charges (25.00)",
  "Refunds are credited at the prevailing rate of 1.00",
  "Cash withdrawals are limited per transaction to 3000.00",
];

test("boilerplate mentioning a money label is not read as that figure", () => {
  const { lines } = realReportLines();
  const spots = [
    lines.findIndex((l) => /^2026\//.test(l)) + 2,          // mid-roll
    lines.findIndex((l) => /^TOTALS SUMMARY/.test(l)) + 1,  // inside the totals
    lines.length,                                           // the last footer
  ];
  for (const sentence of PROSE) {
    for (const spot of spots) {
      const poisoned = lines.slice();
      poisoned.splice(spot, 0, sentence);
      const out = parse(poisoned);
      assert.equal(out.ok, true, `"${sentence}" at ${spot} refused the report: ${out.reason}`);
      const ex = out.extraction;
      assert.equal(ex.totalCents, REAL_REPORT.totalCents, `"${sentence}" moved the total`);
      assert.equal(ex.purchasesCents, REAL_REPORT.totalCents, `"${sentence}" moved purchases`);
      assert.equal(ex.cashCents, 0, `"${sentence}" became a cash figure`);
      assert.equal(ex.refundsCents, 0, `"${sentence}" became a refunds figure`);
    }
  }
});

test("the printed slip does not get the label-suffix rule at all", () => {
  // It searches its WHOLE document rather than a totals region, so a looser
  // rule there would apply to every line of the slip. The emailed reader turns
  // the suffix attempt on for the handful of rows in its totals block; nothing
  // else does.
  const lines = slipLines();
  lines.splice(3, 0, "Cash advance fees are subject to a service charge of 2.50");
  const out = parse(lines);
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.extraction.format, "printed");
  assert.equal(out.extraction.cashCents, 0, "prose became a cash figure on the printed path");
});

test("a label suffix of one or two words still reads", () => {
  // The cap must not be so tight that the thing it was added for stops working.
  const { lines } = realReportLines();
  for (const rewrite of [
    (l) => l.replace(/^(Purchase|Total) {3}/, "$1 Amount   "),
    (l) => l.replace(/^(Purchase|Total) {3}/, "$1 Total Amount   "),
  ]) {
    const out = parse(lines.map(rewrite));
    assert.equal(out.ok, true, `a suffixed label was refused: ${out.reason}`);
    assert.equal(out.extraction.totalCents, REAL_REPORT.totalCents);
    assert.equal(out.extraction.purchasesCents, REAL_REPORT.totalCents);
  }
});

test("a two-word prefix containing a digit is still prose", () => {
  // The word cap alone would admit these: "on 3" and "over 24" are two words.
  // The digit check is what rejects them — a duration is not a money label.
  const { lines } = realReportLines();
  for (const junk of ["Refunds on 3 ZAR 50.00", "Cash over 24 ZAR 10.00", "Total via 2 ZAR 100.00"]) {
    const poisoned = lines.slice();
    poisoned.splice(lines.findIndex((l) => /^TOTALS SUMMARY/.test(l)) + 1, 0, junk);
    const out = parse(poisoned);
    assert.equal(out.ok, true, `"${junk}" refused the report: ${out.reason}`);
    assert.equal(out.extraction.totalCents, REAL_REPORT.totalCents, `"${junk}" moved the total`);
    assert.equal(out.extraction.refundsCents, 0, `"${junk}" became a refunds figure`);
    assert.equal(out.extraction.cashCents, 0, `"${junk}" became a cash figure`);
  }
});

test("a line whose figure position holds something unparseable is REFUSED, not skipped", () => {
  // "Total 7 pages ZAR 100.00" begins, right after its label, with a digit —
  // so the FIRST attempt claims it as a figure row, and the whole-remainder
  // rule then refuses because "7 pages ZAR 100.00" is not an amount.
  //
  // That is the deliberate trade-off and it is the safe side of it: the strict
  // first attempt is what turns "R5O,307.00" into a refusal instead of R5.00,
  // and softening it so this footer could be skipped would soften that too.
  // The refusal names exactly what it choked on, so the manager can see why.
  const { lines } = realReportLines();
  const poisoned = lines.slice();
  poisoned.splice(lines.findIndex((l) => /^TOTALS SUMMARY/.test(l)) + 1, 0, "Total 7 pages ZAR 100.00");
  const out = parse(poisoned);
  assert.equal(out.ok, false);
  assert.match(out.reason, /not an amount this understands/);
  assert.match(out.reason, /7 pages ZAR 100\.00/, "the refusal must quote what it read");
});

test("the printed slip ignores a short labelled-looking line the emailed one would take", () => {
  // The clearest statement of why the attempt is gated rather than global. On
  // the emailed path this shape sits in a three-line totals block and is a
  // figure; on the printed slip it is one line among a whole document and must
  // be left alone. Ungated, it becomes a second, different TOTAL and refuses a
  // perfectly good slip.
  const lines = slipLines();
  lines.splice(3, 0, "Total charges 25.00");
  const out = parse(lines);
  assert.equal(out.ok, true, `the printed slip was refused: ${out.reason}`);
  assert.equal(out.extraction.format, "printed");
  assert.equal(out.extraction.totalCents, 5030700, "the slip's own TOTAL, not the boilerplate");
});

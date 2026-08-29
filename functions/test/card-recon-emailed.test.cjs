// ─── THE BANK'S EMAILED BANKING REPORT ───────────────────────────────────────
// The second PDF format. Same batch as the terminal's printed slip, stated
// completely differently — and three of those differences change what the
// CHECKS may conclude, which is what most of this file is about.
//
// The fixture is THE REAL FILE: test/fixtures/Till2FNB-Txn-Notification.pdf,
// seven pages, forty approved transactions, ZAR 30120.00. Nothing here
// reconstructs it. `emailedLines()` generates the same shape for the cases the
// real file cannot cover on its own — refunds, a different terminal's column
// set, a deliberately corrupted figure.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseSlipPdf, detectReportFormat, tidy, TXN_RE, parseEmailedStamp, sectionStarts, readTxnBlock,
} = require("../lib/card-recon-pdf.cjs");
const {
  validateExtraction, checkTsnContiguity, parseRandsToCents,
} = require("../lib/card-recon.cjs");
const {
  emailedLines, slipLines, REAL_TSNS, REAL_REPORT,
  realReportPdf, realReportLines, makeSlipPdf, makeSlipPdfPaged, makeSlipPdfFragmented,
} = require("./fixtures/makeSlipPdf.cjs");
const { pdfToLines } = require("../cardRecon/pdfText.js");

const parse = (lines) => parseSlipPdf(lines);
const rowsOf = (lines) => lines.map(tidy).filter(Boolean);
const real = () => parseSlipPdf(realReportLines()).extraction;

// ═══ THE REAL FILE ═══════════════════════════════════════════════════════════

test("the committed text matches the committed PDF — the fixture cannot drift", async () => {
  // Line-level tests read the extracted JSON so they need no pdfjs. This is the
  // one test that re-extracts the PDF itself and holds the two together.
  const t = await pdfToLines(realReportPdf());
  assert.equal(t.ok, true, t.reason);
  assert.equal(t.pages, REAL_REPORT.pages, "seven pages");
  assert.deepEqual(t.lines, realReportLines(),
    "real-report-lines.json no longer matches the PDF — regenerate it");
});

test("the real report reads every figure the owner stated", async () => {
  const t = await pdfToLines(realReportPdf());
  const out = parseSlipPdf(t.lines);
  assert.equal(out.ok, true, `the real report was REFUSED: ${out.reason}`);
  const ex = out.extraction;

  assert.equal(ex.format, "emailed");
  assert.equal(ex.tid, REAL_REPORT.tid, "terminal 67365901");
  assert.equal(ex.batchNo, String(REAL_REPORT.batchNo), "batch 59");
  assert.equal(ex.mid, REAL_REPORT.mid);
  assert.equal(ex.txnCount, REAL_REPORT.items, "Items: 40");
  assert.equal(ex.lines.length, REAL_REPORT.items, "…and 40 transactions actually read");
  assert.equal(ex.totalCents, REAL_REPORT.totalCents, "ZAR 30120.00");
  assert.equal(ex.purchasesCents, REAL_REPORT.totalCents);
  assert.equal(ex.refundsCents, 0);
  assert.equal(ex.cashCents, 0);
  assert.equal(ex.lines.reduce((a, l) => a + l.amountCents, 0), REAL_REPORT.totalCents,
    "the transactions must sum to the printed total");

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

test("a transaction is a BLOCK, and every part is read out of it", () => {
  // Eight or nine lines each, with the UTI wrapped across two of them.
  const ex = real();
  const first = ex.lines[0];
  assert.equal(first.uti, "70db11a9-13f2-4980-8fcd-97cbf50222c5", "the wrapped UTI must be rejoined");
  assert.equal(first.rrn, "04Yewn059002");
  assert.equal(first.authCode, "932966");
  assert.equal(first.pan, "518103******4436");
  assert.equal(first.type, "purchase");
  for (const l of ex.lines) {
    assert.match(String(l.uti), /^[0-9a-f-]{30,}$/i, `TSN ${l.tsn} lost its UTI`);
    assert.match(String(l.rrn), /^04Yewn\d+$/, `TSN ${l.tsn} lost its RRN`);
    assert.ok(l.authCode, `TSN ${l.tsn} lost its auth code`);
    assert.match(String(l.pan), /^\d{6}\*{6}\d{4}$/, `TSN ${l.tsn} lost its card number`);
  }
});

test("the report's own header timestamp is not read as a transaction", () => {
  // The header carries a bare timestamp too — 29-08-2026 16:26:31, the moment
  // it was printed. It falls AFTER the last transaction (16:09:09), so counting
  // it would stretch the window and add a 41st line to a 40-item report.
  const ex = real();
  assert.equal(ex.lines.length, 40);
  assert.equal(ex.printedAt, Date.UTC(2026, 7, 29, 14, 26, 31), "printed 16:26:31 SAST");
  assert.ok(ex.printedAt > ex.closedAt, "the report was printed after the batch closed");
});

test("dates are DD-MM-YYYY on this format, and are read as such", () => {
  // 29-08-2026 is 29 August, not a malformed 2026-08-29. Reading it the other
  // way round would put every transaction on the wrong day — and the printed
  // slip's own YYYY-MM-DD parser is deliberately left alone.
  const ex = real();
  assert.equal(ex.lines[0].date, "29-08-2026");
  const d = new Date(ex.lines[0].at + 2 * 3600 * 1000);   // SAST
  assert.equal(d.getUTCDate(), 29);
  assert.equal(d.getUTCMonth(), 7, "August");
  assert.equal(d.getUTCFullYear(), 2026);
  assert.equal(parseEmailedStamp("29-08-2026 09:07:23"), Date.UTC(2026, 7, 29, 7, 7, 23));
  assert.equal(parseEmailedStamp("2026-08-29 09:07:23"), null, "the slip's order is not this format");
  assert.equal(parseEmailedStamp("32-08-2026 09:07:23"), null, "an impossible day is refused");
});

test("the per-transaction Total lines never reach the report totals", () => {
  // Every block prints a "Total: ZAR 900.00" of its own. Only the totals region
  // is searched, so forty of those cannot become the batch total — and the
  // batch total is the figure that becomes a variance against a till.
  const lines = realReportLines();
  assert.equal(lines.filter((l) => /^Total: ZAR/.test(l)).length, 40,
    "the fixture must carry a Total per transaction");
  assert.equal(real().totalCents, REAL_REPORT.totalCents, "not any single transaction's total");
});

test("page furniture INSIDE a block does not break it", () => {
  // "Page 6 of 7" sits between one transaction's timestamp and its UTI in the
  // real file — furniture lands inside a block, not only between them.
  const lines = realReportLines();
  const stampIdx = lines.findIndex((l) => /^29-08-2026 15:43:37$/.test(l));
  assert.ok(stampIdx > 0, "the fixture must contain that transaction");
  assert.match(lines[stampIdx + 1], /^Page \d+ of \d+$/, "…with a page footer immediately after it");
  const ex = real();
  assert.equal(ex.lines.length, 40, "the split block must still read as one transaction");
  assert.ok(ex.lines.some((l) => l.tsn === 49 && l.amountCents === 65000), "…including its amount");
});

test("the address block and legal footers are not figures", () => {
  const lines = realReportLines();
  assert.ok(lines.some((l) => /P\.O\. Box 1153/.test(l)), "the fixture must carry the address");
  assert.ok(lines.some((l) => /Reg No\. 1929\/001225\/06/.test(l)), "…and the legal footer");
  const ex = real();
  assert.equal(ex.totalCents, REAL_REPORT.totalCents);
  assert.equal(ex.refundsCents, 0);
  assert.equal(ex.cashCents, 0);
});

// ═══ FORMAT DETECTION ════════════════════════════════════════════════════════

test("the two formats are told apart before either is read", () => {
  assert.equal(detectReportFormat(rowsOf(realReportLines())), "emailed");
  assert.equal(detectReportFormat(rowsOf(emailedLines().lines)), "emailed");
  assert.equal(detectReportFormat(rowsOf(slipLines())), "printed");
});

test("a banking report is still recognised without its title line", () => {
  // "APPROVED TRANSACTIONS" + "Items:" are marks the printed slip never carries.
  const lines = realReportLines().filter((l) => !/^Banking Report/.test(l));
  assert.equal(detectReportFormat(rowsOf(lines)), "emailed");
  const out = parse(lines);
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.extraction.tid, REAL_REPORT.tid, "the Terminal: row carries it when the title is gone");
  assert.equal(out.extraction.batchNo, String(REAL_REPORT.batchNo));
});

test("a PDF in NEITHER format is refused, and the refusal says so", () => {
  const out = parse(["AN INVOICE", "Bill to: someone", "Amount due R400.00", "Thank you"]);
  assert.equal(out.ok, false);
  assert.match(out.reason, /neither a terminal batch slip nor an emailed banking report/);
  assert.match(out.reason, /photograph the slip/);
});

test("the title and the labelled rows must agree", () => {
  for (const [what, from, to] of [
    ["terminal", /^Terminal: 67365901$/, "Terminal: 67365902"],
    ["batch", /^Batch: 59$/, "Batch: 60"],
  ]) {
    const lines = realReportLines().map((l) => (from.test(l) ? to : l));
    const out = parse(lines);
    assert.equal(out.ok, false, `two different ${what}s must not be chosen between`);
    assert.match(out.reason, new RegExp(`title says ${what}`));
  }
});

test("a transaction claiming another batch is refused", () => {
  // Each block states its own "TSN:n Batch:n". That batch must be this report's.
  const lines = realReportLines().map((l) => (l === "TSN:29 Batch:59" ? "TSN:29 Batch:60" : l));
  const out = parse(lines);
  assert.equal(out.ok, false);
  assert.match(out.reason, /belongs to batch 60/);
});

// ═══ CHECK 1: TSN CONTIGUITY IS FORMAT-DEPENDENT ═════════════════════════════

test("the real report's TSN gaps are the ones it actually has, and they warn", () => {
  const ex = real();
  const tsns = ex.lines.map((l) => l.tsn);
  assert.deepEqual(tsns, REAL_TSNS);
  const missing = [];
  for (let n = tsns[0]; n <= tsns.at(-1); n++) if (!tsns.includes(n)) missing.push(n);
  assert.deepEqual(missing, REAL_REPORT.missingTsns, "5, 21-24, 30-31, 33-34 and 43");
  assert.equal(checkTsnContiguity(tsns).ok, false, "the sequence genuinely has gaps");

  const v = validateExtraction(ex, { source: "pdf" });
  assert.equal(v.ok, true, `a banking report was refused for its gaps: ${v.reason}`);
  assert.ok(v.warnings.some((w) => /not in this report/.test(w)), "the gaps are stated, not hidden");
  assert.ok(v.warnings.some((w) => /approved transactions only/.test(w)), "…and explained");
});

test("the SAME gap on a printed slip is still a refusal", () => {
  // The printed roll shows every attempt, so a gap there means a missed line —
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
  for (const [name, base] of [["emailed", real()], ["printed", parse(slipLines()).extraction]]) {
    const ex = { ...base };
    Object.assign(ex, {
      lines: [
        { tsn: 5, amountCents: 1000, at: ex.openedAt + 1 },
        { tsn: 5, amountCents: 1000, at: ex.openedAt + 2 },
      ],
      txnCount: 2, purchasesCents: 2000, totalCents: 2000, refundsCents: 0, cashCents: 0,
    });
    const v = validateExtraction(ex, { source: "pdf" });
    assert.equal(v.ok, false, `${name}: a duplicate TSN must refuse`);
    assert.match(v.reason, /repeat/);
  }
});

// ═══ CHECK 2: THE WINDOW IS DERIVED, AND SAYS SO ═════════════════════════════

test("the window is derived from the real transactions", () => {
  const ex = real();
  assert.equal(ex.windowSource, "transactions");
  assert.equal(ex.openedAt, Date.UTC(2026, 7, 29, 7, 7, 23), "09:07:23 SAST");
  assert.equal(ex.closedAt, Date.UTC(2026, 7, 29, 14, 9, 9) + 1, "16:09:09 SAST, plus the millisecond");
  assert.equal(ex.openedText, null, "this format prints no Opened line");
  assert.equal(ex.closedText, null, "…and no Closed line");
  const times = ex.lines.map((l) => l.at);
  assert.ok(Math.min(...times) >= ex.openedAt && Math.max(...times) < ex.closedAt,
    "every transaction must fall inside the window derived from it");
});

test("a printed slip keeps its declared window and is marked as such", () => {
  const ex = parse(slipLines()).extraction;
  assert.equal(ex.windowSource, "printed");
  assert.equal(ex.openedText, "2026/08/26 18:50:04");
});

test("a single-transaction report still yields a usable window", () => {
  const ex = parse(emailedLines({ tsns: [7] }).lines).extraction;
  assert.equal(ex.closedAt, ex.openedAt + 1, "one transaction is still a window, not a zero-width one");
  assert.equal(validateExtraction(ex, { source: "pdf" }).ok, true);
});

test("transactions spanning more than 7 days are refused, without mentioning a header", () => {
  const lines = realReportLines().map((l) => l.replace(/^29-08-2026 1[0-9]:/, "29-09-2026 1$&".slice(0, 0) + "29-09-2026 1"));
  const stretched = realReportLines().map((l) => (/^29-08-2026 1[5-6]:/.test(l) ? l.replace("29-08-2026", "29-09-2026") : l));
  assert.ok(stretched.some((l, i) => l !== realReportLines()[i]), "the fixture edit did nothing");
  const out = parse(stretched);
  assert.equal(out.ok, true, `the READ should succeed; the window check is what refuses: ${out.reason}`);
  const v = validateExtraction(out.extraction, { source: "pdf" });
  assert.equal(v.ok, false, "a month-long span is not one batch");
  assert.match(v.reason, /more than 7 days/);
  assert.doesNotMatch(v.reason, /header/i, "a report with no header must not be told to re-photograph one");
  assert.doesNotMatch(v.reason, /Opened/);
  void lines;
});

// ═══ EVERYTHING ELSE HOLDS ═══════════════════════════════════════════════════

test("the line count is checked against the printed Items figure", () => {
  const lines = realReportLines().map((l) => (l === "Items: 40" ? "Items: 41" : l));
  const out = parse(lines);
  assert.equal(out.ok, true, out.reason);
  const v = validateExtraction(out.extraction, { source: "pdf" });
  assert.equal(v.ok, false, "41 items and 40 transactions must refuse");
  assert.match(v.reason, /41 transactions but 40 lines/);
});

test("two Items counts that disagree are refused, not chosen between", () => {
  // That count is what the line-count check measures a missed transaction
  // against, so preferring one silently would defeat the check, not trip it.
  const { lines } = emailedLines();
  const idx = lines.findIndex((l) => /^Items: /.test(l));
  const wrong = lines.slice();
  wrong.splice(idx + 1, 0, "Items: 39");
  const out = parse(wrong);
  assert.equal(out.ok, false);
  assert.match(out.reason, /Items count more than once/);
});

test("arithmetic that does not hold is refused", () => {
  const lines = realReportLines().map((l) => (l === "Total ZAR 30120.00" ? "Total ZAR 30130.00" : l));
  const out = parse(lines);
  assert.equal(out.ok, true, out.reason);
  assert.equal(validateExtraction(out.extraction, { source: "pdf" }).ok, false);
});

test("transactions that do not sum to the printed total are refused on this format", () => {
  // Move R10 into BOTH summary figures, so the slip's own arithmetic still
  // holds but the transactions no longer add up to it.
  const lines = realReportLines().map((l) => (
    l === "Purchase ZAR 30120.00" ? "Purchase ZAR 30130.00"
      : l === "Total ZAR 30120.00" ? "Total ZAR 30130.00" : l));
  const out = parse(lines);
  assert.equal(out.ok, true, out.reason);
  const v = validateExtraction(out.extraction, { source: "pdf" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /read exactly/);
});

test("a banking report is never summary-only — one file is the whole report", () => {
  const ex = real();
  assert.ok(ex.lines.length > 0);
  assert.equal(validateExtraction(ex, { source: "pdf" }).ok, true);
});

test("a mangled figure is refused by name", () => {
  const lines = realReportLines().map((l) => (l === "Total ZAR 30120.00" ? "Total ZAR 3O120.00" : l));
  const out = parse(lines);
  assert.equal(out.ok, false);
  assert.match(out.reason, /not an amount this understands/);
});

test("a mangled amount inside a transaction is refused by name", () => {
  const lines = realReportLines().map((l) => (l === "Total: ZAR 900.00" ? "Total: ZAR 9O0.00" : l));
  const out = parse(lines);
  assert.equal(out.ok, false);
  assert.match(out.reason, /not an amount this understands/);
});

test("a transaction whose two amounts disagree is refused", () => {
  // Each block prints its amount twice — "Total: ZAR 900.00" then
  // "Purchase ZAR 900.00". They must agree.
  const lines = realReportLines().map((l) => (l === "Purchase ZAR 900.00" ? "Purchase ZAR 800.00" : l));
  const out = parse(lines);
  assert.equal(out.ok, false);
  assert.match(out.reason, /two different amounts/);
});

// ═══ FURNITURE AND PROSE ARE NEVER FIGURES ═══════════════════════════════════

const JUNK = [
  "Total pages 7",
  "Refunds enquiries 0860 12 34 56",
  "Cash enquiries 0860 12 34 56",
  "Purchase queries 0860 12 34 56",
  "Total surcharge rate is 12.00",
  "Cash advance fees are subject to a service charge of 2.50",
  "Purchases made after hours incur a surcharge of 5.00",
  "Total excludes certain bank charges (25.00)",
  "Refunds on 3 ZAR 50.00",
  "Total for 7 pages ZAR 100.00",
  "Page 4 of 7",
];

test("furniture and prose are survived wherever they land", () => {
  const lines = realReportLines();
  const spots = [
    0,
    lines.findIndex((l) => /^29-08-2026 09:07:23$/.test(l)) + 1,   // inside a block
    lines.findIndex((l) => /^TOTALS SUMMARY$/.test(l)) + 1,
    lines.findIndex((l) => /^CARD TOTALS$/.test(l)) + 1,
    lines.length,
  ];
  for (const junk of JUNK) {
    for (const spot of spots) {
      const poisoned = lines.slice();
      poisoned.splice(spot, 0, junk);
      const out = parse(poisoned);
      assert.equal(out.ok, true, `"${junk}" at ${spot} refused the report: ${out.reason}`);
      const ex = out.extraction;
      assert.equal(ex.totalCents, REAL_REPORT.totalCents, `"${junk}" at ${spot} moved the total`);
      assert.equal(ex.purchasesCents, REAL_REPORT.totalCents, `"${junk}" at ${spot} moved purchases`);
      assert.equal(ex.refundsCents, 0, `"${junk}" at ${spot} invented a refund`);
      assert.equal(ex.cashCents, 0, `"${junk}" at ${spot} invented a cash figure`);
      assert.equal(ex.lines.length, REAL_REPORT.items, `"${junk}" at ${spot} changed the transaction count`);
    }
  }
});

test("…but a real conflicting figure in the totals blocks is still refused", () => {
  const lines = realReportLines();
  const poisoned = lines.slice();
  poisoned.splice(lines.findIndex((l) => /^CARD TOTALS$/.test(l)) + 1, 0, "Total ZAR 0.00");
  const out = parse(poisoned);
  assert.equal(out.ok, false, "two different totals must not be chosen between");
  assert.match(out.reason, /appears twice/);
});

test("TOTALS SUMMARY and CARD TOTALS disagreeing is refused, not resolved", () => {
  // The region begins at whichever block comes FIRST, putting both in scope of
  // the ambiguity rule; anchoring it to CARD TOTALS would prefer the later one.
  const lines = realReportLines();
  const summaryIdx = lines.findIndex((l) => /^TOTALS SUMMARY$/.test(l));
  const cardIdx = lines.findIndex((l) => /^CARD TOTALS$/.test(l));
  assert.ok(summaryIdx >= 0 && cardIdx > summaryIdx, "the fixture prints both, summary first");
  const disagreeing = lines.slice();
  const totalInSummary = disagreeing.findIndex((l, i) => i > summaryIdx && i < cardIdx && /^Total ZAR/.test(l));
  disagreeing[totalInSummary] = "Total ZAR 29000.00";
  const out = parse(disagreeing);
  assert.equal(out.ok, false);
  assert.match(out.reason, /appears twice/);
});

test("the printed slip does not get the label-suffix rule at all", () => {
  // It searches its WHOLE document rather than a totals region, so a looser
  // rule there would apply to every line of the slip.
  const lines = slipLines();
  lines.splice(3, 0, "Total charges 25.00");
  const out = parse(lines);
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.extraction.format, "printed");
  assert.equal(out.extraction.totalCents, 5030700, "the slip's own TOTAL, not the boilerplate");
});

test("a suffixed label still reads on the emailed path", () => {
  const lines = realReportLines().map((l) => l.replace(/^(Purchase|Total) ZAR/, "$1 Amount ZAR"));
  const out = parse(lines);
  assert.equal(out.ok, true, `a suffixed label was refused: ${out.reason}`);
  assert.equal(out.extraction.totalCents, REAL_REPORT.totalCents);
  assert.equal(out.extraction.purchasesCents, REAL_REPORT.totalCents);
});

// ═══ SHAPES A DIFFERENT TERMINAL MIGHT PRINT ═════════════════════════════════
// The real file is one terminal's output. These vary the parts most likely to
// differ, and each must read the generated fixture's own known figures.

const SHAPES = {
  "the real file's shape":   {},
  "a UTI on one line":       { utiWraps: false },
  "no auth code line":       { noAuth: true },
  "no type line":            { typeLine: false },
  "an x-masked card number": { panMask: "x" },
  "no page furniture":       { withFurniture: false },
  "furniture every block":   { furnitureEvery: 1 },
};
for (const [name, opts] of Object.entries(SHAPES)) {
  test(`a report with ${name} reads exactly`, () => {
    const { truth, lines } = emailedLines(opts);
    const out = parse(lines);
    assert.equal(out.ok, true, `refused: ${out.reason}`);
    const ex = out.extraction;
    assert.equal(ex.txnCount, truth.count);
    assert.equal(ex.lines.length, truth.count);
    assert.equal(ex.totalCents, truth.totalCents);
    assert.equal(ex.purchasesCents, truth.purchasesCents);
    assert.deepEqual(ex.lines.map((l) => l.tsn), truth.tsns);
    assert.equal(ex.lines.reduce((a, l) => a + l.amountCents, 0), truth.totalCents);
    assert.equal(validateExtraction(ex, { source: "pdf" }).ok, true);
  });
}

test("a refund is signed negative and folds into the totals", () => {
  const { truth, lines } = emailedLines({ refundTsns: [7] });
  const out = parse(lines);
  assert.equal(out.ok, true, out.reason);
  const ex = out.extraction;
  const refund = ex.lines.find((l) => l.tsn === 7);
  assert.equal(refund.type, "refund");
  assert.ok(refund.amountCents < 0);
  assert.equal(ex.refundsCents, truth.refundsCents, "recorded as a positive magnitude by contract");
  assert.equal(ex.lines.reduce((a, l) => a + l.amountCents, 0), truth.totalCents);
  assert.equal(validateExtraction(ex, { source: "pdf" }).ok, true);
});

// ═══ THROUGH A REAL PDF, NOT AN ARRAY OF STRINGS ═════════════════════════════

test("the generated shape survives a genuine seven-page PDF round trip", async () => {
  // Seven pages, like the real file: a banking report is 400-odd lines and the
  // reader caps a batch report at ten pages, so the page size has to be
  // realistic rather than convenient.
  const { truth, lines } = emailedLines();
  const t = await pdfToLines(makeSlipPdfPaged(lines, { perPage: 60 }));
  assert.equal(t.ok, true, t.reason);
  assert.equal(t.pages, 7, "the fixture must be seven pages, as the real file is");
  assert.equal(t.lines.length, lines.length, "no page may be dropped or merged");
  const out = parseSlipPdf(t.lines);
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.extraction.totalCents, truth.totalCents);
  assert.deepEqual(out.extraction.lines.map((l) => l.tsn), truth.tsns);
});

test("…and survives a PDF whose fragments arrive shuffled", async () => {
  // The fragmenting writer lays one page, so this uses a short report — the
  // point here is the line REASSEMBLY, which is per page anyway.
  const { truth, lines } = emailedLines({ tsns: [2, 3, 4, 6] });
  const t = await pdfToLines(makeSlipPdfFragmented(lines, { seed: 31 }));
  assert.equal(t.ok, true, t.reason);
  const out = parseSlipPdf(t.lines);
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.extraction.totalCents, truth.totalCents);
  assert.deepEqual(out.extraction.lines.map((l) => l.tsn), truth.tsns);
});

test("an ambiguous printed-slip row refuses rather than guessing", () => {
  // Unchanged behaviour on the printed path, pinned here because the row
  // pattern is shared: the masked PAN is what stops the amount capture reaching
  // back into the identifier columns, and without it no reading is preferred.
  const ambiguous = "2026/08/27 09:07:23 123456 789012 345678 2 59 900.00 Purchase";
  const m = TXN_RE.exec(ambiguous);
  assert.ok(m, "the row still matches the pattern");
  assert.equal(parseRandsToCents(m[4]), null, "…but its amount must not resolve to a figure");
  const marked = "2026/08/27 09:07:23 123456 789012 345678 2 59 ZAR 900.00 Purchase";
  assert.equal(parseRandsToCents(TXN_RE.exec(marked)[4]), 90000);
});

test("a report stating refunds but not marking them is refused", () => {
  // The per-transaction type line is the only thing that says WHICH
  // transactions are refunds. Without it every transaction reads as a purchase,
  // the roll cannot sum to a total that nets refunds off, and the report is
  // refused rather than a refund being guessed at. Discovered by the fuzz,
  // which was generating exactly this incoherent document.
  const { lines } = emailedLines({ tsns: [2, 3], refundTsns: [3], typeLine: false });
  const out = parse(lines);
  assert.equal(out.ok, true, "the READ succeeds; the sum check is what refuses");
  const v = validateExtraction(out.extraction, { source: "pdf" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /add up to/);

  // With the type line present the same report is fine…
  const marked = emailedLines({ tsns: [2, 3], refundTsns: [3], typeLine: true });
  assert.equal(validateExtraction(parse(marked.lines).extraction, { source: "pdf" }).ok, true);
  // …and without refunds, the type line is not needed at all.
  const plain = emailedLines({ tsns: [2, 3], typeLine: false });
  assert.equal(validateExtraction(parse(plain.lines).extraction, { source: "pdf" }).ok, true);
});

test("a transaction block with no amount is refused, not skipped", () => {
  // A block that carries a TSN is a transaction. If its amount cannot be found
  // the report is refused — dropping it silently would leave the roll one
  // transaction short of the printed Items count, which is the shortfall this
  // whole feature exists to notice.
  const lines = realReportLines().filter((l) => l !== "Total: ZAR 900.00");
  const out = parse(lines);
  assert.equal(out.ok, false);
  assert.match(out.reason, /prints no amount/);
});

test("a line that merely STARTS with a timestamp does not open a block", () => {
  // The stamp pattern is anchored at both ends. Without the end anchor a
  // footer like "29-08-2026 16:26:31 Reprint" would split the document at the
  // wrong place, cutting a transaction in half.
  const lines = realReportLines();
  const at = lines.findIndex((l) => /^29-08-2026 09:33:49$/.test(l));
  assert.ok(at > 0, "the fixture must contain that transaction");
  const poisoned = lines.slice();
  poisoned.splice(at + 2, 0, "29-08-2026 16:26:31 Reprint requested by branch");
  const out = parse(poisoned);
  assert.equal(out.ok, true, `a trailing-text timestamp broke the report: ${out.reason}`);
  const ex = out.extraction;
  assert.equal(ex.lines.length, REAL_REPORT.items, "no block may be split by it");
  assert.equal(ex.totalCents, REAL_REPORT.totalCents);
  // The count alone does not catch it: splitting a block leaves the first half
  // TSN-less (so skipped) and gives the second half the WRONG timestamp, which
  // still produces forty transactions. The time is what gives it away — and
  // through the time, the derived window.
  const tsn3 = ex.lines.find((l) => l.tsn === 3);
  assert.equal(tsn3.time, "09:33:49", "the transaction kept its own time, not the footer's");
  assert.equal(ex.closedAt, Date.UTC(2026, 7, 29, 14, 9, 9) + 1, "…so the window is unchanged");
});

test("a report with no transactions at all is refused", () => {
  // Header only — every stamp-slice skipped. That is not an empty batch, it is
  // a file this reader could not read.
  const lines = realReportLines();
  const firstTxn = lines.findIndex((l) => /^29-08-2026 09:07:23$/.test(l));
  const totals = lines.findIndex((l) => /^TOTALS SUMMARY$/.test(l));
  const out = parse([...lines.slice(0, firstTxn), ...lines.slice(totals - 1)]);
  assert.equal(out.ok, false);
  assert.match(out.reason, /No transactions could be read/);
});

// ─── SECTIONS ────────────────────────────────────────────────────────────────
// The report divides itself with printed rules of underscores, and a section
// begins where a divider is followed by an ALL-CAPS heading. Reading that
// structure matters because a report may carry more than one section of
// transactions, and their counts are different facts — not contradictions.

test("the real file's sections are read from its own dividers", () => {
  const secs = sectionStarts(realReportLines());
  assert.deepEqual(secs.map((s) => s.heading),
    ["APPROVED TRANSACTIONS", "TOTALS SUMMARY", "CARD TOTALS"]);
});

test("a second section's Items count is not a contradiction", () => {
  // A Trophy till's report stated "Items: 25" and "Items: 5" in two sections
  // and was refused as self-contradictory. It was not: 25 belonged to the
  // approved list and 5 to something else. Only the approved section's count
  // is the one the line-count check measures against.
  const lines = realReportLines();
  const totals = lines.findIndex((l) => /^TOTALS SUMMARY$/.test(l));
  const withSecond = [
    ...lines.slice(0, totals - 1),
    "______________________________",
    "DECLINED TRANSACTIONS",
    "Items: 5",
    "______________________________",
    ...lines.slice(totals - 1),
  ];
  const out = parse(withSecond);
  assert.equal(out.ok, true, `a second section refused the report: ${out.reason}`);
  assert.equal(out.extraction.txnCount, REAL_REPORT.items, "the APPROVED count, not the other one");
  assert.equal(out.extraction.lines.length, REAL_REPORT.items);
  assert.equal(out.extraction.totalCents, REAL_REPORT.totalCents);
});

test("…but a repeated count WITHIN the approved section must still agree", () => {
  // Inside one section it is the same fact stated twice, and this is the figure
  // a missed transaction is measured against.
  const lines = realReportLines();
  const at = lines.findIndex((l) => /^Items: 40$/.test(l));
  const wrong = lines.slice();
  wrong.splice(at + 1, 0, "Items: 39");
  const out = parse(wrong);
  assert.equal(out.ok, false);
  assert.match(out.reason, /Items count more than once/);
});

test("a second section's TRANSACTIONS are not counted either", () => {
  // Otherwise the roll would run over the printed Items figure and refuse.
  const lines = realReportLines();
  const totals = lines.findIndex((l) => /^TOTALS SUMMARY$/.test(l));
  const withSecond = [
    ...lines.slice(0, totals - 1),
    "______________________________",
    "DECLINED TRANSACTIONS",
    "Items: 1",
    "______________________________",
    "29-08-2026 16:20:00",
    "UTI:aaaaaaaa-bbbb-cccc-dddd-",
    "eeeeeeeeeeee",
    "RRN: 04Yewn059099",
    "Auth Code: 111111",
    "TSN:99 Batch:59",
    "518103******9999",
    "Total: ZAR 100.00",
    "Purchase ZAR 100.00",
    ...lines.slice(totals - 1),
  ];
  const out = parse(withSecond);
  assert.equal(out.ok, true, `a declined section refused the report: ${out.reason}`);
  assert.equal(out.extraction.lines.length, REAL_REPORT.items, "40, not 41");
  assert.ok(!out.extraction.lines.some((l) => l.tsn === 99), "the other section's transaction is not ours");
  assert.equal(out.extraction.totalCents, REAL_REPORT.totalCents);
});

test("a report with no dividers at all still reads", () => {
  // Another terminal's firmware may not print them; the section map then falls
  // back to the whole document, which is what this did before sections existed.
  const lines = realReportLines().filter((l) => !/^_+$/.test(l));
  const out = parse(lines);
  assert.equal(out.ok, true, `a divider-less report was refused: ${out.reason}`);
  assert.equal(out.extraction.txnCount, REAL_REPORT.items);
  assert.equal(out.extraction.lines.length, REAL_REPORT.items);
  assert.equal(out.extraction.totalCents, REAL_REPORT.totalCents);
});

test("a continuation is only joined when the previous line was cut mid-value", () => {
  // The real file wraps the UTI inside a group — "UTI:70db11a9-…-8fcd-" — so
  // the trailing hyphen is the wrap marker. Without requiring it, a bare hex
  // line under a COMPLETE UTI gets appended: digits are hex, so an auth code
  // of "932966" was swallowed, corrupting the UTI and losing the auth code
  // with no refusal at all.
  const complete = [
    "29-08-2026 09:07:23",
    "UTI:70db11a9-13f2-4980-8fcd-97cbf50222c5",   // complete, no trailing hyphen
    "932966",                                      // an unlabelled hex value
    "TSN:2 Batch:59", "518103******4436",
    "Total: ZAR 900.00", "Purchase ZAR 900.00",
  ];
  const a = readTxnBlock(complete, "59").txn;
  assert.equal(a.uti, "70db11a9-13f2-4980-8fcd-97cbf50222c5", "nothing may be appended to a complete UTI");

  // …and the real wrap is still rejoined.
  const wrapped = [
    "29-08-2026 09:07:23",
    "UTI:70db11a9-13f2-4980-8fcd-",
    "97cbf50222c5",
    "TSN:2 Batch:59", "518103******4436",
    "Total: ZAR 900.00", "Purchase ZAR 900.00",
  ];
  assert.equal(readTxnBlock(wrapped, "59").txn.uti, "70db11a9-13f2-4980-8fcd-97cbf50222c5");
});

test("with no totals heading, the figures are sought below the transactions", () => {
  // Not across the whole document: every block prints a "Total:" and a
  // "Purchase" of its own, so an unscoped search meets forty disagreeing
  // candidates and refuses on the first two. Here another section bounds the
  // transaction list, and the figures follow under a heading this reader does
  // not recognise.
  const lines = realReportLines();
  const totals = lines.findIndex((l) => /^TOTALS SUMMARY$/.test(l));
  const renamed = [
    ...lines.slice(0, totals - 1),
    "______________________________",
    "SETTLEMENT BREAKDOWN",
    "______________________________",
    "Purchase ZAR 30120.00",
    "Total ZAR 30120.00",
  ];
  const out = parse(renamed);
  assert.equal(out.ok, true, `an unrecognised totals heading refused the report: ${out.reason}`);
  assert.equal(out.extraction.totalCents, REAL_REPORT.totalCents, "not one transaction's total");
  assert.equal(out.extraction.purchasesCents, REAL_REPORT.totalCents);
  assert.equal(out.extraction.lines.length, REAL_REPORT.items);
});

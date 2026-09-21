// ─── A BATCH IN WHICH NO CARD WAS TAKEN ──────────────────────────────────────
// Marathon Till 3 (67365901), batch 81, emailed 21 Sept 2026 17:15. The whole
// report is a header and two empty totals blocks:
//
//     Banking Report for Batch 81 of Terminal 67365901
//     …
//     TOTALS SUMMARY
//     Total ZAR 0.00
//     CARD TOTALS
//     (nothing)
//
// No APPROVED section, so no "Items:" count — and the parser refused it for
// that: "That banking report does not print an Items count." The terminal had
// simply settled an empty batch. It is a valid R0 batch, and the till must
// show as reported.
//
// The fixture is THE REAL FILE. It carries no transaction or card data.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseSlipPdf, isEmptyBatchShape, tidy } = require("../lib/card-recon-pdf.cjs");
const { validateExtraction, buildBatchRecord } = require("../lib/card-recon.cjs");
const { pdfToLines } = require("../cardRecon/pdfText.js");

const PDF = path.join(__dirname, "fixtures/Till3-Batch81-Empty-FNB-Txn-Notification.pdf");
const LINES = path.join(__dirname, "fixtures/real-report-empty-lines.json");
const lines = () => JSON.parse(fs.readFileSync(LINES, "utf8"));

test("the committed text matches the committed PDF", async () => {
  const t = await pdfToLines(fs.readFileSync(PDF));
  assert.equal(t.ok, true, t.reason);
  assert.deepEqual(t.lines, lines());
  assert.ok(t.lines.includes("Total ZAR 0.00"), "the fixture is the empty report");
  assert.ok(!t.lines.some((l) => /items/i.test(l)), "…and prints no Items count at all");
});

test("the real empty report is READ as a R0 batch, not refused", () => {
  const out = parseSlipPdf(lines());
  assert.equal(out.ok, true, `REFUSED: ${out.reason}`);
  const ex = out.extraction;
  assert.equal(ex.tid, "67365901");
  assert.equal(ex.batchNo, "81");
  assert.equal(ex.totalCents, 0);
  assert.equal(ex.purchasesCents, 0);
  assert.equal(ex.txnCount, 0);
  assert.deepEqual(ex.lines, []);
  assert.equal(ex.emptyBatch, true);
  assert.equal(ex.windowSource, "empty-batch");
  // 21-09-2026 17:15:31 SAST
  assert.equal(ex.printedAt, Date.UTC(2026, 8, 21, 15, 15, 31));
  assert.equal(ex.openedAt, ex.printedAt);
  assert.equal(ex.closedAt, ex.printedAt + 1);
});

test("it passes validation, with a warning that says what it is", () => {
  const ex = parseSlipPdf(lines()).extraction;
  const v = validateExtraction(ex, { source: "pdf" });
  assert.equal(v.ok, true, v.reason);
  assert.match(v.warnings[0], /no card transactions — recorded as R0\.00/);
});

test("the record carries R0, no lines, and the empty-batch window", () => {
  const ex = parseSlipPdf(lines()).extraction;
  const rec = buildBatchRecord({
    extraction: ex, terminal: { storeId: "pe", tillId: "till-3", label: "Marathon Till 3" },
    tid: ex.tid, batchKey: "81", revision: 1, supersedes: null,
    photoPaths: [], summaryOnly: false, warnings: [],
    expected: { cardCents: 0, legs: 0, byKind: {} },
    cashiers: null, submittedBy: "u", submittedAt: 1,
  });
  assert.equal(rec.slip.totalCents, 0);
  assert.equal(rec.slip.windowSource, "empty-batch");
  assert.equal(rec.lineCount, 0);
});

// ── THE NARROWNESS IS THE SAFETY ─────────────────────────────────────────────
// An empty batch must never become the way a report this parser could not
// read gets recorded as R0.

test("the same shape with a NON-ZERO total is still refused", () => {
  const bent = lines().map((l) => (l === "Total ZAR 0.00" ? "Total ZAR 950.00" : l));
  const out = parseSlipPdf(bent);
  assert.equal(out.ok, false);
  assert.match(out.reason, /does not print an Items count/);
});

test("a report with a transaction block but no Items count is still refused", () => {
  const src = lines();
  const at = src.indexOf("TOTALS SUMMARY") - 1;
  const withTxn = [...src.slice(0, at), "21-09-2026 10:00:00", "TSN:3 Batch:81", "Total: ZAR 0.00", "Purchase ZAR 0.00", ...src.slice(at)];
  assert.equal(isEmptyBatchShape(withTxn.map(tidy).filter(Boolean)), false);
  assert.equal(parseSlipPdf(withTxn).ok, false);
});

test("an APPROVED heading means it is not empty, whatever the total says", () => {
  const src = lines();
  const at = src.indexOf("TOTALS SUMMARY") - 1;
  const withSection = [...src.slice(0, at), "______________________________", "APPROVED TRANSACTIONS", ...src.slice(at)];
  assert.equal(isEmptyBatchShape(withSection.map(tidy).filter(Boolean)), false);
  assert.equal(parseSlipPdf(withSection).ok, false);
});

test("validation refuses the empty flag on anything that is not exactly empty", () => {
  const ex = parseSlipPdf(lines()).extraction;
  for (const bent of [
    { ...ex, totalCents: 100, purchasesCents: 100 },
    { ...ex, txnCount: 1 },
    { ...ex, lines: [{ tsn: 1, amountCents: 0 }] },
    { ...ex, format: "printed" },
  ]) {
    const v = validateExtraction(bent, { source: "pdf" });
    assert.equal(v.ok, false, JSON.stringify(bent).slice(0, 80));
  }
});

// ── A SETTLEMENT FAILURE IS NOT A BATCH ──────────────────────────────────────
test("a settlement-failure notice is refused and says what it is", () => {
  for (const phrase of [
    "Settlement failed for Batch 82 of Terminal 67365901",
    "Your batch failed to settle",
    "Batch 82 has not been settled",
    "Settlement unsuccessful",
  ]) {
    const out = parseSlipPdf(["FNB Merchant Services", phrase, "Terminal: 67365901", "Batch: 82"]);
    assert.equal(out.ok, false, phrase);
    assert.match(out.reason, /settlement-failure notice from the bank, not a batch report/, phrase);
  }
});

test("no real report on file trips the settlement-failure check", () => {
  const { realReportLines, declinedReportLines } = require("./fixtures/makeSlipPdf.cjs");
  for (const [name, src] of [["Till 2 batch 59", realReportLines()], ["Till 1 batch 58", declinedReportLines()], ["Till 3 batch 81", lines()]]) {
    const out = parseSlipPdf(src);
    assert.equal(out.ok, true, `${name}: ${out.reason}`);
  }
});

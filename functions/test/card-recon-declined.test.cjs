// ─── A REPORT WITH TWO TRANSACTION SECTIONS ──────────────────────────────────
// Marathon Till 1's batch 58, settled 19 Sept 2026. The first report on file
// that prints more than one list of transactions:
//
//     ______________________________
//     DECLINED TRANSACTIONS
//     Items: 1
//     ______________________________
//     …one declined attempt…
//     ______________________________
//     APPROVED TRANSACTIONS
//     Items: 48
//     ______________________________
//     …forty-eight approved…
//     ______________________________
//     TOTALS SUMMARY          ZAR 43530.00
//
// Two sections, two Items counts, and the DECLINED one printed FIRST. Three
// ways to get this wrong, all of which this file pins:
//
//   • read the first Items figure           → 1 instead of 48
//   • sum the two                           → expect 49 lines, find 48
//   • treat the pair as a contradiction     → refuse every report with a decline
//
// A decline is never money and never enters a total. It IS evidence: a card
// that declines and is re-swiped is one of the real causes of a variance, and
// this report is the only place the attempt is visible at all — the till has no
// leg for it, and the approved list simply skips its sequence number.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseSlipPdf, declinedSection, approvedSection, sectionStarts, tidy } = require("../lib/card-recon-pdf.cjs");
const { validateExtraction, buildBatchRecord } = require("../lib/card-recon.cjs");
const { declinedReportLines, DECLINED_REPORT } = require("./fixtures/makeSlipPdf.cjs");

const real = () => {
  const out = parseSlipPdf(declinedReportLines());
  assert.equal(out.ok, true, `the real report was REFUSED: ${out.reason}`);
  return out.extraction;
};

// ═══ THE FIXTURE ════════════════════════════════════════════════════════════
// Built line-for-line from the real nine-page file and then sanitised — see
// makeSlipPdf.cjs. This repository is public; the structure is what the parser
// reads, and the structure is what is kept.

test("the report is ACCEPTED, not refused", () => {
  // The real file was refused live on 19 Sept 2026 — by the duplicate check,
  // before the parser ever saw it. This asserts the parser itself is sound on
  // a report of this shape.
  const out = parseSlipPdf(declinedReportLines());
  assert.equal(out.ok, true, `REFUSED: ${out.reason}`);
});

test("the fixture still has the shape the rest of this file relies on", () => {
  // If the fixture is ever regenerated wrongly, every test below would pass
  // vacuously against a one-section report.
  const lines = declinedReportLines();
  assert.equal(lines.length, 488, "the real file's line count, preserved");
  assert.equal(lines.filter((l) => /^Items: \d+$/.test(l)).length, 2, "two Items counts");
  assert.ok(lines.includes("DECLINED TRANSACTIONS"));
  assert.ok(lines.includes("APPROVED TRANSACTIONS"));
});

test("no production identifiers survived the sanitiser", () => {
  // The guard on the thing that made this fixture safe to publish. A
  // regenerated fixture that skipped the sanitiser fails here, loudly.
  const text = declinedReportLines().join("\n");
  assert.doesNotMatch(text, /Merchant: 100000002453164/, "the real merchant id");
  assert.doesNotMatch(text, /04YUTM/, "real retrieval reference numbers");
  assert.doesNotMatch(text, /5(28497|31594|19612)\*{6}/, "real masked card numbers");
  // Every PAN is the one synthetic value.
  for (const l of declinedReportLines()) {
    if (/^\d{6}\*{6}\d{4}$/.test(l)) assert.equal(l, "400000******0000");
  }
});

// ═══ THE TWO SECTIONS ════════════════════════════════════════════════════════

test("the report really does print two sections, declined first", () => {
  // If this ever fails, the fixture changed and the rest of the file is
  // testing nothing. The order is asserted because the parser must not depend
  // on it — and a test that assumed approved-first would pass vacuously.
  const rows = declinedReportLines().map(tidy).filter(Boolean);
  const headings = sectionStarts(rows).map((s) => s.heading);
  assert.deepEqual(headings.slice(0, 2), ["DECLINED TRANSACTIONS", "APPROVED TRANSACTIONS"]);
});

test("the APPROVED count is read, not the first Items figure on the page", () => {
  // "Items: 1" is printed higher up the document than "Items: 48".
  const ex = real();
  assert.equal(ex.txnCount, DECLINED_REPORT.approvedItems, "Items: 48");
  assert.notEqual(ex.txnCount, DECLINED_REPORT.declinedItems);
});

test("the counts are never summed", () => {
  const ex = real();
  assert.equal(ex.txnCount, 48);
  assert.notEqual(ex.txnCount, 49, "48 approved + 1 declined is not 49 approved");
});

test("each list is validated against ITS OWN stated count", () => {
  const ex = real();
  assert.equal(ex.lines.length, ex.txnCount, "48 approved lines against Items: 48");
  assert.equal(ex.declined.length, ex.declinedCount, "1 declined line against Items: 1");
  assert.equal(ex.declinedCount, DECLINED_REPORT.declinedItems);
});

test("two differing Items figures are no longer a contradiction", () => {
  // The refusal this replaced: "That report states its Items count more than
  // once and the counts differ (1 and 48)." They are two facts, not two
  // readings of one.
  const out = parseSlipPdf(declinedReportLines());
  assert.equal(out.ok, true);
  assert.equal(String(out.reason || ""), "");
});

// ═══ THE DECLINED LINE ═══════════════════════════════════════════════════════

test("the declined attempt is captured, with its own details", () => {
  const [d] = real().declined;
  assert.equal(d.tsn, DECLINED_REPORT.declinedTsn, "TSN 25");
  assert.equal(d.amountCents, DECLINED_REPORT.declinedCents, "R750.00");
  assert.equal(d.authCode, DECLINED_REPORT.declinedAuth, "auth code all zeros");
  assert.equal(d.outcome, "declined");
  assert.equal(d.date, "19-09-2026");
  assert.equal(d.time, "12:01:33");
});

test("the declined line is NOT in the approved list", () => {
  const ex = real();
  assert.equal(ex.lines.some((l) => l.tsn === DECLINED_REPORT.declinedTsn), false,
    "TSN 25 declined — it must not appear among the approved transactions");
});

test("the declined amount is in NO total", () => {
  const ex = real();
  assert.equal(ex.totalCents, DECLINED_REPORT.totalCents, "ZAR 43530.00");
  assert.equal(ex.lines.reduce((a, l) => a + l.amountCents, 0), ex.totalCents,
    "the approved transactions alone must sum to the printed total");
  // Had the decline been counted anywhere, the total would be the sum below
  // and the assertion above would be the one that caught it. Derived from the
  // fixture's own constants so a regenerated fixture cannot silently pass.
  assert.notEqual(ex.totalCents, DECLINED_REPORT.totalCents + DECLINED_REPORT.declinedCents);
});

test("the declined sequence number explains a gap in the approved list", () => {
  // This is the investigation value: TSN 25 is absent from the approved
  // transactions BECAUSE it declined, and nothing else in the estate records
  // that.
  const ex = real();
  const tsns = ex.lines.map((l) => l.tsn).sort((a, b) => a - b);
  assert.equal(ex.declined[0].tsn, 25);
  assert.equal(tsns.includes(25), false, "25 declined, so it is not an approved transaction");
  // It is a GAP, not the end of the run: the approved list continues past it.
  // Without this, a report that simply stopped at 24 would satisfy the check
  // above and prove nothing about declines explaining interior gaps.
  assert.ok(tsns.some((t) => t < 25), "approved transactions before the decline");
  assert.ok(tsns.some((t) => t > 25), "approved transactions after the decline");
});

// ═══ WHAT THE RECORD KEEPS ═══════════════════════════════════════════════════

const terminal = { storeId: "pe", tillId: "till-1", label: "Marathon Till 1" };
const recordFor = (ex, opts = {}) => buildBatchRecord({
  extraction: ex, terminal, tid: ex.tid, batchKey: "58", revision: 1, supersedes: null,
  photoPaths: [], summaryOnly: false, warnings: [],
  expected: { cardCents: DECLINED_REPORT.totalCents, legs: 48, byKind: { sale: 48 } }, cashiers: [],
  submittedBy: { uid: "u" }, submittedAt: 1, draftId: "d", ocr: null,
  capturedVia: "pdf", ...opts,
});

test("the record carries the declines, keyed separately from the approved lines", () => {
  const rec = recordFor(real());
  assert.equal(rec.lineCount, 48);
  assert.equal(Object.keys(rec.lines).length, 48);
  assert.deepEqual(Object.keys(rec.declined), ["25"]);
  assert.equal(rec.declined["25"].amountCents, DECLINED_REPORT.declinedCents);
  assert.equal(rec.declined["25"].outcome, "declined");
  assert.equal(rec.declinedCount, 1);
  // The thing that makes this structural rather than remembered: a reader that
  // has never heard of a decline reads `lines` and cannot reach one.
  assert.equal(rec.lines["25"], undefined);
});

test("a summary-only capture records NO declines rather than an empty list", () => {
  // One photo of the totals block never showed the declined section. An empty
  // list there would read as "there were no declines" rather than "nobody
  // looked".
  const rec = recordFor(real(), { summaryOnly: true });
  assert.equal(rec.declined, null);
  assert.equal(rec.declinedCount, null);
});

// ═══ A REPORT WITH NO DECLINED SECTION IS UNCHANGED ══════════════════════════

test("a report with no declined section reports none — and reads nothing twice", () => {
  // The fallback here is the OPPOSITE of approvedSection's, and it has to be:
  // falling back to the whole document would read the approved list a second
  // time and report all 40 sales as declines.
  const { realReportLines, REAL_REPORT } = require("./fixtures/makeSlipPdf.cjs");
  const out = parseSlipPdf(realReportLines());
  assert.equal(out.ok, true, out.reason);
  assert.deepEqual(out.extraction.declined, []);
  // NULL, not 0: this report STATED NOTHING about declines, which is not the
  // same as stating none. buildBatchRecord's contract reserves null for it.
  assert.equal(out.extraction.declinedCount, null);
  assert.equal(out.extraction.txnCount, REAL_REPORT.items, "still 40 approved");

  const rows = realReportLines().map(tidy).filter(Boolean);
  assert.equal(declinedSection(rows, rows.length), null, "absent means absent, never the whole document");
});

test("approvedSection and declinedSection pick different spans on the two-section file", () => {
  const rows = declinedReportLines().map(tidy).filter(Boolean);
  const totalsIdx = rows.findIndex((r) => /^TOTALS SUMMARY$/i.test(r));
  const a = approvedSection(rows, totalsIdx);
  const d = declinedSection(rows, totalsIdx);
  assert.ok(d, "the declined section must be found");
  // They must not overlap, or a transaction would be read into both lists.
  assert.ok(d.to < a.from, `declined ${d.from}-${d.to} must end before approved starts at ${a.from}`);
});

// ═══ THE WHOLE EXTRACTION STILL VALIDATES ════════════════════════════════════

test("the extraction passes validation, gaps and all", () => {
  const v = validateExtraction(real(), { source: "pdf" });
  assert.equal(v.ok, true, v.reason);
});

test("the batch spans two days, which is why it collided with the interim report", () => {
  const ex = real();
  const day = (ms) => new Date(ms + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.equal(day(ex.openedAt), "2026-09-18");
  assert.equal(day(ex.lastTxnAt), "2026-09-19");
});

// ═══ AN UNREADABLE DECLINED SECTION NEVER COSTS THE REPORT ═══════════════════
// This was a refusal for about an hour, and it was the wrong trade: it would
// have thrown away forty good transactions and a correct total because a
// supplementary section did not parse. The declined list is evidence; the
// approved list and the total are the money.

test("a declined section whose lines cannot be read WARNS — it does not refuse", () => {
  const { realReportLines, REAL_REPORT } = require("./fixtures/makeSlipPdf.cjs");
  const lines = realReportLines();
  const totals = lines.findIndex((l) => /^TOTALS SUMMARY$/.test(l));
  // A heading and a count with NO transaction blocks beneath it — which is
  // what an unparseable section looks like from here.
  const withEmptyDeclined = [
    ...lines.slice(0, totals - 1),
    "______________________________",
    "DECLINED TRANSACTIONS",
    "Items: 5",
    "______________________________",
    ...lines.slice(totals - 1),
  ];
  const out = parseSlipPdf(withEmptyDeclined);
  assert.equal(out.ok, true, `an unreadable declined section refused the report: ${out.reason}`);

  const ex = out.extraction;
  // The money is untouched and still checked on its own.
  assert.equal(ex.txnCount, REAL_REPORT.items, "the APPROVED count, not the declined one");
  assert.equal(ex.lines.length, REAL_REPORT.items);
  assert.equal(ex.totalCents, REAL_REPORT.totalCents);
  // Nothing claims a decline it could not read.
  assert.deepEqual(ex.declined, []);
  assert.equal(ex.declinedCount, 5, "the figure the report stated still stands");
  assert.equal(ex.declinedUnread, 5);

  // …and the gap is reported rather than swallowed.
  const v = validateExtraction(ex, { source: "pdf" });
  assert.equal(v.ok, true, v.reason);
  const warned = v.warnings.find((w) => /declined/i.test(w));
  assert.ok(warned, `no warning named the unread declines: ${JSON.stringify(v.warnings)}`);
  assert.match(warned, /5 of them could not be read/);
  assert.match(warned, /total are unaffected/);
});

test("the real file reads its declined section fully, so it warns about nothing", () => {
  const ex = real();
  assert.equal(ex.declinedUnread, 0);
  const v = validateExtraction(ex, { source: "pdf" });
  assert.equal(v.warnings.some((w) => /could not be read/i.test(w)), false);
});

test("a MALFORMED declined block is counted as unread, not fatal", () => {
  // The same trade as the count mismatch above, which was left inconsistent:
  // a declined line the parser could not read would have refused a report
  // whose approved transactions and printed total were perfectly sound.
  const { realReportLines, REAL_REPORT } = require("./fixtures/makeSlipPdf.cjs");
  const lines = realReportLines();
  const totals = lines.findIndex((l) => /^TOTALS SUMMARY$/.test(l));
  const withBadDeclined = [
    ...lines.slice(0, totals - 1),
    "______________________________",
    "DECLINED TRANSACTIONS",
    "Items: 1",
    "______________________________",
    // A block that OPENS like a transaction — so it is not skipped — and then
    // carries a TSN line the reader cannot make sense of.
    "19-09-2026 12:01:33",
    "TSN:notanumber Batch:59",
    "Total: ZAR not-an-amount",
    ...lines.slice(totals - 1),
  ];
  const out = parseSlipPdf(withBadDeclined);
  assert.equal(out.ok, true, `a malformed declined block refused the report: ${out.reason}`);

  const ex = out.extraction;
  assert.equal(ex.txnCount, REAL_REPORT.items, "the approved list is untouched");
  assert.equal(ex.lines.length, REAL_REPORT.items);
  assert.equal(ex.totalCents, REAL_REPORT.totalCents, "and so is the total");
  assert.equal(ex.declinedCount, 1, "the stated figure stands");
  assert.equal(ex.declined.length, 0, "nothing claims a decline it could not read");
  assert.equal(ex.declinedUnread, 1);

  const v = validateExtraction(ex, { source: "pdf" });
  assert.equal(v.ok, true, v.reason);
  assert.ok(v.warnings.some((w) => /could not be read/i.test(w)), "the gap is reported");
});

test("an unreadable block is not double-counted against the shortfall", () => {
  // A failed block is ALSO missing from `declined`, so it is already inside
  // the shortfall; adding both would report 2 unread where 1 is true.
  const { realReportLines } = require("./fixtures/makeSlipPdf.cjs");
  const lines = realReportLines();
  const totals = lines.findIndex((l) => /^TOTALS SUMMARY$/.test(l));
  const out = parseSlipPdf([
    ...lines.slice(0, totals - 1),
    "______________________________", "DECLINED TRANSACTIONS", "Items: 1", "______________________________",
    "19-09-2026 12:01:33", "TSN:notanumber Batch:59", "Total: ZAR not-an-amount",
    ...lines.slice(totals - 1),
  ]);
  assert.equal(out.extraction.declinedUnread, 1, "one unread decline, not two");
});

test("a report with no declined section reports declinedUnread as null, not 0", () => {
  const { realReportLines } = require("./fixtures/makeSlipPdf.cjs");
  const ex = parseSlipPdf(realReportLines()).extraction;
  assert.equal(ex.declinedUnread, null);
  assert.equal(ex.declinedCount, null);
});

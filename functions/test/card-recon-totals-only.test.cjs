// ─── TOTALS ONLY, WHEN THE TRANSACTION LIST WILL NOT READ ────────────────────
// Every past emailed-report refusal was a new layout of the TRANSACTION LIST,
// while the batch's identity and its totals sat there legible. When only the
// list fails, the batch is recorded from its TOTALS SUMMARY and CARD TOTALS —
// summary-only, a warning naming why — and in every other case it refuses
// exactly as before. Built on a real report (Marathon Till 1, batch 44,
// R2,700.00, 5 transactions), damaged one way at a time.
"use strict";

const nodeTest = require("node:test");
// THE REAL REPORTS LIVE ON THE MAC MINI ONLY (gitignored — the repo is public
// and they print card numbers). Everywhere else these tests skip, by name.
const HAVE_REAL = require("node:fs").existsSync(require("node:path").join(__dirname, "fixtures", "card-recon-real"));
const SKIP_WHY = "real FNB reports are kept on the Mac mini only (functions/test/fixtures/card-recon-real/ is gitignored)";
const test = (name, fn) => nodeTest.test(name, { skip: HAVE_REAL ? false : SKIP_WHY }, fn);
const assert = require("node:assert/strict");
const { readSlipPdfLines } = require("../lib/card-recon-pdf.cjs");
const { buildBatchRecord } = require("../lib/card-recon.cjs");

const REAL = HAVE_REAL ? require("./fixtures/card-recon-real/20261013-67377843-b44-accepted-m527.lines.json") : [];
const edit = (fn) => fn([...REAL]);
const without = (re) => edit((l) => l.filter((x) => !re.test(x)));
const swap = (from, to) => edit((l) => l.map((x) => (x === from ? to : x)));

test("the real report reads in full, as before — no fallback when nothing failed", () => {
  const out = readSlipPdfLines(REAL);
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.summaryOnly, false);
  assert.equal(out.extraction.lines.length, 5);
});

// ── WHEN THE LIST FAILS, THE TOTALS SETTLE IT ───────────────────────────────

test("Items count missing → recorded from the totals, summary-only, count left unread", () => {
  const out = readSlipPdfLines(without(/^Items: 5$/));
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.summaryOnly, true);
  const e = out.extraction;
  assert.equal(e.tid, "67377843");
  assert.equal(e.batchNo, "44");
  assert.equal(e.totalCents, 270000, "the printed total, exactly");
  assert.equal(e.purchasesCents, 270000);
  assert.equal(e.txnCount, null, "a count is never invented");
  assert.deepEqual(e.lines, []);
  assert.match(out.warnings[0], /^Totals only — the transaction list could not be read \(.*Items count.*\), so this batch was recorded from the report's TOTALS SUMMARY and CARD TOTALS, which agree\./);
  assert.doesNotMatch(out.warnings[0], /photograph/i, "the warning is for Junid's record, not a manager");
});

test("Items count disagreeing with the lines read → totals only, and the stated count is kept", () => {
  const out = readSlipPdfLines(swap("Items: 5", "Items: 6"));
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.summaryOnly, true);
  assert.equal(out.extraction.txnCount, 6, "what the report states, as stated");
  assert.match(out.warnings[0], /says 6 transactions but 5 lines/);
});

test("a transaction block that will not read → totals only", () => {
  const out = readSlipPdfLines(swap("Total: ZAR 750.00", "Total: ZAR 75O.00"));
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.summaryOnly, true);
  assert.equal(out.extraction.totalCents, 270000);
});

test("the window comes from the report's own timestamps, closing at its print time", () => {
  const out = readSlipPdfLines(without(/^Items: 5$/));
  const full = readSlipPdfLines(REAL).extraction;
  assert.equal(out.extraction.openedAt, full.openedAt);
  assert.equal(out.extraction.closedAt, full.closedAt);
  assert.equal(out.extraction.windowSource, "stamps-to-print");
});

test("the record says linesCaptured:false, and carries no lines and no count", () => {
  const out = readSlipPdfLines(without(/^Items: 5$/));
  const rec = buildBatchRecord({
    extraction: out.extraction, terminal: { storeId: "trophy", tillId: "till-1", label: "Marathon Till 1" },
    tid: "67377843", batchKey: "44", revision: 1, supersedes: null, photoPaths: [], summaryOnly: true,
    warnings: out.warnings, expected: { cardCents: 270000, legs: 5, byKind: {} }, cashiers: [],
    submittedBy: { uid: "u" }, submittedAt: 1, draftId: "d", ocr: null, capturedVia: "pdf",
  });
  assert.equal(rec.linesCaptured, false);
  assert.equal(rec.lines, null);
  assert.equal(rec.slip.txnCount, null);
  assert.equal(rec.slip.totalCents, 270000);
  assert.equal(rec.varianceCents, 0, "a zero variance is clean, whatever the source");
});

// ── AND NEVER, WHEN THE TOTALS OR THE IDENTITY ARE IN ANY DOUBT ─────────────

const refusesWithOriginal = (lines, why) => {
  const out = readSlipPdfLines(lines);
  assert.equal(out.ok, false, `${why}: must refuse`);
  return out.reason;
};

test("never when the two totals blocks disagree", () => {
  // Line 78 is CARD TOTALS' Total; the Items count is gone so the list fails.
  const lines = without(/^Items: 5$/);
  const i = lines.lastIndexOf("Total ZAR 2700.00");
  lines[i] = "Total ZAR 2600.00";
  refusesWithOriginal(lines, "totals disagree");
});

test("never when CARD TOTALS is missing — the second statement is the cross-check", () => {
  const lines = without(/^Items: 5$/);
  const at = lines.indexOf("CARD TOTALS");
  lines.splice(at, lines.length - at);
  refusesWithOriginal(lines, "no card totals");
});

test("never when the purchases do not add up to the total", () => {
  const lines = without(/^Items: 5$/);
  lines[lines.indexOf("Purchase ZAR 2700.00")] = "Purchase ZAR 2600.00";
  lines[lines.lastIndexOf("Purchase ZAR 2700.00")] = "Purchase ZAR 2600.00";
  refusesWithOriginal(lines, "arithmetic");
});

test("never when the identity is not printed in all three places", () => {
  refusesWithOriginal(without(/^Items: 5$|^Batch: 44$/), "no labelled Batch row");
  refusesWithOriginal(without(/^Items: 5$|^Terminal: 67377843$/), "no labelled Terminal row");
});

test("never when the title and the labelled rows disagree", () => {
  const lines = without(/^Items: 5$/).map((x) => (x === "Batch: 44" ? "Batch: 45" : x));
  refusesWithOriginal(lines, "batch disagrees");
});

test("never for a settlement-failure notice", () => {
  const lines = without(/^Items: 5$/);
  lines.splice(16, 0, "Settlement failed for this batch");
  assert.match(refusesWithOriginal(lines, "settlement failure"), /settlement-failure notice/);
});

test("never when there is no transaction timestamp to place the batch", () => {
  const lines = REAL.filter((x) => !/^Items: 5$/.test(x) && !/^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/.test(x));
  refusesWithOriginal(lines, "no stamps");
});

test("a mangled TOTAL is still a refusal, never a fallback", () => {
  const lines = without(/^Items: 5$/).map((x) => (x === "Total ZAR 2700.00" ? "Total ZAR 27O0.00" : x));
  refusesWithOriginal(lines, "mangled total");
});

// ── REVIEW FOLLOW-UPS ────────────────────────────────────────────────────────

test("the totals-only window ignores a declined attempt outside the approved span", () => {
  // Marathon Till 1 batch 32 prints a DECLINED section above its approved one.
  const REAL_D = require("./fixtures/card-recon-real/20260923-67377843-b32-accepted-declined-m154.lines.json");
  const full = readSlipPdfLines(REAL_D);
  assert.equal(full.ok, true, full.reason);
  const items = REAL_D.filter((l) => /^Items: \d+$/.test(l));
  const approvedItems = items.at(-1);
  const out = readSlipPdfLines(REAL_D.filter((l) => l !== approvedItems));
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.summaryOnly, true);
  assert.equal(out.extraction.openedAt, full.extraction.openedAt, "opens at the first APPROVED sale, as the full read does");
  assert.equal(out.extraction.closedAt, full.extraction.closedAt);
});

test("a later report of a batch recorded TOTALS ONLY is not filed as a harmless re-send", async () => {
  const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
  const { resolveWriteFor } = require("../cardRecon/cardRecon.js");
  const db = makeFakeDb({ card_batches: { trophy: { 67377843: { 44: { batchKey: "44", batchNo: 44, slip: { totalCents: 270000, windowSource: "stamps-to-print" } } } } } });
  const changed = await resolveWriteFor(db, { storeId: "trophy", tid: "67377843", batchNo: "44", correction: false, lines: [{ tsn: 1, amountCents: 1 }], totalCents: 300000 });
  assert.equal(changed.write.ok, false);
  assert.match(changed.write.reason, /recorded from its totals only, and this later report of it states a different total/);
  assert.doesNotMatch(changed.write.reason, /already captured/, "must not read as a re-send");
  // The same total again IS a re-send.
  const same = await resolveWriteFor(db, { storeId: "trophy", tid: "67377843", batchNo: "44", correction: false, lines: [], totalCents: 270000 });
  assert.match(same.write.reason, /already captured/);
});

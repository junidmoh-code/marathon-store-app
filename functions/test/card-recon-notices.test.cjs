// ─── FNB DOCUMENTS THAT ARE NOT BATCHES, AND THE EMPTY BATCH WITH A FAILED CARD
// Step 0 of the refusal hardening (CARD-RECON-REFUSALS.md) found that Marathon
// Till 3's "does not print an Items count" was never a mis-read line. It was
// two real documents, both from FNB, both read here from their real lines:
//
//   • "Banking Done" notices — no figures; the batch was already banked.
//   • batch 91 — Total ZAR 0.00, no approved list, one cancelled card under
//     FAILED ATTEMPTS. An empty batch, refused because of the failed attempt.
//
// And Marathon Till 1's "does not state a batch number" was a Transaction
// History report — a date-range printout, not a batch.
"use strict";

const nodeTest = require("node:test");
// THE REAL REPORTS LIVE ON THE MAC MINI ONLY (gitignored — the repo is public
// and they print card numbers). Everywhere else these tests skip, by name.
const HAVE_REAL = require("node:fs").existsSync(require("node:path").join(__dirname, "fixtures", "card-recon-real"));
const SKIP_WHY = "real FNB reports are kept on the Mac mini only (functions/test/fixtures/card-recon-real/ is gitignored)";
const test = (name, fn) => nodeTest.test(name, { skip: HAVE_REAL ? false : SKIP_WHY }, fn);
const assert = require("node:assert/strict");
const { parseSlipPdf, readSlipPdfLines, isEmptyBatchShape } = require("../lib/card-recon-pdf.cjs");

const real = (name) => require(`./fixtures/card-recon-real/${name}.lines.json`);
const BANKING_DONE = "20261014-67365901-b92-refused-banking-done-m553";
const BATCH_91 = "20261013-67365901-b91-refused-empty-with-failed-attempt-m528";
const HISTORY = "20261011-67377843-bx-refused-transaction-history-m494";
const ORDINARY = "20261013-67377843-b44-accepted-m527";

test("a Banking Done notice is named as one, and nothing is read out of it", () => {
  const out = parseSlipPdf(real(BANKING_DONE));
  assert.equal(out.ok, false);
  assert.equal(out.unrelated, true);
  assert.match(out.reason, /"Banking Done" notice for batch 92/);
  assert.match(out.reason, /nothing to record/);
});

test("a real report that merely PRINTS the Banking Done phrase is still read as a report", () => {
  // Recognition requires the document to carry no figures at all — otherwise a
  // report with transactions and a stray sentence would be set aside unread.
  const lines = [...real(ORDINARY)];
  lines.splice(16, 0, "Banking Done:", "All transactions have already", "been banked.");
  const out = parseSlipPdf(lines);
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.extraction.totalCents, parseSlipPdf(real(ORDINARY)).extraction.totalCents);
});

test("a Transaction History report is named as one, not refused as a broken batch", () => {
  const out = parseSlipPdf(real(HISTORY));
  assert.equal(out.ok, false);
  assert.equal(out.unrelated, true);
  assert.match(out.reason, /Transaction History report/);
});

test("Marathon Till 3 batch 91: an empty batch with a failed attempt records as R0.00", () => {
  const out = readSlipPdfLines(real(BATCH_91));
  assert.equal(out.ok, true, out.reason);
  const e = out.extraction;
  assert.equal(e.emptyBatch, true);
  assert.equal(e.tid, "67365901");
  assert.equal(e.batchNo, "91");
  assert.equal(e.totalCents, 0);
  assert.equal(e.txnCount, 0);
  assert.deepEqual(e.lines, []);
  assert.equal(e.failedAttempts, 1);
  assert.ok(out.warnings.some((w) => /1 failed attempt \(a cancelled or declined card\)/.test(w)), out.warnings.join(" | "));
});

test("the failed attempt does not let a NON-ZERO total pass as empty", () => {
  const lines = real(BATCH_91).map((l) => (l === "Total ZAR 0.00" ? "Total ZAR 350.00" : l));
  const out = readSlipPdfLines(lines);
  assert.equal(out.ok, false);
  assert.match(out.reason, /Items count/);
});

test("an Items count OUTSIDE a failed/declined section still means transactions", () => {
  const lines = [...real(BATCH_91)];
  // The same count, but under a section heading that is not a no-money one.
  const at = lines.indexOf("FAILED ATTEMPTS");
  lines[at] = "OTHER TRANSACTIONS";
  assert.equal(isEmptyBatchShape(lines), false);
  // …and an APPROVED heading anywhere is never an empty batch.
  assert.equal(isEmptyBatchShape([...real(BATCH_91), "APPROVED TRANSACTIONS"]), false);
});

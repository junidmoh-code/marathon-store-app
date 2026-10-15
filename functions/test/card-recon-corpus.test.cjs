// ─── THE REAL-REPORT CORPUS: NO ACCEPTED FILE MAY CHANGE BY ACCIDENT ─────────
// Every PDF in fixtures/card-recon-real/ (and the two older real fixtures) is
// run through the whole pure PDF path — pdfToLines, parseSlipPdf, the dedupe,
// validateExtraction, the totals-only fallback — and compared with the
// expected.json beside it. See card-recon-corpus.lib.cjs for what is compared
// and how to regenerate deliberately.
//
// THE HISTORY THIS EXISTS FOR: each emailed-report fix patched one layout and
// the next layout failed (CARD-RECON-REFUSALS.md). A change that moves an
// accepted file's figures, line count or lines now fails here, by file name,
// before it ships.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { corpusFiles, summarise, expectedPath } = require("./card-recon-corpus.lib.cjs");

const files = corpusFiles();

test("the corpus is there, and covers every kind of file the mailbox has sent", () => {
  const names = files.map((f) => path.basename(f));
  assert.ok(names.length >= 25, `only ${names.length} corpus files`);
  for (const kind of ["accepted", "long-batch", "banking-done", "empty-with-failed-attempt", "transaction-history", "empty-batch", "failed-attempts", "declined"]) {
    assert.ok(names.some((n) => n.includes(kind)), `no "${kind}" file in the corpus`);
  }
});

for (const file of files) {
  test(`real report: ${path.basename(file)}`, async () => {
    const want = expectedPath(file);
    assert.ok(fs.existsSync(want), `no ${path.basename(want)} — run: node test/card-recon-corpus.lib.cjs --write, and review the diff`);
    const expected = JSON.parse(fs.readFileSync(want, "utf8"));
    const actual = JSON.parse(JSON.stringify(await summarise(file)));
    if (expected.ok) {
      // AN ACCEPTED FILE: everything that reaches the record must be identical.
      assert.equal(actual.ok, true, `this file was accepted and is now refused: ${actual.reason}`);
      assert.deepEqual(actual.extraction, expected.extraction, "the figures, window or lines moved");
      assert.equal(actual.summaryOnly, expected.summaryOnly, "the capture changed between full and totals-only");
      assert.deepEqual(actual.lines, expected.lines, "pdfToLines extracted different lines");
    }
    assert.deepEqual(actual, expected);
  });
}

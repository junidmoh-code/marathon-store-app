// ─── WHICH FRAGMENTS SHARE A PRINTED LINE ────────────────────────────────────
// pdfText.js used to group fragments by Math.round(y): a bucket boundary sat
// inside every point, so one printed line whose fragments straddled it came
// out as two rows and every row-anchored pattern in the parser missed it. It
// now clusters by gap. These pin the clustering itself; the real-report corpus
// (card-recon-corpus.test.cjs) pins that no real file's extraction moved.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { clusterLines, bucketLines, fontHeightOf } = require("../cardRecon/pdfText.js");

const frag = (str, x, y, h = 9.75) => ({ str, x, y, h });

test("one printed line straddling a rounding boundary stays one line", () => {
  // 100.49 rounds to 100 and 100.51 to 101: the old bucket split this.
  const frags = [frag("Items:", 209.89, 100.49), frag("40", 260, 100.51)];
  assert.deepEqual(bucketLines(frags), ["40", "Items:"], "the old rule's failure, reproduced");
  assert.deepEqual(clusterLines(frags), ["Items: 40"]);
});

test("adjacent lines on the report's own leading stay apart", () => {
  // Real coordinates (Marathon Till 3, batch 81): 10.9pt between body lines.
  const frags = [
    frag("Merchant:", 209.89, 588.83), frag("100000001178101", 297.64, 588.83),
    frag("Terminal:", 209.89, 577.91), frag("67365901", 338.59, 577.91),
    frag("Batch:", 209.89, 567), frag("81", 373.69, 567),
  ];
  assert.deepEqual(clusterLines(frags), ["Merchant: 100000001178101", "Terminal: 67365901", "Batch: 81"]);
});

test("FNB's page number stays its own line, between the two 7.5pt legal lines", () => {
  // Real coordinates: the 9pt "Page 1 of 1" sits 4.4pt above the lower legal
  // line. Half of 9pt would have merged them; 0.4 of the smaller height does not.
  const frags = [
    frag("First National Bank, a division of FirstRand Bank Limited.", 36, 20.06, 7.5),
    frag("An Authorised Financial Services and Credit Provider (NCRCP20).", 36, 10.12, 7.5),
    frag("Page 1 of 1", 512.17, 14.55, 9),
  ];
  assert.deepEqual(clusterLines(frags), [
    "First National Bank, a division of FirstRand Bank Limited.",
    "Page 1 of 1",
    "An Authorised Financial Services and Credit Provider (NCRCP20).",
  ]);
});

test("a line is measured from its FIRST fragment, so small steps cannot chain lines together", () => {
  // Each step is 2.5pt (inside 0.4 × 9 = 3.6), but 100 → 95 is 5pt: two lines.
  const frags = [frag("a", 0, 100, 9), frag("b", 10, 97.5, 9), frag("c", 0, 95, 9), frag("d", 10, 92.5, 9)];
  assert.deepEqual(clusterLines(frags), ["a b", "c d"]);
});

test("within a line, fragments read left to right whatever order they arrive in", () => {
  const frags = [frag("ZAR 900.00", 300, 50.2), frag("Total:", 10, 50), frag("·", 150, 49.9)];
  assert.deepEqual(clusterLines(frags), ["Total: · ZAR 900.00"]);
});

test("a fragment's height comes from item.height, then the text matrix, then 9pt", () => {
  assert.equal(fontHeightOf({ height: 7.5, transform: [9, 0, 0, 9, 0, 0] }), 7.5);
  assert.equal(fontHeightOf({ height: 0, transform: [12, 0, 0, -12, 0, 0] }), 12);
  assert.equal(fontHeightOf({}), 9);
});

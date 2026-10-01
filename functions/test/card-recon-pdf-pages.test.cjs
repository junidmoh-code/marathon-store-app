// A LONG BATCH IS STILL A BATCH. Marathon Till 1's batch 66, left open from
// 30 Sept 2026, emailed a 16-page report on 1 Oct; the old 10-page cap filed it
// as "not a batch report" and the till's card money never reached the record.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MAX_PAGES } = require("../cardRecon/pdfText.js");

test("the page cap admits a batch left open across busy days", () => {
  assert.ok(MAX_PAGES >= 16, `a 16-page report must be read, cap is ${MAX_PAGES}`);
  assert.ok(MAX_PAGES <= 100, "it is still a bound");
});

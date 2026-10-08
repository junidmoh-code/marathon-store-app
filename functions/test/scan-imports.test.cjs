// The hourly scan must load and reference only names it defines or imports.
// (7–8 Oct 2026: a missing `stockTrust` import made every run throw
// "stockTrust is not defined" — no test loaded that code path.)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("refill-scan.cjs imports every stock-trust helper it uses", () => {
  const src = fs.readFileSync(path.join(__dirname, "../refill-scan.cjs"), "utf8");
  if (/\bstockTrust\./.test(src)) assert.match(src, /const stockTrust = require\("\.\/lib\/stock-trust\.cjs"\);/);
});

test("refill-scan.cjs loads", () => {
  assert.doesNotThrow(() => require("../refill-scan.cjs"));
});

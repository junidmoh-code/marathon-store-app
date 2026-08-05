// ─── STYLE CODE NORMALISATION (server copy) ──────────────────────────────────
// src/utils/styleCode.test.js already pins this module against its ESM twin, but
// that test only runs in the CLIENT suite. This keeps the functions suite
// self-standing: `npm test` in functions/ alone still fails if the normaliser
// starts truncating, and the collapse gate is asserted on the side that owns the
// /sneaker_models key.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  STYLE_CODE_FORMATS,
  normaliseStyleCode,
  styleCodeFormat,
  isKnownStyleCodeFormat,
  formatStyleCodeForDisplay,
  styleCodeQueryCandidates,
} = require("../lib/style-code.cjs");

const BRAND_CASES = [
  ["CT8527-016", "CT8527016", "nike-alpha-6-3", "CT8527-016"],
  ["CT8527-700", "CT8527700", "nike-alpha-6-3", "CT8527-700"],
  ["315122-111", "315122111", "numeric-6-3", "315122-111"],
  ["IE3437", "IE3437", "adidas-block", "IE3437"],
  ["ML574EVG", "ML574EVG", "new-balance", "ML574EVG"],
  ["380190-01", "38019001", "puma-6-2", "380190-01"],
];

test("normalises every accepted brand format without truncating", () => {
  for (const [typed, normalised] of BRAND_CASES) {
    assert.strictEqual(normaliseStyleCode(typed), normalised);
    const alnum = typed.replace(/[^a-zA-Z0-9]/g, "");
    assert.strictEqual(normaliseStyleCode(typed).length, alnum.length, `${typed} lost characters`);
  }
});

test("THE GATE: codes sharing the first six characters never collapse", () => {
  const a = normaliseStyleCode("CT8527-016");
  const b = normaliseStyleCode("CT8527-700");
  assert.strictEqual(a, "CT8527016");
  assert.strictEqual(b, "CT8527700");
  assert.notStrictEqual(a, b);
  assert.strictEqual(a.slice(0, 6), b.slice(0, 6), "the shared prefix is real — that is the whole hazard");
  // Same across every spelling a human might type.
  for (const [x, y] of [["ct8527016", "ct8527700"], ["CT8527 016", "CT8527 700"], ["Ct-8527-016", "Ct-8527-700"]]) {
    assert.notStrictEqual(normaliseStyleCode(x), normaliseStyleCode(y));
  }
});

test("the normalised code is always a legal RTDB key", () => {
  for (const input of ["ct85.27#016$/[]", "CT8527-016", "IE.3437", "a/b/c123"]) {
    const norm = normaliseStyleCode(input);
    if (!norm) continue;
    assert.match(norm, /^[A-Z0-9]+$/);
    for (const forbidden of [".", "#", "$", "/", "[", "]"]) {
      assert.ok(!norm.includes(forbidden), `${norm} contains ${forbidden}`);
    }
  }
});

test("unusable input normalises to '' rather than throwing", () => {
  for (const bad of [null, undefined, 42, {}, [], "", "  ", "---"]) {
    assert.strictEqual(normaliseStyleCode(bad), "");
  }
});

test("does NOT substitute O↔0 or I↔1 — that could merge two real codes", () => {
  assert.notStrictEqual(normaliseStyleCode("CT8527-O16"), normaliseStyleCode("CT8527-016"));
});

test("format recognition names each brand shape and rejects prose", () => {
  for (const [typed, , format] of BRAND_CASES) {
    assert.strictEqual(styleCodeFormat(typed), format);
    assert.strictEqual(isKnownStyleCodeFormat(typed), true);
  }
  for (const junk of ["AIR JORDAN 4", "NIKE", "SIZE 9", "MADE IN VIETNAM", "", null, 7]) {
    assert.strictEqual(isKnownStyleCodeFormat(junk), false);
  }
  for (const f of STYLE_CODE_FORMATS) {
    assert.strictEqual(typeof f.name, "string");
    assert.ok(f.re instanceof RegExp);
  }
});

test("display form round-trips back to the identical key", () => {
  for (const [typed, normalised, , display] of BRAND_CASES) {
    assert.strictEqual(formatStyleCodeForDisplay(typed), display);
    assert.strictEqual(normaliseStyleCode(formatStyleCodeForDisplay(typed)), normalised);
  }
});

test("every query candidate normalises back to the SAME key", () => {
  for (const [typed, normalised] of BRAND_CASES) {
    const candidates = styleCodeQueryCandidates(typed);
    assert.ok(candidates.length > 0);
    for (const c of candidates) assert.strictEqual(normaliseStyleCode(c), normalised);
  }
  assert.deepStrictEqual(styleCodeQueryCandidates("ct8527016"), ["ct8527016", "CT8527-016", "CT8527016"]);
  assert.deepStrictEqual(styleCodeQueryCandidates(null), []);
});

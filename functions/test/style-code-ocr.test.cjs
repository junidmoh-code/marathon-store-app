// ─── STYLE CODE OCR — EXTRACTION, CONFUSABLES, CACHE SHAPE ───────────────────
// The two tests that matter most here:
//
//   1. A REAL LABEL yields the style code and NOTHING ELSE. An inside-tongue
//      label prints a size line, a production date range and a postal address,
//      all of which contain digit runs that look like style codes. Strip the
//      slashes from "08/15/2019" and you have 8 digits — the exact Puma shape.
//
//   2. The SUBSTRING TRAP. The adidas pattern [A-Z]{1,2}\d{4,6} matches
//      "CT8527" inside "CT8527-016". Emitting that six-character prefix as a
//      candidate is the never-truncate violation in its most disguised form:
//      CT8527-016 and CT8527-700 would both reduce to "CT8527" and become one
//      product with one merged stock cell.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  maskNonCodeText,
  extractStyleCodeCandidates,
  confusableVariants,
  imageHash,
  buildOcrCacheRecord,
  isOcrCacheFresh,
  OCR_CACHE_TTL_MS,
  MAX_CANDIDATES,
} = require("../lib/style-code-ocr.cjs");

const NOW = 1754300000000;

// A real Nike inside-tongue label, as DOCUMENT_TEXT_DETECTION returns it.
const NIKE_LABEL = [
  "NIKE, INC. ONE BOWERMAN DR",
  "BEAVERTON, OR 97005 USA",
  "CT8527-016",
  "US 9   UK 8   EUR 42.5   CM 27",
  "08/15/19 - 01/20/20",
  "MADE IN VIETNAM",
].join("\n");

// ─────────────────────────────────────────────────────────────────────────────
test("a real Nike label yields exactly ONE candidate — the style code", () => {
  const got = extractStyleCodeCandidates(NIKE_LABEL);
  assert.strictEqual(got.length, 1, `expected 1 candidate, got ${JSON.stringify(got)}`);
  assert.strictEqual(got[0].normalised, "CT8527016");
  assert.strictEqual(got[0].format, "nike-alpha-6-3");
});

test("THE SUBSTRING TRAP: 'CT8527' is never emitted from 'CT8527-016'", () => {
  // The adidas shape matches the first six characters. If that leaked out as a
  // candidate, CT8527-016 and CT8527-700 would collapse into one product.
  const got = extractStyleCodeCandidates("CT8527-016").map((c) => c.normalised);
  assert.deepStrictEqual(got, ["CT8527016"]);
  assert.ok(!got.includes("CT8527"), "a six-character prefix is NOT a style code");
});

test("THE SUBSTRING TRAP holds for the sibling colorway too", () => {
  const a = extractStyleCodeCandidates("CT8527-016").map((c) => c.normalised);
  const b = extractStyleCodeCandidates("CT8527-700").map((c) => c.normalised);
  assert.deepStrictEqual(a, ["CT8527016"]);
  assert.deepStrictEqual(b, ["CT8527700"]);
  assert.notDeepStrictEqual(a, b);
});

test("a 9-digit code is never split into an 8-digit Puma code plus a stray digit", () => {
  const got = extractStyleCodeCandidates("315122-111").map((c) => c.normalised);
  assert.deepStrictEqual(got, ["315122111"]);
});

// ── The three decoys a label always carries ──────────────────────────────────
test("the PRODUCTION DATE RANGE is never read as a style code", () => {
  for (const line of ["08/15/19 - 01/20/20", "08/15/2019 - 01/20/2020", "08-15-2019", "08.15.19"]) {
    assert.deepStrictEqual(extractStyleCodeCandidates(line), [], `date leaked: ${line}`);
  }
});

test("a 4-digit year date does not become a Puma 6+2 code", () => {
  // "08/15/2019" stripped of separators is 08152019 — 8 digits, the Puma shape.
  // Masking must remove it BEFORE the shape patterns ever see it.
  const got = extractStyleCodeCandidates("MADE 08/15/2019 VIETNAM");
  assert.deepStrictEqual(got, []);
});

test("the SIZE line is never read as a style code", () => {
  for (const line of ["US 9  UK 8  EUR 42.5  CM 27", "SIZE 9", "SIZE: 42.5", "EUR 44 JP 280"]) {
    assert.deepStrictEqual(extractStyleCodeCandidates(line), [], `size leaked: ${line}`);
  }
});

test("the postal address is never read as a style code", () => {
  assert.deepStrictEqual(extractStyleCodeCandidates("BEAVERTON, OR 97005 USA"), []);
});

test("masking preserves offsets so span bookkeeping stays valid", () => {
  const src = "US 9 CT8527-016";
  const masked = maskNonCodeText(src);
  assert.strictEqual(masked.length, src.length);
  assert.ok(masked.includes("CT8527-016"));
  assert.ok(!/US\s*9/.test(masked));
});

// ── Every accepted brand format survives a real label ─────────────────────────
test("each brand format is extracted from its own label", () => {
  const cases = [
    ["CT8527-016", "CT8527016", "nike-alpha-6-3"],
    ["315122-111", "315122111", "numeric-6-3"],
    ["380190-01", "38019001", "puma-6-2"],
    ["ML574EVG", "ML574EVG", "new-balance"],
    ["IE3437", "IE3437", "adidas-block"],
  ];
  for (const [printed, normalised, format] of cases) {
    const got = extractStyleCodeCandidates(`ACME BRAND\n${printed}\nMADE IN VIETNAM`);
    assert.strictEqual(got.length, 1, `${printed} -> ${JSON.stringify(got)}`);
    assert.strictEqual(got[0].normalised, normalised);
    assert.strictEqual(got[0].format, format);
  }
});

test("a space-separated code reads the same as a hyphenated one", () => {
  assert.strictEqual(extractStyleCodeCandidates("CT8527 016")[0].normalised, "CT8527016");
});

test("two distinct codes on one label both surface (the caller escalates to tier 2)", () => {
  const got = extractStyleCodeCandidates("CT8527-016\nIE3437").map((c) => c.normalised);
  assert.deepStrictEqual(got.sort(), ["CT8527016", "IE3437"]);
});

test("the same code twice de-duplicates to one candidate", () => {
  assert.strictEqual(extractStyleCodeCandidates("CT8527-016\nCT8527-016").length, 1);
});

test("empty / junk / non-string input yields no candidates, never a throw", () => {
  for (const bad of ["", "   ", "MADE IN VIETNAM", "NIKE, INC.", null, undefined, 42, {}, []]) {
    assert.deepStrictEqual(extractStyleCodeCandidates(bad), []);
  }
});

test("candidates are capped so a noisy scan cannot flood the caller", () => {
  const many = Array.from({ length: 40 }, (_, i) => `AB${String(1000 + i)}${String(100 + i)}`).join("\n");
  assert.ok(extractStyleCodeCandidates(many).length <= MAX_CANDIDATES);
});

// ── Confusable retry (tier 3) ────────────────────────────────────────────────
test("a smudged O is retried as a 0", () => {
  const variants = confusableVariants("CT8527O16");
  assert.ok(variants.includes("CT8527016"), "the obvious misread must be tried");
});

test("confusables never include the original and never repeat", () => {
  const v = confusableVariants("CT8527016");
  assert.ok(!v.includes("CT8527016"));
  assert.strictEqual(new Set(v).size, v.length);
});

test("variants that cannot be a real code are dropped rather than looked up", () => {
  for (const v of confusableVariants("CT8527016")) {
    assert.notStrictEqual(require("../lib/style-code.cjs").styleCodeFormat(v), null);
  }
});

test("the variant count is hard-capped — 2^n is not a plan", () => {
  const v = confusableVariants("SSSSSSSSS"); // every character confusable
  assert.ok(v.length <= 24, `got ${v.length}`);
  assert.ok(confusableVariants("CT8527016", { max: 3 }).length <= 3);
});

test("a code with no confusable characters yields no variants", () => {
  assert.deepStrictEqual(confusableVariants("XY3467"), []);
  assert.deepStrictEqual(confusableVariants(""), []);
  assert.deepStrictEqual(confusableVariants(null), []);
});

test("substitution widens the LOOKUP only — it never touches normalisation", () => {
  const { normaliseStyleCode } = require("../lib/style-code.cjs");
  // The normaliser must still treat O and 0 as different characters.
  assert.notStrictEqual(normaliseStyleCode("CT8527O16"), normaliseStyleCode("CT8527016"));
});

// ── OCR cache ────────────────────────────────────────────────────────────────
test("the cache key is a stable hash of the image bytes", () => {
  const a = imageHash(Buffer.from("same-photo"));
  const b = imageHash(Buffer.from("same-photo"));
  const c = imageHash(Buffer.from("different-photo"));
  assert.strictEqual(a, b, "a retake of the identical photo must not re-bill");
  assert.notStrictEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("THE CACHE RECORD HOLDS CANDIDATES ONLY — never the Vision payload", () => {
  // A full DOCUMENT_TEXT_DETECTION response is tens of KB of bounding boxes.
  // Storing it, times every photo in every shop, re-downloaded on every read,
  // is the exact node shape that has already cost this project bandwidth.
  const rec = buildOcrCacheRecord({
    candidates: [{ normalised: "CT8527016", raw: "CT8527-016", format: "nike-alpha-6-3" }],
    source: "vision",
    nowMs: NOW,
  });
  assert.deepStrictEqual(Object.keys(rec).sort(), ["at", "candidates", "expiresAt", "source"]);
  assert.deepStrictEqual(rec.candidates, ["CT8527016"]);
  assert.strictEqual(rec.source, "vision");
  assert.strictEqual(rec.at, NOW);
  // Candidate objects are reduced to bare strings — no raw, no format, no boxes.
  assert.ok(rec.candidates.every((c) => typeof c === "string"));
});

test("a fat payload cannot leak in through the candidates argument", () => {
  const rec = buildOcrCacheRecord({
    candidates: [{ normalised: "IE3437", fullTextAnnotation: { pages: [{ blocks: new Array(500).fill("x") }] } }],
    source: "gemini",
    nowMs: NOW,
  });
  assert.deepStrictEqual(rec.candidates, ["IE3437"]);
  assert.strictEqual(JSON.stringify(rec).length < 200, true, "one row must stay tiny");
});

test("expiresAt is a 90-day TTL", () => {
  const rec = buildOcrCacheRecord({ candidates: ["IE3437"], source: "vision", nowMs: NOW });
  assert.strictEqual(rec.expiresAt - rec.at, OCR_CACHE_TTL_MS);
  assert.strictEqual(OCR_CACHE_TTL_MS, 90 * 24 * 60 * 60 * 1000);
});

test("an unknown source tag falls back rather than writing an unvalidated value", () => {
  assert.strictEqual(buildOcrCacheRecord({ candidates: [], source: "wat", nowMs: NOW }).source, "vision");
});

test("a zero-candidate OCR pass still caches — a blank label must not re-bill either", () => {
  const rec = buildOcrCacheRecord({ candidates: [], source: "vision", nowMs: NOW });
  assert.deepStrictEqual(rec.candidates, []);
  assert.strictEqual(isOcrCacheFresh(rec, NOW), true);
});

test("lazy expiry: an expired row is never served", () => {
  const rec = buildOcrCacheRecord({ candidates: ["IE3437"], source: "vision", nowMs: NOW });
  assert.strictEqual(isOcrCacheFresh(rec, NOW + OCR_CACHE_TTL_MS - 1), true);
  assert.strictEqual(isOcrCacheFresh(rec, NOW + OCR_CACHE_TTL_MS), false);
  assert.strictEqual(isOcrCacheFresh(rec, NOW + OCR_CACHE_TTL_MS + 1), false);
});

test("a malformed cache row is treated as a miss, not trusted", () => {
  for (const bad of [null, undefined, {}, { candidates: "nope" }, { candidates: [] }, { candidates: [], expiresAt: "soon" }]) {
    assert.strictEqual(isOcrCacheFresh(bad, NOW), false);
  }
});

test("cache candidates de-duplicate and stay capped", () => {
  const rec = buildOcrCacheRecord({
    candidates: ["IE3437", "ie3437", "IE-3437", ...Array.from({ length: 20 }, (_, i) => `AB${1000 + i}${100 + i}`)],
    source: "vision",
    nowMs: NOW,
  });
  assert.strictEqual(rec.candidates[0], "IE3437");
  assert.ok(rec.candidates.length <= MAX_CANDIDATES);
  assert.strictEqual(new Set(rec.candidates).size, rec.candidates.length);
});

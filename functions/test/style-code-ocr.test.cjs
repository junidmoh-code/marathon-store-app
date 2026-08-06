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
  assert.deepStrictEqual(Object.keys(rec).sort(), ["at", "candidates", "expiresAt", "fpv", "source"]);
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

// ─── LACOSTE + THE LABEL FINGERPRINT (owner fix 2026-08-06) ──────────────────
const { labelFingerprint } = require("../lib/style-code-ocr.cjs");

const LACOSTE_LABEL = [
  "LACOSTE",
  "POWERCOURT 0520 1 SWA",
  "7-43SMA0033 1R5",
  "UK 8 US 9 EUR 42.5 JP 27",
  "09/24",
  "MADE IN VIETNAM",
].join("\n");

test("a Lacoste label yields its article reference — whole, with the colour suffix", () => {
  const out = extractStyleCodeCandidates(LACOSTE_LABEL);
  assert.deepStrictEqual(out.map((c) => c.normalised), ["743SMA00331R5"]);
  assert.strictEqual(out[0].format, "lacoste-ref");
});

test("web-form Lacoste references (no 7- prefix) extract too", () => {
  const out = extractStyleCodeCandidates("L001 124 6 SMA\n47SMA0057 042\nUS 10");
  assert.deepStrictEqual(out.map((c) => c.normalised), ["47SMA0057042"]);
});

// The On Cloud size label: sizes and a colourway token, NO article code.
const ON_LABEL_SIZE_8 = "On\nCLOUDNOVA MONO UNDYED WHITE\nUS M 8.5 UK 8 EU 42 JP 26.5\n1222\nMADE IN VIETNAM";
const ON_LABEL_SIZE_10 = "On\nCLOUDNOVA MONO UNDYED WHITE\nUS M 10 UK 9.5 EU 44 JP 28\n0521\nMADE IN VIETNAM";
const ON_OTHER_SHOE = "On\nCLOUDMONSTER 2 EVERGREEN\nUS M 8.5 UK 8 EU 42\n1222\nMADE IN VIETNAM";

test("FINGERPRINT: the same shoe in two different sizes produces the SAME fingerprint", () => {
  const a = labelFingerprint(ON_LABEL_SIZE_8);
  const b = labelFingerprint(ON_LABEL_SIZE_10);
  assert.ok(a, "a readable label must produce an identity");
  assert.strictEqual(a, b, "size, date and serial tokens must not leak into the identity");
});

test("FINGERPRINT: two different shoes produce DIFFERENT fingerprints", () => {
  assert.notStrictEqual(labelFingerprint(ON_LABEL_SIZE_8), labelFingerprint(ON_OTHER_SHOE));
});

test("FINGERPRINT: satisfies the styleCodeNormalised constraints — own uppercase, ≤32, alnum", () => {
  for (const text of [ON_LABEL_SIZE_8, ON_OTHER_SHOE, "SOME VERY LONG LABEL WITH MANY MANY DISTINCT MODEL TOKENS ALPHA BRAVO CHARLIE DELTA ECHO FOXTROT GOLF HOTEL"]) {
    const fp = labelFingerprint(text);
    assert.ok(fp.length <= 32, `≤32: ${fp}`);
    assert.strictEqual(fp, fp.toUpperCase());
    assert.match(fp, /^[A-Z0-9]+$/);
  }
});

test("FINGERPRINT: reading order cannot change the identity", () => {
  const shuffled = "MADE IN VIETNAM\n1222\nUS M 8.5 UK 8 EU 42 JP 26.5\nUNDYED WHITE\nCLOUDNOVA MONO\nOn";
  assert.strictEqual(labelFingerprint(ON_LABEL_SIZE_8), labelFingerprint(shuffled));
});

test("FINGERPRINT: adjacent-token re-splits never collide across labels (the delimiter digest)", () => {
  // {"CLOUDNOVA","MONO"} and {"CLOUDNOVAM","ONO"} concatenate identically once
  // sorted — the digest over the DELIMITED token list must keep them apart.
  const a = labelFingerprint("CLOUDNOVA MONO UNDYED WHITE");
  const b = labelFingerprint("CLOUDNOVAM ONO UNDYED WHITE");
  assert.notStrictEqual(a, b, "different token sets must never share an identity");
});

test("FINGERPRINT: two long-but-different labels never merge through truncation", () => {
  const long1 = "ALPHA BRAVO CHARLIE DELTA ECHO FOXTROT GOLF HOTEL INDIA1 JULIET";
  const long2 = "ALPHA BRAVO CHARLIE DELTA ECHO FOXTROT GOLF HOTEL INDIA1 KILO";
  const a = labelFingerprint(long1), b = labelFingerprint(long2);
  assert.strictEqual(a.length, 32);
  assert.notStrictEqual(a, b, "the digest tail must keep truncated identities apart");
});

test("FINGERPRINT: an empty or all-noise label produces nothing — not a junk identity", () => {
  assert.strictEqual(labelFingerprint(""), null);
  assert.strictEqual(labelFingerprint("US 9 UK 8 EUR 42.5\n08/15/19\n12345678"), null);
});

test("the cache record carries the token MAP when present, and nothing else new", () => {
  const rec = buildOcrCacheRecord({ candidates: [], source: "vision", nowMs: NOW, tokens: ["CLOUDNOVA", "MONO"] });
  assert.deepStrictEqual(rec.tk, { CLOUDNOVA: true, MONO: true });
  assert.strictEqual(rec.fpv, 2);
  const bare = buildOcrCacheRecord({ candidates: ["CT8527016"], source: "vision", nowMs: NOW });
  assert.deepStrictEqual(Object.keys(bare).sort(), ["at", "candidates", "expiresAt", "fpv", "source"]);
});

// ─── Substitute-review round (Kimi): month-name production dates ─────────────
test("a month-name date is never offered as a style code (01JAN2024 fits the Lacoste shape)", () => {
  const out = extractStyleCodeCandidates("ADIDAS\nIE3437\nMFG 01JAN2024\nUS 9");
  assert.deepStrictEqual(out.map((c) => c.normalised), ["IE3437"], "the date must not become a candidate");
});

test("month-name dates never split the same shoe's fingerprint across production runs", () => {
  const run1 = labelFingerprint("SOME SHOE X1\n01JAN2024\nMADE IN CHINA");
  const run2 = labelFingerprint("SOME SHOE X1\n15MAY2023\nMADE IN CHINA");
  const bare = labelFingerprint("SOME SHOE X1\nDEC 2023\nMADE IN CHINA");
  assert.strictEqual(run1, run2, "numeric-attached month dates are per-run noise");
  assert.strictEqual(run1, bare, "bare month tokens are per-run noise too");
});


test("labelTokens is BOUNDED — a noisy Vision response cannot balloon the cache row", () => {
  const { labelTokens } = require("../lib/style-code-ocr.cjs");
  const noisy = Array.from({ length: 200 }, (_, i) => `NOISETOKEN${i}X`).join(" ") + " " + "A".repeat(100);
  const out = labelTokens(noisy);
  assert.ok(out.length <= 40, `count bounded: ${out.length}`);
  assert.ok(out.every((t) => t.length <= 24), "token length bounded");
});

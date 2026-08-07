// ─── LABEL EXTRAS — colourway line, UPC, and the colour-words guarantee ──────
// Owner-spec proofs pinned here (2026-08-07):
//   • a colourway line IS extracted when the label prints one (RTFKT-style
//     Nike prints "WOLF GREY/PHOTO BLUE" under the model name — two Dunk
//     Genesis pairs differed ONLY by that line and we were discarding it)
//   • colour words are NEVER stripped from fingerprint token sets — they are
//     precisely what separates a colourway from its sibling
//   • the UPC is captured as evidence (12-14 digits; the photographed stock
//     prints a zero-padded 14) — and remains NON-authoritative everywhere
//   • extras ride the OCR cache in bounded short keys and come back on a hit

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  COLOUR_LEXICON,
  detectColourwayLine,
  extractLabelExtras,
  labelTokens,
  buildOcrCacheRecord,
} = require("../lib/style-code-ocr.cjs");
const { runLabelRead } = require("../styleCode/readStyleCodeLabel.js");

const NOW = 1754500000000;

// The RTFKT-style label the owner photographed the pattern from: model name,
// colourway line, code, sizes, dates — as OCR hands it back.
const RTFKT_LABEL = [
  "NIKE DUNK GENESIS",
  "WOLF GREY/PHOTO BLUE",
  "DV3853-001",
  "US 9 UK 8 EUR 42.5 CM 27",
  "03/11/25 - 04/23/25",
  "00197859117222",
  "MADE IN VIETNAM",
].join("\n");

test("PROOF — the colourway line is extracted when the label prints one", () => {
  const extras = extractLabelExtras(RTFKT_LABEL);
  assert.strictEqual(extras.colourway, "WOLF GREY/PHOTO BLUE");
});

test("the 14-digit zero-padded GTIN off the photographed labels is captured", () => {
  const extras = extractLabelExtras(RTFKT_LABEL);
  assert.strictEqual(extras.upc, "00197859117222");
});

test("a standard Nike label (no colourway printed) yields null — never a guess", () => {
  const standard = [
    "NIKE, INC. ONE BOWERMAN DR",
    "BEAVERTON, OR 97005 USA",
    "HF5509-002",
    "US 8 UK 7 EUR 41 CM 26",
    "03/11/25 - 04/23/25",
    "MADE IN VIETNAM",
  ].join("\n");
  assert.strictEqual(extractLabelExtras(standard).colourway, null);
});

test("model names, addresses and size lines never pass the colourway gate", () => {
  assert.strictEqual(detectColourwayLine("NIKE DUNK GENESIS"), null);          // no slash
  assert.strictEqual(detectColourwayLine("AIR/MAX 90"), null);                 // not colour words
  assert.strictEqual(detectColourwayLine("ONE BOWERMAN DR/BEAVERTON"), null);  // address
  assert.strictEqual(detectColourwayLine("US 9/UK 8"), null);                  // sizes
  assert.strictEqual(detectColourwayLine(""), null);
  assert.strictEqual(detectColourwayLine(null), null);
});

test("multi-segment colourways come out whole", () => {
  assert.strictEqual(detectColourwayLine("BLACK/WHITE/UNIVERSITY RED"), "BLACK/WHITE/UNIVERSITY RED");
  assert.strictEqual(detectColourwayLine("wolf grey / photo blue"), "WOLF GREY/PHOTO BLUE");
});

// ─────────────────────────────────────────────────────────────────────────────
// PROOF — colour words are NEVER stripped from token sets
// ─────────────────────────────────────────────────────────────────────────────

test("every colour word in the lexicon survives tokenisation — none is a stopword", () => {
  for (const colour of COLOUR_LEXICON) {
    if (colour.length < 3) continue; // 1-2 letter fragments are dropped by design, none are colours
    const tokens = labelTokens(`CLOUDNOVA ${colour} SHOE LABEL`);
    assert.ok(tokens.includes(colour), `colour word ${colour} was stripped from the token set`);
  }
});

test("two labels differing ONLY by colourway produce DIFFERENT token sets — the whole point", () => {
  const grey = labelTokens("NIKE DUNK GENESIS WOLF GREY/WHITE 04FP74YVB169C MADE IN VIETNAM");
  const blue = labelTokens("NIKE DUNK GENESIS WOLF GREY/PHOTO BLUE 04FP74YVB169C MADE IN VIETNAM");
  assert.notDeepStrictEqual(grey, blue);
  assert.ok(grey.includes("WHITE"));
  assert.ok(blue.includes("PHOTO") && blue.includes("BLUE"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Extras ride the cache — bounded, short-keyed, and served on a hit
// ─────────────────────────────────────────────────────────────────────────────

test("buildOcrCacheRecord stores extras under short keys, omits absents, bounds lengths", () => {
  const rec = buildOcrCacheRecord({
    candidates: ["DV3853001"], source: "vision", nowMs: NOW,
    extras: { colourway: "WOLF GREY/PHOTO BLUE", upc: "00197859117222", modelName: "X".repeat(200) },
  });
  assert.strictEqual(rec.cw, "WOLF GREY/PHOTO BLUE");
  assert.strictEqual(rec.upc, "00197859117222");
  assert.strictEqual(rec.mn.length, 64);
  const bare = buildOcrCacheRecord({ candidates: ["DV3853001"], source: "vision", nowMs: NOW, extras: { colourway: null } });
  assert.ok(!("cw" in bare) && !("upc" in bare) && !("mn" in bare));
});

function fakeDb(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  const at = (path) => path.split("/").filter(Boolean).reduce((n, k) => (n == null ? n : n[k]), data);
  const put = (path, value) => {
    const parts = path.split("/").filter(Boolean);
    const last = parts.pop();
    let node = data;
    for (const k of parts) { if (node[k] == null || typeof node[k] !== "object") node[k] = {}; node = node[k]; }
    node[last] = value;
  };
  return {
    data,
    ref(path) {
      return {
        async get() { const v = at(path); return { val: () => (v === undefined ? null : v) }; },
        async set(v) { put(path, v); },
      };
    },
  };
}

test("runLabelRead: tier-1 text yields code + colourway + UPC, caches them, and a retake serves them back", async () => {
  const db = fakeDb();
  const args = {
    buffer: Buffer.from("same-photo-bytes"),
    base64: "same-photo-bytes",
    mimeType: "image/jpeg",
    nowMs: NOW,
    geminiKey: "unused",
    visionFetch: async () => ({
      ok: true,
      json: async () => ({ responses: [{ fullTextAnnotation: { text: RTFKT_LABEL } }] }),
    }),
    tokenFn: async () => "token",
    geminiFetch: async () => { throw new Error("tier 2 must not fire on a clean tier-1 read"); },
  };
  const first = await runLabelRead(db, args);
  assert.deepStrictEqual(first.candidates, ["DV3853001"]);
  assert.strictEqual(first.colorway, "WOLF GREY/PHOTO BLUE");
  assert.strictEqual(first.upc, "00197859117222");
  assert.strictEqual(first.fromCache, false);

  const again = await runLabelRead(db, { ...args, visionFetch: async () => { throw new Error("must not re-bill"); } });
  assert.strictEqual(again.fromCache, true);
  assert.deepStrictEqual(again.candidates, ["DV3853001"]);
  assert.strictEqual(again.colorway, "WOLF GREY/PHOTO BLUE");
  assert.strictEqual(again.upc, "00197859117222");
});

test("a clean tier-1 read returns modelName null BY DESIGN — tier 2 (and its cost) never fires", async () => {
  // The documented contract (SCHEMA.md labelModelName): the model-name line is
  // a tier-2-residual bonus. A label whose code settles in tier 1 must not pay
  // a Gemini call to fill a prefill-only field.
  const db = fakeDb();
  const out = await runLabelRead(db, {
    buffer: Buffer.from("clean-tier1-photo"),
    base64: "clean-tier1-photo",
    mimeType: "image/jpeg",
    nowMs: NOW,
    geminiKey: "unused",
    visionFetch: async () => ({
      ok: true,
      json: async () => ({ responses: [{ fullTextAnnotation: { text: RTFKT_LABEL } }] }),
    }),
    tokenFn: async () => "token",
    geminiFetch: async () => { throw new Error("tier 2 must not fire on a clean tier-1 read"); },
  });
  assert.deepStrictEqual(out.candidates, ["DV3853001"]);
  assert.strictEqual(out.tier2Used, false);
  assert.strictEqual(out.modelName, null);       // the documented limit, pinned
  assert.strictEqual(out.colorway, "WOLF GREY/PHOTO BLUE"); // tier-1 extras unaffected
});

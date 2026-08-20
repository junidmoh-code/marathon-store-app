// ─── THE CONDITION RULE IS A COMPLIANCE RULE, SO IT IS TESTED LIKE ONE ───────
// Owner ruling 2026-08-20, reaffirming the spec of 2026-08-14: a photograph
// showing an item in better condition than the one that ships misrepresents
// the goods. The line he drew is between DIRT (not the goods — remove it) and
// WEAR (the goods — two of the three condition grades exist to declare it).
//
// These tests exist because the previous version of this prompt asked, in one
// breath, for both: "clean off dust, smudges, fingerprints, scuffs, scratches,
// lint, stray threads and creases". Nothing failed. Nobody noticed for six
// days. A sentence in a 3,500-line file is not a control.
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  PHOTO_PROMPT, CONDITION_CLAUSE, DEFAULT_WHITE_PROMPT, buildPhotoPrompt,
} = require("../lib/photo-prompt.cjs");

// The words that name WEAR. None may appear in an instruction to remove.
const WEAR = [
  "scuff", "scuffs", "scuffing", "scratch", "scratches", "abrasion",
  "sole wear", "worn", "yellowing", "fading", "faded", "stain", "stains",
  "tear", "tears", "loose stitching", "broken stitching",
];
// The words that name DIRT. These MAY be removed, and the prompt should say so.
const DIRT = ["dust", "smudges", "fingerprints", "lint", "stray threads", "creases"];

// Phrases that instruct wear removal without naming it.
const EUPHEMISMS = [
  /\bpristine\b/i,
  /\bbrand[- ]new condition\b/i,
  /\blike[- ]new\b/i,
  /\bas[- ]new\b/i,
  /\bimmaculate condition\b/i,
  /\bflawless condition\b/i,
  /\brefurbish/i,
  /\brestore the (product|item|shoe)/i,
];

const RULE_MARKER = "ABSOLUTE RULE, OVERRIDING EVERY INSTRUCTION ABOVE";

test("the white-bg prompt no longer asks for the product to be made new", () => {
  for (const re of EUPHEMISMS) {
    assert.ok(!re.test(PHOTO_PROMPT), `PHOTO_PROMPT still matches ${re}`);
  }
});

test("the white-bg prompt's cleanup list contains DIRT only", () => {
  // The sentence that lists what may be taken off the item.
  const sentence = PHOTO_PROMPT.split(/(?<=\.)\s+/).find((s) => /Take off loose dust/.test(s));
  assert.ok(sentence, "the cleanup sentence is missing — did the prompt get rewritten?");
  for (const d of DIRT) {
    assert.ok(sentence.toLowerCase().includes(d), `cleanup list dropped "${d}", which Junid kept`);
  }
  for (const w of ["scuff", "scratch"]) {
    assert.ok(!sentence.toLowerCase().includes(w), `cleanup list still names "${w}", which is wear`);
  }
});

test("the condition clause names every kind of wear it forbids removing", () => {
  const c = CONDITION_CLAUSE.toLowerCase();
  for (const w of WEAR) {
    assert.ok(c.includes(w.toLowerCase()), `the clause never mentions "${w}"`);
  }
});

test("the condition clause permits exactly the dirt Junid kept", () => {
  const c = CONDITION_CLAUSE.toLowerCase();
  for (const d of DIRT) assert.ok(c.includes(d), `the clause never permits removing "${d}"`);
});

test("the clause resolves ambiguity toward KEEPING the mark", () => {
  assert.match(CONDITION_CLAUSE, /if you cannot tell whether a mark is dirt or wear, KEEP IT/i);
});

// ── The invariant that actually matters ──────────────────────────────────────
// The per-run note is injected as "PRIORITY FIX … Apply this above all else",
// so anything typed by a person outranks the base prompt by construction. The
// rule therefore has to come LAST and say that it overrides what came before.
test("EVERY composed prompt ends with the condition clause", () => {
  const houseish = "Re-shoot this in our signature house style against the reference backdrop.";
  const cases = [
    buildPhotoPrompt(null, ""),
    buildPhotoPrompt("Camel lounge set", ""),
    buildPhotoPrompt(null, "make it look mint"),
    buildPhotoPrompt("Camel lounge set", "make it look mint"),
    buildPhotoPrompt("Camel lounge set", "", houseish),
    buildPhotoPrompt("Camel lounge set", "clean off every scuff", houseish),
    buildPhotoPrompt("", undefined, houseish),
  ];
  for (const p of cases) {
    assert.ok(p.endsWith(CONDITION_CLAUSE), "a composed prompt does not END with the clause");
    assert.ok(p.includes(RULE_MARKER), "a composed prompt is missing the override marker");
  }
});

test("a custom house prompt saved without a redeploy still gets the clause", () => {
  // /aiAssistant/styleKit/{template}/prompt is editable from the Style Kit
  // panel and read at call time. Whatever is in it arrives here as basePrompt,
  // and it cannot opt out of the rule.
  const hostile = "Present the product in pristine, brand-new condition, buffing out every scuff.";
  const composed = buildPhotoPrompt("Some shoe", "", hostile);
  assert.ok(composed.includes(hostile), "the custom prompt should still be honoured for style");
  assert.ok(composed.endsWith(CONDITION_CLAUSE), "…but the rule must have the last word");
});

test("a fix chip asking for wear removal is overridden, not obeyed", () => {
  const composed = buildPhotoPrompt("Some shoe", "remove all the scuffs and make it look unworn");
  const ruleAt = composed.indexOf(RULE_MARKER);
  const noteAt = composed.indexOf("remove all the scuffs");
  assert.ok(noteAt !== -1 && ruleAt !== -1);
  assert.ok(ruleAt > noteAt, "the rule must come AFTER the note it overrides");
});

test("the engines' fallback prompt is not a way around the rule", () => {
  // The adapters take `prompt || DEFAULT_WHITE_PROMPT`. A fallback of the bare
  // PHOTO_PROMPT would be a live bypass.
  assert.ok(DEFAULT_WHITE_PROMPT.endsWith(CONDITION_CLAUSE));
  assert.ok(!PHOTO_PROMPT.includes(RULE_MARKER), "PHOTO_PROMPT is the raw body, by design");
});

test("index.js never falls back to the raw prompt", () => {
  const src = readIndex();
  assert.ok(!/prompt \|\| PHOTO_PROMPT/.test(src),
    "an engine adapter falls back to PHOTO_PROMPT, which carries no condition rule");
});

function readIndex() {
  return require("fs").readFileSync(require("path").join(__dirname, "..", "index.js"), "utf8");
}

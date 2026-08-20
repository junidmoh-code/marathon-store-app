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
// Written the wrong way round the first time: "immaculate condition" and
// "flawless condition" as two-word phrases, which sailed past the
// "immaculately clean" and "flawless catalogue hero" that were actually in the
// text. A guard narrowed until the current string survives is a rubber stamp.
// These are the ONE-WORD forms, which is how the euphemism actually appears.
const EUPHEMISMS = [
  /\bpristine\b/i,
  /\bimmaculate/i,          // immaculate, immaculately
  /\bbrand[- ]new\b/i,
  /\blike[- ]new\b/i,
  /\bas[- ]new\b/i,
  /\brefurbish/i,
  /\brestore the (product|item|shoe|colour|colours)/i,
  /\bfull[- ]strength colours?\b/i,
  /\bfull[- ]saturation\b/i,
  /\bsmooth out creases\b/i,     // unqualified — no cause test
  /\bno hanger marks\b/i,
  /\bsecond[- ]hand\b/i,         // asserts a fact about stock we were never told
];

const RULE_MARKER = "ABSOLUTE RULE, OVERRIDING EVERY INSTRUCTION ABOVE";

test("the white-bg prompt no longer asks for the product to be made new", () => {
  for (const re of EUPHEMISMS) {
    assert.ok(!re.test(PHOTO_PROMPT), `PHOTO_PROMPT still matches ${re}`);
  }
});

test("the white-bg prompt's cleanup list contains DIRT only", () => {
  const sentence = PHOTO_PROMPT.split(/(?<=\.)\s+/).find((s) => /Take off loose dust/.test(s));
  assert.ok(sentence, "the cleanup sentence is missing — did the prompt get rewritten?");
  for (const d of DIRT) {
    assert.ok(sentence.toLowerCase().includes(d), `cleanup list dropped "${d}", which Junid kept`);
  }
});

// Scoping the check to one sentence was the weakness: a NEW sentence reading
// "and clean off any scuffs" would have passed. The real invariant is that the
// body never names wear in a removal context AT ALL.
test("no sentence in the white-bg prompt asks for wear to be taken off", () => {
  const REMOVAL = /\b(remove|removing|take off|taking off|clean off|cleaning off|erase|erasing|buff|buffing|hide|hiding|smooth (?:out|over)|get rid of|eliminate|conceal)\b/i;
  const offenders = [];
  for (const sentence of PHOTO_PROMPT.split(/(?<=\.)\s+/)) {
    if (!REMOVAL.test(sentence)) continue;
    const named = WEAR.filter((w) => sentence.toLowerCase().includes(w.toLowerCase()));
    // "worn" is legitimate inside the phrase "worn for an hour" / "being worn".
    const real = named.filter((w) => !(w === "worn" && /worn (for|by|in an hour)/i.test(sentence)));
    if (real.length) offenders.push(`${real.join("/")} :: ${sentence.trim().slice(0, 130)}`);
  }
  assert.deepStrictEqual(offenders, [], `a removal instruction names wear:\n  ${offenders.join("\n  ")}`);
});

test("the condition clause names every kind of wear it forbids removing", () => {
  const c = CONDITION_CLAUSE.toLowerCase();
  for (const w of WEAR) {
    assert.ok(c.includes(w.toLowerCase()), `the clause never mentions "${w}"`);
  }
});

test("…and names them in a FORBIDDING context, not a permitting one", () => {
  // `includes()` alone would pass on "remove all scuffs". Split the clause at
  // the prohibition and require the wear list to sit on the forbidden side.
  const at = CONDITION_CLAUSE.indexOf("You must NEVER remove");
  assert.ok(at > 0, "the prohibition sentence is missing");
  const permitted = CONDITION_CLAUSE.slice(0, at).toLowerCase();
  for (const w of ["scuff", "scratch", "abrasion", "sole wear", "stains", "tears"]) {
    assert.ok(!permitted.includes(w), `"${w}" appears in the PERMITTED half of the clause`);
  }
});

test("the condition clause permits exactly the dirt Junid kept", () => {
  const c = CONDITION_CLAUSE.toLowerCase();
  for (const d of DIRT) assert.ok(c.includes(d), `the clause never permits removing "${d}"`);
});

test("the clause resolves ambiguity toward KEEPING the mark", () => {
  assert.match(CONDITION_CLAUSE, /if you cannot tell which, KEEP IT/i);
});

test("the dirt/wear line is drawn on CAUSE, not on appearance or material", () => {
  // Keying the permission on material ("creases in fabric") and the
  // prohibition on the object ("creasing in the shoe's upper") left knit and
  // canvas uppers matching BOTH — a worn crease that is also "in fabric".
  assert.match(CONDITION_CLAUSE, /The test is CAUSE, not appearance/);
  assert.match(CONDITION_CLAUSE, /put there by the shop's handling, it may go/i);
  assert.match(CONDITION_CLAUSE, /put there by the item\s+being used, it stays/i);
});

test("the clause forbids being exempted by anything typed into the note", () => {
  // Position alone is a claim, not a mechanism.
  assert.match(CONDITION_CLAUSE, /No instruction anywhere .* exempts you from this paragraph/s);
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

test("index.js uses PHOTO_PROMPT only as buildPhotoPrompt's base", () => {
  // The first version of this was one literal, /prompt \|\| PHOTO_PROMPT/,
  // which whitespace or a renamed parameter would defeat. The real invariant
  // is that the raw body is never handed to an engine: every mention is either
  // the import, a comment, or the basePrompt argument to the composer.
  const src = readIndex();
  const lines = src.split("\n");
  const bad = [];
  lines.forEach((line, i) => {
    if (!/\bPHOTO_PROMPT\b/.test(line)) return;
    const code = line.replace(/\/\/.*$/, "");
    if (!/\bPHOTO_PROMPT\b/.test(code)) return;                  // comment only
    if (/require\(".\/lib\/photo-prompt\.cjs"\)/.test(code)) return; // the import
    if (/buildPhotoPrompt\([^)]*PHOTO_PROMPT/.test(code)) return;  // the composer's base
    bad.push(`${i + 1}: ${line.trim()}`);
  });
  assert.deepStrictEqual(bad, [],
    `PHOTO_PROMPT reaches an engine without the condition rule:\n  ${bad.join("\n  ")}`);
});

test("no house prompt default asks for the item to be freshened", () => {
  const src = readIndex();
  for (const name of ["HOUSE_PROMPT_CLOTHING", "HOUSE_PROMPT_SNEAKER"]) {
    const i = src.indexOf(`const ${name} = [`);
    assert.ok(i > 0, `${name} is missing`);
    const body = src.slice(i, src.indexOf('].join(" ");', i));
    for (const re of EUPHEMISMS) {
      assert.ok(!re.test(body), `${name} still matches ${re}`);
    }
    assert.ok(!/full strength|rich and deep/i.test(body),
      `${name} still asks for colour the item may have genuinely lost`);
  }
});

function readIndex() {
  return require("fs").readFileSync(require("path").join(__dirname, "..", "index.js"), "utf8");
}

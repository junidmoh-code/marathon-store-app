// ─── SOCIAL CAPTIONS AND SCENE PROMPTS ───────────────────────────────────────
// Two things are pinned hard here, because both are rules somebody could
// plausibly "tidy up" into their opposite:
//
//   1. The Shopify brand validator must NEVER reach a caption (owner ruling).
//   2. The condition clause must ALWAYS reach a scene prompt — dirt may be
//      cleaned, wear may not.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  CAPTION_MIN, CAPTION_MAX, MAX_HASHTAGS, CONDITION_CLAUSE, KIND_SCENE,
  buildScenePrompt, buildCaptionPrompt, readCaption, fallbackCaption,
} = require("../lib/social-caption.cjs");

const GENERATING_KINDS = ["single", "flatlay", "outfit"];

describe("buildScenePrompt", () => {
  test("refuses a kind it has no scene for, rather than emitting a vague prompt", () => {
    // new_arrivals generates nothing — asking for its scene is a caller bug and
    // a $0.134 generation is the wrong place to discover it.
    assert.throws(() => buildScenePrompt({ kind: "new_arrivals" }), /no scene for kind/);
    assert.throws(() => buildScenePrompt({ kind: "reel" }), /no scene for kind/);
    assert.throws(() => buildScenePrompt({}), /no scene for kind/);
  });

  // ── THE CONDITION RULE, ON EVERY PATH ────────────────────────────────────
  for (const kind of GENERATING_KINDS) {
    test(`${kind}: carries the condition clause whatever else is passed`, () => {
      const variants = [
        { kind },
        { kind, style: "white" },
        { kind, style: "house" },
        { kind, productNames: ["A", "B"], styleNotes: ["make them look brand new", "erase the scuffs"] },
      ];
      for (const v of variants) {
        const p = buildScenePrompt(v);
        assert.ok(p.includes(CONDITION_CLAUSE), `${kind} ${JSON.stringify(v)} lost the condition clause`);
      }
    });

    test(`${kind}: the condition clause comes AFTER the styling notes, so it outranks them`, () => {
      const p = buildScenePrompt({ kind, styleNotes: ["make them look brand new"] });
      assert.ok(p.indexOf(CONDITION_CLAUSE) > p.indexOf("make them look brand new"));
    });
  }

  test("the condition clause permits dirt removal and forbids wear removal — both, explicitly", () => {
    assert.match(CONDITION_CLAUSE, /Dust, smudges and packing creases may be cleaned up/);
    assert.match(CONDITION_CLAUSE, /set in by WEAR stays/);
    assert.match(CONDITION_CLAUSE, /Never repair, restore, re-colour or redesign/);
  });

  test("house is the DEFAULT — the backdrop is what you get by not choosing", () => {
    const p = buildScenePrompt({ kind: "single" });
    assert.match(p, /STYLE REFERENCE images show our real shop's painted backdrop/);
    assert.doesNotMatch(p, /seamless pure-white studio background/);
  });

  test("white is only ever reached by asking for it by name", () => {
    assert.match(buildScenePrompt({ kind: "single", style: "white" }), /seamless pure-white studio background/);
    // Anything that is not exactly "white" falls back to the backdrop.
    for (const style of ["White", "WHITE", "advertising", "", null, undefined]) {
      const p = buildScenePrompt({ kind: "single", style });
      assert.match(p, /painted backdrop/, `style=${style} should have fallen back to house`);
    }
  });

  test("names every product and forbids inventing extras", () => {
    const p = buildScenePrompt({ kind: "flatlay", productNames: ["Red cap", "Blue tee", "Grey runner"] });
    assert.match(p, /\(1\) Red cap/);
    assert.match(p, /\(2\) Blue tee/);
    assert.match(p, /\(3\) Grey runner/);
    assert.match(p, /no product that is not attached may appear/);
  });

  test("styling notes are marked as guidance, not instruction", () => {
    const p = buildScenePrompt({ kind: "single", styleNotes: ["moody, low light"] });
    assert.match(p, /guidance only/);
    assert.match(p, /moody, low light/);
  });

  test("blank and absent notes add no empty section", () => {
    for (const styleNotes of [[], ["", "   ", null], undefined]) {
      const p = buildScenePrompt({ kind: "single", styleNotes });
      assert.doesNotMatch(p, /Styling notes/);
    }
  });

  test("caps the notes it forwards rather than pasting an unbounded library", () => {
    const notes = Array.from({ length: 30 }, (_, i) => `note${i}`);
    const p = buildScenePrompt({ kind: "single", styleNotes: notes });
    assert.ok(p.includes("note5"));
    assert.ok(!p.includes("note6"), "more than six notes reached the prompt");
  });

  test("asks for no text or watermark burned into the image", () => {
    assert.match(buildScenePrompt({ kind: "single" }), /No text, no graphics, no watermark/);
  });

  test("each kind describes a genuinely different composition", () => {
    const scenes = GENERATING_KINDS.map((k) => KIND_SCENE[k]);
    assert.equal(new Set(scenes).size, scenes.length, "two post kinds share a scene description");
  });
});

describe("buildCaptionPrompt", () => {
  const products = [
    { name: "Black mesh daypack", retailPrice: 500, slot: null },
    { name: "White leather low-top", retailPrice: 1299.4, slot: "shoe" },
  ];

  test("lists every product with its real price, rounded to rands", () => {
    const p = buildCaptionPrompt({ kind: "flatlay", products });
    assert.match(p, /· Black mesh daypack — R500/);
    assert.match(p, /· White leather low-top — R1299/);
  });

  test("omits the price rather than inventing one when there is none", () => {
    const p = buildCaptionPrompt({ kind: "single", products: [{ name: "No price item" }] });
    assert.match(p, /· No price item$/m);
    assert.match(p, /never invent one that is not listed above/);
  });

  test("names the outfit slots so the caption can talk about the pieces", () => {
    assert.match(buildCaptionPrompt({ kind: "outfit", products }), /\[shoe\]/);
  });

  test("says which kind of post it is, for each kind", () => {
    const seen = new Set();
    for (const kind of ["single", "flatlay", "new_arrivals", "outfit"]) {
      const line = buildCaptionPrompt({ kind, products }).split("\n")[2];
      assert.ok(line.length > 10);
      seen.add(line);
    }
    assert.equal(seen.size, 4, "two kinds describe themselves identically");
  });

  test("tells the model NOT to write the link — the code appends it", () => {
    assert.match(buildCaptionPrompt({ kind: "single", products }), /Do NOT write the link/);
  });

  test("sets South African English and rands, and bounds the hashtags", () => {
    const p = buildCaptionPrompt({ kind: "single", products });
    assert.match(p, /South African English, South African rands/);
    assert.match(p, new RegExp(`At most ${MAX_HASHTAGS} hashtags`));
  });

  test("survives an empty product list without throwing", () => {
    assert.doesNotThrow(() => buildCaptionPrompt({ kind: "single" }));
    assert.doesNotThrow(() => buildCaptionPrompt({}));
  });
});

describe("readCaption", () => {
  test("accepts an ordinary caption unchanged", () => {
    const r = readCaption("Fresh mesh daypack, in store now.");
    assert.equal(r.ok, true);
    assert.equal(r.caption, "Fresh mesh daypack, in store now.");
  });

  test("strips a whole-body markdown fence but leaves inline backticks", () => {
    assert.equal(readCaption("```\nJust landed.\n```").caption, "Just landed.");
    assert.equal(readCaption("```json\nJust landed.\n```").caption, "Just landed.");
    assert.equal(readCaption("A `code` word in a caption about nothing").caption, "A `code` word in a caption about nothing");
  });

  test("strips wrapping quotes and normalises runaway blank lines", () => {
    assert.equal(readCaption('"Quoted caption here"').caption, "Quoted caption here");
    assert.equal(readCaption("A line.\n\n\n\n\nAnother line.").caption, "A line.\n\nAnother line.");
    assert.equal(readCaption("windows\r\nnewlines here").caption, "windows\nnewlines here");
  });

  test("refuses an empty or near-empty answer", () => {
    for (const v of ["", "   ", "\n\n", null, undefined, "hi"]) {
      const r = readCaption(v);
      assert.equal(r.ok, false, `${JSON.stringify(v)} should have been refused`);
      assert.match(r.reason, /empty|near-empty/);
    }
  });

  test("refuses a refusal instead of posting it", () => {
    for (const v of [
      "I'm sorry, I can't help with that request.",
      "I cannot write a caption for this product.",
      "As an AI language model, I am unable to…",
      "Unfortunately, I am not able to do this.",
    ]) {
      const r = readCaption(v);
      assert.equal(r.ok, false, `${JSON.stringify(v.slice(0, 20))} slipped through`);
      assert.match(r.reason, /refused/);
    }
  });

  test("trims a hashtag wall to the cap rather than refusing the whole caption", () => {
    const tags = Array.from({ length: 25 }, (_, i) => `#tag${i}`).join(" ");
    const r = readCaption(`A good caption.\n\n${tags}`);
    assert.equal(r.ok, true);
    assert.equal((r.caption.match(/#[\p{L}\p{N}_]+/gu) || []).length, MAX_HASHTAGS);
    assert.match(r.caption, /A good caption\./);
    // Kept in the order written, first N.
    assert.match(r.caption, /#tag0/);
    assert.ok(!r.caption.includes("#tag8"));
  });

  test("leaves a caption at exactly the hashtag cap alone", () => {
    const tags = Array.from({ length: MAX_HASHTAGS }, (_, i) => `#t${i}`).join(" ");
    const r = readCaption(`Caption body here.\n\n${tags}`);
    assert.equal((r.caption.match(/#/g) || []).length, MAX_HASHTAGS);
  });

  test("truncates an over-long caption on a word boundary", () => {
    const r = readCaption("word ".repeat(1000));
    assert.equal(r.ok, true);
    assert.ok(r.caption.length <= CAPTION_MAX);
    assert.ok(r.caption.endsWith("…"));
    assert.ok(!/wor…$/.test(r.caption), "cut mid-word");
  });

  test("a caption at exactly the limit is not truncated", () => {
    const r = readCaption("x".repeat(CAPTION_MAX));
    assert.equal(r.caption.length, CAPTION_MAX);
    assert.ok(!r.caption.endsWith("…"));
  });

  // ── THE OWNER RULING, PINNED ─────────────────────────────────────────────
  test("a brand name passes straight through — captions name products normally", () => {
    for (const text of [
      "Nike Air Max 90 in white — R1 899, in store now.",
      "Adidas Sambas back in stock, all sizes.",
      "Real Madrid home shirt, 2018 season.",
      "Dolce & Gabbana, one only.",
    ]) {
      const r = readCaption(text);
      assert.equal(r.ok, true, `refused: ${text}`);
      assert.equal(r.caption, text);
    }
  });
});

describe("fallbackCaption", () => {
  const products = [{ name: "Alpha" }, { name: "Beta" }];

  test("never returns something readCaption would refuse", () => {
    for (const kind of ["single", "flatlay", "new_arrivals", "outfit"]) {
      const c = fallbackCaption({ kind, products });
      assert.ok(c.length >= CAPTION_MIN, `${kind} fallback is too short: ${JSON.stringify(c)}`);
      assert.equal(readCaption(c).ok, true, `${kind} fallback would be refused`);
    }
  });

  test("still produces something usable with no products at all", () => {
    for (const kind of ["single", "flatlay", "new_arrivals", "outfit"]) {
      const c = fallbackCaption({ kind, products: [] });
      assert.ok(c.length >= CAPTION_MIN, `${kind}: ${JSON.stringify(c)}`);
      assert.equal(readCaption(c).ok, true);
    }
    assert.ok(fallbackCaption({}).length >= CAPTION_MIN);
  });

  test("names the products it has", () => {
    assert.match(fallbackCaption({ kind: "outfit", products }), /Alpha/);
    assert.match(fallbackCaption({ kind: "outfit", products }), /Beta/);
  });

  test("is plainly different from a written caption, so nobody mistakes it for one", () => {
    const kinds = ["single", "flatlay", "new_arrivals", "outfit"].map((k) => fallbackCaption({ kind: k, products }));
    assert.equal(new Set(kinds).size, 4);
  });
});

// ─── THE VALIDATOR MUST NOT REACH THIS MODULE ────────────────────────────────
// Same pin as socialCore.test.js, on the functions side. The failure this
// guards against is silent: captions would still generate, they would just stop
// naming anything a customer could recognise.
describe("the Shopify brand validator is deliberately absent", () => {
  const FILES = ["../lib/social-caption.cjs", "../lib/social-select.cjs", "../lib/social-signal.cjs"];
  for (const f of FILES) {
    test(`${f} imports neither shopifyTriggers nor compliance`, () => {
      const src = readFileSync(join(__dirname, f), "utf8");
      const requires = src.match(/require\(\s*["'][^"']+["']\s*\)/g) || [];
      for (const r of requires) {
        assert.ok(!/shopifyTriggers/.test(r), `${f}: ${r}`);
        assert.ok(!/compliance/.test(r), `${f}: ${r}`);
      }
    });
  }
});

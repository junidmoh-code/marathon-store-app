// ─── FLAT-LAYS, PAIRINGS AND OUTFITS CHOSEN BY THE STYLIST ───────────────────
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const ss = require("../lib/social-stylist.cjs");
const { outfitSlot, PAIRING_SHAPES } = require("../lib/social-select.cjs");

const TAG = (over = {}) => ({ dominant: "black", secondary: null, pattern: "solid", silhouette: "regular", family: "streetwear", formality: 3, season: "all", gender: "mens", cut: "none", headwear: "cap", knit: false, source: "vision", ...over });
// A buildCandidates-shaped row.
const C = (pid, categoryKey, tag = {}, over = {}) => {
  const product = { categoryKey, brand: "Nike", name: `Nike ${categoryKey} ${pid}`, retailPrice: 500 };
  return { pid, product, name: `Thing ${pid}`, displayName: `Nike ${pid}`, retailPrice: 500, score: 0.5, slot: outfitSlot(product), _tag: TAG(tag), ...over };
};
const tagsOf = (list) => new Map(list.map((c) => [c.pid, c._tag]));

const POOL = () => [
  C("tee-black", "t-shirts", { silhouette: "oversized" }),
  C("tee-print", "t-shirts", { dominant: "orange", pattern: "print" }, { score: 1 }),
  C("hood-grey", "hoodies", { dominant: "grey" }),
  C("cargo-char", "pants", { dominant: "charcoal", silhouette: "slim" }),
  C("short-olive", "shorts", { dominant: "olive", season: "summer" }),
  C("af1-white", "sneakers", { dominant: "white", silhouette: "n/a" }),
  C("boot-stud", "soccer-boots", { dominant: "black", silhouette: "n/a", family: "athleisure", formality: 1 }),
  C("cap-black", "caps-beanies", { dominant: "black", silhouette: "n/a" }),
  C("bag-black", "bags", { dominant: "black", silhouette: "n/a" }),
  C("scent", "perfumes", { dominant: "black", silhouette: "n/a", formality: 4 }),
  C("track", "tracksuits", { dominant: "navy", family: "athleisure", formality: 2 }),
];

describe("styledPicksForKind", () => {
  test("pairing: one of the owner's shapes, never a top + bottom + shoe set", () => {
    const pool = POOL();
    const r = ss.styledPicksForKind("pairing", pool, { tags: tagsOf(pool) });
    assert.equal(r.reason, null);
    assert.ok(r.picks.length >= 2 && r.picks.length <= 3);
    assert.ok(PAIRING_SHAPES.some((s) => JSON.stringify(s) === JSON.stringify(r.shape)));
    for (const o of r.shortlist) {
      const slots = new Set(o.picks.map((p) => p.slot));
      assert.ok(!(slots.has("top") && slots.has("bottom") && slots.has("shoe")));
    }
  });

  test("outfit: top, bottoms and shoes; a tracksuit is top and bottoms; studs never with denim-world pieces", () => {
    const pool = POOL();
    const r = ss.styledPicksForKind("outfit", pool, { tags: tagsOf(pool) });
    assert.equal(r.reason, null);
    const slots = r.picks.map((p) => p.slot);
    assert.ok(slots.includes("shoe"));
    assert.ok(slots.includes("top"));
    assert.ok(slots.includes("bottom") || r.picks.some((p) => p.product.categoryKey === "tracksuits"));
    assert.ok(r.picks.length >= 3 && r.picks.length <= 5);
    for (const o of r.shortlist) {
      const keys = o.picks.map((p) => p.product.categoryKey);
      assert.ok(!(keys.includes("soccer-boots") && keys.includes("pants")), "fitsWith still applies");
      assert.ok(!(keys.includes("tracksuits") && (keys.includes("pants") || keys.includes("shorts"))), "nothing beside a tracksuit");
    }
  });

  test("flat-lay: three to five pieces from different slots, the same hard rules", () => {
    const pool = POOL();
    const r = ss.styledPicksForKind("flatlay", pool, { tags: tagsOf(pool) });
    assert.equal(r.reason, null);
    assert.ok(r.picks.length >= 3 && r.picks.length <= 5);
    for (const o of r.shortlist) {
      const loud = o.pieces.filter((p) => p.tags.pattern !== "solid" || ["orange"].includes(p.tags.dominant));
      assert.ok(loud.length <= 1);
      assert.equal(new Set(o.pieces.map((p) => p.slot)).size, o.pieces.length);
    }
  });

  test("today's products are never re-used; an untagged product is read from its name", () => {
    const pool = POOL();
    const tags = tagsOf(pool);
    tags.delete("af1-white");
    const r = ss.styledPicksForKind("pairing", pool, { tags, used: new Set(["tee-black"]) });
    assert.ok(!r.picks.some((p) => p.pid === "tee-black"));
    const named = ss.pieceOf(pool.find((c) => c.pid === "af1-white"), tags);
    assert.equal(named.tags.source, "name");
  });

  test("single and new-arrivals posts are not the stylist's", () => {
    assert.match(ss.styledPicksForKind("single", POOL()).reason, /does not choose/);
    assert.equal(ss.STYLED_KINDS.has("new_arrivals"), false);
  });

  test("nothing passes the guide: refused with a reason, never an unstyled pile", () => {
    const loud = [C("a", "t-shirts", { pattern: "print" }), C("b", "sneakers", { pattern: "logo-heavy", silhouette: "n/a" })];
    const r = ss.styledPicksForKind("pairing", loud, { tags: tagsOf(loud) });
    assert.deepEqual(r.picks, []);
    assert.match(r.reason, /passes the style guide/);
  });
});

describe("chooseStyledPicks", () => {
  test("the model's option, look and note; a pairing note never calls it a look", () => {
    const pool = POOL();
    const r = ss.styledPicksForKind("pairing", pool, { tags: tagsOf(pool) });
    const n = r.shortlist.length;
    const c = ss.chooseStyledPicks("pairing", r, JSON.stringify({ choice: n, look: "x", note: "The grey and white keep it calm and clean." }));
    assert.deepEqual(c.picks, r.shortlist[n - 1].picks);
    assert.equal(c.look.note, "The grey and white keep it calm and clean.");
    const bad = ss.chooseStyledPicks("pairing", r, JSON.stringify({ choice: 1, note: "A great look for the weekend" }));
    assert.doesNotMatch(bad.look.note, /\b(look|outfit|fit)\b/i);
    assert.match(ss.styledChoicePrompt("pairing", r), /Never call them an outfit/);
  });
});

// ── JUNID'S REVIEW OF SAMPLES 06–08 (19 Oct): THE SAME RULES ON EVERY POST ──
describe("flat-lays, pairings and outfits are men's, caps-only in summer, real names only", () => {
  test("the women's Alo bike shorts never reach a pairing, an outfit or a flat-lay", () => {
    const pool = [...POOL(), C("alo", "shorts", { dominant: "cream", gender: "womens", cut: "bike-short", season: "summer" }, {
      name: "High-waisted compression bike shorts with side pockets", displayName: "Alo Airlift high-rise short", score: 1,
      product: { categoryKey: "shorts", brand: "Alo", name: "Alo Airlift high-rise short", retailPrice: 350 } })];
    for (const kind of ["pairing", "outfit", "flatlay"]) {
      const r = ss.styledPicksForKind(kind, pool, { tags: tagsOf(pool) });
      assert.ok(!r.shortlist.some((o) => o.pieces.some((p) => p.pid === "alo")), kind);
    }
  });
  test("a beanie is not a cap in October", () => {
    const pool = [...POOL().filter((c) => c.pid !== "cap-black"), C("beanie", "caps-beanies", { silhouette: "n/a", headwear: "beanie", season: "winter" }, { score: 1, name: "Ribbed knit beanie" })];
    const r = ss.styledPicksForKind("pairing", pool, { tags: tagsOf(pool), month: 10 });
    assert.ok(!r.shortlist.some((o) => o.pieces.some((p) => p.pid === "beanie")));
  });
  test("a raw display name is never a piece", () => {
    const t = TAG();
    assert.equal(ss.pieceOf(C("jb", "jackets", {}, { displayName: "Jacket brown", product: { categoryKey: "jackets", brand: "Jacket", name: "Jacket brown #1513" } }), new Map([["jb", t]])), null);
    assert.equal(ss.pieceOf(C("ww", "t-shirts", {}, { displayName: "Wanchao Wear 6925", product: { categoryKey: "t-shirts", brand: "Wanchao", name: "Wanchao Wear 6925" } }), new Map([["ww", t]])), null);
    assert.equal(ss.pieceOf(C("bg", "bags", {}, { displayName: "Bag Green", product: { categoryKey: "bags", brand: "", name: "Bag Green" } }), new Map([["bg", t]])), null);
    assert.ok(ss.pieceOf(C("ok", "t-shirts", {}, { displayName: "Nike Sportswear Club tee" }), new Map([["ok", t]])));
  });
});

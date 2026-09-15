// ─── THE CATEGORY KEY THE POLICY RESOLVES THROUGH, and the coverage buckets ──
//
// Two things landed together on 2026-09-15 and this file pins both:
//
//   1. policyCategoryKey — the engine applies the catalogue's own legacy-sneaker
//      rule (src/utils/productTaxonomy.js effectiveCategoryKey): a keyless
//      record that is category "Footwear" + subcategory "Sneakers" IS a
//      sneaker to the category policy. The Sneakers LEAF only; an assigned key
//      always wins; explicit rows still outrank; carriedOnly still decides
//      WHERE. The engine copy is pinned EQUAL to the app function over a fuzz,
//      so the two cannot drift apart without this file going red.
//
// Every test here asserts a NUMBER or a RESOLVED TARGET, never a title — a
// test that only checks the bucket exists would pass with an empty loop.
//
// Run: cd functions && node --test test/policy-category-key.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan, resolveTarget, categoryPolicyEntry, policyCategoryKey } = require("../lib/refill-engine.cjs");

const NOW = Date.parse("2026-09-15T09:00:00.000Z");
const RUN = {
  6: { target: 3, minQty: 2, reorderPoint: 1 }, 7: { target: 3, minQty: 2, reorderPoint: 1 },
  8: { target: 3, minQty: 2, reorderPoint: 1 }, "5_5": { target: 2, minQty: 1, reorderPoint: 1 },
};
const SNEAKERS = { perSize: true, hub1: { sizes: RUN, carriedOnly: true }, hub2: { sizes: RUN, carriedOnly: true } };
const SLIDES = { perSize: true, hub1: { sizes: { 6: { target: 1, minQty: 1 } }, carriedOnly: true } };

// The live shapes, verbatim in spirit. `legacy` is p1785153420278 — Adidas
// campus black white — created 27 Jul 2026, three days before #280 made a key
// mandatory: category Footwear, subcategory Sneakers, productType sneaker, NO
// categoryKey. `keyed` is the same shoe as the form writes it today.
const PRODUCTS = {
  legacy: { id: "legacy", name: "Adidas campus black white ", category: "Footwear", subcategory: "Sneakers", productType: "sneaker", sizes: ["5.5", "6", "7", "8"] },
  keyed: { id: "keyed", name: "Adidas Campus Black White", category: "Footwear", subcategory: "Sneakers", categoryKey: "sneakers", sizes: ["5.5", "6", "7", "8"] },
  soccer: { id: "soccer", name: "Soccer boot", category: "Footwear", subcategory: "Soccer Boots", productType: "sneaker", sizes: ["6", "7"] },
  nosub: { id: "nosub", name: "Labubu", category: "Footwear", productType: "sneaker", sizes: ["6"] },
  slideAsSneaker: { id: "slideAsSneaker", name: "Karl slide", category: "Footwear", subcategory: "Sneakers", categoryKey: "slides", sizes: ["6"] },
  boot: { id: "boot", name: "Boss Suede Ankle Boot", category: "Footwear", subcategory: "Boots", categoryKey: "designer-shoes", sizes: ["6", "7"] },
  retired: { id: "retired", name: "Old line", category: "Footwear", subcategory: "Sneakers", sizes: ["6"], deactivated: { at: 1, by: "x" } },
  shirt: { id: "shirt", name: "Shirt", categoryKey: "t-shirts", productType: "clothing", category: "Clothing", sizes: ["M", "L"] },
  centralOnly: { id: "centralOnly", name: "Nike airforce 1 cream", category: "Footwear", subcategory: "Sneakers", categoryKey: "sneakers", sizes: ["6", "7"] },
};
const STOCK = {
  hub1: {
    legacy: { "5_5": { qty: 0 }, 6: { qty: 1 }, 7: { qty: 0 } },
    keyed: { 6: { qty: 1 } },
    boot: { 6: { qty: 1 } },
    slideAsSneaker: { 6: { qty: 1 } },
  },
  hub2: {
    legacy: { 6: { qty: 0 }, 7: { qty: 1 }, 8: { qty: 2 } },
    soccer: { 6: { qty: 2 } },
    nosub: { 6: { qty: 3 } },
    boot: { 6: { qty: 12 } },
    retired: { 6: { qty: 4 } },
    shirt: { M: { qty: 0 }, L: { qty: 1 } },
  },
  central: {
    legacy: { "5_5": { qty: 10 }, 6: { qty: 10 }, 7: { qty: 10 }, 8: { qty: 10 } },
    keyed: { 6: { qty: 10 } },
    centralOnly: { 6: { qty: 30 } },
    nosub: { 6: { qty: 157 } },
    shirt: { M: { qty: 10 }, L: { qty: 10 } },
  },
  "marathon-pe": { legacy: { 6: { qty: 1 } } },
  trophy: {},
};
function cfg(over = {}) {
  return {
    mode: { hub1: "live", hub2: "live", "marathon-pe": "live", trophy: "live" },
    routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
    ruleBasedTargets: true, maxIntentsPerRun: 200, maxFootwearIntentsPerRun: 200, maxUnitsPerIntent: 20,
    defaultRunByStore: { hub2: { M: 3, L: 3 } },
    categoryPolicy: { sneakers: SNEAKERS, slides: SLIDES },
    ...over,
  };
}
const ctx = (over = {}) => ({ config: cfg(over.config), products: over.products || PRODUCTS, stock: over.stock || STOCK, targets: over.targets || {} });
const snap = (over = {}) => ({
  nowMs: NOW, config: cfg(over.config), products: over.products || PRODUCTS, stock: over.stock || STOCK, targets: over.targets || {},
  openIndex: {}, refillRequests: {}, orders: {}, movements: [], targetDecisions: {}, rejectStreak: {}, retryState: {}, heldLines: {},
});

// ── 1. THE KEY RULE ──────────────────────────────────────────────────────────
test("a keyless Footwear+Sneakers record resolves the sneakers per-size policy where it is carried", () => {
  const t = resolveTarget(ctx(), "hub1", "legacy", "6");
  assert.deepEqual(t, { target: 3, minQty: 2, reorderPoint: 1, source: "category_policy" });
  // Byte-same answer as the keyed twin — the rule makes them the same product to the policy.
  assert.deepEqual(resolveTarget(ctx(), "hub1", "legacy", "6"), resolveTarget(ctx(), "hub1", "keyed", "6"));
  // The half size goes through the same encoded lookup ("5.5" → map key "5_5"):
  // hub2 carries the product and Central holds 10 of 5.5, so it arms at 2.
  assert.equal(resolveTarget(ctx(), "hub2", "legacy", "5.5")?.target, 2);
});

test("HOW MANY, never WHERE: carriedOnly still refuses a hub with no cell, and a shop is never armed", () => {
  const noHub1 = { ...STOCK, hub1: {} };
  assert.equal(resolveTarget(ctx({ stock: noHub1 }), "hub1", "legacy", "6"), null, "no hub1 cell → nothing at hub1");
  assert.equal(resolveTarget(ctx(), "marathon-pe", "legacy", "6"), null, "the policy names no shop leg; a shop cell arms nothing");
  assert.equal(categoryPolicyEntry(cfg(), PRODUCTS, noHub1, "legacy", "hub1"), null);
  assert.ok(categoryPolicyEntry(cfg(), PRODUCTS, STOCK, "legacy", "hub2"));
});

test("the Sneakers LEAF only: Soccer Boots and a missing subcategory resolve no key and no target", () => {
  assert.equal(policyCategoryKey(PRODUCTS.soccer), null);
  assert.equal(policyCategoryKey(PRODUCTS.nosub), null);
  assert.equal(resolveTarget(ctx(), "hub2", "soccer", "6"), null);
  assert.equal(resolveTarget(ctx(), "hub2", "nosub", "6"), null);
  // The whole Footwear top must NOT fold in: a "Boots" subcategory with no key is not a sneaker.
  assert.equal(policyCategoryKey({ category: "Footwear", subcategory: "Boots" }), null);
});

test("an assigned key always wins over the legacy pair", () => {
  assert.equal(policyCategoryKey(PRODUCTS.slideAsSneaker), "slides");
  const t = resolveTarget(ctx(), "hub1", "slideAsSneaker", "6");
  assert.equal(t.target, 1, "resolved through the slides policy (target 1), not sneakers (target 3)");
  // Padded keys are trimmed, exactly as the app's isAssigned/effectiveCategoryKey do.
  assert.equal(policyCategoryKey({ categoryKey: "  sneakers " }), "sneakers");
  assert.equal(policyCategoryKey({ categoryKey: "   ", category: "Footwear", subcategory: "Sneakers" }), "sneakers", "a blank key is absent, so the legacy pair applies");
});

test("an explicit target-0 row (Seating switch-off) still outranks the policy on a legacy sneaker", () => {
  const targets = { hub1: { legacy: { 6: { target: 0, minQty: 0, source: "seating_off" } } } };
  const t = resolveTarget(ctx({ targets }), "hub1", "legacy", "6");
  assert.deepEqual(t, { target: 0, minQty: 0, reorderPoint: null, source: "explicit" });
});

test("a deactivated legacy sneaker resolves nothing", () => {
  assert.equal(resolveTarget(ctx(), "hub2", "retired", "6"), null);
});

test("CONTRACT: policyCategoryKey equals the app's effectiveCategoryKey on a fuzz of records", async () => {
  const { effectiveCategoryKey } = await import("../../src/utils/productTaxonomy.js");
  let s = 20260915;
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const pick = (a) => a[Math.floor(r() * a.length)];
  const KEYS = ["sneakers", "slides", "soccer-boots", "", "  ", "  sneakers ", null, undefined, 7];
  const CATS = ["Footwear", "Clothing", "footwear", "", null, undefined];
  const SUBS = ["Sneakers", "sneakers", "Soccer Boots", "Boots", "", null, undefined];
  let legacyHits = 0;
  for (let i = 0; i < 5000; i++) {
    const p = r() < 0.05 ? pick([null, undefined, "x", 3]) : { categoryKey: pick(KEYS), category: pick(CATS), subcategory: pick(SUBS) };
    const a = policyCategoryKey(p), b = effectiveCategoryKey(p);
    assert.equal(a, b, `record ${JSON.stringify(p)}: engine ${a} vs app ${b}`);
    if (a === "sneakers" && !(typeof p?.categoryKey === "string" && p.categoryKey.trim())) legacyHits++;
  }
  assert.ok(legacyHits > 50, `the fuzz must actually exercise the legacy pair (hit ${legacyHits} times)`);
});

// ── 2. THE PLAN: arming by the map, quantities only ──────────────────────────
test("the scan raises Hub 1 / Hub 2 intents for a legacy sneaker from Central, and none for a shop", () => {
  const plan = computeRefillPlan(snap());
  const mine = plan.intents.filter((i) => i.productId === "legacy");
  const byDest = mine.reduce((m, i) => { m[i.dest] = (m[i.dest] || 0) + 1; return m; }, {});
  // hub1 carries 5.5/6/7 (8 has no cell but the per-size map arms every declared
  // size — sizesFor walks the map ∩ declared) — below target with Central supply.
  assert.ok((byDest.hub1 || 0) >= 3, `expected ≥3 hub1 lines, got ${JSON.stringify(byDest)}`);
  assert.ok((byDest.hub2 || 0) >= 2, `expected ≥2 hub2 lines, got ${JSON.stringify(byDest)}`);
  assert.equal(byDest["marathon-pe"] || 0, 0, "a shop leg is never armed by this");
  assert.equal(byDest.trophy || 0, 0);
  for (const i of mine) assert.equal(i.source, "central");
});

test("with the legacy pair removed from the record, the same shoe raises nothing (the rule is the only reason it arms)", () => {
  const products = { ...PRODUCTS, legacy: { ...PRODUCTS.legacy, subcategory: "Trainers" } };
  const plan = computeRefillPlan(snap({ products }));
  assert.equal(plan.intents.filter((i) => i.productId === "legacy").length, 0);
});

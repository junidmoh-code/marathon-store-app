// ─── SUBCATEGORY POLICY ("watches keep 2") — tests ────────────────────────────
// config.subcategoryRunByLocation lets a standing target be expressed per
// CATEGORY rather than per SIZE. It exists because watches are one-size ("_")
// and defaultRunByStore holds only garment letters, so no watch ever resolved a
// target.
//
// The load-bearing property is CONTAINMENT. The rejected shortcut — adding "_"
// to defaultRunByStore — would have armed every one-size product in the
// catalogue (20 sunglasses, 4 belts, 4 jewellery lines carried at Trophy/PE
// alongside the 6 watches). Most of this file pins what must NOT move.
//
// Run: cd functions && node --test test/refill-watch-subcategory.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan, resolveTarget, subcategoryRun } = require("../lib/refill-engine.cjs");

const NOW = Date.parse("2026-08-03T09:00:00.000Z");

// The live shapes, copied from /products (2026-08-03).
const WATCH     = { id: "w1", name: "Swarovski Crystal Rose Watch", category: "Accessories", subcategory: "Watches",  productType: "clothing", sizes: ["_"] };
const WATCH_S   = { id: "w2", name: "Patek watch",                  category: "Accessories", subcategory: "Watches",  productType: "clothing", sizes: ["S"] };
const GLASSES   = { id: "g1", name: "Ray-Ban Glasses",              category: "Accessories", subcategory: "Eyewear",  productType: "clothing", sizes: ["_"] };
const BELT      = { id: "b1", name: "Belt Premium",                 category: "Accessories", subcategory: "Belts",    productType: "clothing", sizes: ["_"] };
const TSHIRT    = { id: "t1", name: "Nike Tee",                     category: "Clothing",    subcategory: "T-Shirts", productType: "clothing", sizes: ["S", "M", "L"] };
// Perfume as it really is: NO productType, so isClothing()'s heuristic sees no
// garment letter and returns false. Its policy is explicit rows, and it must
// stay that way no matter what this config node says.
const PERFUME   = { id: "pf1", name: "Queen of Fire", category: "Perfume", subcategory: "Perfume", sizes: ["_"] };

const PRODUCTS = { w1: WATCH, w2: WATCH_S, g1: GLASSES, b1: BELT, t1: TSHIRT, pf1: PERFUME };

const WATCH_POLICY = { hub2: { Watches: 2 }, trophy: { Watches: 2 }, "marathon-pe": { Watches: 2 } };
const SIZE_RUN = {
  hub2: { S: 2, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 1 },
  trophy: { S: 2, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 1 },
  "marathon-pe": { S: 2, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 1 },
};

// Every product above carried at trophy (a cell exists — qty is irrelevant to
// storeCarries) so the rule branch is reachable for all of them.
const CARRIED = {
  trophy: { w1: { _: { qty: 0 } }, w2: { S: { qty: 0 } }, g1: { _: { qty: 0 } }, b1: { _: { qty: 0 } }, t1: { M: { qty: 0 } }, pf1: { _: { qty: 0 } } },
  hub2:   { w1: { _: { qty: 50 } } },
  central: { w1: { _: { qty: 174 } } },
};

// NOTE: the policy is read with an `in` check, NOT a destructuring default —
// passing an explicit `undefined` has to mean "the key is missing from config",
// which is the exact case the kill-switch tests below need to exercise. A
// default parameter would silently substitute WATCH_POLICY and those tests
// would pass while asserting nothing.
function ctx(opts = {}) {
  const { ruleBasedTargets = true, targets = {}, stock = CARRIED } = opts;
  const subcategoryRunByLocation = "subcategoryRunByLocation" in opts ? opts.subcategoryRunByLocation : WATCH_POLICY;
  return {
    targets,
    config: { ruleBasedTargets, defaultRunByStore: SIZE_RUN, subcategoryRunByLocation, routes: { trophy: "hub2", hub2: "central" } },
    products: PRODUCTS,
    stock,
  };
}

// ── 1. the feature itself ────────────────────────────────────────────────────

test("a carried watch resolves the subcategory target on its one-size cell", () => {
  const t = resolveTarget(ctx(), "trophy", "w1", "_");
  assert.ok(t, "a watch at a store that carries it must now resolve a target");
  assert.equal(t.target, 2);
  assert.equal(t.minQty, 1, "minQty follows the rule-branch convention max(1, target-1)");
  assert.equal(t.reorderPoint, null, "a policy carries no reorder point — that belongs on an approved row");
  assert.equal(t.source, "subcategory_default");
});

test("the policy applies at every location it is configured for", () => {
  for (const loc of ["hub2", "trophy", "marathon-pe"]) {
    const stock = { [loc]: { w1: { _: { qty: 0 } } } };
    assert.equal(resolveTarget(ctx({ stock }), loc, "w1", "_").target, 2, `${loc} must honour the policy`);
  }
});

test("a location absent from the policy map gets no target", () => {
  const stock = { hub1: { w1: { _: { qty: 0 } } } };
  assert.equal(resolveTarget(ctx({ stock }), "hub1", "w1", "_"), null,
    "hub1 is not in the policy — absent must mean off, not inherit another location's number");
});

test("subcategory beats the size run for a watch mis-filed with a garment size", () => {
  const t = resolveTarget(ctx(), "trophy", "w2", "S");
  assert.equal(t.target, 2, "'watches keep 2' must hold for every watch");
  assert.equal(t.source, "subcategory_default", "not the garment S standard");
});

// ── 2. CONTAINMENT — what must NOT move ──────────────────────────────────────

test("one-size products in OTHER subcategories stay unmanaged", () => {
  assert.equal(resolveTarget(ctx(), "trophy", "g1", "_"), null, "sunglasses must not be armed");
  assert.equal(resolveTarget(ctx(), "trophy", "b1", "_"), null, "belts must not be armed");
});

test("perfume is untouched even if someone adds a Perfume key to the policy", () => {
  const withPerfume = ctx({ subcategoryRunByLocation: { ...WATCH_POLICY, trophy: { Watches: 2, Perfume: 5 } } });
  assert.equal(resolveTarget(withPerfume, "trophy", "pf1", "_"), null,
    "perfume carries no productType, so it is not clothing and never reaches the rule branch at all");
});

test("ordinary clothing resolves exactly the size run it always did", () => {
  const withPolicy = resolveTarget(ctx(), "trophy", "t1", "M");
  const withoutPolicy = resolveTarget(ctx({ subcategoryRunByLocation: undefined }), "trophy", "t1", "M");
  assert.deepEqual(withPolicy, withoutPolicy, "the policy node must be invisible to non-policy products");
  assert.equal(withPolicy.target, 2);
  assert.equal(withPolicy.source, "default");
});

test("a watch the store does NOT carry still resolves nothing", () => {
  const t = resolveTarget(ctx({ stock: { trophy: {} } }), "trophy", "w1", "_");
  assert.equal(t, null, "carriage remains the gate — Solve is what puts a watch on a store's list");
});

test("a size that is not in the product's catalogue gets no target", () => {
  assert.equal(resolveTarget(ctx(), "trophy", "w1", "XL"), null,
    "the policy applies to catalogue sizes only — it must not invent cells");
});

// ── 3. both off-switches ─────────────────────────────────────────────────────

test("deleting the config node kills the policy live", () => {
  for (const v of [undefined, null, {}, { trophy: {} }]) {
    assert.equal(resolveTarget(ctx({ subcategoryRunByLocation: v }), "trophy", "w1", "_"), null,
      `absent/empty policy (${JSON.stringify(v)}) must resolve nothing`);
  }
});

test("ruleBasedTargets:false kills the subcategory policy too", () => {
  assert.equal(resolveTarget(ctx({ ruleBasedTargets: false }), "trophy", "w1", "_"), null,
    "the one big red button must take this with it — it is a refinement of the clothing rule");
});

test("garbage in the policy resolves to no policy, never to a garbage target", () => {
  for (const bad of [0, -1, "2", NaN, Infinity, true, null, {}, []]) {
    const t = resolveTarget(ctx({ subcategoryRunByLocation: { trophy: { Watches: bad } } }), "trophy", "w1", "_");
    assert.equal(t, null, `Watches:${JSON.stringify(bad)} must not arm a target`);
  }
  const arrayRun = resolveTarget(ctx({ subcategoryRunByLocation: { trophy: [2] } }), "trophy", "w1", "_");
  assert.equal(arrayRun, null, "an array where a map belongs must not be indexed into");
});

test("subcategoryRun is a pure lookup with no side conditions", () => {
  assert.equal(subcategoryRun({ subcategoryRunByLocation: WATCH_POLICY }, PRODUCTS, "w1", "trophy"), 2);
  assert.equal(subcategoryRun({ subcategoryRunByLocation: WATCH_POLICY }, PRODUCTS, "g1", "trophy"), null);
  assert.equal(subcategoryRun({}, PRODUCTS, "w1", "trophy"), null);
  assert.equal(subcategoryRun({ subcategoryRunByLocation: WATCH_POLICY }, { w1: { sizes: ["_"] } }, "w1", "trophy"), null,
    "a product with no subcategory field must not match anything");
});

// ── 4. an explicit row still outranks the policy ─────────────────────────────

test("an explicit /stock_targets row wins over the subcategory policy", () => {
  const t = resolveTarget(ctx({ targets: { trophy: { w1: { _: { target: 6, minQty: 3 } } } } }), "trophy", "w1", "_");
  assert.equal(t.target, 6, "a human's row always wins");
  assert.equal(t.source, "explicit");
});

test("an explicit target of 0 still means deliberately excluded", () => {
  const t = resolveTarget(ctx({ targets: { trophy: { w1: { _: { target: 0 } } } } }), "trophy", "w1", "_");
  assert.equal(t.target, 0, "the policy must not resurrect a watch a human switched off");
  assert.equal(t.source, "explicit");
});

// ── 5. end to end through the planner ────────────────────────────────────────

test("a carried, empty watch at Trophy produces a 2-unit refill intent from Hub 2", () => {
  const plan = computeRefillPlan({
    nowMs: NOW,
    config: {
      routes: { trophy: "hub2", hub2: "central" },
      mode: { trophy: "live", hub2: "live" },
      ruleBasedTargets: true,
      defaultRunByStore: SIZE_RUN,
      subcategoryRunByLocation: WATCH_POLICY,
      maxUnitsPerIntent: 20,
    },
    products: { w1: WATCH },
    stock: {
      trophy: { w1: { _: { qty: 0 } } },     // carried, empty — seeded by Solve
      hub2: { w1: { _: { qty: 50 } } },
      central: { w1: { _: { qty: 174 } } },
    },
    targets: {},
  });
  const intent = (plan.intents || []).find((i) => i.dest === "trophy" && i.productId === "w1");
  assert.ok(intent, "the whole point: a seeded watch cell must now generate a refill");
  assert.equal(intent.qty, 2, "top up to the policy target");
  assert.equal(intent.size, "_", "on the one-size cell, not an invented size");
});

test("without the policy that same watch generates nothing", () => {
  const plan = computeRefillPlan({
    nowMs: NOW,
    config: {
      routes: { trophy: "hub2", hub2: "central" },
      mode: { trophy: "live", hub2: "live" },
      ruleBasedTargets: true,
      defaultRunByStore: SIZE_RUN,
      maxUnitsPerIntent: 20,
    },
    products: { w1: WATCH },
    stock: { trophy: { w1: { _: { qty: 0 } } }, hub2: { w1: { _: { qty: 50 } } }, central: { w1: { _: { qty: 174 } } } },
    targets: {},
  });
  assert.equal((plan.intents || []).filter((i) => i.productId === "w1").length, 0,
    "this is the pre-change behaviour that made every watch invisible to the engine");
});

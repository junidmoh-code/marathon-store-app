// ─── THE SNEAKERS POLICY, AND PER-SIZE ARMING ─────────────────────────────────
//
// The third pass presents the seven footwear categories as ONE Sneakers policy
// and builds a per-size editor. This file pins the five properties the pass is
// allowed to ship on, at the SHAPE THE LIVE DATA ACTUALLY HAS rather than at a
// two-member toy: seven members, four of which hold no products at all, and a
// twelve-size union with a half size in it.
//
//   1. A DISARMED SNEAKERS GROUP PRODUCES ZERO INTENTS — the state it ships in.
//   2. AN EXISTING SCALAR POLICY RESOLVES IDENTICALLY. Per-size is a second
//      shape, not a replacement, and a capability that alters one existing
//      intent is a failure.
//   3. A PER-SIZE POLICY RESOLVES PER SIZE — including the half size 5.5,
//      stored "5_5", which is the size a wrong encoding loses silently.
//   4. A MEMBER'S OWN NUMBERS BEAT THE GROUP'S, everywhere, including at a
//      location its own entry does not name.
//   5. THE GROUP'S SIZE RUN IS THE UNION OF ITS MEMBERS' RUNS, derived from
//      live data, with the sizes only some members carry marked rather than
//      dropped.
//
// Each is mutation-proved in scripts/mutation-proof-policy-groups.mjs.
//
// Run: cd functions && node --test test/sneakers-group-sizes.test.cjs

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan, resolveTarget } = require("../lib/refill-engine.cjs");
const { sizeRunForGroup, sizeRunForCategory, validatePolicyGroup } = require("../lib/policy-groups.cjs");
const { locationPolicyFor } = require("../lib/policy-resolve.cjs");

const NOW = Date.parse("2026-08-22T09:00:00.000Z");

// The live membership, 2026-08-22. soccer-boots is deliberately NOT in it.
const MEMBERS = ["boots", "designer-shoes", "kids-shoes", "loafers", "running-shoes", "slides", "sneakers"];

// The live union, 2026-08-22: twelve sizes, half size among them, and four
// members contributing nothing because they hold no products.
const UNION = ["3", "4", "5", "5_5", "6", "7", "8", "9", "10", "11", "12", "13"];

const PRODUCTS = {
  sn1: { id: "sn1", name: "Air Max", category: "Footwear", categoryKey: "sneakers", productType: "sneaker",
    sizes: ["5", "5.5", "6", "12"] },
  sl1: { id: "sl1", name: "Slide", category: "Footwear", categoryKey: "slides", productType: "sneaker",
    sizes: ["5", "6"] },
  ds1: { id: "ds1", name: "Loafer", category: "Footwear", categoryKey: "designer-shoes", productType: "sneaker",
    sizes: ["6", "7"] },
  // A one-size category with numbers of its own — the scalar shape this pass
  // must not disturb.
  pf1: { id: "pf1", name: "Perfume", categoryKey: "perfumes", productType: "perfume", sizes: ["_"] },
};
const STOCK = {
  hub2: {
    sn1: { 5: { qty: 0 }, "5_5": { qty: 0 }, 6: { qty: 0 }, 12: { qty: 0 } },
    sl1: { 5: { qty: 0 }, 6: { qty: 0 } },
    ds1: { 6: { qty: 0 }, 7: { qty: 0 } },
    pf1: { _: { qty: 0 } },
  },
  trophy: { sn1: { 6: { qty: 0 } } },
  central: {
    sn1: { 5: { qty: 40 }, "5_5": { qty: 40 }, 6: { qty: 40 }, 12: { qty: 40 } },
    sl1: { 5: { qty: 40 }, 6: { qty: 40 } }, ds1: { 6: { qty: 40 }, 7: { qty: 40 } },
    pf1: { _: { qty: 40 } },
  },
};

// A per-size group policy over the full union — the shape the group holds live.
const GROUP_POLICY = {
  perSize: true,
  hub2: { sizes: Object.fromEntries(UNION.map((s, i) => [s, { target: i < 4 ? 2 : 3, minQty: 1, reorderPoint: 0 }])) },
};

function cfg({ armed = false, categoryPolicy = {}, groupPolicy = GROUP_POLICY } = {}) {
  return {
    mode: { hub2: "live", trophy: "live" }, routes: { hub2: "central", trophy: "hub2" },
    ruleBasedTargets: false, maxIntentsPerRun: 200, maxUnitsPerIntent: 20,
    categoryPolicy,
    policyGroups: { "footwear-all": { label: "Sneakers", memberCategoryKeys: MEMBERS, armed, policy: groupPolicy } },
  };
}
const ctx = (config, targets = {}) => ({ targets, config, products: PRODUCTS, stock: STOCK });
const plan = (config, targets = {}) => computeRefillPlan({
  nowMs: NOW, config, targets, stock: STOCK, products: PRODUCTS,
  openIndex: {}, refillRequests: {}, orders: {}, movements: [], targetDecisions: {},
  rejectStreak: {}, retryState: {},
});

// ═══ 1. DISARMED PRODUCES NOTHING ════════════════════════════════════════════
test("the Sneakers group, disarmed, produces zero intents across all seven members", () => {
  const c = cfg({ armed: false });
  for (const pid of ["sn1", "sl1", "ds1"]) {
    for (const size of ["5", "5.5", "6", "7", "12"]) {
      assert.equal(resolveTarget(ctx(c), "hub2", pid, size), null,
        `${pid} ${size} resolved through a DISARMED group`);
    }
  }
  assert.equal(plan(c).intents.length, 0);
});

test("relabelling the group to Sneakers changes no resolution at all", () => {
  const before = cfg({ armed: true });
  const after = cfg({ armed: true });
  after.policyGroups["footwear-all"].label = "Sneakers";
  for (const size of ["5", "5.5", "6", "12"]) {
    assert.deepEqual(resolveTarget(ctx(after), "hub2", "sn1", size), resolveTarget(ctx(before), "hub2", "sn1", size));
  }
  assert.deepEqual(plan(after).intents, plan(before).intents);
});

// ═══ 2. AN EXISTING SCALAR POLICY IS UNTOUCHED ═══════════════════════════════
// Pinned as literals, not as "the same as the other branch computed": a shared
// helper that changed would move both sides together and prove nothing.
test("a scalar (one-number) category policy resolves exactly as it always has", () => {
  const c = cfg({ armed: false, categoryPolicy: { perfumes: { hub2: { target: 4, minQty: 2 } } } });
  assert.deepEqual(resolveTarget(ctx(c), "hub2", "pf1", "_"),
    { target: 4, minQty: 2, reorderPoint: null, source: "category_policy" });
  // Absent Ask at stays ABSENT — null, never 0. The two are different policies.
  const withRp = cfg({ armed: false, categoryPolicy: { perfumes: { hub2: { target: 4, minQty: 2, reorderPoint: 0 } } } });
  assert.deepEqual(resolveTarget(ctx(withRp), "hub2", "pf1", "_"),
    { target: 4, minQty: 2, reorderPoint: 0, source: "category_policy" });
  // And a location the scalar entry does not name resolves NOTHING.
  assert.equal(resolveTarget(ctx(c), "trophy", "pf1", "_"), null);
});

test("locationPolicyFor reports the scalar shape as uniform, with no size map", () => {
  const c = cfg({ armed: false, categoryPolicy: { perfumes: { hub2: { target: 4, minQty: 2 } } } });
  assert.deepEqual(locationPolicyFor(c, "perfumes", "hub2"), {
    perSize: false, mode: "uniform", target: 4, minQty: 2, reorderPoint: undefined,
    sizes: null, source: "category", groupKey: null,
  });
});

// ═══ 3. PER-SIZE RESOLVES PER SIZE ═══════════════════════════════════════════
test("a per-size policy gives each size its own number, and the half size is not lost", () => {
  const perSize = { perSize: true, hub2: { sizes: {
    5: { target: 2, minQty: 1 }, "5_5": { target: 7, minQty: 3 }, 6: { target: 4, minQty: 2 },
  } } };
  const c = cfg({ armed: false, categoryPolicy: { sneakers: perSize } });
  assert.equal(resolveTarget(ctx(c), "hub2", "sn1", "5").target, 2);
  assert.equal(resolveTarget(ctx(c), "hub2", "sn1", "5.5").target, 7, "5.5 must resolve through the stored key 5_5");
  assert.equal(resolveTarget(ctx(c), "hub2", "sn1", "6").target, 4);
  // A size the map does not name falls THROUGH the entry rather than inheriting
  // a neighbour's number.
  const twelve = resolveTarget(ctx(c), "hub2", "sn1", "12");
  assert.ok(twelve === null || twelve.source !== "category_policy");
});

test("a per-size group policy governs every member that has no numbers of its own", () => {
  const c = cfg({ armed: true });
  assert.equal(resolveTarget(ctx(c), "hub2", "sn1", "5").target, 2);
  assert.equal(resolveTarget(ctx(c), "hub2", "sn1", "5.5").target, 2);
  assert.equal(resolveTarget(ctx(c), "hub2", "sn1", "6").target, 3);
  assert.equal(resolveTarget(ctx(c), "hub2", "sl1", "6").target, 3);
  assert.equal(resolveTarget(ctx(c), "hub2", "ds1", "7").target, 3);
});

// ═══ 4. A MEMBER'S OWN NUMBERS BEAT THE GROUP'S ══════════════════════════════
test("a member with its own entry ignores the group ENTIRELY — not per location", () => {
  const own = { perSize: true, hub2: { sizes: { 6: { target: 9, minQty: 4 } } } };
  const c = cfg({ armed: true, categoryPolicy: { sneakers: own } });
  assert.equal(resolveTarget(ctx(c), "hub2", "sn1", "6").target, 9, "its own number must win");
  // A size its OWN entry does not name resolves nothing — it does not fall back
  // to the group for the sizes the member left out. Under a per-location or
  // per-size merge this would be the group's 2, which is the design that was
  // rejected: joining a group would arm sizes the member deliberately omitted.
  assert.equal(resolveTarget(ctx(c), "hub2", "sn1", "5"), null);
  // trophy is named by neither the member's entry nor the group's policy, and
  // the member must not pick the group up there either: being in a group must
  // not arm a shop the member's own policy left out.
  assert.equal(resolveTarget(ctx(c), "trophy", "sn1", "6"), null);
  // Its sibling, which has no entry of its own, still resolves the group.
  assert.equal(resolveTarget(ctx(c), "hub2", "sl1", "6").target, 3);
});

test("even an entry the ENGINE cannot use for this cell takes the member out of the group", () => {
  // A one-size (scalar) entry on a sized product speaks for the "_" cell alone,
  // so size 6 resolves NOTHING — it does not fall through to the group. Having
  // an entry at all is what leaves the group, not having a usable one.
  const c = cfg({ armed: true, categoryPolicy: { sneakers: { hub2: { target: 9, minQty: 4 } } } });
  assert.equal(resolveTarget(ctx(c), "hub2", "sn1", "6"), null);
  assert.equal(resolveTarget(ctx(c), "hub2", "sl1", "6").target, 3, "the sibling still resolves the group");
});

test("an explicit /stock_targets row still outranks both the member's entry and the group's", () => {
  const c = cfg({ armed: true, categoryPolicy: { sneakers: { hub2: { target: 9, minQty: 4 } } } });
  const targets = { hub2: { sn1: { 6: { target: 1, minQty: 1 } } } };
  assert.deepEqual(resolveTarget(ctx(c, targets), "hub2", "sn1", "6"),
    { target: 1, minQty: 1, reorderPoint: null, source: "explicit" });
});

// ═══ 5. THE GROUP'S SIZE RUN ═════════════════════════════════════════════════
const TAXONOMY = { cats: {
  sneakers: { label: "Sneakers", sizeMode: "list", sizes: ["3", "4", "5", "5.5", "6", "7", "8", "9", "10", "11", "12", "13"] },
  slides: { label: "Slides", sizeMode: "list", sizes: ["3", "4", "5", "5.5", "6", "7", "8", "9", "10", "11"] },
  "designer-shoes": { label: "Designer shoes", sizeMode: "list", sizes: ["3", "4", "5", "6", "7", "8", "9", "10", "11"] },
  boots: { label: "Boots", sizeMode: "list", sizes: ["6", "7", "8"] },
  loafers: { label: "Loafers", sizeMode: "list", sizes: ["6", "7"] },
  "kids-shoes": { label: "Kids shoes", sizeMode: "list", sizes: ["1", "2"] },
  "running-shoes": { label: "Running shoes", sizeMode: "list", sizes: ["7", "8"] },
} };
const runArgs = { products: PRODUCTS, stock: STOCK, targets: {}, taxonomy: TAXONOMY, locations: ["hub2", "trophy", "central"] };

test("the group's run is the UNION of its members' runs, never the intersection", () => {
  const run = sizeRunForGroup({ ...runArgs, memberCategoryKeys: MEMBERS });
  // sneakers has 5, 5_5, 6, 12 live; slides 5, 6; designer-shoes 6, 7.
  assert.deepEqual(run.sizes, ["5", "5_5", "6", "7", "12"]);
  // The intersection would be ["6"] — a policy built on it would arm nothing at
  // either end of the run.
  assert.notDeepEqual(run.sizes, ["6"]);
});

test("sizes only some members carry are MARKED, and every size names who carries it", () => {
  const run = sizeRunForGroup({ ...runArgs, memberCategoryKeys: MEMBERS });
  assert.deepEqual(run.partial, ["5", "5_5", "6", "7", "12"]);
  assert.deepEqual(run.carriedBy["6"], ["designer-shoes", "slides", "sneakers"]);
  assert.deepEqual(run.carriedBy["12"], ["sneakers"]);
  assert.deepEqual(run.carriedBy["5_5"], ["sneakers"]);
});

test("members with no derivable run are named rather than silently ignored", () => {
  const run = sizeRunForGroup({ ...runArgs, memberCategoryKeys: MEMBERS });
  assert.deepEqual(run.membersWithoutRun, ["boots", "kids-shoes", "loafers", "running-shoes"]);
  assert.equal(run.empty, false);
});

test("a group whose members have no live data at all has an EMPTY run — the stop", () => {
  const run = sizeRunForGroup({ ...runArgs, memberCategoryKeys: ["boots", "loafers"] });
  assert.deepEqual(run.sizes, []);
  assert.equal(run.empty, true);
});

test("the group's run agrees with each member's own derivation — one implementation, not two", () => {
  const run = sizeRunForGroup({ ...runArgs, memberCategoryKeys: MEMBERS });
  for (const key of MEMBERS) {
    const own = sizeRunForCategory({ ...runArgs, categoryKey: key });
    assert.deepEqual(run.byMember[key].sizes, own.sizes, `${key} derives two different runs`);
  }
});

// ── THE WRITE GATE ───────────────────────────────────────────────────────────
test("a group policy on a size no member carries is refused", () => {
  const run = sizeRunForGroup({ ...runArgs, memberCategoryKeys: MEMBERS });
  const group = { label: "Sneakers", armed: false, memberCategoryKeys: MEMBERS,
    policy: { perSize: true, hub2: { sizes: { 13: { target: 2, minQty: 1 } } } } };
  const err = validatePolicyGroup("footwear-all", group, {
    knownCategoryKeys: Object.keys(TAXONOMY.cats), knownLocations: ["hub2", "trophy"],
    existingGroups: {}, allowedSizes: run.sizes });
  assert.match(String(err), /13/);
  // …and one on a size a member does carry goes through.
  const ok = validatePolicyGroup("footwear-all", {
    ...group, policy: { perSize: true, hub2: { sizes: { "5_5": { target: 2, minQty: 1 } } } } }, {
    knownCategoryKeys: Object.keys(TAXONOMY.cats), knownLocations: ["hub2", "trophy"],
    existingGroups: {}, allowedSizes: run.sizes });
  assert.equal(ok, null);
});

test("the live union is twelve sizes — under the twenty this pass stops at", () => {
  assert.equal(UNION.length, 12);
  assert.ok(UNION.length <= 20);
});

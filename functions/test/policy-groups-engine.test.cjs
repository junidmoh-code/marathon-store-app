// ─── GROUPS AND PER-SIZE, THROUGH THE ENGINE ITSELF ───────────────────────────
//
// policy-groups.test.cjs proves the primitives. This file proves the ENGINE
// honours them — resolveTarget's precedence and computeRefillPlan's intents —
// because a resolution helper that is right in isolation and unreachable from
// the scan is worth nothing.
//
// THE FOUR PROPERTIES THIS BUILD IS SEEDED ON, in the order they matter:
//
//   1. A CATEGORY'S OWN POLICY BEATS ITS GROUP'S.
//   2. A DISARMED GROUP PRODUCES ZERO INTENTS.
//   3. FOOTWEAR STAYS BEHIND ITS KILL SWITCH — a footwear group, even armed,
//      does not turn footwearTargets on, and turning the group on does not make
//      the footwear RULE fire.
//   4. AN EXPLICIT /stock_targets ROW STILL OUTRANKS EVERYTHING.
//
// Each is mutation-proved in scripts/mutation-proof-policy-groups.mjs.
//
// Run: cd functions && node --test test/policy-groups-engine.test.cjs

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan, resolveTarget, categoryPolicyEntry } = require("../lib/refill-engine.cjs");

const NOW = Date.parse("2026-08-22T09:00:00.000Z");

// A sneaker and a slide, both footwear, both carried at hub2 and stocked at
// central so a deficit is fillable — the state in which an intent is possible
// at all, so "zero intents" below means the switch stopped it, not the world.
const PRODUCTS = {
  // `category: "Footwear"` is what isFootwear() tests, and it is load-bearing
  // here: without it the footwear rule could never fire and every "the kill
  // switch held" assertion below would be passing against a dead branch.
  sn1: { id: "sn1", name: "Air Max", category: "Footwear", categoryKey: "sneakers", productType: "sneaker", sizes: ["7", "8", "9"] },
  sl1: { id: "sl1", name: "Slide", category: "Footwear", categoryKey: "slides", productType: "sneaker", sizes: ["7"] },
  cap: { id: "cap", name: "Cap", categoryKey: "caps-beanies", productType: "clothing", sizes: ["_"] },
};
const STOCK = {
  hub2: { sn1: { 7: { qty: 0 }, 8: { qty: 0 } }, sl1: { 7: { qty: 0 } }, cap: { _: { qty: 0 } } },
  central: { sn1: { 7: { qty: 40 }, 8: { qty: 40 } }, sl1: { 7: { qty: 40 } }, cap: { _: { qty: 40 } } },
};

const GROUP_POLICY = { perSize: true, hub2: { sizes: { 7: { target: 3, minQty: 2 }, 8: { target: 2, minQty: 1 } } } };

function cfg({ armed = false, categoryPolicy = {}, footwearTargets, ruleBasedTargets = false } = {}) {
  const c = {
    mode: { hub2: "live" }, routes: { hub2: "central" },
    ruleBasedTargets, maxIntentsPerRun: 200, maxUnitsPerIntent: 20,
    categoryPolicy,
    policyGroups: {
      "footwear-all": {
        label: "All footwear except soccer boots",
        memberCategoryKeys: ["sneakers", "slides"],
        armed,
        policy: GROUP_POLICY,
      },
    },
  };
  if (footwearTargets !== undefined) c.footwearTargets = footwearTargets;
  return c;
}
const ctx = (config, targets = {}) => ({ targets, config, products: PRODUCTS, stock: STOCK });

const plan = (config, targets = {}) => computeRefillPlan({
  nowMs: NOW, config, targets, stock: STOCK, products: PRODUCTS,
  openIndex: {}, refillRequests: {}, orders: {}, movements: [], targetDecisions: {},
  rejectStreak: {}, retryState: {},
});
const intentsFor = (p, pid) => p.intents.filter((i) => i.productId === pid);

// ── 2. A DISARMED GROUP PRODUCES ZERO INTENTS ────────────────────────────────
test("A DISARMED GROUP RESOLVES NOTHING AND PRODUCES ZERO INTENTS", () => {
  const c = cfg({ armed: false });
  assert.equal(resolveTarget(ctx(c), "hub2", "sn1", "7"), null);
  assert.equal(categoryPolicyEntry(c, PRODUCTS, {}, "sn1", "hub2"), null);
  const p = plan(c);
  assert.equal(p.intents.length, 0, "a disarmed group must not produce a single intent");
});

test("writing the group changes nothing while it is disarmed — same plan as no group at all", () => {
  const withGroup = plan(cfg({ armed: false }));
  const noGroup = plan({ ...cfg({ armed: false }), policyGroups: undefined });
  assert.deepEqual(withGroup.intents, noGroup.intents);
  assert.equal(withGroup.intents.length, 0);
});

// ── AN ARMED GROUP DOES WORK ─────────────────────────────────────────────────
// Not a safety property — the counterweight to the ones above. If arming did
// nothing, "disarmed produces zero" would be true for the wrong reason.
test("an armed group governs its members' declared sizes", () => {
  const c = cfg({ armed: true });
  const t7 = resolveTarget(ctx(c), "hub2", "sn1", "7");
  assert.equal(t7.target, 3);
  assert.equal(t7.minQty, 2);
  assert.equal(t7.source, "category_policy");
  const p = plan(c);
  assert.equal(intentsFor(p, "sn1").length, 2, "sizes 7 and 8 both below target");
  assert.equal(intentsFor(p, "sl1").length, 1, "slides is a member too");
});

test("a size the group does not name resolves nothing", () => {
  // Slides declares only "7"; the group names 7 and 8. Size 8 is not a slide
  // size, so nothing resolves for it whatever the map says.
  const c = cfg({ armed: true });
  assert.equal(resolveTarget(ctx(c), "hub2", "sl1", "8"), null);
});

test("a non-member is untouched by the group", () => {
  const c = cfg({ armed: true });
  assert.equal(resolveTarget(ctx(c), "hub2", "cap", "_"), null);
});

// ── 1. OWN POLICY BEATS THE GROUP ────────────────────────────────────────────
test("A CATEGORY'S OWN POLICY BEATS ITS GROUP'S", () => {
  const c = cfg({ armed: true, categoryPolicy: { sneakers: { perSize: true, hub2: { target: 9, minQty: 4 } } } });
  const t = resolveTarget(ctx(c), "hub2", "sn1", "7");
  assert.equal(t.target, 9, "the category's own number, not the group's 3");
  assert.equal(t.minQty, 4);
  // ...and the group still governs the member that has no policy of its own.
  assert.equal(resolveTarget(ctx(c), "hub2", "sl1", "7").target, 3);
});

test("the group is not consulted for a location the category's own policy omits", () => {
  // The own entry names trophy only. Under a per-location merge, hub2 would
  // fall through to the group and arm a leg the owner deliberately left out.
  const c = cfg({ armed: true, categoryPolicy: { sneakers: { perSize: true, trophy: { target: 9, minQty: 4 } } } });
  c.mode.trophy = "live"; c.routes.trophy = "hub2";
  assert.equal(resolveTarget(ctx(c), "hub2", "sn1", "7"), null,
    "own policy present ⇒ the group is skipped entirely, not merged per location");
});

// ── 4. EXPLICIT ROWS STILL WIN ───────────────────────────────────────────────
test("AN EXPLICIT /stock_targets ROW OUTRANKS AN ARMED GROUP", () => {
  const c = cfg({ armed: true });
  const targets = { hub2: { sn1: { 7: { target: 12, minQty: 6 } } } };
  const t = resolveTarget(ctx(c, targets), "hub2", "sn1", "7");
  assert.equal(t.target, 12);
  assert.equal(t.source, "explicit");
});

test("an explicit row of 0 still stops the cell, group or no group", () => {
  const c = cfg({ armed: true });
  const targets = { hub2: { sn1: { 7: { target: 0, minQty: 0 } } } };
  const p = plan(c, targets);
  assert.equal(intentsFor(p, "sn1").filter((i) => i.size === "7").length, 0);
});

// ── 3. THE FOOTWEAR KILL SWITCH ──────────────────────────────────────────────
test("FOOTWEAR STAYS BEHIND ITS KILL SWITCH — a group does not flip it", () => {
  // footwearTargets absent = OFF. The footwear RULE must stay silent whether
  // the group is armed or not: they are separate switches and this build only
  // touches one of them.
  for (const armed of [false, true]) {
    const c = cfg({ armed });
    delete c.footwearTargets;
    // With no group entry for a size, the footwear rule is the only branch that
    // could answer — and it must not, because its switch is off.
    assert.equal(resolveTarget(ctx(c), "hub2", "sn1", "9"), null,
      `size 9 is undeclared and unmapped; the footwear rule must stay off (armed=${armed})`);
    // The rule's own run is present in config and still produces nothing.
    const withRun = { ...c, footwearRunByLocation: { hub2: { 7: 5, 8: 5, 9: 5 } } };
    assert.equal(resolveTarget({ ...ctx(withRun) }, "hub2", "sn1", "9"), null);
  }
});

test("arming the group does not make the footwear rule fire for sizes it does not name", () => {
  const c = { ...cfg({ armed: true }), footwearRunByLocation: { hub2: { 7: 5, 8: 5 } } };
  // "8" IS named by the group, so it resolves the GROUP's 2 — not the rule's 5.
  assert.equal(resolveTarget(ctx(c), "hub2", "sn1", "8").target, 2);
});

test("with the footwear switch ON the rule fires — proving the assertions above test the switch, not a dead branch", () => {
  const c = { ...cfg({ armed: false }), footwearTargets: true, footwearRunByLocation: { hub2: { 9: 5 } } };
  const t = resolveTarget(ctx(c), "hub2", "sn1", "9");
  assert.equal(t.target, 5);
  assert.equal(t.source, "footwear_default");
});

// ── PER-SIZE MAPS AT A CATEGORY (not only at a group) ────────────────────────
test("a category's own per-size map governs each size with its own numbers", () => {
  const c = cfg({ armed: false, categoryPolicy: { sneakers: { perSize: true, hub2: {
    sizes: { 7: { target: 4, minQty: 2, reorderPoint: 1 }, 8: { target: 1, minQty: 1 } },
  } } } });
  const t7 = resolveTarget(ctx(c), "hub2", "sn1", "7");
  assert.equal(t7.target, 4); assert.equal(t7.minQty, 2); assert.equal(t7.reorderPoint, 1);
  const t8 = resolveTarget(ctx(c), "hub2", "sn1", "8");
  assert.equal(t8.target, 1); assert.equal(t8.reorderPoint, null, "absent stays absent, never zeroed");
});

test("a per-size map keeps the dead-size rule: a size with no units anywhere resolves an explicit 0", () => {
  const stock = { hub2: { sn1: { 7: { qty: 0 } } }, central: { sn1: { 7: { qty: 5 } } } };
  const c = cfg({ armed: false, categoryPolicy: { sneakers: { perSize: true, hub2: {
    sizes: { 7: { target: 4, minQty: 2 }, 8: { target: 4, minQty: 2 } },
  } } } });
  const t = resolveTarget({ targets: {}, config: c, products: PRODUCTS, stock }, "hub2", "sn1", "8");
  assert.equal(t.target, 0, "size 8 holds nothing anywhere — a stop, not a fall-through");
});

test("a HALF SIZE resolves — the map is keyed by the stored form, not the declared one", () => {
  // 5.5 is stored "5_5" everywhere: the /stock cell, the /stock_targets row, and
  // this map. An unencoded lookup would find nothing for it — silently, and for
  // the second-largest size band in the live footwear catalogue (538 cells,
  // 865 units measured 2026-07-30). The engine is asked with the DECLARED size
  // "5.5", so the encode has to happen inside the lookup.
  const products = { h1: { id: "h1", name: "Half", category: "Footwear", categoryKey: "sneakers",
    productType: "sneaker", sizes: ["5.5", "7"] } };
  const stock = { hub2: { h1: { "5_5": { qty: 0 } } }, central: { h1: { "5_5": { qty: 9 } } } };
  const c = cfg({ armed: false, categoryPolicy: { sneakers: { perSize: true, hub2: {
    sizes: { "5_5": { target: 4, minQty: 2 } },
  } } } });
  const t = resolveTarget({ targets: {}, config: c, products, stock }, "hub2", "h1", "5.5");
  assert.ok(t, "the half size must resolve through the map");
  assert.equal(t.target, 4);
  const p = computeRefillPlan({
    nowMs: NOW, config: c, targets: {}, stock, products, openIndex: {},
    refillRequests: {}, orders: {}, movements: [], targetDecisions: {}, rejectStreak: {}, retryState: {},
  });
  assert.equal(p.intents.length, 1, "the half-size cell must produce a real intent");
  assert.equal(p.intents[0].size, "5.5");
});

test("a per-size map is refused outside per-size mode and arms nothing", () => {
  const c = cfg({ armed: false, categoryPolicy: { sneakers: { hub2: { sizes: { 7: { target: 4, minQty: 2 } } } } } });
  assert.equal(categoryPolicyEntry(c, PRODUCTS, {}, "sn1", "hub2"), null);
  assert.equal(plan(c).intents.length, 0);
});

test("both shapes at one location arm nothing — the conservative side", () => {
  const c = cfg({ armed: false, categoryPolicy: { sneakers: { perSize: true, hub2: {
    target: 5, minQty: 2, sizes: { 7: { target: 4, minQty: 2 } },
  } } } });
  assert.equal(categoryPolicyEntry(c, PRODUCTS, {}, "sn1", "hub2"), null);
});

test("a per-size map with no usable row arms nothing", () => {
  const c = cfg({ armed: false, categoryPolicy: { sneakers: { perSize: true, hub2: {
    sizes: { 7: { target: 0, minQty: 0 }, 8: { target: "5", minQty: 2 } },
  } } } });
  assert.equal(categoryPolicyEntry(c, PRODUCTS, {}, "sn1", "hub2"), null);
});

test('the "_" cell is never answered by a per-size map', () => {
  const c = cfg({ armed: false, categoryPolicy: { "caps-beanies": { perSize: true, hub2: {
    sizes: { S: { target: 4, minQty: 2 } },
  } } } });
  assert.equal(resolveTarget(ctx(c), "hub2", "cap", "_"), null);
});

// ── THE UNIFORM SHAPE IS UNTOUCHED ───────────────────────────────────────────
// Every live entry today is uniform. If this file's changes moved any of them,
// five armed categories would change behaviour on the next scan.
test("a uniform one-size entry behaves exactly as it did", () => {
  const c = cfg({ armed: false, categoryPolicy: { "caps-beanies": { hub2: { target: 10, minQty: 5, reorderPoint: 2 } } } });
  const t = resolveTarget(ctx(c), "hub2", "cap", "_");
  assert.equal(t.target, 10); assert.equal(t.minQty, 5); assert.equal(t.reorderPoint, 2);
  assert.equal(t.source, "category_policy");
  assert.equal(resolveTarget(ctx(c), "hub2", "cap", "S"), null, "letters still fall through in one-size mode");
});

test("a uniform per-size entry behaves exactly as it did", () => {
  const c = cfg({ armed: false, categoryPolicy: { sneakers: { perSize: true, hub2: { target: 6, minQty: 3 } } } });
  assert.equal(resolveTarget(ctx(c), "hub2", "sn1", "7").target, 6);
  assert.equal(resolveTarget(ctx(c), "hub2", "sn1", "8").target, 6);
  assert.equal(resolveTarget(ctx(c), "hub2", "sn1", "_"), null);
});

// ── GARBLED CONFIG ARMS NOTHING ──────────────────────────────────────────────
test("a garbled group node arms nothing", () => {
  for (const groups of [null, "nope", 7, [], { "footwear-all": null }, { "footwear-all": { armed: true } }]) {
    const c = { ...cfg({ armed: true }), policyGroups: groups };
    assert.equal(categoryPolicyEntry(c, PRODUCTS, {}, "sn1", "hub2"), null, JSON.stringify(groups));
  }
});

test("armed:'true' as a string does not arm — the flag is a boolean", () => {
  const c = cfg({ armed: true });
  c.policyGroups["footwear-all"].armed = "true";
  assert.equal(categoryPolicyEntry(c, PRODUCTS, {}, "sn1", "hub2"), null);
  assert.equal(plan(c).intents.length, 0);
});

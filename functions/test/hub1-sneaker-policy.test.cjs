// ─── THE HUB 1 SNEAKER POLICY'S PROPERTIES, THROUGH THE ENGINE ────────────────
//
// The 2026-08-25 Hub 1 build arms a per-size `sneakers` category policy at
// hub1. THE SCOPE GATE WAS REMOVED BY THE OWNER the same day it shipped: the
// policy arms EVERY sneaker in the catalogue at Hub 1, carried or not, and the
// only filter is the engine's standing ACTIONABLE-ONLY source gate at the
// request step — a request line is raised iff Central can physically fill it
// right now; the unfilled need parks in awaitingSupplier / missingSizes, never
// silently dropped. The properties, in the order they matter:
//
//   1. ARM EVERYTHING + THE REQUEST-STEP FILTER: a sneaker with no hub1 cell
//      is armed all the same; Central empty → NO request line, need PARKED
//      (awaitingSupplier when units exist elsewhere, missingSizes when nothing
//      exists anywhere); a deactivated sneaker stays fully silent.
//   2. EVERY OTHER DESTINATION IS UNTOUCHED: the plan for hub2 / hub3 / the
//      shops is deep-equal with and without the hub1 policy entry.
//   3. REORDER POINT 1: a cell at 2 (target 2) is silent; at 1 it asks back up
//      to target and NO FURTHER (deficit arithmetic, capped by target).
//   4. HALF SIZES resolve through the "5_5" stored key, never a raw "5.5".
//   5. AN EXPLICIT target:0 ROW (the seating exclusions) still outranks the
//      policy — resolves source "explicit", target 0, zero intents.
//   6. A ZEROED CELL reads as unavailable and can still be topped up — while a
//      NEGATIVE cell clamps to 0 on both sides of the arithmetic (avail() as
//      on-hand, and the source gate), never inflating or hiding a deficit.
//
// Run: cd functions && node --test test/hub1-sneaker-policy.test.cjs

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan, resolveTarget, categoryPolicyEntry } = require("../lib/refill-engine.cjs");

const NOW = Date.parse("2026-08-25T09:00:00.000Z");

// The run the owner set: 3→2, 4→2, 5→2, 5.5→2, 6→3, 7→3, 8→3, 9→2, 10→2, 11→2.
const HUB1_RUN = {
  3: { target: 2, minQty: 1, reorderPoint: 1 }, 4: { target: 2, minQty: 1, reorderPoint: 1 },
  5: { target: 2, minQty: 1, reorderPoint: 1 }, "5_5": { target: 2, minQty: 1, reorderPoint: 1 },
  6: { target: 3, minQty: 2, reorderPoint: 1 }, 7: { target: 3, minQty: 2, reorderPoint: 1 },
  8: { target: 3, minQty: 2, reorderPoint: 1 }, 9: { target: 2, minQty: 1, reorderPoint: 1 },
  10: { target: 2, minQty: 1, reorderPoint: 1 }, 11: { target: 2, minQty: 1, reorderPoint: 1 },
};
const SNEAKER_POLICY = { perSize: true, hub1: { sizes: HUB1_RUN } };

const PRODUCTS = {
  // carried: has hub1 cells. category "Footwear" + categoryKey "sneakers".
  carried: { id: "carried", name: "Carried", category: "Footwear", categoryKey: "sneakers", productType: "sneaker", sizes: ["5.5", "6", "7"] },
  // uncarried: identical sneaker, NO hub1 node at all — the scope gate's case.
  uncarried: { id: "uncarried", name: "Uncarried", category: "Footwear", categoryKey: "sneakers", productType: "sneaker", sizes: ["6", "7"] },
  // a clothing product at hub2 so the "other destinations" plan is non-trivial.
  shirt: { id: "shirt", name: "Shirt", categoryKey: "t-shirts", productType: "clothing", sizes: ["M", "L"] },
};

const STOCK = {
  hub1: { carried: { "5_5": { qty: 1 }, 6: { qty: 1 }, 7: { qty: 3 } } },
  hub2: { shirt: { M: { qty: 0 }, L: { qty: 1 } } },
  central: {
    carried: { "5_5": { qty: 10 }, 6: { qty: 10 }, 7: { qty: 10 } },
    uncarried: { 6: { qty: 10 }, 7: { qty: 10 } },
    shirt: { M: { qty: 10 }, L: { qty: 10 } },
  },
};

function cfg({ withPolicy = true, stock } = {}) {
  return {
    mode: { hub1: "live", hub2: "live", "marathon-pe": "live", trophy: "live" },
    routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
    ruleBasedTargets: true, maxIntentsPerRun: 200, maxFootwearIntentsPerRun: 200, maxUnitsPerIntent: 20,
    defaultRunByStore: { hub2: { M: 3, L: 3 } },
    categoryPolicy: withPolicy ? { sneakers: SNEAKER_POLICY } : {},
  };
}

const plan = (config, { targets = {}, stock = STOCK } = {}) => computeRefillPlan({
  nowMs: NOW, config, targets, stock, products: PRODUCTS,
  openIndex: {}, refillRequests: {}, orders: {}, movements: [], targetDecisions: {},
  rejectStreak: {}, retryState: {},
});
const ctx = (config, { targets = {}, stock = STOCK } = {}) => ({ targets, config, products: PRODUCTS, stock });
const hub1Intents = (p, pid) => p.intents.filter((i) => i.dest === "hub1" && (!pid || i.productId === pid));

// ── 1. ARM EVERYTHING; FILTER AT THE REQUEST STEP ────────────────────────────
test("a sneaker hub1 does NOT carry is armed all the same, and Central-fillable need raises", () => {
  const c = cfg();
  assert.ok(categoryPolicyEntry(c, PRODUCTS, STOCK, "uncarried", "hub1"), "the entry speaks for every sneaker");
  const t = resolveTarget(ctx(c), "hub1", "uncarried", "6");
  assert.deepEqual(t, { target: 3, minQty: 2, reorderPoint: 1, source: "category_policy" });
  const p = plan(c);
  const lines = hub1Intents(p, "uncarried");
  assert.ok(lines.some((i) => i.sizeKey === "6" && i.qty === 3), "Central holds 10 → the full run is raised");
});

test("a stray carriedOnly key on a live entry (transition window) changes nothing", () => {
  const stale = { perSize: true, hub1: { sizes: HUB1_RUN, carriedOnly: true } };
  const c = { ...cfg(), categoryPolicy: { sneakers: stale } };
  const t = resolveTarget(ctx(c), "hub1", "uncarried", "6");
  assert.equal(t?.source, "category_policy", "the removed flag must be inert, not load-bearing");
});

test("REQUEST-STEP FILTER: Central empty, units elsewhere → no line, parked awaitingSupplier", () => {
  const c = cfg();
  const stock = JSON.parse(JSON.stringify(STOCK));
  stock.central.uncarried = {};                      // Central has none
  stock["marathon-pe"] = { uncarried: { 6: { qty: 2 } } };   // units exist somewhere
  const p = plan(c, { stock });
  assert.equal(hub1Intents(p, "uncarried").length, 0, "no request line Central cannot fill");
  const parked = (p.exceptions.awaitingSupplier.items || []).filter((x) => x.pid === "uncarried" && x.loc === "hub1");
  assert.ok(parked.length >= 1, "the need is PARKED, visible in Waiting for Supplier — never dropped");
});

test("DEAD-SIZE RULE: a size with zero units ANYWHERE resolves target 0 — dormant, no line, no noise", () => {
  // This is why the 182 zero-stock ghost lines carry no live demand even with
  // the scope gate gone: the per-size category-policy branch resolves
  // sizeUnitsAnywhere > 0 ? target : 0, so a finished line is silent until a
  // unit appears somewhere — at which point it wakes. Deactivation is the way
  // to keep it from waking; this test pins the dormancy.
  const c = cfg();
  const stock = JSON.parse(JSON.stringify(STOCK));
  stock.central.uncarried = {};                      // zero stock ANYWHERE
  const t0 = resolveTarget(ctx(c, { stock }), "hub1", "uncarried", "6");
  assert.equal(t0?.target, 0, "dead size resolves the computed 0, not the run");
  const p = plan(c, { stock });
  assert.equal(hub1Intents(p, "uncarried").length, 0, "no request line");
  for (const k of ["missingSizes", "awaitingSupplier", "awaitingUpstream", "belowTarget"]) {
    assert.equal((p.exceptions[k].items || []).filter((x) => x.pid === "uncarried").length, 0, `no ${k} noise`);
  }
});

test("a zero-qty cell still arms (presence never mattered to a category policy)", () => {
  const stock = { ...STOCK, hub1: { carried: { 6: { qty: 0 } } } };
  const c = cfg();
  const t = resolveTarget(ctx(c, { stock }), "hub1", "carried", "6");
  assert.equal(t?.source, "category_policy");
  assert.equal(t?.target, 3);
});

test("a DEACTIVATED sneaker under the policy raises nothing and parks nowhere", () => {
  const c = cfg();
  const products = { ...PRODUCTS, uncarried: { ...PRODUCTS.uncarried, deactivated: { at: NOW - 3600e3, by: "u1" } } };
  const stock = JSON.parse(JSON.stringify(STOCK));
  stock.central.uncarried = {};   // would otherwise park in missingSizes
  const p = computeRefillPlan({
    nowMs: NOW, config: c, targets: {}, stock, products,
    openIndex: {}, refillRequests: {}, orders: {}, movements: [], targetDecisions: {},
    rejectStreak: {}, retryState: {},
  });
  assert.equal(p.intents.filter((i) => i.productId === "uncarried").length, 0);
  for (const k of ["missingSizes", "awaitingSupplier", "awaitingUpstream", "belowTarget"]) {
    assert.equal((p.exceptions[k].items || []).filter((x) => x.pid === "uncarried").length, 0, `no ${k} noise`);
  }
});

// ── 2. EVERY OTHER DESTINATION IS UNTOUCHED ──────────────────────────────────
test("hub2 / hub3 / shop plans are DEEP-EQUAL with and without the hub1 policy", () => {
  const with_ = plan(cfg({ withPolicy: true }));
  const without = plan(cfg({ withPolicy: false }));
  const nonHub1 = (p) => p.intents.filter((i) => i.dest !== "hub1");
  assert.deepEqual(nonHub1(with_), nonHub1(without),
    "arming hub1 must not change a single intent anywhere else");
  assert.equal(hub1Intents(without).length, 0, "control: without the policy hub1 raises nothing");
});

// ── 3. REORDER POINT 1 ───────────────────────────────────────────────────────
test("reorder point 1: at target → silent; at 2 (target 3) → silent; at 1 → top up to target and no further", () => {
  const c = cfg();
  const at = (qty) => {
    const stock = JSON.parse(JSON.stringify(STOCK));
    stock.hub1.carried["6"] = { qty };
    return plan(c, { stock }).intents.filter((i) => i.dest === "hub1" && i.productId === "carried" && i.sizeKey === "6");
  };
  assert.equal(at(3).length, 0, "at target: no request");
  assert.equal(at(2).length, 0, "above the reorder point (2 > 1): silent even though below target");
  const dropped = at(1);
  assert.equal(dropped.length, 1, "at the reorder point: exactly one request");
  assert.equal(dropped[0].qty, 2, "asks back up to target 3 (3 − 1 on hand) and no further");
  const empty = at(0);
  assert.equal(empty[0].qty, 3, "an empty cell asks for the full run");
});

// ── 4. HALF SIZES ────────────────────────────────────────────────────────────
test("5.5 resolves through the 5_5 stored key", () => {
  const c = cfg();
  const t = resolveTarget(ctx(c), "hub1", "carried", "5.5");
  assert.deepEqual(t, { target: 2, minQty: 1, reorderPoint: 1, source: "category_policy" });
  const stock = JSON.parse(JSON.stringify(STOCK));
  stock.hub1.carried["5_5"] = { qty: 0 };
  const p = plan(c, { stock });
  const half = p.intents.filter((i) => i.dest === "hub1" && i.sizeKey === "5_5");
  assert.equal(half.length, 1, "the 5_5 cell raises through the encoded key");
  assert.equal(half[0].size, "5.5", "the request's size field stays the raw catalogue size");
});

// ── 5. AN EXPLICIT target:0 ROW STILL WINS ───────────────────────────────────
test("an explicit target:0 seating row outranks the policy and stays silent", () => {
  const c = cfg();
  const targets = { hub1: { carried: { 6: { target: 0, minQty: 0, source: "excluded" } } } };
  const t = resolveTarget(ctx(c, { targets }), "hub1", "carried", "6");
  assert.deepEqual(t, { target: 0, minQty: 0, reorderPoint: null, source: "explicit" });
  const stock = JSON.parse(JSON.stringify(STOCK));
  stock.hub1.carried["6"] = { qty: 0 };   // empty — the policy alone WOULD ask
  const p = plan(c, { targets, stock });
  assert.equal(p.intents.filter((i) => i.dest === "hub1" && i.productId === "carried" && i.sizeKey === "6").length, 0,
    "the 0 row keeps the cell excluded");
});

// ── 6. ZEROED AND NEGATIVE CELLS ─────────────────────────────────────────────
test("a negative cell clamps to 0 on-hand — it asks for the run, never run+|negative|", () => {
  const c = cfg();
  const stock = JSON.parse(JSON.stringify(STOCK));
  stock.hub1.carried["6"] = { qty: -4 };
  const p = plan(c, { stock });
  const neg = p.intents.filter((i) => i.dest === "hub1" && i.productId === "carried" && i.sizeKey === "6");
  assert.equal(neg.length, 1);
  assert.equal(neg[0].qty, 3, "avail() clamps −4 to 0: the ask is the target, not target+4");
});

test("a negative SOURCE cell reads as unavailable — no intent against phantom Central stock", () => {
  const c = cfg();
  const stock = JSON.parse(JSON.stringify(STOCK));
  stock.hub1.carried["6"] = { qty: 0 };
  stock.central.carried["6"] = { qty: -2 };
  stock.hub2 = {};   // keep the network total nonzero via another location? no — leave, see assert
  stock["marathon-pe"] = { carried: { 6: { qty: 2 } } };   // units exist SOMEWHERE, so not "nothing anywhere"
  const p = plan(c, { stock });
  assert.equal(p.intents.filter((i) => i.dest === "hub1" && i.productId === "carried" && i.sizeKey === "6").length, 0,
    "a negative Central cell must never fill a request");
});

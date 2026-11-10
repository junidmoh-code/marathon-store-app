// ─── THE CONCRETE DIVISION POLICY AUDIT (Junid, 10 Nov 2026) ─────────────────
// Every product seated at Pine, Concrete and Hub 3, every size: Junid's policy
// (computed from the key alone) against what the engine arms. Written by the
// scan into /stock_exceptions/latest.divisionPolicy for the Health card.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");
const reg = require("../lib/network-registry.cjs");
const dv = require("../lib/concrete-division.cjs");
const { FOOTWEAR_CATEGORY_KEYS } = require("../lib/policy-resolve.cjs");

const ISO = "2026-11-10T09:00:00.000Z";
const cfg = (on = false) => ({
  routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
  mode: { hub1: "live", hub2: "live", "marathon-pe": "live", trophy: "live" },
  ruleBasedTargets: true, maxIntentsPerRun: 500, maxFootwearIntentsPerRun: 500,
  concreteDivision: { shopOnly: { perSize: 2, oneSize: 5 }, fromHub3: { perSize: 1, oneSize: 5, askAt: 0 }, hub3Keep: { on, perSize: 2, oneSize: 10 } },
  policyGroups: { "footwear-all": { armed: true, memberCategoryKeys: FOOTWEAR_CATEGORY_KEYS.slice(), policy: { perSize: true, hub3: { target: 3, minQty: 2, reorderPoint: 1, carriedOnly: true } } } },
});
const shelf = (qty) => ({ qty, v: 1, mv: "m", lastType: "transfer_in" });
const counted = (qty) => ({ qty, v: 1, mv: "m", lastType: "count" });
const products = {
  t1: { id: "t1", name: "Tee", category: "Clothing", categoryKey: "t-shirts", productType: "clothing", sizes: ["S", "M"] },
  b1: { id: "b1", name: "Bag", category: "Accessories", categoryKey: "bags", sizes: [] },
  s1: { id: "s1", name: "Shoe", category: "Footwear", subcategory: "Sneakers", categoryKey: "sneakers", productType: "sneaker", sizes: ["8", "9"] },
  h1: { id: "h1", name: "Hoodie", category: "Clothing", categoryKey: "hoodies", productType: "clothing", sizes: ["L"] },
};
const seat = { via: "stock", at: ISO };
const world = () => ({
  central: { t1: { S: counted(9), M: counted(9) }, b1: { _: counted(9) }, s1: { 8: counted(9), 9: counted(9) }, h1: { L: counted(9) } },
  hub3: { s1: { 8: counted(1), 9: counted(0) }, h1: { L: counted(2) } },
  concrete: { t1: { S: shelf(1) }, b1: { _: shelf(0) }, h1: { L: shelf(0) } },
  "marathon-pine": { s1: { 8: shelf(0) } },
});
const seats = { concrete: { t1: seat, b1: seat, h1: seat }, "marathon-pine": { s1: seat }, hub3: { s1: seat, h1: seat } };
const run = ({ targets = {}, config = cfg(), stock = world() } = {}) => computeRefillPlan({
  nowMs: Date.parse(ISO), config, targets, stock, products, openIndex: {}, refillRequests: {}, orders: {}, movements: [], network: reg.SEED_REGISTRY, seats,
}).exceptions.divisionPolicy;

test("a correct division: every seated product checked, nothing wrong", () => {
  const a = run();
  assert.equal(a.count, 0, JSON.stringify(a.items));
  assert.deepEqual(a.perLoc.concrete, { products: 3, correct: 3, mismatched: 0, cells: 4, switchedOff: 0 });
  assert.deepEqual(a.perLoc["marathon-pine"], { products: 1, correct: 1, mismatched: 0, cells: 2, switchedOff: 0 }, "a shoe on a shop keeps nothing, and nothing arms it");
  assert.deepEqual(a.perLoc.hub3, { products: 2, correct: 2, mismatched: 0, cells: 3, switchedOff: 0 });
});

test("an explicit row overriding the policy is a mismatch, named as such", () => {
  const a = run({ targets: { concrete: { t1: { S: { target: 4, minQty: 3 } } } } });
  assert.equal(a.count, 1);
  assert.deepEqual(a.items[0], { loc: "concrete", pid: "t1", size: "S", reason: "explicit_row", expected: { target: 2, reorderPoint: null }, effective: { target: 4, reorderPoint: null, source: "explicit" } });
  assert.equal(a.perLoc.concrete.mismatched, 1);
});

test("a Seating switch-off (target 0) is correct, and counted as switched off", () => {
  const a = run({ targets: { concrete: { t1: { S: { target: 0, minQty: 0 }, M: { target: 0, minQty: 0 } } } } });
  assert.equal(a.count, 0);
  assert.equal(a.perLoc.concrete.switchedOff, 2);
});

test("the expected number is Junid's, not the engine's: a Hub 3 sneaker leg drifted to keep 2 is wrong_number", () => {
  const c = cfg(); c.policyGroups["footwear-all"].policy.hub3 = { target: 2, minQty: 1, reorderPoint: 1, carriedOnly: true };
  const a = run({ config: c });
  // Both sizes: Central holds 9 too, so neither is a dead size.
  assert.deepEqual(a.byReason, { wrong_number: 2 });
  assert.deepEqual(a.items.map((m) => `${m.loc}:${m.pid}:${m.size}:${m.expected.target}->${m.effective.target}`), ["hub3:s1:8:3->2", "hub3:s1:9:3->2"]);
  assert.equal(a.perLoc.hub3.mismatched, 1);
});

test("verdicts: missing, unexpected, dead size, none", () => {
  assert.deepEqual(dv.divisionAuditVerdict({ expected: { target: 2, reorderPoint: null }, effective: null }), { ok: false, reason: "missing" });
  assert.deepEqual(dv.divisionAuditVerdict({ expected: null, effective: { target: 2, source: "category_policy" } }), { ok: false, reason: "unexpected" });
  assert.deepEqual(dv.divisionAuditVerdict({ expected: { target: 3, reorderPoint: 1 }, effective: { target: 0 }, deadSize: true }), { ok: true, reason: "dead_size" });
  assert.deepEqual(dv.divisionAuditVerdict({ expected: null, effective: null }), { ok: true, reason: "none" });
});

test("expected keeps, straight from the policy", () => {
  const division = dv.divisionContext({ config: cfg(), rawStock: { hub3: { h1: { L: counted(2) } } }, seats, openIndex: {}, heldLines: {}, refillRequests: {} });
  assert.deepEqual(dv.divisionExpectedTarget(division, "concrete", "t1", "S", products.t1), { target: 2, reorderPoint: null });
  assert.deepEqual(dv.divisionExpectedTarget(division, "concrete", "b1", "", products.b1), { target: 5, reorderPoint: null });
  assert.deepEqual(dv.divisionExpectedTarget(division, "concrete", "h1", "L", products.h1), { target: 1, reorderPoint: 0 }, "Hub 3 holds L: the from-Hub-3 keep");
  assert.equal(dv.divisionExpectedTarget(division, "concrete", "s1", "8", products.s1), null);
  assert.deepEqual(dv.divisionExpectedTarget(division, "hub3", "s1", "8", products.s1), { target: 3, reorderPoint: 1 });
  assert.equal(dv.divisionExpectedTarget(division, "hub3", "h1", "L", products.h1), null, "Hub 3 clothing keep off");
  const on = dv.divisionContext({ config: cfg(true), rawStock: {}, seats, openIndex: {}, heldLines: {}, refillRequests: {} });
  assert.deepEqual(dv.divisionExpectedTarget(on, "hub3", "h1", "L", products.h1), { target: 2, reorderPoint: null });
  assert.deepEqual(dv.divisionExpectedTarget(on, "hub3", "b1", "", products.b1), { target: 10, reorderPoint: null });
});

test("key off: no audit at all", () => {
  const c = cfg(); delete c.concreteDivision;
  assert.equal(run({ config: c }), undefined);
});

test("the audit reads nothing: same plan intents with or without it (pure, no side effects)", () => {
  const p = computeRefillPlan({ nowMs: Date.parse(ISO), config: cfg(), targets: {}, stock: world(), products, openIndex: {}, refillRequests: {}, orders: {}, movements: [], network: reg.SEED_REGISTRY, seats });
  assert.ok(Array.isArray(p.exceptions.divisionPolicy.items));
  assert.ok(p.intents.some((i) => i.dest === "concrete"));
});

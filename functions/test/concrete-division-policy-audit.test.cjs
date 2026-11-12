// ─── THE CONCRETE DIVISION POLICY AUDIT (Junid, 10 Nov 2026) ─────────────────
// Every product seated at Pine, Concrete and Hub 3, every size: Junid's policy
// (his pinned numbers) against what the engine arms. Written by the scan into
// /stock_exceptions/latest.divisionPolicy for the Health card. The 12 Nov 2026
// model: shops 2 per size / 5 per design from Central; Hub 3 sneakers 2, ask at 1;
// Hub 3 keeps no non-footwear.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");
const reg = require("../lib/network-registry.cjs");
const dv = require("../lib/concrete-division.cjs");
const { FOOTWEAR_CATEGORY_KEYS } = require("../lib/policy-resolve.cjs");

const ISO = "2026-11-10T09:00:00.000Z";
const cfg = () => ({
  routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
  mode: { hub1: "live", hub2: "live", "marathon-pe": "live", trophy: "live" },
  ruleBasedTargets: true, maxIntentsPerRun: 500, maxFootwearIntentsPerRun: 500,
  concreteDivision: { shopOnly: { perSize: 2, oneSize: 5 } },
  policyGroups: { "footwear-all": { armed: true, memberCategoryKeys: FOOTWEAR_CATEGORY_KEYS.slice(), policy: { perSize: true, hub3: { target: 2, minQty: 1, reorderPoint: 1, carriedOnly: true } } } },
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

test("the expected number is Junid's, not the engine's: a Hub 3 sneaker leg still at the old keep of 3 is wrong_number", () => {
  const c = cfg(); c.policyGroups["footwear-all"].policy.hub3 = { target: 3, minQty: 2, reorderPoint: 1, carriedOnly: true };
  const a = run({ config: c });
  // Both sizes: Central holds 9 too, so neither is a dead size.
  assert.deepEqual(a.byReason, { wrong_number: 2 });
  assert.deepEqual(a.items.map((m) => `${m.loc}:${m.pid}:${m.size}:${m.expected.target}->${m.effective.target}`), ["hub3:s1:8:2->3", "hub3:s1:9:2->3"]);
  assert.equal(a.perLoc.hub3.mismatched, 1);
});

test("verdicts: missing, unexpected, dead size, none", () => {
  assert.deepEqual(dv.divisionAuditVerdict({ expected: { target: 2, reorderPoint: null }, effective: null }), { ok: false, reason: "missing" });
  assert.deepEqual(dv.divisionAuditVerdict({ expected: null, effective: { target: 2, source: "category_policy" } }), { ok: false, reason: "unexpected" });
  assert.deepEqual(dv.divisionAuditVerdict({ expected: { target: 3, reorderPoint: 1 }, effective: { target: 0 }, deadSize: true }), { ok: true, reason: "dead_size" });
  assert.deepEqual(dv.divisionAuditVerdict({ expected: null, effective: null }), { ok: true, reason: "none" });
});

test("expected keeps, straight from Junid's 12 Nov numbers", () => {
  const division = dv.divisionContext({ config: cfg(), seats });
  assert.deepEqual(dv.divisionExpectedTarget(division, "concrete", "t1", "S", products.t1), { target: 2, reorderPoint: null });
  assert.deepEqual(dv.divisionExpectedTarget(division, "concrete", "b1", "", products.b1), { target: 5, reorderPoint: null });
  assert.deepEqual(dv.divisionExpectedTarget(division, "concrete", "h1", "L", products.h1), { target: 2, reorderPoint: null }, "Hub 3 holding it changes nothing");
  assert.equal(dv.divisionExpectedTarget(division, "concrete", "s1", "8", products.s1), null);
  assert.deepEqual(dv.divisionExpectedTarget(division, "hub3", "s1", "8", products.s1), { target: 2, reorderPoint: 1 });
  assert.equal(dv.divisionExpectedTarget(division, "hub3", "h1", "L", products.h1), null, "Hub 3 keeps no non-footwear");
  assert.equal(dv.divisionExpectedTarget(division, "hub3", "b1", "", products.b1), null);
  assert.equal(dv.divisionExpectedTarget(division, "concrete", "p1", "", { category: "Perfume", categoryKey: "perfumes", sizes: [] }), null, "no perfume at Concrete");
  assert.deepEqual(dv.divisionExpectedTarget(division, "marathon-pine", "p1", "", { category: "Perfume", categoryKey: "perfumes", sizes: [] }), { target: 5, reorderPoint: null });
});

test("a Hub 3 clothing seat left over (before the scan unseats it) is not a mismatch: nothing expected, nothing armed", () => {
  const a = run();
  assert.ok(!a.items.some((m) => m.loc === "hub3" && m.pid === "h1"), JSON.stringify(a.items));
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

test("the expected keeps are Junid's numbers, not the key's: a key drifted to 3 per size is wrong_number", () => {
  const c = cfg(); c.concreteDivision.shopOnly.perSize = 3;
  const a = run({ config: c });
  assert.ok(a.count > 0);
  assert.ok(a.items.every((m) => m.reason === "wrong_number" && m.expected.target === 2 && m.effective.target === 3), JSON.stringify(a.items));
  assert.deepEqual(dv.JUNID_DIVISION_KEEPS, { shopOnly: { perSize: 2, oneSize: 5, askAt: null } });
  assert.deepEqual(dv.HUB3_SNEAKER_KEEP, { target: 2, reorderPoint: 1 });
});

test("an explicit row is always named explicit_row, even with the policy's target (ask-at differs)", () => {
  assert.deepEqual(dv.divisionAuditVerdict({ expected: { target: 1, reorderPoint: 0 }, effective: { target: 1, reorderPoint: null, source: "explicit" } }), { ok: false, reason: "explicit_row" });
  assert.deepEqual(dv.divisionAuditVerdict({ expected: { target: 2, reorderPoint: null }, effective: { target: 2, reorderPoint: null, source: "explicit" } }), { ok: true, reason: "kept" });
});

test("a keep with no live source for the size is 'unrouted', not 'kept'", () => {
  const net = JSON.parse(JSON.stringify(reg.SEED_REGISTRY));
  net.locations.central.autoRefill = "off";
  // Central is not routable to Concrete: the shop keep has no source at all.
  const a = computeRefillPlan({ nowMs: Date.parse(ISO), config: cfg(), targets: {}, stock: world(), products, openIndex: {}, refillRequests: {}, orders: {}, movements: [], network: net, seats }).exceptions.divisionPolicy;
  assert.ok(a.items.some((m) => m.loc === "concrete" && m.pid === "h1" && m.reason === "unrouted"), JSON.stringify(a.items));
});

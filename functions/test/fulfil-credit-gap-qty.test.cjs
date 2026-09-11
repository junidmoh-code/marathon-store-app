// ─── The Diesel Slide request asked for 1 — pinned as the source gate ─────────
// FULFIL-CREDIT-GAP.md, Phase D. At the 14:00 window on 9 Sep, Hub 1 size 6
// held −1 (reads 0), the policy target was 3 (reorder point 1), and Central
// held exactly 1. need = 3; the engine asked for min(need, Central on-hand) = 1.
// That is the actionable-only gate working as designed, not a defect in the
// need calculation. These tests replay that instant through computeRefillPlan
// and pin both halves: the full gap is asked when Central can supply it, and
// a negative destination cell never shrinks (or inflates) the gap.
//
// Run: cd functions && node --test test/fulfil-credit-gap-qty.test.cjs
// Mutation-proved in scripts/mutation-proof-fulfil-credit-gap.mjs.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");

const NOW = Date.parse("2026-09-09T12:00:04.905Z");   // the 14:00 SA window, 9 Sep
const PID = "p1778157967464";

// The live Hub 1 slides run as resolved on 2026-09-11: size 6 → target 3, min 2, reorder point 1.
const HUB1_SLIDES = { 6: { target: 3, minQty: 2, reorderPoint: 1 }, 7: { target: 3, minQty: 2, reorderPoint: 1 } };
const PRODUCTS = {
  [PID]: { id: PID, name: "Diesel Slide Full Black", category: "Footwear", categoryKey: "slides", brand: "Diesel", sizes: ["6", "7"] },
};
const config = () => ({
  mode: { hub1: "live" }, routes: { hub1: "central" },
  ruleBasedTargets: true, maxIntentsPerRun: 200, maxFootwearIntentsPerRun: 200, maxUnitsPerIntent: 20,
  categoryPolicy: { slides: { perSize: true, hub1: { sizes: HUB1_SLIDES, carriedOnly: true } } },
});
const plan = (stock) => computeRefillPlan({
  nowMs: NOW, config: config(), targets: {}, stock, products: PRODUCTS,
  openIndex: {}, refillRequests: {}, orders: {}, movements: [], targetDecisions: {}, rejectStreak: {}, retryState: {},
});
const size6 = (p) => p.intents.filter((i) => i.dest === "hub1" && i.productId === PID && i.size === "6");

test("the live instant: hub1 −1, central 1, target 3 → ONE intent for qty 1 (need 3 capped by Central's 1)", () => {
  const p = plan({ hub1: { [PID]: { 6: { qty: -1 }, 7: { qty: 3 } } }, central: { [PID]: { 6: { qty: 1 }, 7: { qty: 7 } } } });
  const i = size6(p);
  assert.equal(i.length, 1);
  assert.equal(i[0].qty, 1);
  assert.equal(i[0].source, "central");
  const bt = p.exceptions.belowTarget.items.find((x) => x.loc === "hub1" && x.pid === PID && x.size === "6");
  assert.equal(bt.deficit, 3);                      // the NEED was the full gap to target
  assert.equal(bt.have, -1);                        // reported as it is, clamped only in the arithmetic
});

test("same cell with Central holding 5 → the full gap of 3 is asked, not 1", () => {
  const p = plan({ hub1: { [PID]: { 6: { qty: -1 } } }, central: { [PID]: { 6: { qty: 5 } } } });
  assert.equal(size6(p)[0].qty, 3);
});

test("a −1 destination cell asks for exactly what a 0 cell asks for — the negative neither inflates nor hides the gap", () => {
  const neg = plan({ hub1: { [PID]: { 6: { qty: -1 } } }, central: { [PID]: { 6: { qty: 5 } } } });
  const zero = plan({ hub1: { [PID]: { 6: { qty: 0 } } }, central: { [PID]: { 6: { qty: 5 } } } });
  assert.equal(size6(neg)[0].qty, size6(zero)[0].qty);
  assert.equal(size6(neg)[0].qty, 3);
});

test("Central at 0 → no intent at all (the gate never writes a card the warehouse cannot pick)", () => {
  const p = plan({ hub1: { [PID]: { 6: { qty: -1 } } }, central: { [PID]: { 6: { qty: 0 } } } });
  assert.equal(size6(p).length, 0);
  assert.equal(p.intents.length, 0);
});

test("Health: a sold movement carrying a shortfall is reported under exceptions.shortfalls (the shortage signal that replaced negative cells)", () => {
  const movements = [
    // an OFFLINE sale: rung at ts, written later at appliedAt — reported on the sale instant
    { type: "sold", productId: PID, size: "6", qty: 3, from: "hub1", shortfall: 2, ts: "2026-09-11T10:00:00.000Z", appliedAt: "2026-09-11T13:45:00.000Z", link: { saleId: "S1" } },
    { type: "sold", productId: PID, size: "7", qty: 1, from: "hub1", appliedAt: "2026-09-11T10:00:00.000Z" },   // fully covered — not a shortfall
  ];
  const p = computeRefillPlan({
    nowMs: NOW, config: config(), targets: {}, stock: { hub1: { [PID]: { 6: { qty: 0 } } }, central: { [PID]: { 6: { qty: 5 } } } }, products: PRODUCTS,
    openIndex: {}, refillRequests: {}, orders: {}, movements, targetDecisions: {}, rejectStreak: {}, retryState: {},
  });
  assert.equal(p.exceptions.shortfalls.count, 1);
  assert.deepEqual(p.exceptions.shortfalls.items[0], { loc: "hub1", pid: PID, size: "6", qty: 3, shortfall: 2, ts: "2026-09-11T10:00:00.000Z", saleId: "S1" });
});

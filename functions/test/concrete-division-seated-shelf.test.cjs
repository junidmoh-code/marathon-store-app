// ─── A SEATED SHOP SHELF ARMS ITS KEEP (Junid, 10 Nov 2026) ──────────────────
// Concrete raised nothing: Pine and Concrete are "solved products only", so the
// trust mask hid every uncounted shop cell, and the division keep only armed a
// product the masked view carried. 1,059 of Concrete's products were seated and
// invisible. A seat is now the arming act at the two shops, and a seated
// non-sneaker reads its whole shelf (the till deducts every sale there).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");
const reg = require("../lib/network-registry.cjs");
const dv = require("../lib/concrete-division.cjs");
const { FOOTWEAR_CATEGORY_KEYS } = require("../lib/policy-resolve.cjs");

const NOW = Date.parse("2026-11-10T09:00:00.000Z");
const ISO = "2026-11-10T09:00:00.000Z";
const config = () => ({
  routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
  mode: { hub1: "live", hub2: "live", "marathon-pe": "live", trophy: "live" },
  ruleBasedTargets: true, maxIntentsPerRun: 500, maxFootwearIntentsPerRun: 500, maxUnitsPerIntent: 20,
  concreteDivision: { shopOnly: { perSize: 2, oneSize: 5 }, fromHub3: { perSize: 1, oneSize: 5, askAt: 0 }, hub3Keep: { on: false, perSize: 2, oneSize: 10 } },
  policyGroups: { "footwear-all": { armed: true, memberCategoryKeys: FOOTWEAR_CATEGORY_KEYS.slice(), policy: { perSize: true, hub3: { target: 3, minQty: 2, reorderPoint: 1, carriedOnly: true } } } },
  categoryPolicy: {},
});
// An uncounted (untrusted) cell — what almost every Concrete cell is.
const shelf = (qty) => ({ qty, v: 1, mv: "m", lastType: "transfer_in" });
const counted = (qty) => ({ qty, v: 1, mv: "m", lastType: "count" });
const TEE = { id: "t1", name: "Tee", category: "Clothing", categoryKey: "t-shirts", productType: "clothing", sizes: ["S", "M", "L"] };
const BAG = { id: "b1", name: "Bag", category: "Accessories", categoryKey: "bags", sizes: [] };
const SHOE = { id: "s1", name: "Shoe", category: "Footwear", subcategory: "Sneakers", categoryKey: "sneakers", productType: "sneaker", sizes: ["8"] };
const products = { t1: TEE, b1: BAG, s1: SHOE };
const seat = { via: "stock", at: ISO };
const CENTRAL = { t1: { S: counted(9), M: counted(9), L: counted(9) }, b1: { _: counted(20) }, s1: { 8: counted(9) } };
function plan({ stock, seats, targets = {}, cfg = config() }) {
  return computeRefillPlan({
    nowMs: NOW, config: cfg, targets, products, openIndex: {}, refillRequests: {}, orders: {}, movements: [],
    stock: { central: CENTRAL, hub3: {}, concrete: {}, "marathon-pine": {}, ...stock }, network: reg.SEED_REGISTRY, seats,
  });
}
const lines = (p, dest) => p.intents.filter((i) => i.dest === dest).map((i) => `${i.source}:${i.sizeKey}:${i.qty}`).sort();

test("a seated, uncounted Concrete shelf below keep asks Central for the gap, every declared size", () => {
  const p = plan({ stock: { concrete: { t1: { S: shelf(1), M: shelf(0) } } }, seats: { concrete: { t1: seat } } });
  // keep 2 per size: S has 1 → 1; M has 0 → 2; L has no cell → 2.
  assert.deepEqual(lines(p, "concrete"), ["central:L:2", "central:M:2", "central:S:1"]);
  assert.ok(p.intents.filter((i) => i.dest === "concrete").every((i) => i.seatedShop === true), "the write-time trust check is told why");
});

test("the shelf is read whole: three uncounted units on a keep of 2 ask for nothing", () => {
  const p = plan({ stock: { concrete: { t1: { S: shelf(3), M: shelf(2), L: shelf(2) } } }, seats: { concrete: { t1: seat } } });
  assert.deepEqual(lines(p, "concrete"), []);
});

test("a no-size item keeps 5 per design", () => {
  const p = plan({ stock: { "marathon-pine": { b1: { _: shelf(1) } } }, seats: { "marathon-pine": { b1: seat } } });
  assert.deepEqual(lines(p, "marathon-pine"), ["central:_:4"]);
});

test("an UNSEATED uncounted shelf still arms nothing (seating, not the cell, decides)", () => {
  const p = plan({ stock: { concrete: { t1: { S: shelf(0) } } }, seats: { concrete: {} } });
  assert.deepEqual(lines(p, "concrete"), []);
});

test("a Seating-tab switch-off (target 0 rows) still wins over the seat", () => {
  const targets = { concrete: { t1: { S: { target: 0, minQty: 0 }, M: { target: 0, minQty: 0 }, L: { target: 0, minQty: 0 } } } };
  const p = plan({ stock: { concrete: { t1: { S: shelf(0) } } }, seats: { concrete: { t1: seat } }, targets });
  assert.deepEqual(lines(p, "concrete"), []);
});

test("a shoe on a seated shop shelf is never a shop keep", () => {
  const p = plan({ stock: { concrete: { s1: { 8: shelf(0) } } }, seats: { concrete: { s1: seat } } });
  assert.deepEqual(lines(p, "concrete"), []);
});

test("Central holding none of the size is the source gate: no line, the size is a reorder candidate", () => {
  const cfg = config();
  const p = computeRefillPlan({
    nowMs: NOW, config: cfg, targets: {}, products, openIndex: {}, refillRequests: {}, orders: {}, movements: [],
    stock: { central: { t1: { S: counted(0) } }, hub3: {}, concrete: { t1: { S: shelf(0) } }, "marathon-pine": {} }, network: reg.SEED_REGISTRY, seats: { concrete: { t1: seat } },
  });
  assert.deepEqual(lines(p, "concrete"), []);
  assert.ok(p.exceptions.missingSizes.items.some((m) => m.loc === "concrete" && m.pid === "t1"));
});

test("the lift is the shop's own: the masked view every other reader holds is unchanged", () => {
  // Pine's uncounted shelf is NOT a source for Concrete and NOT network stock for Marathon.
  const raw = { concrete: { t1: { S: shelf(4) } } };
  const masked = require("../lib/refill-engine.cjs").maskUntrustedStock({ central: CENTRAL, ...raw }, reg.SEED_REGISTRY).stock;
  assert.equal(masked.concrete.t1, undefined, "the mask itself is untouched");
});

test("the shared predicates: seated at a shop, or a cell in the view", () => {
  const division = dv.divisionContext({ config: config(), rawStock: {}, seats: { concrete: { t1: seat }, hub3: { b1: seat } }, openIndex: {}, heldLines: {}, refillRequests: {} });
  assert.equal(dv.isSeatedAtShop(division, "concrete", "t1"), true);
  assert.equal(dv.isSeatedAtShop(division, "hub3", "b1"), false, "Hub 3 is not a shop");
  assert.equal(dv.divisionShopCarries(division, "marathon-pine", "t1", { "marathon-pine": { t1: { S: {} } } }), true);
  assert.equal(dv.divisionShopCarries(division, "marathon-pine", "t1", {}), false);
  assert.deepEqual(dv.divisionManagedPids(division, "concrete", {}, products), ["t1"]);
});

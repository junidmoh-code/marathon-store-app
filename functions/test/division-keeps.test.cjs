// The Engine Policy census counts the Concrete division's keeps (Junid, 9 Nov 2026).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { divisionContext, divisionKeepCounts } = require("../lib/concrete-division.cjs");
const { buildCensus } = require("../lib/category-policy-write.cjs");
const { SEED_REGISTRY } = require("../lib/network-registry.cjs");

const PRODUCTS = {
  tee: { categoryKey: "t-shirts", category: "Clothing", productType: "clothing", sizes: ["S", "M"] },
  cap: { categoryKey: "caps-beanies", category: "Accessories", sizes: ["_"] },
  shoe: { categoryKey: "sneakers", category: "Footwear", sizes: ["8"] },
  gone: { categoryKey: "t-shirts", category: "Clothing", productType: "clothing", sizes: ["S"] },
};
const POLICY = (on) => ({ concreteDivision: { shopOnly: { perSize: 2, oneSize: 5 }, fromHub3: { perSize: 1, oneSize: 5, askAt: 0 }, hub3Keep: { on, perSize: 2, oneSize: 10 } } });
const cell = (qty) => ({ qty, v: 1, trusted: true });
const STOCK = {
  concrete: { tee: { S: cell(1), M: cell(0) }, shoe: { 8: cell(1) } },
  "marathon-pine": { cap: { _: cell(1) } },
  hub3: { tee: { S: cell(4) } },
};
const counts = (on, stock = STOCK, seats = {}) => divisionKeepCounts({
  division: divisionContext({ config: POLICY(on), rawStock: stock, seats, openIndex: {}, heldLines: null, refillRequests: null }),
  stockView: stock, products: PRODUCTS,
});

test("each shop's keeps: its products, every declared size, the units the policy asks", () => {
  const c = counts(false);
  // Concrete's tee is held at Hub 3 too, so it is the from-Hub-3 keep: 1 per size.
  assert.deepEqual(c.concrete, { products: 1, cells: 2, units: 2 });
  // Pine's cap, one size, shop-only: 5.
  assert.deepEqual(c["marathon-pine"], { products: 1, cells: 1, units: 5 });
});

test("a shoe on a shop's shelf is not a keep: footwear stays Hub 3's", () => {
  assert.equal(counts(false).concrete.products, 1);
});

test("the Hub 3 keep counts nothing while it is off, and says how many seats wait for it", () => {
  const seats = { hub3: { tee: { via: "solve" }, shoe: { via: "stock" } } };
  const off = counts(false, STOCK, seats);
  assert.deepEqual(off.hub3, { products: 0, cells: 0, units: 0, on: false, seatedNonSneakers: 1 });
  const on = counts(true, STOCK, seats);
  // Every declared size of the seated tee: 2 per size, S and M.
  assert.deepEqual(on.hub3, { products: 1, cells: 2, units: 4, on: true, seatedNonSneakers: 1 });
});

test("no key, no counts: every location answers zero", () => {
  const c = divisionKeepCounts({ division: null, stockView: STOCK, products: PRODUCTS });
  assert.deepEqual(c.concrete, { products: 0, cells: 0, units: 0 });
  assert.equal(c.hub3.on, false);
});

// A paged-read fake: orderByKey().limitToFirst().startAt() and a snapshot forEach.
function fakeDb(tree) {
  const at = (p) => String(p).split("/").filter(Boolean).reduce((n, k) => (n == null ? undefined : n[k]), tree);
  return { ref: (p) => {
    const q = { _start: null, _limit: Infinity,
      orderByKey() { return q; }, limitToFirst(n) { q._limit = n; return q; }, startAt(k) { q._start = k; return q; },
      once: async () => {
        const v = at(p);
        const keys = v && typeof v === "object" ? Object.keys(v).sort().filter((k) => q._start == null || k >= q._start).slice(0, q._limit) : [];
        return { val: () => v ?? null, forEach: (fn) => keys.forEach((k) => fn({ key: k })), child: (k) => ({ val: () => v[k] }) };
      } };
    return q;
  } };
}

test("buildCensus carries the counts, read from the three locations, when the key is on", async () => {
  const db = fakeDb({ products: PRODUCTS, stock: STOCK, stock_targets: {}, refill_engine: { open: {}, seats: { hub3: { tee: { via: "solve" } } } } });
  const census = await buildCensus(db, { config: POLICY(true), taxonomy: { cats: {} }, knownLocations: [], network: SEED_REGISTRY });
  assert.equal(census.divisionKeeps.hub3.on, true);
  assert.equal(census.divisionKeeps.hub3.products, 1);
  assert.equal(census.divisionKeeps["marathon-pine"].units, 5);
});

test("buildCensus says nothing about the division when the key is off", async () => {
  const db = fakeDb({ products: PRODUCTS, stock: STOCK, stock_targets: {}, refill_engine: { open: {} } });
  const census = await buildCensus(db, { config: {}, taxonomy: { cats: {} }, knownLocations: [], network: SEED_REGISTRY });
  assert.equal(census.divisionKeeps, null);
});

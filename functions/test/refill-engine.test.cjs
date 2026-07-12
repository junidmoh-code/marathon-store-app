// Tests for the pure refill-engine core. Run: cd functions && node --test
const { test } = require("node:test");
const assert = require("node:assert");
const { computeRefillPlan, computeConfidence, encodeSizeKey, saTodayKey } = require("../lib/refill-engine.cjs");

const NOW = Date.parse("2026-07-12T10:00:00.000Z");
const iso = (msAgoH = 0) => new Date(NOW - msAgoH * 3600e3).toISOString();

const CONFIG = {
  enabled: true,
  mode: { "marathon-pe": "live", trophy: "live", hub2: "live" },
  routes: { "marathon-pe": "hub2", trophy: "hub2", hub2: "central" },
  defaultRunByStore: {
    "marathon-pe": { S: 2, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 1 },
    trophy: { S: 2, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 1 },
  },
  defaultRunRecentSaleDays: 14,
  staleIntentHours: 48,
  maxUnitsPerIntent: 20,
  maxIntentsPerRun: 200,
};

const PRODUCTS = { p1: { name: "Tee", productType: "clothing", sizes: ["M", "L", "XL"] } };
const cell = (qty) => ({ qty, v: 1 });

function base(over = {}) {
  return {
    nowMs: NOW, config: CONFIG, products: PRODUCTS,
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } } },
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(10) } }, central: { p1: { M: cell(5) } }, trophy: {} },
    openIndex: {}, refillRequests: {}, orders: {}, movements: [],
    ...over,
  };
}

test("store below target → intent from routed source", () => {
  const plan = computeRefillPlan(base());
  const i = plan.intents.find((x) => x.dest === "marathon-pe" && x.productId === "p1");
  assert.ok(i, "intent created");
  assert.equal(i.source, "hub2");
  assert.equal(i.qty, 2); // target 3 − have 1
  assert.equal(i.priority, "high"); // have 1 < minQty 2
});

test("negative store qty counts as 0 available, never inflates deficit", () => {
  const plan = computeRefillPlan(base({
    stock: { "marathon-pe": { p1: { M: cell(-5) } }, hub2: { p1: { M: cell(10) } }, central: {}, trophy: {} },
  }));
  const i = plan.intents.find((x) => x.dest === "marathon-pe");
  assert.equal(i.qty, 3); // target 3 − max(−5,0) = 3, NOT 8
  assert.ok(plan.exceptions.negativeCells.count >= 1);
});

test("existing open intent suppresses a duplicate and reserves source stock", () => {
  const plan = computeRefillPlan(base({
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", qty: 2, source: "hub2", createdAt: iso(1) } } } },
  }));
  assert.equal(plan.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0);
});

test("manual Shop Refill order counts as inbound; engine autoRefill order does not double-count", () => {
  const plan = computeRefillPlan(base({
    orders: {
      "R001-1": { customerName: "Shop Refill", destShop: "marathon-pe", placedAtHub: "hub2", productId: "p1", size: "M", qty: 2, status: "incoming", clothingRefillStatus: null, createdAt: iso(1) },
    },
  }));
  assert.equal(plan.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0, "manual refill already covers the deficit");
});

test("propose-don't-suppress: full deficit requested even when the source shows less", () => {
  const plan = computeRefillPlan(base({
    targets: {
      "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } },
      hub2: { p1: { M: { target: 4, minQty: 2 } } },
    },
    stock: {
      "marathon-pe": { p1: { M: cell(0) } },
      hub2: { p1: { M: cell(1) } },       // system says 1 — the shelf decides
      central: { p1: { M: cell(50) } },
      trophy: {},
    },
  }));
  const storeLeg = plan.intents.find((x) => x.dest === "marathon-pe");
  assert.equal(storeLeg.qty, 3, "full deficit — warehouse validates availability");
  const hubLeg = plan.intents.find((x) => x.dest === "hub2");
  assert.equal(hubLeg.qty, 3); // hub2 target 4 − have 1
  assert.equal(hubLeg.source, "central");
});

test("zero stock anywhere → request STILL created + missingSizes reorder candidate", () => {
  const plan = computeRefillPlan(base({
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: {}, central: {}, trophy: {} },
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } }, hub2: { p1: { M: { target: 2, minQty: 1 } } } },
  }));
  assert.equal(plan.intents.length, 2, "both legs still ask — shelves beat database cells");
  assert.ok(plan.exceptions.missingSizes.count >= 1, "and the reorder candidate is surfaced");
});

test("rejection cooldown: a size the warehouse rejected today is not re-asked", () => {
  const plan = computeRefillPlan(base({
    orders: {
      "R009-1": { customerName: "Shop Refill", autoRefill: true, destShop: "marathon-pe", productId: "p1", size: "M", clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(2), status: "incoming", createdAt: iso(2) },
    },
  }));
  assert.equal(plan.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0);
  const old = computeRefillPlan(base({
    orders: {
      "R009-1": { customerName: "Shop Refill", autoRefill: true, destShop: "marathon-pe", productId: "p1", size: "M", clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(30), status: "incoming", createdAt: iso(30) },
    },
  }));
  assert.equal(old.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "cooldown expired → ask again");
});

test("excess: hub2 strict, stores only when significant; sneakers never counted", () => {
  const plan = computeRefillPlan(base({
    products: {
      p1: { name: "Tee", productType: "clothing", sizes: ["M"] },
      pSnk: { name: "Shoe", productType: "sneaker", sizes: ["8"] },
    },
    targets: {
      "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } },
      hub2: { p1: { M: { target: 3, minQty: 2 } } },
    },
    stock: {
      "marathon-pe": { p1: { M: cell(4) }, pSnk: { "8": cell(-3) } },  // +1 only → not significant
      hub2: { p1: { M: cell(4) } },                                     // +1 → flagged (strict)
      central: {}, trophy: {},
    },
  }));
  const locs = plan.exceptions.excess.items.map((e) => e.loc);
  assert.deepEqual(locs, ["hub2"]);
  assert.ok(plan.exceptions.negativeCells.items.every((n) => n.pid !== "pSnk"), "sneaker negatives filtered out");
});

test("resolved order closes its lock (fulfilled on available, cancelled on rejected)", () => {
  const plan = computeRefillPlan(base({
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "R004-1", orderCreatedAt: iso(3), qty: 2, source: "hub2", createdAt: iso(3) } } } },
    orders: { "R004-1": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(3), clothingRefillStatus: "available", status: "incoming" } },
  }));
  const c = plan.closes.find((x) => x.pid === "p1");
  assert.ok(c); assert.equal(c.reason, "fulfilled");
});

test("recycled R-number (createdAt mismatch) does NOT close the lock; it goes stale instead", () => {
  const plan = computeRefillPlan(base({
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "R004-1", orderCreatedAt: iso(80), qty: 2, source: "hub2", createdAt: iso(80) } } } },
    orders: { "R004-1": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(1), clothingRefillStatus: "available", status: "incoming" } },
  }));
  assert.equal(plan.closes.length, 0);
  assert.ok(plan.exceptions.stuckRefills.count >= 1, "80h old lock is stale");
});

test("circuit breaker is FAIR across destinations (no store starves another)", () => {
  const products = { p1: { productType: "clothing", sizes: [] } };
  const targets = { "marathon-pe": { p1: {} }, trophy: { p1: {} } };
  const stockPe = { p1: {} }, stockTr = { p1: {} }, stockHub = { p1: {} };
  for (let i = 0; i < 20; i++) {
    const s = `Z${i}`;
    products.p1.sizes.push(s);
    targets["marathon-pe"].p1[s] = { target: 3, minQty: 3 };  // ALL high priority
    stockPe.p1[s] = cell(0); stockHub.p1[s] = cell(9);
    if (i < 5) { targets.trophy.p1[s] = { target: 3, minQty: 1 }; stockTr.p1[s] = cell(0); } // few, normal priority
  }
  const plan = computeRefillPlan(base({
    config: { ...CONFIG, maxIntentsPerRun: 10 },
    products, targets,
    stock: { "marathon-pe": stockPe, trophy: stockTr, hub2: stockHub, central: {} },
  }));
  assert.equal(plan.intents.length, 10);
  const trophyGot = plan.intents.filter((i) => i.dest === "trophy").length;
  assert.equal(trophyGot, 5, "trophy gets its full share despite PE's bigger, higher-priority backlog");
});

test("three states: no target = noTarget surface (NOT excess); explicit 0 = all excess", () => {
  const plan = computeRefillPlan(base({
    products: {
      p1: PRODUCTS.p1,
      pUnset: { productType: "clothing", sizes: ["M"] },   // stock, NO target anywhere
      pBanned: { productType: "clothing", sizes: ["M"] },  // explicit target 0
    },
    targets: {
      "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } },
      hub2: { pBanned: { M: { target: 0, minQty: 0 } } },
    },
    stock: {
      "marathon-pe": { p1: { M: cell(3) } },
      hub2: { pUnset: { M: cell(6) }, pBanned: { M: cell(1) } },
      central: {}, trophy: {},
    },
  }));
  // Unconfigured stock: surfaced for humans, never auto-classified as excess.
  assert.deepEqual(plan.exceptions.noTarget.items, [{ loc: "hub2", pid: "pUnset", units: 6 }]);
  assert.ok(!plan.exceptions.excess.items.some((e) => e.pid === "pUnset"), "no-target is NOT excess");
  // Deliberate exclusion (target 0): every unit is excess, even a single one.
  assert.deepEqual(plan.exceptions.excess.items, [{ loc: "hub2", pid: "pBanned", sizeKey: "M", have: 1, target: 0, excess: 1 }]);
  // And unmanaged cells never generate refill intents.
  assert.ok(!plan.intents.some((i) => i.productId === "pUnset"));
});

test("keep-as-is decision clears a product from the No Target queue", () => {
  const over = {
    products: { p1: PRODUCTS.p1, pUnset: { productType: "clothing", sizes: ["M"] } },
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } } },
    stock: { "marathon-pe": { p1: { M: cell(3) } }, hub2: { pUnset: { M: cell(6) } }, central: {}, trophy: {} },
  };
  const before = computeRefillPlan(base(over));
  assert.equal(before.exceptions.noTarget.count, 1);
  const after = computeRefillPlan(base({
    ...over,
    targetDecisions: { hub2: { pUnset: { decision: "keep", decidedAt: iso(1) } } },
  }));
  assert.equal(after.exceptions.noTarget.count, 0, "decided products never reappear");
});

test("engine is driven by explicit targets only — no default-run auto-activation", () => {
  const plan = computeRefillPlan(base({
    targets: {},
    stock: { "marathon-pe": { p1: { L: cell(0) } }, hub2: { p1: { L: cell(9) } }, central: {}, trophy: {} },
    movements: [{ type: "sold", from: "marathon-pe", productId: "p1", size: "L", qty: 1, ts: iso(5) }],
  }));
  assert.equal(plan.intents.length, 0, "no targets → no requests, regardless of sales");
});

test("circuit breaker caps intents and reports an error", () => {
  const targets = { "marathon-pe": { p1: {} } };
  const stockPe = { p1: {} }; const stockHub = { p1: {} };
  const products = { p1: { productType: "clothing", sizes: [] } };
  for (let i = 0; i < 30; i++) {
    const s = `Z${i}`;
    products.p1.sizes.push(s);
    targets["marathon-pe"].p1[s] = { target: 3, minQty: 1 };
    stockPe.p1[s] = cell(0); stockHub.p1[s] = cell(9);
  }
  const plan = computeRefillPlan(base({
    config: { ...CONFIG, maxIntentsPerRun: 10 },
    products, targets,
    stock: { "marathon-pe": stockPe, hub2: stockHub, central: {}, trophy: {} },
  }));
  assert.equal(plan.intents.length, 10);
  assert.ok(plan.errors.length >= 1);
});

test("intelligence: onlyInCentral / onlyInHub2 / hub2 excess", () => {
  const plan = computeRefillPlan(base({
    products: { p1: PRODUCTS.p1, p2: { productType: "clothing", sizes: ["M"] }, p3: { productType: "clothing", sizes: ["M"] } },
    targets: { hub2: { p3: { M: { target: 2, minQty: 1 } } } },
    stock: {
      "marathon-pe": {}, trophy: {},
      hub2: { p3: { M: cell(11) } },
      central: { p2: { M: cell(7) } },
    },
  }));
  assert.deepEqual(plan.exceptions.onlyInCentral.items[0], { pid: "p2", units: 7 });
  assert.equal(plan.exceptions.onlyInHub2.items[0].pid, "p3");
  assert.deepEqual(plan.exceptions.excess.items[0], { loc: "hub2", pid: "p3", sizeKey: "M", have: 11, target: 2, excess: 9 });
});

test("confidence: negative cells + adjustments + uncounted sends lower the score", () => {
  const out = computeConfidence({
    nowMs: NOW,
    stock: { "marathon-pe": { p1: { M: { qty: -2, updatedAt: iso(1) } } } },
    movements: [
      { type: "adjustment", from: "marathon-pe", productId: "p1", ts: iso(24) },
      { type: "received", reason: "clothing_cr_uncounted", to: "marathon-pe", productId: "p1", ts: iso(24) },
    ],
  });
  const e = out["marathon-pe"].p1;
  assert.equal(e.score, 100 - 30 - 5 - 10);
  assert.equal(e.factors.negativeCells, 1);
});

test("saTodayKey matches device-local SA format (0-based month)", () => {
  // 2026-07-11 23:30 UTC = 2026-07-12 01:30 SA → key uses SA date, month 0-based
  assert.equal(saTodayKey(Date.parse("2026-07-11T23:30:00Z")), "2026-6-12");
  assert.equal(encodeSizeKey("5.5"), "5_5");
  assert.equal(encodeSizeKey(""), "_");
});

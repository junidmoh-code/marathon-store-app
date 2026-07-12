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

test("cascade: store shortfall at hub2 rolls into central→hub2 intent", () => {
  const plan = computeRefillPlan(base({
    targets: {
      "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } },
      hub2: { p1: { M: { target: 4, minQty: 2 } } },
    },
    stock: {
      "marathon-pe": { p1: { M: cell(0) } },
      hub2: { p1: { M: cell(1) } },       // can only give 1 of the 3 needed
      central: { p1: { M: cell(50) } },
      trophy: {},
    },
  }));
  const storeLeg = plan.intents.find((x) => x.dest === "marathon-pe");
  assert.equal(storeLeg.qty, 1, "capped by hub2 availability");
  const hubLeg = plan.intents.find((x) => x.dest === "hub2");
  // hub2 target 4 − have 1 + passThrough 2 = 5... but hub2's own have=1 was
  // fully reserved by the store leg. Engine math: deficit = 4 − 1 + 2 = 5.
  assert.equal(hubLeg.qty, 5);
  assert.equal(hubLeg.source, "central");
});

test("unavailable everywhere → missingSizes exception, no impossible intent", () => {
  const plan = computeRefillPlan(base({
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: {}, central: {}, trophy: {} },
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } }, hub2: { p1: { M: { target: 2, minQty: 1 } } } },
  }));
  assert.equal(plan.intents.length, 0);
  assert.ok(plan.exceptions.missingSizes.count >= 1);
});

test("default run applies only after a recent sale at that shop", () => {
  const noSale = computeRefillPlan(base({ targets: {}, stock: { "marathon-pe": { p1: { L: cell(0) } }, hub2: { p1: { L: cell(9) } }, central: {}, trophy: {} } }));
  assert.equal(noSale.intents.length, 0, "no recent sale → unmanaged");
  const withSale = computeRefillPlan(base({
    targets: {},
    stock: { "marathon-pe": { p1: { L: cell(0) } }, hub2: { p1: { L: cell(9) } }, central: {}, trophy: {} },
    movements: [{ type: "sold", from: "marathon-pe", productId: "p1", size: "L", qty: 1, ts: iso(5) }],
  }));
  const i = withSale.intents.find((x) => x.dest === "marathon-pe" && x.sizeKey === "L");
  assert.ok(i, "recent sale activates the default run");
  assert.equal(i.qty, 3); // default L=3
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

test("intelligence: onlyInCentral / onlyInHub2 / excessAtHub2", () => {
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
  assert.deepEqual(plan.exceptions.excessAtHub2.items[0], { pid: "p3", sizeKey: "M", have: 11, target: 2, excess: 9 });
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

test("policy warnings: uncarried size, inactive product, unknown product", () => {
  const plan = computeRefillPlan(base({
    products: { p1: { name: "Tee", productType: "clothing", sizes: ["M"] } },
    targets: {
      "marathon-pe": {
        p1: { M: { target: 3, minQty: 2 }, XXXL: { target: 1, minQty: 1 } }, // XXXL not carried, no stock
        pGone: { M: { target: 3, minQty: 2 } },                              // product deleted
      },
    },
    stock: { "marathon-pe": { p1: { M: cell(3) } }, hub2: {}, central: {}, trophy: {} },
    movements: [], // no sales in 30d → p1 inactive warning too
  }));
  const kinds = plan.exceptions.policyWarnings.items.map((w) => w.kind).sort();
  assert.deepEqual(kinds, ["inactive_product", "size_not_carried", "unknown_product"]);
});

test("policy warnings: recent sale suppresses inactive_product; stock legitimises a size", () => {
  const plan = computeRefillPlan(base({
    products: { p1: { name: "Tee", productType: "clothing", sizes: ["M"] } },
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 }, L: { target: 3, minQty: 2 } } } },
    // L isn't in the catalog but hub2 physically holds it → not a warning.
    stock: { "marathon-pe": { p1: { M: cell(3), L: cell(3) } }, hub2: { p1: { L: cell(2) } }, central: {}, trophy: {} },
    movements: [{ type: "sold", from: "marathon-pe", productId: "p1", size: "M", qty: 1, ts: iso(24) }],
  }));
  assert.equal(plan.exceptions.policyWarnings.count, 0);
});

test("saTodayKey matches device-local SA format (0-based month)", () => {
  // 2026-07-11 23:30 UTC = 2026-07-12 01:30 SA → key uses SA date, month 0-based
  assert.equal(saTodayKey(Date.parse("2026-07-11T23:30:00Z")), "2026-6-12");
  assert.equal(encodeSizeKey("5.5"), "5_5");
  assert.equal(encodeSizeKey(""), "_");
});

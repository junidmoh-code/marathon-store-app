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

test("zero stock anywhere → NO request at all, straight to the reorder list", () => {
  const plan = computeRefillPlan(base({
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: {}, central: {}, trophy: {} },
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } }, hub2: { p1: { M: { target: 2, minQty: 1 } } } },
  }));
  assert.equal(plan.intents.length, 0, "provably unfillable — never enters a queue");
  assert.ok(plan.exceptions.missingSizes.count >= 1, "surfaced as a reorder candidate instead");
});

test("rejection cooldown: a rejected size WITH upstream stock rests 24h, then re-asks", () => {
  const withStock = { stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(10) } }, central: {}, trophy: {} } };
  const fresh = computeRefillPlan(base({
    ...withStock,
    orders: { "R009-1": { customerName: "Shop Refill", autoRefill: true, destShop: "marathon-pe", productId: "p1", size: "M", clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(2), status: "incoming", createdAt: iso(2) } },
  }));
  assert.equal(fresh.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0, "2h since rejection → resting");
  const old = computeRefillPlan(base({
    ...withStock,
    orders: { "R009-1": { customerName: "Shop Refill", autoRefill: true, destShop: "marathon-pe", productId: "p1", size: "M", clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(30), status: "incoming", createdAt: iso(30) } },
  }));
  assert.equal(old.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "cooldown passed + stock exists → ask again");
});

test("ARRIVAL LIFT: stock arriving at the source AFTER a rejection reopens the demand at once", () => {
  const withStock = { stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(10) } }, central: {}, trophy: {} } };
  const rejected5hAgo = {
    orders: { "R009-1": { customerName: "Shop Refill", autoRefill: true, destShop: "marathon-pe", productId: "p1", size: "M", clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(5), status: "incoming", createdAt: iso(5) } },
  };
  // Hub 2 received stock an hour ago (AFTER the 5h-old rejection) → the "no"
  // is stale; the engine re-asks immediately instead of resting out 24h.
  const arrived = computeRefillPlan(base({
    ...withStock, ...rejected5hAgo,
    movements: [{ type: "received", to: "hub2", productId: "p1", size: "M", qty: 10, ts: iso(1) }],
  }));
  assert.equal(arrived.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "arrival after rejection → reopened");
  // The only arrival PREDATES the rejection (they looked and said no AFTER the
  // stock came in) → the cooldown holds, and the parked demand is visible as
  // waitingForStock instead of vanishing.
  const stale = computeRefillPlan(base({
    ...withStock, ...rejected5hAgo,
    movements: [{ type: "received", to: "hub2", productId: "p1", size: "M", qty: 10, ts: iso(9) }],
  }));
  assert.equal(stale.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0, "arrival predates the rejection → still resting");
  assert.ok(stale.exceptions.waitingForStock.items.some((w) => w.pid === "p1" && w.loc === "marathon-pe" && w.source === "hub2"),
    "parked demand surfaced as Waiting for Stock");
  // An outbound movement (a sale at the source) is NOT an arrival — no lift.
  const soldOnly = computeRefillPlan(base({
    ...withStock, ...rejected5hAgo,
    movements: [{ type: "sold", from: "hub2", productId: "p1", size: "M", qty: 1, ts: iso(1) }],
  }));
  assert.equal(soldOnly.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0, "a sale never lifts a rejection");
});

test("ARRIVAL LIFT: confirmed-out clears when stock arrives at a denying level after its denial", () => {
  const denials = {
    orders: { "R009-1": { customerName: "Shop Refill", autoRefill: true, destShop: "marathon-pe", productId: "p1", size: "M", clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(30), status: "incoming", createdAt: iso(30) } },
    refillRequests: { rHub: { status: "cancelled", resolvedAt: iso(30), productId: "p1", size: "M", requestingLocation: "hub2", rejectedBy: "warehouse" } },
  };
  // Central receives the size from a supplier AFTER both denials → no longer
  // confirmed out; the normal cycle resumes (the 30h-old rejection has cooled
  // down, so the store's deficit is asked again right away).
  const restocked = computeRefillPlan(base({
    ...denials,
    movements: [{ type: "received", to: "central", productId: "p1", size: "M", qty: 6, ts: iso(2) }],
  }));
  assert.equal(restocked.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "arrival at Central un-confirms the out");
  assert.ok(!restocked.exceptions.missingSizes.items.some((m) => m.pid === "p1" && /confirmed out/.test(m.note)), "off the confirmed-out reorder list");
  // Arrival BEFORE the denials changes nothing — still confirmed out.
  const priorArrival = computeRefillPlan(base({
    ...denials,
    movements: [{ type: "received", to: "central", productId: "p1", size: "M", qty: 6, ts: iso(40) }],
  }));
  assert.equal(priorArrival.intents.filter((x) => x.productId === "p1" && x.sizeKey === "M").length, 0, "old arrival ≠ fresh evidence");
  assert.ok(priorArrival.exceptions.missingSizes.items.some((m) => m.pid === "p1" && /confirmed out/.test(m.note)), "stays on the reorder list");
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

test("restock resurrects a size: no stock = absent; stock appears = requested again", () => {
  const rejected = {
    orders: {
      "R009-1": { customerName: "Shop Refill", autoRefill: true, destShop: "marathon-pe", productId: "p1", size: "M", clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(30), status: "incoming", createdAt: iso(30) },
    },
  };
  const dry = computeRefillPlan(base({
    ...rejected,
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: {}, central: {}, trophy: {} },
  }));
  assert.equal(dry.intents.filter((x) => x.sizeKey === "M").length, 0, "nothing upstream → absent from queues");
  const restocked = computeRefillPlan(base({
    ...rejected,
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: {}, central: { p1: { M: cell(12) } }, trophy: {} },
  }));
  assert.equal(restocked.intents.filter((x) => x.sizeKey === "M").length, 1, "stock appeared + cooldown passed → asked again");
});

test("CONFIRMED OUT: denied at BOTH levels → no request anywhere, reorder list instead", () => {
  // Shop level said no (rejected Shop Refill line, 30h ago — past the 24h
  // cooldown, so WITHOUT the rule an intent would be re-created) AND Central
  // said no (cancelled hub2 request, no cancelReason). Counted cells still
  // show plenty — humans beat the database.
  const denials = {
    orders: { "R009-1": { customerName: "Shop Refill", autoRefill: true, destShop: "marathon-pe", productId: "p1", size: "M", clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(30), status: "incoming", createdAt: iso(30) } },
    refillRequests: { rHub: { status: "cancelled", resolvedAt: iso(30), productId: "p1", size: "M", requestingLocation: "hub2", rejectedBy: "warehouse" } },
  };
  const plan = computeRefillPlan(base(denials));
  assert.equal(plan.intents.filter((x) => x.productId === "p1" && x.sizeKey === "M").length, 0, "confirmed out — never asked again");
  assert.ok(plan.exceptions.missingSizes.items.some((m) => m.pid === "p1" && /confirmed out/.test(m.note)), "surfaced on the reorder list as confirmed out");

  // Only ONE level denied → normal lifecycle: the 30h-old shop rejection has
  // cooled down and stock exists upstream, so the engine re-asks.
  const oneLevel = computeRefillPlan(base({ orders: denials.orders }));
  assert.equal(oneLevel.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "single-level denial keeps the cooldown cycle");

  // An engine SELF-withdrawal at the central level never counts as a denial.
  const selfWithdraw = computeRefillPlan(base({
    orders: denials.orders,
    refillRequests: { rHub: { status: "cancelled", cancelReason: "unfillable", resolvedAt: iso(30), productId: "p1", size: "M", requestingLocation: "hub2" } },
  }));
  assert.equal(selfWithdraw.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "self-withdrawal ≠ human denial");

  // Window lapse (15 days > confirmedOutDays 14) → one re-ask resumes.
  const lapsed = computeRefillPlan(base({
    orders: { "R009-1": { ...denials.orders["R009-1"], clothingOutOfStockAt: iso(15 * 24), createdAt: iso(15 * 24) } },
    refillRequests: { rHub: { ...denials.refillRequests.rHub, resolvedAt: iso(15 * 24) } },
  }));
  assert.equal(lapsed.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "denials aged out — engine may re-ask once");
});

test("SELF-REVERSAL: request withdrawn when stock arrives by another path", () => {
  const openReq = {
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "R003-2", orderCreatedAt: iso(1), qty: 2, source: "hub2", createdAt: iso(1) } } } },
    refillRequests: { r1: { status: "open", productId: "p1", size: "M", requestingLocation: "marathon-pe" } },
    orders: { "R003-2": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(1), clothingRefillStatus: null, status: "incoming" } },
  };
  // Manual transfer / direct add / bulk return raised the shop to target (3/3):
  const topped = computeRefillPlan(base({
    ...openReq,
    stock: { "marathon-pe": { p1: { M: cell(3) } }, hub2: { p1: { M: cell(10) } }, central: {}, trophy: {} },
  }));
  const c = topped.closes.find((x) => x.reason === "no_longer_needed");
  assert.ok(c, "withdrawn on the next scan");
  assert.equal(c.removeOrderId, "R003-2", "warehouse card deleted before anyone picks it");
  assert.equal(c.rrStatus, "cancelled");
  // Still partially needed (1/3, ask covers it) → NOT withdrawn.
  const partial = computeRefillPlan(base({
    ...openReq,
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(10) } }, central: {}, trophy: {} },
  }));
  assert.ok(!partial.closes.some((x) => x.reason === "no_longer_needed"), "still needed → stays in the queue");
});

test("engine self-withdrawal imposes NO cooldown — a fresh dip re-asks immediately", () => {
  const plan = computeRefillPlan(base({
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(10) } }, central: {}, trophy: {} },
    refillRequests: { rOld: { status: "cancelled", cancelReason: "no_longer_needed", resolvedAt: iso(1), productId: "p1", size: "M", requestingLocation: "marathon-pe" } },
  }));
  assert.equal(plan.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1,
    "withdrawal an hour ago ≠ human rejection — deficit re-asks at once");
});

test("PURGE: open engine request that became unfillable is withdrawn from the queue", () => {
  const plan = computeRefillPlan(base({
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(0) } }, central: {}, trophy: {} },
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "R002-4", orderCreatedAt: iso(2), qty: 2, source: "hub2", createdAt: iso(2) } } } },
    refillRequests: { r1: { status: "open", productId: "p1", size: "M", requestingLocation: "marathon-pe" } },
    orders: { "R002-4": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(2), clothingRefillStatus: null, status: "incoming" } },
  }));
  const c = plan.closes.find((x) => x.reason === "unfillable");
  assert.ok(c, "withdrawn");
  assert.equal(c.rrStatus, "cancelled");
  assert.equal(c.removeOrderId, "R002-4", "the queue card is deleted, not left for staff to reject");
});

test("Cortez fix: surplus is HELD for downstream deficits, never excess past a starving store", () => {
  const over = {
    products: { p1: { name: "Cortez tracksuit", productType: "clothing", sizes: ["XL"] } },
    targets: {
      "marathon-pe": { p1: { XL: { target: 2, minQty: 1 } } },
      hub2: { p1: { XL: { target: 2, minQty: 1 } } },
    },
    stock: {
      "marathon-pe": { p1: { XL: cell(0) } },   // store starving: deficit 2
      hub2: { p1: { XL: cell(3) } },            // hub +1 over its own target
      central: { p1: { XL: cell(20) } }, trophy: {},
    },
  };
  const plan = computeRefillPlan(base(over));
  assert.equal(plan.exceptions.excess.items.filter((e) => e.pid === "p1").length, 0,
    "hub2's +1 is held for the store's deficit — NOT excess to return to Central");
  // Once the store is satisfied, the same surplus IS excess again.
  const fed = computeRefillPlan(base({ ...over,
    stock: { "marathon-pe": { p1: { XL: cell(2) } }, hub2: { p1: { XL: cell(3) } }, central: { p1: { XL: cell(20) } }, trophy: {} },
  }));
  assert.deepEqual(fed.exceptions.excess.items.map((e) => `${e.loc}:${e.excess}`), ["hub2:1"]);
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

test("decision types: keep (permanent), snooze (expires), until_change (fingerprint)", () => {
  const over = {
    products: { p1: PRODUCTS.p1, pUnset: { productType: "clothing", sizes: ["M"] } },
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } } },
    stock: { "marathon-pe": { p1: { M: cell(3) } }, hub2: { pUnset: { M: cell(6) } }, central: {}, trophy: {} },
  };
  assert.equal(computeRefillPlan(base(over)).exceptions.noTarget.count, 1);
  // keep: permanent
  assert.equal(computeRefillPlan(base({ ...over,
    targetDecisions: { hub2: { pUnset: { decision: "keep" } } } })).exceptions.noTarget.count, 0);
  // snooze: suppressed until `until`, resurfaces after
  assert.equal(computeRefillPlan(base({ ...over,
    targetDecisions: { hub2: { pUnset: { decision: "snooze", until: new Date(NOW + 30 * 864e5).toISOString() } } } })).exceptions.noTarget.count, 0);
  assert.equal(computeRefillPlan(base({ ...over,
    targetDecisions: { hub2: { pUnset: { decision: "snooze", until: new Date(NOW - 1).toISOString() } } } })).exceptions.noTarget.count, 1, "expired snooze resurfaces");
  // until_change: suppressed while the network fingerprint matches, resurfaces on ANY qty change
  const { stockFingerprint } = require("../lib/refill-engine.cjs");
  const fp = stockFingerprint(base(over).stock, "pUnset");
  assert.equal(computeRefillPlan(base({ ...over,
    targetDecisions: { hub2: { pUnset: { decision: "until_change", fingerprint: fp } } } })).exceptions.noTarget.count, 0);
  const changed = JSON.parse(JSON.stringify(base(over).stock));
  changed.hub2.pUnset.M = cell(5); // one unit sold
  assert.equal(computeRefillPlan(base({ ...over, stock: changed,
    targetDecisions: { hub2: { pUnset: { decision: "until_change", fingerprint: fp } } } })).exceptions.noTarget.count, 1, "inventory change resurfaces the card");
});

test("NEW PRODUCT at Central (no targets anywhere) enters the Decision Queue", () => {
  const plan = computeRefillPlan(base({
    products: { p1: PRODUCTS.p1, pNew: { productType: "clothing", sizes: ["M", "L"] } },
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } } },
    stock: { "marathon-pe": { p1: { M: cell(3) } }, hub2: {}, trophy: {}, central: { pNew: { M: cell(20), L: cell(15) } } },
  }));
  const entry = plan.exceptions.noTarget.items.find((n) => n.pid === "pNew");
  assert.deepEqual(entry, { loc: "central", pid: "pNew", units: 35, isNew: true });
  // ...but a product introduced ANYWHERE no longer counts as new at Central.
  const introduced = computeRefillPlan(base({
    products: { pNew: { productType: "clothing", sizes: ["M"] } },
    targets: { trophy: { pNew: { M: { target: 2, minQty: 1 } } } },
    stock: { "marathon-pe": {}, hub2: {}, trophy: { pNew: { M: cell(2) } }, central: { pNew: { M: cell(20) } } },
  }));
  assert.ok(!introduced.exceptions.noTarget.items.some((n) => n.pid === "pNew" && n.loc === "central"));
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

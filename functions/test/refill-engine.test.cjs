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
    "marathon-pe": { S: 1, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 1 },
    trophy: { S: 1, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 1 },
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

test("ACTIONABLE-ONLY (v9): qty capped to what the source actually has; every card fully pickable", () => {
  const plan = computeRefillPlan(base({
    targets: {
      "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } },
      hub2: { p1: { M: { target: 4, minQty: 2 } } },
    },
    stock: {
      "marathon-pe": { p1: { M: cell(0) } },
      hub2: { p1: { M: cell(1) } },       // source has exactly 1
      central: { p1: { M: cell(50) } },
      trophy: {},
    },
  }));
  const storeLeg = plan.intents.find((x) => x.dest === "marathon-pe");
  assert.equal(storeLeg.qty, 1, "capped to source availability — the card is fully pickable as written");
  const hubLeg = plan.intents.find((x) => x.dest === "hub2");
  assert.equal(hubLeg.qty, 3); // hub2 target 4 − have 1, central has plenty
  assert.equal(hubLeg.source, "central");
});

test("CASCADE (v9): downstream leg is created only after the upstream leg lands", () => {
  const targets = {
    trophy: { p1: { M: { target: 2, minQty: 1 } } },
    hub2: { p1: { M: { target: 3, minQty: 2 } } },
  };
  // Scan 1: Trophy needs M, hub2 has NONE, central has plenty →
  // ONLY the central→hub2 leg is created; Trophy parks as awaiting-upstream.
  const scan1 = computeRefillPlan(base({
    targets,
    stock: { trophy: { p1: { M: cell(0) } }, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(20) } }, "marathon-pe": {} },
  }));
  assert.equal(scan1.intents.filter((x) => x.dest === "trophy").length, 0, "no Trophy card while hub2 is empty");
  assert.equal(scan1.intents.filter((x) => x.dest === "hub2" && x.source === "central").length, 1, "the upstream leg IS created");
  assert.ok(scan1.exceptions.awaitingUpstream.items.some((w) => w.loc === "trophy" && w.source === "hub2"), "Trophy demand parked visibly, not dropped");
  // Scan 2: hub2 received → the Trophy leg auto-creates. Nobody recreated anything.
  const scan2 = computeRefillPlan(base({
    targets,
    stock: { trophy: { p1: { M: cell(0) } }, hub2: { p1: { M: cell(3) } }, central: { p1: { M: cell(17) } }, "marathon-pe": {} },
  }));
  assert.equal(scan2.intents.filter((x) => x.dest === "trophy" && x.source === "hub2").length, 1, "downstream leg lands the scan after the stock does");
});

test("AWAITING SUPPLIER (v9): whole upstream chain empty → passive category, never a card", () => {
  const plan = computeRefillPlan(base({
    targets: { "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } } },
    // stock exists ONLY at the other store — nothing hub2 or central can pick
    stock: { "marathon-pe": { p1: { M: cell(0) } }, trophy: { p1: { M: cell(4) } }, hub2: {}, central: {} },
  }));
  assert.equal(plan.intents.length, 0, "no impossible work");
  assert.ok(plan.exceptions.awaitingSupplier.items.some((w) => w.loc === "marathon-pe"), "parked under Awaiting Supplier");
  assert.ok(!plan.exceptions.missingSizes.items.some((m) => m.pid === "p1"), "not on the reorder list — stock exists, just stranded");
});

test("AUTO-RESIZE: open requests continuously track reality — shrink, grow, cap, and in-flight skip", () => {
  const mkOpen = (qty, extra = {}) => ({
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "R007-1", orderCreatedAt: iso(2), qty, source: "hub2", createdAt: iso(2) } } } },
    refillRequests: { r1: { status: "open", productId: "p1", size: "M", requestingLocation: "marathon-pe", source: "hub2" } },
    orders: { "R007-1": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(2), clothingRefillStatus: null, status: "incoming", ...extra } },
  });
  // SHRINK: policy dropped to target 2; legacy ask was 3.
  const shrink = computeRefillPlan(base({
    ...mkOpen(3),
    targets: { "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } } },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: { p1: { M: cell(9) } }, central: {}, trophy: {} },
  }));
  assert.deepEqual(shrink.resizes[0] && { from: shrink.resizes[0].from, to: shrink.resizes[0].to }, { from: 3, to: 2 }, "3 → 2 (new deficit)");
  // GROW capped by source: deficit rose to 3 but hub2 only has 2.
  const grow = computeRefillPlan(base({
    ...mkOpen(1),
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } } },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: { p1: { M: cell(2) } }, central: {}, trophy: {} },
  }));
  assert.deepEqual(grow.resizes[0] && { from: grow.resizes[0].from, to: grow.resizes[0].to }, { from: 1, to: 2 }, "1 → 2 (deficit 3, source caps at 2)");
  // IN-FLIGHT: locked split → never resized this scan.
  const picking = computeRefillPlan(base({
    ...mkOpen(3, { clothingPlanGen: 0 }),
    targets: { "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } } },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: { p1: { M: cell(9) } }, central: {}, trophy: {} },
  }));
  assert.equal(picking.resizes.length, 0, "a card being picked keeps its quantity");
  // EXACT already: no resize entry.
  const exact = computeRefillPlan(base({
    ...mkOpen(2),
    targets: { "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } } },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: { p1: { M: cell(9) } }, central: {}, trophy: {} },
  }));
  assert.equal(exact.resizes.length, 0, "correct quantities are untouched");
});

test("AUTO-RESIZE threading: sibling grows share the source, never overcommit (Sonnet HIGH)", () => {
  // hub2 holds 10; A and B both hold qty-1 locks and both deficits widen to 8.
  // Stale-read math promised 16 vs 10 physical; threaded math shares exactly 10.
  const two = (qa, qb) => ({
    openIndex: {
      "marathon-pe": { p1: { M: { refillId: "rA", orderId: "R008-1", orderCreatedAt: iso(1), qty: qa, source: "hub2", createdAt: iso(1) } } },
      trophy: { p1: { M: { refillId: "rB", orderId: "R009-1", orderCreatedAt: iso(1), qty: qb, source: "hub2", createdAt: iso(1) } } },
    },
    refillRequests: {
      rA: { status: "open", productId: "p1", size: "M", requestingLocation: "marathon-pe", source: "hub2" },
      rB: { status: "open", productId: "p1", size: "M", requestingLocation: "trophy", source: "hub2" },
    },
    orders: {
      "R008-1": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(1), clothingRefillStatus: null, status: "incoming" },
      "R009-1": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(1), clothingRefillStatus: null, status: "incoming" },
    },
  });
  const grow = computeRefillPlan(base({
    ...two(1, 1),
    targets: { "marathon-pe": { p1: { M: { target: 8, minQty: 2 } } }, trophy: { p1: { M: { target: 8, minQty: 2 } } } },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, trophy: { p1: { M: cell(0) } }, hub2: { p1: { M: cell(10) } }, central: {} },
  }));
  const total = grow.resizes.reduce((t, r) => t + r.to, 0) +
    2 - grow.resizes.length * 1;   // resized locks new qty + untouched locks old qty (1 each)
  assert.ok(total <= 10, `combined promises (${total}) never exceed the 10 physical units`);
  assert.ok(grow.resizes.length >= 1, "at least one sibling grows into the free units");
  // Symmetric SHRINK converges: both qty-3 locks against deficits of 2 shrink
  // to 2 each — never frozen at their oversized quantities (old deadlock).
  const shrink = computeRefillPlan(base({
    ...two(3, 3),
    targets: { "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } }, trophy: { p1: { M: { target: 2, minQty: 1 } } } },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, trophy: { p1: { M: cell(0) } }, hub2: { p1: { M: cell(3) } }, central: {} },
  }));
  assert.equal(shrink.resizes.length, 2, "both oversized siblings shrink — never frozen");
  assert.ok(shrink.resizes.every((r) => r.to <= 2 && r.to >= 1), "each lands within its true deficit");
  assert.equal(shrink.resizes.reduce((t, r) => t + r.to, 0), 3, "combined claims converge to exactly the 3 physical units");
});

test("AUTO-RESIZE threading: a grow consumes the units BEFORE the deficit loop sees them", () => {
  // trophy lock grows 1→5 over hub2 five units; PE (no lock) must then park —
  // stale reservations previously let PE create a fresh 3-unit intent (8 vs 5).
  const plan = computeRefillPlan(base({
    openIndex: { trophy: { p1: { M: { refillId: "rB", orderId: "R009-1", orderCreatedAt: iso(1), qty: 1, source: "hub2", createdAt: iso(1) } } } },
    refillRequests: { rB: { status: "open", productId: "p1", size: "M", requestingLocation: "trophy", source: "hub2" } },
    orders: { "R009-1": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(1), clothingRefillStatus: null, status: "incoming" } },
    targets: { trophy: { p1: { M: { target: 5, minQty: 2 } } }, "marathon-pe": { p1: { M: { target: 3, minQty: 1 } } } },
    stock: { trophy: { p1: { M: cell(0) } }, "marathon-pe": { p1: { M: cell(0) } }, hub2: { p1: { M: cell(5) } }, central: {} },
  }));
  const rb = plan.resizes.find((r) => r.dest === "trophy");
  assert.deepEqual(rb && { from: rb.from, to: rb.to }, { from: 1, to: 5 }, "trophy grows into all 5");
  assert.equal(plan.intents.filter((i) => i.dest === "marathon-pe").length, 0, "PE cannot claim already-promised units");
  assert.ok(plan.exceptions.awaitingUpstream.items.some((w) => w.loc === "marathon-pe") || plan.exceptions.awaitingSupplier.items.some((w) => w.loc === "marathon-pe"), "PE parks passively");
});

test("AUTO-RESIZE emits for hub2 legs too (no orderId on the lock)", () => {
  const plan = computeRefillPlan(base({
    openIndex: { hub2: { p1: { M: { refillId: "rH", qty: 3, source: "central", createdAt: iso(1) } } } },
    refillRequests: { rH: { status: "open", productId: "p1", size: "M", requestingLocation: "hub2", source: "central" } },
    targets: { hub2: { p1: { M: { target: 2, minQty: 1 } } } },
    stock: { hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(9) } }, "marathon-pe": {}, trophy: {} },
  }));
  const rz = plan.resizes.find((r) => r.dest === "hub2");
  assert.deepEqual(rz && { from: rz.from, to: rz.to, orderId: rz.orderId }, { from: 3, to: 2, orderId: null }, "hub2 leg resizes with null orderId");
});

test("AUTO-RESIZE respects sibling reservations — never steals another request's units", () => {
  const plan = computeRefillPlan(base({
    targets: {
      "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } },
      trophy: { p1: { M: { target: 3, minQty: 2 } } },
    },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, trophy: { p1: { M: cell(0) } }, hub2: { p1: { M: cell(3) } }, central: {} },
    openIndex: {
      "marathon-pe": { p1: { M: { refillId: "rA", orderId: "R008-1", orderCreatedAt: iso(1), qty: 2, source: "hub2", createdAt: iso(1) } } },
      trophy: { p1: { M: { refillId: "rB", orderId: "R009-1", orderCreatedAt: iso(1), qty: 3, source: "hub2", createdAt: iso(1) } } },
    },
    refillRequests: {
      rA: { status: "open", productId: "p1", size: "M", requestingLocation: "marathon-pe", source: "hub2" },
      rB: { status: "open", productId: "p1", size: "M", requestingLocation: "trophy", source: "hub2" },
    },
    orders: {
      "R008-1": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(1), clothingRefillStatus: null, status: "incoming" },
      "R009-1": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(1), clothingRefillStatus: null, status: "incoming" },
    },
  }));
  // hub2 holds 3; PE reserves 2 → Trophy's ask must shrink to the 1 unit left.
  const rb = plan.resizes.find((r) => r.dest === "trophy");
  assert.deepEqual(rb && { from: rb.from, to: rb.to }, { from: 3, to: 1 }, "trophy 3 → 1 (PE's reservation respected)");
  assert.ok(!plan.resizes.some((r) => r.dest === "marathon-pe"), "PE ask (2) already ≤ its share");
});

test("NO SILENT STARVATION (v9): a source with no buffer target is a CONFIG block, never 'chain flowing'", () => {
  // Stores need M; hub2 is empty AND has NO target for the cell — no
  // central→hub2 leg will ever auto-create, so labelling this
  // awaiting-upstream would starve silently behind a self-healing promise.
  const plan = computeRefillPlan(base({
    targets: { "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } }, trophy: { p1: { M: { target: 2, minQty: 1 } } } },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, trophy: { p1: { M: cell(0) } }, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(50) } } },
  }));
  assert.equal(plan.exceptions.awaitingUpstream.count, 0, "nothing may claim the chain is flowing");
  const blocked = plan.exceptions.awaitingSupplier.items.filter((w) => /no buffer target/.test(w.note));
  assert.equal(blocked.length, 2, "both stores surface as blocked-by-config, demanding a human");
  // Give hub2 its buffer target → the chain genuinely flows: hub2 leg created,
  // stores correctly park as awaiting-upstream.
  const flowing = computeRefillPlan(base({
    targets: {
      "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } }, trophy: { p1: { M: { target: 2, minQty: 1 } } },
      hub2: { p1: { M: { target: 3, minQty: 2 } } },
    },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, trophy: { p1: { M: cell(0) } }, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(50) } } },
  }));
  assert.equal(flowing.intents.filter((x) => x.dest === "hub2").length, 1, "upstream leg created");
  assert.equal(flowing.exceptions.awaitingUpstream.items.filter((w) => w.loc !== "hub2").length, 2, "stores now genuinely awaiting upstream");
});

test("BLOCKED UPSTREAM (v9): a rejection-parked source leg is labelled blocked, not flowing", () => {
  const plan = computeRefillPlan(base({
    targets: {
      "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } },
      hub2: { p1: { M: { target: 3, minQty: 2 } } },
    },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(50) } }, trophy: {} },
    // Central's queue rejected hub2's ask 2h ago (cooldown active, no arrival since)
    refillRequests: { rHub: { status: "cancelled", resolvedAt: iso(2), productId: "p1", size: "M", requestingLocation: "hub2", source: "central", rejectedBy: "warehouse" } },
  }));
  assert.equal(plan.intents.length, 0, "hub2 leg rests on its cooldown");
  assert.ok(plan.exceptions.awaitingSupplier.items.some((w) => w.loc === "marathon-pe" && /blocked/.test(w.note)),
    "store demand shows the truth: upstream leg blocked, not flowing");
  assert.equal(plan.exceptions.awaitingUpstream.count, 0);
});

test("SOURCE RESERVATION (v9): two stores never get cards for the same physical unit", () => {
  const targets = {
    "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } },
    trophy: { p1: { M: { target: 2, minQty: 1 } } },
  };
  const stock = { "marathon-pe": { p1: { M: cell(0) } }, trophy: { p1: { M: cell(0) } }, hub2: { p1: { M: cell(3) } }, central: {} };
  const plan = computeRefillPlan(base({ targets, stock }));
  const totalAsked = plan.intents.reduce((t, i) => t + i.qty, 0);
  assert.equal(totalAsked, 3, "combined asks never exceed the 3 units hub2 actually holds (demand is 4)");
  // And an EXISTING open request reserves its units across scans too:
  const scan2 = computeRefillPlan(base({
    targets: { "marathon-pe": targets["marathon-pe"], trophy: targets.trophy },
    stock: { ...stock, hub2: { p1: { M: cell(1) } } },
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", qty: 1, source: "hub2", createdAt: iso(1) } } } },
    refillRequests: { r1: { status: "open", productId: "p1", size: "M", requestingLocation: "marathon-pe", source: "hub2" } },
  }));
  assert.equal(scan2.intents.filter((x) => x.dest === "trophy").length, 0, "hub2's last unit is already promised to PE — no Trophy card");
  assert.ok(scan2.exceptions.awaitingUpstream.items.some((w) => w.loc === "trophy") || scan2.exceptions.awaitingSupplier.items.some((w) => w.loc === "trophy"),
    "Trophy demand parks passively instead");
});

test("IN-FLIGHT GUARD (v9): a card being picked is never withdrawn under the picker", () => {
  const plan = computeRefillPlan(base({
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(9) } }, trophy: {} },
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "R005-3", orderCreatedAt: iso(1), qty: 2, source: "hub2", createdAt: iso(1) } } } },
    refillRequests: { r1: { status: "open", productId: "p1", size: "M", requestingLocation: "marathon-pe", source: "hub2" } },
    // The warehouse has LOCKED a split for this card (attempt underway).
    orders: { "R005-3": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(1), clothingRefillStatus: null, status: "incoming", clothingPlanGen: 0 } },
  }));
  assert.ok(!plan.closes.some((x) => x.reason === "awaiting_upstream"), "in-flight fulfilment is untouchable");
});

test("SOURCE-EMPTY WITHDRAW (v9): an open request the source can no longer fill leaves the queue", () => {
  const plan = computeRefillPlan(base({
    targets: {
      "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } },
      hub2: { p1: { M: { target: 3, minQty: 2 } } },   // buffer target — chain genuinely flows
    },
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(9) } }, trophy: {} },
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "R005-3", orderCreatedAt: iso(1), qty: 2, source: "hub2", createdAt: iso(1) } } } },
    refillRequests: { r1: { status: "open", productId: "p1", size: "M", requestingLocation: "marathon-pe", source: "hub2" } },
    orders: { "R005-3": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(1), clothingRefillStatus: null, status: "incoming" } },
  }));
  const c = plan.closes.find((x) => x.reason === "awaiting_upstream");
  assert.ok(c, "withdrawn — staff never scroll past unpickable cards");
  assert.equal(c.removeOrderId, "R005-3", "the queue card is deleted");
  assert.ok(plan.exceptions.awaitingUpstream.items.some((w) => w.loc === "marathon-pe"), "and the demand stays visible passively");
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
  // EVERY inbound type counts as arrival evidence (transfers carry a REAL
  // from+to in this system — no in_transit hop — so both legs qualify).
  for (const type of ["return", "adjustment", "transfer_in", "transfer_out", "opening"]) {
    const lifted = computeRefillPlan(base({
      ...withStock, ...rejected5hAgo,
      movements: [{ type, from: type.startsWith("transfer") ? "central" : undefined, to: "hub2", productId: "p1", size: "M", qty: 3, ts: iso(1) }],
    }));
    assert.equal(lifted.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, `${type} after rejection → reopened`);
  }
});

test("BOOKKEEPING ≠ ARRIVAL: a movement that leaves the cell at ≤0 lifts nothing", () => {
  const withStock = { stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(4) } }, trophy: {} } };
  const rejected5hAgo = {
    orders: { "R009-1": { customerName: "Shop Refill", autoRefill: true, destShop: "marathon-pe", productId: "p1", size: "M", clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(5), status: "incoming", createdAt: iso(5) } },
  };
  // The Negative Inventory "Fix → 0" adjustment records after:{hub2:0} — a
  // bookkeeping correction, not pickable stock. Must NOT reopen the demand.
  const negFix = computeRefillPlan(base({
    ...withStock, ...rejected5hAgo,
    movements: [{ type: "adjustment", to: "hub2", productId: "p1", size: "M", qty: 2, ts: iso(1), reason: "health_negative_zero_fix", after: { hub2: 0 } }],
  }));
  assert.equal(negFix.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0, "clearing a negative to 0 is not an arrival");
  assert.ok(negFix.exceptions.waitingForStock.items.some((w) => w.pid === "p1"), "still parked as Waiting for Stock");
  // A receive into a deep oversell hole (after still negative) lifts nothing.
  const intoHole = computeRefillPlan(base({
    ...withStock, ...rejected5hAgo,
    movements: [{ type: "received", to: "hub2", productId: "p1", size: "M", qty: 2, ts: iso(1), after: { hub2: -1 } }],
  }));
  assert.equal(intoHole.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0, "arrival swallowed by an oversell hole ≠ available stock");
  // The same receive that ends POSITIVE is a real arrival → reopened. (The
  // hub2 CELL carries the arrived stock too — v9 only queues actionable work.)
  const arrivedStock = { stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(3) } }, central: { p1: { M: cell(4) } }, trophy: {} } };
  const real = computeRefillPlan(base({
    ...arrivedStock, ...rejected5hAgo,
    movements: [{ type: "received", to: "hub2", productId: "p1", size: "M", qty: 3, ts: iso(1), after: { hub2: 3 } }],
  }));
  assert.equal(real.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "positive resulting balance → reopened");
  // Legacy movements without an after snapshot keep the old behavior (lift).
  const legacy = computeRefillPlan(base({
    ...arrivedStock, ...rejected5hAgo,
    movements: [{ type: "received", to: "hub2", productId: "p1", size: "M", qty: 3, ts: iso(1) }],
  }));
  assert.equal(legacy.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "no after snapshot → counted as before");
});

test("SAME-SCAN REOPEN: a rejected lock releases its inbound so the re-ask lands in the same plan", () => {
  // Rejection and arrival both happened since the last scan. The stale lock
  // must not keep counting as inbound — close AND fresh intent in ONE plan.
  const plan = computeRefillPlan(base({
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(10) } }, central: {}, trophy: {} },
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "R004-7", orderCreatedAt: iso(6), qty: 2, source: "hub2", createdAt: iso(6) } } } },
    refillRequests: { r1: { status: "open", productId: "p1", size: "M", requestingLocation: "marathon-pe", source: "hub2" } },
    orders: { "R004-7": { customerName: "Shop Refill", autoRefill: true, destShop: "marathon-pe", productId: "p1", size: "M", createdAt: iso(6), clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(5), status: "incoming" } },
    movements: [{ type: "received", to: "hub2", productId: "p1", size: "M", qty: 10, ts: iso(1) }],
  }));
  assert.ok(plan.closes.some((c) => c.refillId === "r1"), "stale lock closed");
  assert.equal(plan.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "re-ask in the SAME plan, not next scan");
});

test("DENIER-PINNED: after a route change, only arrival at the location that SAID no lifts the rejection", () => {
  const cfg = { ...CONFIG, routes: { "marathon-pe": "hub3", trophy: "hub2", hub2: "central" } };
  const rejectedByHub2 = {
    config: cfg,
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub3: { p1: { M: cell(8) } }, hub2: {}, central: {}, trophy: {} },
    orders: { "R011-3": { customerName: "Shop Refill", autoRefill: true, destShop: "marathon-pe", productId: "p1", size: "M", placedAtHub: "hub2", clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(5), status: "incoming", createdAt: iso(6) } },
  };
  // Arrival at the NEW route source (hub3) is no evidence against hub2's "no".
  const wrongLoc = computeRefillPlan(base({
    ...rejectedByHub2,
    movements: [{ type: "received", to: "hub3", productId: "p1", size: "M", qty: 5, ts: iso(1) }],
  }));
  assert.equal(wrongLoc.intents.filter((x) => x.dest === "marathon-pe").length, 0, "hub3 arrival ≠ hub2 evidence");
  assert.ok(wrongLoc.exceptions.waitingForStock.items.some((w) => w.source === "hub2"), "watches the denier, not today's route");
  // Arrival at the RECORDED denier (hub2) lifts it; the new route then supplies.
  const rightLoc = computeRefillPlan(base({
    ...rejectedByHub2,
    movements: [{ type: "received", to: "hub2", productId: "p1", size: "M", qty: 5, ts: iso(1) }],
  }));
  assert.equal(rightLoc.intents.filter((x) => x.dest === "marathon-pe" && x.source === "hub3").length, 1, "hub2 arrival reopens; intent routed via hub3");
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
  // Stock lands at CENTRAL only → v9 cascade: still no store card (hub2 is
  // empty), but the demand is visibly awaiting the upstream leg (hub2 has a
  // buffer target, so the chain genuinely flows).
  const centralOnly = computeRefillPlan(base({
    ...rejected,
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } }, hub2: { p1: { M: { target: 3, minQty: 2 } } } },
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: {}, central: { p1: { M: cell(12) } }, trophy: {} },
  }));
  assert.equal(centralOnly.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0, "hub2 still empty → cascades, no store card yet");
  assert.ok(centralOnly.exceptions.awaitingUpstream.items.some((w) => w.loc === "marathon-pe"), "parked as awaiting-upstream");
  // Stock reaches HUB 2 → the request returns to the queue.
  const restocked = computeRefillPlan(base({
    ...rejected,
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(6) } }, central: { p1: { M: cell(6) } }, trophy: {} },
  }));
  assert.equal(restocked.intents.filter((x) => x.sizeKey === "M").length, 1, "stock at the source + cooldown passed → asked again");
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

test("POLICY DROP reconciliation: lowering a target withdraws the now-oversized open request", () => {
  // Request for 2 units was created under the old policy (target 3, have 1).
  // The policy drops to target 1 → the shop already holds enough → the very
  // next scan withdraws the request (no human cleanup, no obsolete work).
  const openReq = {
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "R003-2", orderCreatedAt: iso(1), qty: 2, source: "hub2", createdAt: iso(1) } } } },
    refillRequests: { r1: { status: "open", productId: "p1", size: "M", requestingLocation: "marathon-pe", source: "hub2" } },
    orders: { "R003-2": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(1), clothingRefillStatus: null, status: "incoming" } },
  };
  const plan = computeRefillPlan(base({
    ...openReq,
    targets: { "marathon-pe": { p1: { M: { target: 1, minQty: 1 } } } },  // NEW reduced policy
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(10) } }, central: {}, trophy: {} },
  }));
  const c = plan.closes.find((x) => x.reason === "no_longer_needed");
  assert.ok(c, "request obsolete under the new policy → withdrawn");
  assert.equal(c.removeOrderId, "R003-2", "warehouse card deleted");
  assert.equal(plan.intents.length, 0, "and no replacement is created — target is met");
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

test("TWO-LEG MOVE EXCESS: store overage splits deficit-first to Hub 2, remainder to Central, in one card", () => {
  // The Shambeen case: PE M 7/2 (raw 5), hub2 M 0/3 (deficit 3) →
  // ONE card moving all 5: 3 → Hub 2 (Cortez preserved), 2 → Central.
  const plan = computeRefillPlan(base({
    products: { p1: { name: "Shambeen", productType: "clothing", sizes: ["M", "XL", "XXL"] } },
    targets: {
      "marathon-pe": { p1: { M: { target: 2, minQty: 1 }, XL: { target: 1, minQty: 1 }, XXL: { target: 1, minQty: 1 } } },
      hub2: { p1: { M: { target: 3, minQty: 2 }, XL: { target: 2, minQty: 1 }, XXL: { target: 2, minQty: 1 } } },
    },
    stock: {
      "marathon-pe": { p1: { M: cell(7), XL: cell(2), XXL: cell(3) } },
      hub2: { p1: { M: cell(0), XL: cell(0), XXL: cell(0) } },
      central: {}, trophy: {},
    },
  }));
  const ex = (sk) => plan.exceptions.excess.items.find((e) => e.loc === "marathon-pe" && e.sizeKey === sk);
  assert.deepEqual({ excess: ex("M").excess, toHub: ex("M").toHub, toCentral: ex("M").toCentral }, { excess: 5, toHub: 3, toCentral: 2 }, "M: whole overage, split deficit-first");
  assert.equal(ex("XL"), undefined, "XL raw 1 stays below the store threshold (sells down naturally)");
  assert.deepEqual({ toHub: ex("XXL").toHub, toCentral: ex("XXL").toCentral }, { toHub: 2, toCentral: 0 }, "XXL: fully-held overage now VISIBLE and routed to Hub 2");
});

test("TWO-LEG MOVE EXCESS: allocation is threaded — two stores never both fill the same Hub 2 need", () => {
  const plan = computeRefillPlan(base({
    products: { p1: { name: "Tee", productType: "clothing", sizes: ["M"] } },
    targets: {
      "marathon-pe": { p1: { M: { target: 1, minQty: 1 } } },
      trophy: { p1: { M: { target: 1, minQty: 1 } } },
      hub2: { p1: { M: { target: 3, minQty: 2 } } },
    },
    stock: {
      "marathon-pe": { p1: { M: cell(4) } },   // raw 3
      trophy: { p1: { M: cell(4) } },          // raw 3
      hub2: { p1: { M: cell(0) } },            // deficit 3
      central: {},
    },
  }));
  const items = plan.exceptions.excess.items.filter((e) => e.loc !== "hub2" && e.sizeKey === "M");
  const hubTotal = items.reduce((t, e) => t + (e.toHub || 0), 0);
  assert.equal(hubTotal, 3, "combined Hub 2 allocation equals its deficit exactly — no double-fill");
  assert.equal(items.reduce((t, e) => t + e.excess, 0), 6, "both stores still move their whole overage");
});

test("NO SILENT MISS: a stocked STANDARD size without a target surfaces under a managed product", () => {
  // The owner audit case: Diesel Jeans managed on L, but M×4 sits at hub2 with
  // no M target — no deficit ever computes for M, so no refill would EVER
  // generate. It must surface as a decision instead of vanishing.
  const plan = computeRefillPlan(base({
    products: { p1: { name: "Diesel Jeans", productType: "clothing", sizes: ["M", "L"] } },
    targets: { hub2: { p1: { L: { target: 3, minQty: 2 } } } },
    stock: { hub2: { p1: { L: cell(3), M: cell(4) } }, central: {}, "marathon-pe": {}, trophy: {} },
  }));
  const card = plan.exceptions.noTarget.items.find((c) => c.pid === "p1" && c.noStandard);
  assert.ok(card, "untargeted stocked M surfaces");
  assert.equal(card.units, 4);
  // And a NEW size arriving at CENTRAL (upstream) surfaces on the hub2 card
  // even though hub2 itself holds none of it yet.
  const upstream = computeRefillPlan(base({
    products: { p1: { name: "Diesel Jeans", productType: "clothing", sizes: ["S", "L"] } },
    targets: { hub2: { p1: { L: { target: 3, minQty: 2 } } } },
    stock: { hub2: { p1: { L: cell(3) } }, central: { p1: { S: cell(6) } }, "marathon-pe": {}, trophy: {} },
  }));
  const up = upstream.exceptions.noTarget.items.find((c) => c.pid === "p1" && c.loc === "hub2");
  assert.ok(up && up.units === 6, "central-stocked new size surfaces at the buffer");
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
  // Unconfigured circulating stock with standard sizes: awaiting MIGRATION
  // (v8), not a decision — and never auto-classified as excess.
  assert.equal(plan.exceptions.noTarget.count, 0, "standard-size circulating product is not a decision");
  assert.deepEqual(plan.exceptions.unintroduced.items, [
    { pid: "pUnset", standardSizes: ["M"], units: 6, byLoc: { central: 0, hub2: 6, "marathon-pe": 0, trophy: 0 } },
  ]);
  assert.ok(!plan.exceptions.excess.items.some((e) => e.pid === "pUnset"), "no-target is NOT excess");
  // Deliberate exclusion (target 0): every unit is excess, even a single one.
  assert.deepEqual(plan.exceptions.excess.items, [{ loc: "hub2", pid: "pBanned", sizeKey: "M", have: 1, target: 0, excess: 1 }]);
  // And unmanaged cells never generate refill intents.
  assert.ok(!plan.intents.some((i) => i.productId === "pUnset"));
});

test("decision types: keep (permanent), snooze (expires), until_change (fingerprint)", () => {
  // pUnset is numeric-size (no standard run) so it stays a GENUINE decision
  // under v8 — postponements only ever apply to decision cards, never to the
  // unintroduced migration list.
  const over = {
    products: { p1: PRODUCTS.p1, pUnset: { productType: "clothing", sizes: ["32"] } },
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } } },
    stock: { "marathon-pe": { p1: { M: cell(3) } }, hub2: { pUnset: { 32: cell(6) } }, central: {}, trophy: {} },
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
  changed.hub2.pUnset["32"] = cell(5); // one unit sold
  assert.equal(computeRefillPlan(base({ ...over, stock: changed,
    targetDecisions: { hub2: { pUnset: { decision: "until_change", fingerprint: fp } } } })).exceptions.noTarget.count, 1, "inventory change resurfaces the card");
});

test("v8 split: circulating = unintroduced (migration) · central-only = NEW · numeric = decision · leftover = decision", () => {
  const plan = computeRefillPlan(base({
    products: {
      p1: PRODUCTS.p1,                                          // targeted at PE
      pCirc: { productType: "clothing", sizes: ["M", "L"] },    // circulating, no targets → MIGRATION
      pFresh: { productType: "clothing", sizes: ["M"] },        // central-only, no targets → NEW
      pJeans: { productType: "clothing", sizes: ["32", "34"] }, // numeric circulating → DECISION (noStandard)
    },
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } } },
    stock: {
      central: { pCirc: { M: cell(9) }, pFresh: { M: cell(7) } },
      "marathon-pe": { p1: { M: cell(3) } },
      hub2: { pCirc: { L: cell(4) }, pJeans: { 32: cell(5) } },
      trophy: { p1: { M: cell(2) } },                           // leftover: targets elsewhere, none here
    },
  }));
  const nt = plan.exceptions.noTarget.items;
  // pCirc: stock at Central AND hub2 — NOT new, NOT a decision; one migration entry.
  assert.ok(!nt.some((c) => c.pid === "pCirc"), "circulating product never appears in the Decision Queue");
  const mig = plan.exceptions.unintroduced.items.find((u) => u.pid === "pCirc");
  assert.deepEqual(mig, { pid: "pCirc", standardSizes: ["M", "L"], units: 4, byLoc: { central: 9, hub2: 4, "marathon-pe": 0, trophy: 0 } });
  // pFresh: genuinely new (central-only) — leads the queue.
  assert.deepEqual(nt[0], { loc: "central", pid: "pFresh", units: 7, isNew: true });
  // pJeans: no standard quantities exist for numeric sizes — a real decision.
  assert.ok(nt.some((c) => c.pid === "pJeans" && c.noStandard && c.loc === "hub2"), "numeric-size product stays a decision");
  // p1 at Trophy: has targets at PE but none at Trophy — assortment decision.
  assert.ok(nt.some((c) => c.pid === "p1" && c.loc === "trophy" && !c.isNew && !c.noStandard), "leftover with targets elsewhere stays a decision");
  // Exactly one card per product — no duplicates across lists.
  const all = [...nt.map((c) => c.pid), ...plan.exceptions.unintroduced.items.map((u) => u.pid)];
  assert.equal(new Set(all).size, all.length, "one card per product, no dup across NEW/migration/decision");
});

test("numeric-only product at TWO locations gets a decision card per location (dedup is migration-only)", () => {
  const plan = computeRefillPlan(base({
    products: { p1: PRODUCTS.p1, pJeans: { productType: "clothing", sizes: ["32", "34"] } },
    targets: { "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } } },
    stock: {
      "marathon-pe": { p1: { M: cell(2) } },
      hub2: { pJeans: { 32: cell(5) } },
      trophy: { pJeans: { 34: cell(3) } },
      central: {},
    },
  }));
  const cards = plan.exceptions.noTarget.items.filter((c) => c.pid === "pJeans" && c.noStandard);
  assert.equal(cards.length, 2, "one decision card per location holding stock");
  assert.deepEqual(cards.map((c) => c.loc).sort(), ["hub2", "trophy"], "no location's stock goes invisible");
});

test("sold-to-zero destination cell still counts as circulated — never NEW again", () => {
  const plan = computeRefillPlan(base({
    products: { p1: PRODUCTS.p1, pSoldOut: { productType: "clothing", sizes: ["M"] } },
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } } },
    stock: { central: { pSoldOut: { M: cell(6) } }, "marathon-pe": { p1: { M: cell(3) } }, hub2: { pSoldOut: { M: cell(0) } }, trophy: {} },
  }));
  assert.ok(!plan.exceptions.noTarget.items.some((c) => c.pid === "pSoldOut" && c.isNew), "a zero-qty cell is circulation evidence — not NEW");
  assert.ok(plan.exceptions.unintroduced.items.some((u) => u.pid === "pSoldOut"), "sold-through product goes to migration (demand proven)");
});

test("size-scoped guard: a managed product's stocked numeric sizes surface as noStandard", () => {
  const plan = computeRefillPlan(base({
    products: { p1: { name: "Mixed jeans", productType: "clothing", sizes: ["M", "32"] } },
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } } },
    stock: { "marathon-pe": { p1: { M: cell(3), 32: cell(4) } }, hub2: {}, central: {}, trophy: {} },
  }));
  const card = plan.exceptions.noTarget.items.find((c) => c.pid === "p1" && c.noStandard);
  assert.ok(card, "numeric leftover under a MANAGED pid is never silently lost");
  assert.equal(card.units, 4);
  assert.equal(card.loc, "marathon-pe");
  assert.equal(plan.exceptions.noTarget.items.filter((c) => c.pid === "p1").length, 1, "the targeted M cell creates no extra decision");
});

test("orphaned pending lock (crashed scan) self-heals; the freed deficit re-asks in the same plan", () => {
  const plan = computeRefillPlan(base({
    openIndex: { "marathon-pe": { p1: { M: { qty: 2, createdAt: iso(2), runId: "old", pending: true } } } },
  }));
  const c = plan.closes.find((x) => x.reason === "orphaned_pending");
  assert.ok(c, "pending lock older than 1h is removed");
  assert.equal(plan.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "released inbound → re-ask in the SAME plan");
  // A young pending lock is in-flight: untouched, still suppressing.
  const young = computeRefillPlan(base({
    openIndex: { "marathon-pe": { p1: { M: { qty: 2, createdAt: iso(0.5), runId: "cur", pending: true } } } },
  }));
  assert.ok(!young.closes.some((x) => x.reason === "orphaned_pending"), "young pending lock left alone");
  assert.equal(young.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0, "in-flight lock still counts as inbound");
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

test("ZOMBIE LEG: lock whose order node is GONE → request cancelled order_lost, lock closed", () => {
  const plan = computeRefillPlan(base({
    openIndex: { "marathon-pe": { p1: { M: {
      refillId: "r9", qty: 1, source: "hub2", createdAt: iso(30),
      orderId: "R013-1", orderCreatedAt: iso(30),
    } } } },
    refillRequests: { r9: { productId: "p1", size: "M", qty: 1, requestingLocation: "marathon-pe", status: "open" } },
    orders: {},   // the R013-1 node was clobbered by the daily reset
  }));
  const c = plan.closes.find((x) => x.refillId === "r9");
  assert.ok(c, "zombie close emitted");
  assert.equal(c.reason, "order_lost");
  assert.equal(c.rrStatus, "cancelled");
  assert.equal(c.cancelReason, "order_lost");
  assert.ok(!c.removeOrderId, "must never delete a same-key node that belongs to a later order");
});

test("ZOMBIE LEG: order node RECYCLED (same key, different createdAt) → order_lost, node untouched", () => {
  const plan = computeRefillPlan(base({
    openIndex: { "marathon-pe": { p1: { M: {
      refillId: "r9", qty: 1, source: "hub2", createdAt: iso(30),
      orderId: "R013-1", orderCreatedAt: iso(30),
    } } } },
    refillRequests: { r9: { productId: "p1", size: "M", qty: 1, requestingLocation: "marathon-pe", status: "open" } },
    // Same key, but a DIFFERENT (later) order: createdAt no longer matches.
    orders: { "R013-1": { productId: "p1", size: "M", createdAt: iso(2), customerName: "Shop Refill", status: "incoming", autoRefill: true } },
  }));
  const c = plan.closes.find((x) => x.refillId === "r9");
  assert.ok(c, "recycled-node zombie close emitted");
  assert.equal(c.cancelReason, "order_lost");
  assert.ok(!c.removeOrderId, "the recycled node belongs to the newer order — never deleted");
});

test("ZOMBIE guard: a matching, unresolved order is NOT order_lost (normal reconcile continues)", () => {
  const plan = computeRefillPlan(base({
    openIndex: { "marathon-pe": { p1: { M: {
      refillId: "r9", qty: 1, source: "hub2", createdAt: iso(1),
      orderId: "R013-1", orderCreatedAt: iso(1),
    } } } },
    refillRequests: { r9: { productId: "p1", size: "M", qty: 1, requestingLocation: "marathon-pe", status: "open" } },
    orders: { "R013-1": { productId: "p1", size: "M", createdAt: iso(1), customerName: "Shop Refill", status: "incoming", autoRefill: true, clothingRefillStatus: null } },
  }));
  assert.ok(!plan.closes.find((x) => x.cancelReason === "order_lost"), "live matching leg untouched");
});

test("AUTO-ADOPT: stocked untargeted standard size at a flagged loc gets the standard target", () => {
  const plan = computeRefillPlan(base({
    config: { ...CONFIG, autoAdoptTargets: { hub2: true }, defaultRunByStore: { ...CONFIG.defaultRunByStore, hub2: { S: 2, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 1 } } },
    stock: { "marathon-pe": {}, trophy: {}, central: {}, hub2: { p1: { L: cell(2), XXXL: cell(1), M: cell(0) } } },
    targets: {},
  }));
  const l = plan.adopts.find((a) => a.loc === "hub2" && a.pid === "p1" && a.sizeKey === "L");
  assert.ok(l, "L adopted");
  assert.equal(l.target, 3);
  assert.equal(l.minQty, 2);                    // max(1, 3−1)
  const xxxl = plan.adopts.find((a) => a.sizeKey === "XXXL");
  assert.equal(xxxl.target, 1);
  assert.equal(xxxl.minQty, 1);                 // max(1, 1−1) floors at 1
  assert.ok(!plan.adopts.find((a) => a.sizeKey === "M"), "zero-qty cell never adopts");
});

test("AUTO-ADOPT: explicit targets (incl. 0 exclusions) and Decision Queue records are never overridden", () => {
  const over = {
    config: { ...CONFIG, autoAdoptTargets: { hub2: true }, defaultRunByStore: { ...CONFIG.defaultRunByStore, hub2: { L: 3, M: 3 } } },
    stock: { "marathon-pe": {}, trophy: {}, central: {}, hub2: { p1: { L: cell(2), M: cell(2) } } },
    targets: { hub2: { p1: { L: { target: 0 } } } },   // explicit exclusion
  };
  const plan = computeRefillPlan(base(over));
  assert.ok(!plan.adopts.find((a) => a.sizeKey === "L"), "explicit 0 wins over adopt");
  assert.ok(plan.adopts.find((a) => a.sizeKey === "M"), "sibling size still adopts");
  const parked = computeRefillPlan(base({
    ...over,
    targetDecisions: { hub2: { p1: { decision: "keep" } } },
  }));
  assert.equal(parked.adopts.length, 0, "decision-parked product never adopts");
});

test("AUTO-ADOPT: off by default, per-location gate, standard-run sizes only", () => {
  const stockOver = { "marathon-pe": { p1: { M: cell(2) } }, trophy: {}, central: {}, hub2: { p1: { M: cell(2), 8: cell(4) } } };
  const off = computeRefillPlan(base({ stock: stockOver, targets: {} }));
  assert.ok(!off.adopts || off.adopts.length === 0, "no flag → no adopts");
  const on = computeRefillPlan(base({
    config: { ...CONFIG, autoAdoptTargets: { hub2: true }, defaultRunByStore: { ...CONFIG.defaultRunByStore, hub2: { M: 3 } } },
    stock: stockOver, targets: {},
  }));
  assert.equal(on.adopts.length, 1, "hub2 M only");
  assert.equal(on.adopts[0].loc, "hub2");
  assert.ok(!on.adopts.find((a) => a.sizeKey === "8"), "numeric size never auto-adopts");
  assert.ok(!on.adopts.find((a) => a.loc === "marathon-pe"), "unflagged store stays human-decided");
});

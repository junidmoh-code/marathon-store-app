// ─── LEDGER-LINK IDENTITY — the recycled-R-number poisoning ──────────────────
// physicallyTouched was a bare Set of movement link.orderId values. R-numbers
// are daily-recycled (refill-engine.cjs:17 — "never identity"), so across the
// 45-day movement window the same label names dozens of unrelated orders. Any
// one of them marked a live lock as "a pick is in flight", which suppressed its
// resize during PLANNING — silently, since the plan just came back empty.
//
// Measured live 2026-07-28: 6,160 movements in the window carried a
// link.orderId and ZERO were genuine for any open lock; "R026-1" alone appeared
// on 9 movements over 10 days, all different products; 69 of 180 open store-leg
// locks (38%) were frozen. Hub legs were immune because they carry no orderId.
//
// WHY BOTH NEGATIVES ARE NON-NEGOTIABLE: with zero genuine in-flight movements
// in live data, a fix that disabled in-flight detection ENTIRELY would look
// identical to a correct one in production. Only the positive case can catch
// that over-correction, and only the negatives can catch the original bug. All
// three directions must hold together or the test proves nothing.
//
// Run: cd functions && node --test test/ledger-touched-identity.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");

const PID = "p-gloves";
const OTHER_PID = "p-something-else";
const ORDER_ID = "R026-1";                         // the recycled label
const ORDER_CREATED = "2026-07-28T10:51:12.818Z";  // today's order
const NOW = Date.parse("2026-07-28T14:00:00.000Z");

// PE(target 15, has 1) ← hub2(has 2). Deficit 14, source 2 → resize 1→2.
function scenario(movements) {
  return {
    nowMs: NOW,
    config: { routes: { "marathon-pe": "hub2", hub2: "central" }, mode: { "marathon-pe": "live", hub2: "live" },
              ruleBasedTargets: false, maxUnitsPerIntent: 20 },
    products: { [PID]: { id: PID, name: "Gloves", productType: "clothing", sizes: ["M", "L"] },
                [OTHER_PID]: { id: OTHER_PID, name: "Other", productType: "clothing", sizes: ["L"] } },
    stock: { "marathon-pe": { [PID]: { L: { qty: 1 } } }, hub2: { [PID]: { L: { qty: 2 } } }, central: {} },
    targets: { "marathon-pe": { [PID]: { L: { target: 15, minQty: 8 } } } },
    openIndex: { "marathon-pe": { [PID]: { L: {
      qty: 1, source: "hub2", refillId: "rr1", orderId: ORDER_ID,
      orderCreatedAt: ORDER_CREATED, createdAt: ORDER_CREATED,
    } } } },
    refillRequests: { rr1: { status: "open", productId: PID, size: "L", requestingLocation: "marathon-pe", qty: 1 } },
    orders: { [ORDER_ID]: { id: ORDER_ID, productId: PID, size: "L", qty: 1, createdAt: ORDER_CREATED,
                            customerName: "Shop Refill", autoRefill: true, status: "incoming", clothingRefillStatus: null } },
    movements,
  };
}
const mv = (o) => ({ type: "transfer_out", from: "hub2", to: "marathon-pe", qty: 1, link: { orderId: ORDER_ID }, ...o });
const resizeOf = (p) => p.resizes.find((r) => r.pid === PID && r.sizeKey === "L");
const suppressed = (p) => p.stats?.resizeSuppressed;

// ── BASELINE ────────────────────────────────────────────────────────────────

test("no movements at all → resize is planned (the shape every case below varies)", () => {
  const p = computeRefillPlan(scenario([]));
  assert.deepEqual(resizeOf(p) && { from: resizeOf(p).from, to: resizeOf(p).to }, { from: 1, to: 2 });
  assert.equal(suppressed(p), undefined, "nothing suppressed, so the counter stays absent");
});

// ── NEGATIVE 1 — the exact live poisoning ───────────────────────────────────

test("NEGATIVE: same R-number, PRIOR DAY, DIFFERENT product → NOT in-flight, resize survives", () => {
  // The literal shape found in production: 9 movements labelled R026-1 across 10
  // days, every one a different product. Under the old bare-Set match this alone
  // froze the lock.
  const p = computeRefillPlan(scenario([
    mv({ productId: OTHER_PID, size: "L", ts: "2026-07-17T07:35:06.046Z" }),
    mv({ productId: OTHER_PID, size: "M", ts: "2026-07-21T08:40:25.004Z" }),
  ]));
  assert.ok(resizeOf(p), "a stranger's movement must not suppress this resize");
  assert.equal(resizeOf(p).to, 2);
  assert.equal(suppressed(p), undefined);
});

// ── NEGATIVE 2 — why product+size alone is not enough ───────────────────────

test("NEGATIVE: same R-number, SAME product AND size, but ts BEFORE orderCreatedAt → NOT in-flight", () => {
  // The case a product+size-only fix would still get wrong: the same shop
  // refills the same SKU in the same size repeatedly, so a recycled label
  // eventually collides on all three. Only the AGE BOUND separates them — a
  // movement cannot belong to an order that did not exist when it was written.
  const p = computeRefillPlan(scenario([
    mv({ productId: PID, size: "L", ts: "2026-07-24T09:00:00.000Z" }),   // 4 days before this order
  ]));
  assert.ok(resizeOf(p), "a pre-dating movement cannot belong to this order");
  assert.equal(resizeOf(p).to, 2);
  assert.equal(suppressed(p), undefined);
});

// ── POSITIVE — the guard must still fire, or the fix is a silent disable ────

test("POSITIVE: same order, same product+size, ts AT/AFTER orderCreatedAt → IN-FLIGHT, resize suppressed", () => {
  // Without this, a fix that simply deleted in-flight detection would pass every
  // negative above AND look correct against live data (which contains zero
  // genuine in-flight movements).
  const p = computeRefillPlan(scenario([
    mv({ productId: PID, size: "L", ts: "2026-07-28T11:30:00.000Z" }),   // after the order existed
  ]));
  assert.equal(resizeOf(p), undefined, "a real pick in flight must still park the resize");
  assert.deepEqual(suppressed(p), { in_flight_ledger_link: 1 }, "and it must be COUNTED, not silent");
});

test("POSITIVE: a movement exactly AT orderCreatedAt counts as in-flight (boundary is inclusive)", () => {
  const p = computeRefillPlan(scenario([mv({ productId: PID, size: "L", ts: ORDER_CREATED })]));
  assert.equal(resizeOf(p), undefined);
  assert.deepEqual(suppressed(p), { in_flight_ledger_link: 1 });
});

// ── the OTHER in-flight source stays distinguishable ────────────────────────

test("clothingPlanGen suppression is counted separately from the ledger link", () => {
  const s = scenario([]);
  s.orders[ORDER_ID].clothingPlanGen = 3;            // a fulfil attempt locked its split
  const p = computeRefillPlan(s);
  assert.equal(resizeOf(p), undefined);
  assert.deepEqual(suppressed(p), { in_flight_plan_gen: 1 },
    "the two in-flight sources must never collapse onto one reason — that is what made this invisible");
});

// ── structural: why hub legs were immune ────────────────────────────────────

test("a lock with NO orderId can never be ledger-touched (hub legs)", () => {
  const s = scenario([mv({ productId: PID, size: "L", ts: "2026-07-28T11:30:00.000Z" })]);
  delete s.openIndex["marathon-pe"][PID].L.orderId;      // hub-leg shape
  delete s.openIndex["marathon-pe"][PID].L.orderCreatedAt;
  const p = computeRefillPlan(s);
  assert.ok(resizeOf(p), "no orderId → nothing to match a label against → never suppressed");
});

// ── locks whose anchor does not match ────────────────────────────────────────

test("a lock whose orderCreatedAt does not match its order is WITHDRAWN, never resized", () => {
  // Proves the no-anchor branch of ledgerTouched is unreachable in the resize
  // path: orderIsOurs fails → orderLost fires → the lock closes and `continue`s
  // before inFlight is consulted (zombie-leg rule, #234). Written as a test so a
  // future edit that reorders those branches fails loudly here.
  const s = scenario([mv({ productId: PID, size: "L", ts: "2026-07-28T11:30:00.000Z" })]);
  delete s.openIndex["marathon-pe"][PID].L.orderCreatedAt;
  const p = computeRefillPlan(s);
  assert.equal(resizeOf(p), undefined, "not resized");
  assert.ok(p.closes.some((c) => c.pid === PID && c.sizeKey === "L" && c.reason === "order_lost"),
    "withdrawn as a lost order, which is what owns this case");
  assert.equal(suppressed(p), undefined, "and it is NOT counted as an in-flight suppression");
});

// ── counter hygiene ─────────────────────────────────────────────────────────

test("suppressions TALLY and the counter is absent on a clean plan", () => {
  const s = scenario([mv({ productId: PID, size: "L", ts: "2026-07-28T11:30:00.000Z" })]);
  // second armed cell on the same product, same poisoning
  s.stock["marathon-pe"][PID].M = { qty: 1 };
  s.stock.hub2[PID].M = { qty: 2 };
  s.targets["marathon-pe"][PID].M = { target: 15, minQty: 8 };
  // A SECOND order — one order node cannot be two sizes, so reusing ORDER_ID here
  // would fail orderIsOurs and be withdrawn rather than suppressed.
  const ORDER_2 = "R026-2";
  s.openIndex["marathon-pe"][PID].M = { qty: 1, source: "hub2", refillId: "rr2", orderId: ORDER_2,
                                        orderCreatedAt: ORDER_CREATED, createdAt: ORDER_CREATED };
  s.refillRequests.rr2 = { status: "open", productId: PID, size: "M", requestingLocation: "marathon-pe", qty: 1 };
  s.orders[ORDER_2] = { id: ORDER_2, productId: PID, size: "M", qty: 1, createdAt: ORDER_CREATED,
                        customerName: "Shop Refill", autoRefill: true, status: "incoming", clothingRefillStatus: null };
  s.movements.push({ ...mv({ productId: PID, size: "M", ts: "2026-07-28T11:31:00.000Z" }), link: { orderId: ORDER_2 } });
  const p = computeRefillPlan(s);
  assert.deepEqual(suppressed(p), { in_flight_ledger_link: 2 }, "same reason accumulates");

  assert.equal(suppressed(computeRefillPlan(scenario([]))), undefined, "clean plan → counter absent");
});

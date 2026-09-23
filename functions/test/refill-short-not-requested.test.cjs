// ─── SHORT BUT NOT REQUESTED — the standing Health list ──────────────────────
// Run: cd functions && node --test test/refill-short-not-requested.test.cjs
//
// exceptions.shortNotRequested lists every SHOP cell below keep, with the size
// at its hub or Central, and nothing on its way — with the reason the engine
// parked it. These pin WHO is on the list and the REASON each carries, through
// the real computeRefillPlan. (Cross-checked cell-for-cell against the
// independent census, scripts/audit/short-not-requested-census.mjs, on the
// live snapshot of 2026-09-23: 61 = 61, identical sets.)

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");

const NOW = Date.parse("2026-09-23T10:00:00.000Z");
const iso = (hAgo = 0) => new Date(NOW - hAgo * 3600e3).toISOString();
const cell = (qty) => ({ qty, v: 1 });

const CONFIG = {
  enabled: true,
  mode: { hub2: "live", "marathon-pe": "live", trophy: "live" },
  routes: { hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
  ruleBasedTargets: false,
  maxUnitsPerIntent: 20,
  maxIntentsPerRun: 75,
  recheckCooldownMinutes: 1440,
  rejectStreakLimit: 4,
};
const P = { p1: { name: "Tee", productType: "clothing", sizes: ["M", "L"] } };
const keep = (loc, sizes) => ({ [loc]: { p1: Object.fromEntries(sizes.map(([s, t]) => [s, { target: t, minQty: 1 }])) } });

function plan(over = {}) {
  return computeRefillPlan({
    nowMs: NOW, config: CONFIG, products: P,
    targets: keep("marathon-pe", [["M", 2]]),
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: {}, central: {}, trophy: {} },
    openIndex: {}, refillRequests: {}, orders: {}, movements: [], rejectStreak: {}, retryState: {},
    ...over,
  });
}
const list = (p) => p.exceptions.shortNotRequested;
const reasonOf = (p, loc, size) => list(p).items.find((r) => r.loc === loc && r.size === size)?.reason;

test("an ordinary shortfall the engine asks for is NOT on the list", () => {
  const p = plan({ stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: { p1: { M: cell(3) } }, central: {}, trophy: {} } });
  assert.ok(p.intents.some((i) => i.dest === "marathon-pe"));
  assert.equal(list(p).count, 0);
});

test("a pass-through leg carrying the shop takes it OFF the list — this scan and while it is in flight", () => {
  const stock = { "marathon-pe": { p1: { M: cell(0) } }, hub2: {}, central: { p1: { M: cell(9) } }, trophy: {} };
  const raised = plan({ stock });
  assert.equal(raised.intents.find((i) => i.dest === "hub2")?.passThrough, "no_target");
  assert.equal(list(raised).count, 0, "raised now");
  const inFlight = plan({
    stock,
    openIndex: { hub2: { p1: { M: { qty: 2, source: "central", createdAt: iso(1), runId: "r", refillId: "rr", passThrough: "no_target", forDests: ["marathon-pe"] } } } },
    refillRequests: { rr: { productId: "p1", size: "M", qty: 2, requestingLocation: "hub2", status: "open", createdAt: iso(1) } },
  });
  assert.equal(list(inFlight).count, 0, "the hub leg is on its way");
});

test("the loop guard with NOTHING at Central → listed as 'recount' (only a recount can settle it)", () => {
  const p = plan({
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: { p1: { M: cell(3) } }, central: {}, trophy: {} },
    rejectStreak: { "marathon-pe": { p1: { M: { count: 4, by: "hub2", lastTs: iso(20) } } } },
  });
  assert.equal(p.intents.length, 0);
  const row = list(p).items[0];
  assert.deepEqual(
    { loc: row.loc, size: row.size, have: row.have, keep: row.keep, hub: row.hub, hubHas: row.hubHas, upstream: row.upstream, upHas: row.upHas, reason: row.reason },
    { loc: "marathon-pe", size: "M", have: 0, keep: 2, hub: "hub2", hubHas: 3, upstream: "central", upHas: 0, reason: "recount" },
  );
  assert.deepEqual(list(p).byReason, { recount: 1 });
  assert.deepEqual(list(p).byShop, { "marathon-pe": 1 });
});

test("an EXPLICIT hub 0 keeps the no-target dead end visible — 'hub_no_target', never silent", () => {
  const p = plan({
    targets: { ...keep("marathon-pe", [["M", 2]]), ...keep("hub2", [["M", 0]]) },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: {}, central: { p1: { M: cell(9) } }, trophy: {} },
  });
  assert.equal(p.intents.length, 0);
  assert.equal(reasonOf(p, "marathon-pe", "M"), "hub_no_target");
});

test("inside the retry window after an ordinary refusal → 'cooldown'", () => {
  const p = plan({
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: { p1: { M: cell(3) } }, central: {}, trophy: {} },
    retryState: { "marathon-pe": { p1: { M: { retryCount: 1, lastRejectedAt: iso(2), nextRetryAt: iso(-22) } } } },
  });
  assert.equal(reasonOf(p, "marathon-pe", "M"), "cooldown");
});

test("Central refused the hub's restock → 'upstream_blocked'", () => {
  const p = plan({
    targets: { ...keep("marathon-pe", [["M", 2]]), ...keep("hub2", [["M", 3]]) },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(9) } }, trophy: {} },
    refillRequests: { rrC: { productId: "p1", size: "M", qty: 3, requestingLocation: "hub2", status: "cancelled",
      createdAt: iso(5), resolvedAt: iso(2), createdFrom: { engine: true, source: "central" } } },
  });
  assert.equal(reasonOf(p, "marathon-pe", "M"), "upstream_blocked");
});

test("computed but deferred by the per-run cap → 'throttled'", () => {
  const p = plan({
    config: { ...CONFIG, maxIntentsPerRun: 1 },
    targets: keep("marathon-pe", [["M", 2], ["L", 2]]),
    stock: { "marathon-pe": { p1: { M: cell(0), L: cell(0) } }, hub2: { p1: { M: cell(3), L: cell(3) } }, central: {}, trophy: {} },
  });
  assert.equal(p.intents.length, 1);
  assert.equal(list(p).count, 1);
  assert.equal(list(p).items[0].reason, "throttled");
});

test("never listed: a hub cell, a cell with nothing upstream, and a cell held by the owner's ask-at", () => {
  const p = plan({
    targets: {
      ...keep("hub2", [["M", 3]]),
      "marathon-pe": { p1: { M: { target: 2, minQty: 1 }, L: { target: 3, minQty: 1, reorderPoint: 1 } } },
    },
    stock: { "marathon-pe": { p1: { M: cell(0), L: cell(2) } }, hub2: { p1: { M: cell(0) } }, central: { p1: { L: cell(5) } }, trophy: {} },
  });
  // hub2 M: a hub, not a shop. PE M: nothing at hub2 or Central. PE L: 2 > ask-at 1.
  assert.equal(list(p).count, 0);
  assert.deepEqual(list(p).shops, ["marathon-pe", "trophy"]);
});

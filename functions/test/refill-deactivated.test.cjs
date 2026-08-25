// ─── DEACTIVATED PRODUCTS — THE ENGINE SKIPS THEM ENTIRELY ───────────────────
// Run: cd functions && node --test
//
// products/{pid}/deactivated (owner spec 2026-08-25, the Leftovers deactivate
// action — src/utils/deactivation.js) retires a finished line reversibly. The
// engine contract, pinned here:
//
//   1. A deactivated product raises NO intent — whether rule-managed clothing
//      or armed by an explicit /stock_targets row (the guard sits ABOVE the
//      explicit branch in resolveTarget).
//   2. Every OTHER product's planning is byte-for-byte unchanged by a
//      neighbour's deactivation.
//   3. An in-flight open request for a product deactivated afterwards is
//      withdrawn on the next scan (no_longer_needed) — no zombie cards.
//   4. Deactivated products owe no Decision Queue entries (noTarget /
//      unintroduced) and no exception noise (belowTarget / missingSizes).
//   5. Reactivation (the node deleted) restores the exact original plan —
//      byte-for-byte, because the flag's absence is indistinguishable from a
//      product that never was deactivated.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");

const NOW = Date.parse("2026-08-25T08:00:00.000Z");
const iso = (hoursAgo) => new Date(NOW - hoursAgo * 3600e3).toISOString();

const CONFIG = {
  enabled: true,
  routes: { "marathon-pe": "hub2", hub2: "central" },
  mode: { "marathon-pe": "live", hub2: "live" },
  productTypes: { clothing: true },
  defaultRunByStore: { "marathon-pe": { M: 2, L: 2 }, hub2: { M: 3, L: 3 } },
  maxIntentsPerRun: 75,
  maxUnitsPerIntent: 20,
  ruleBasedTargets: true,
  confirmedOutDays: 14,
};
const PRODUCTS = {
  p1: { id: "p1", name: "Finished Hoodie", productType: "clothing", category: "Clothing", sizes: ["M", "L"] },
  p2: { id: "p2", name: "Live Tee", productType: "clothing", category: "Clothing", sizes: ["M", "L"] },
  f1: { id: "f1", name: "Finished Runner", category: "Footwear", sizes: ["8", "9"] },
};
const DEACTIVATED = { at: NOW - 3600e3, by: "someUid", byName: "junid" };

const snapshot = (over = {}) => ({
  nowMs: NOW, config: CONFIG, products: PRODUCTS,
  // f1 is armed by an EXPLICIT row — the strongest source resolveTarget knows.
  targets: { "marathon-pe": { f1: { "8": { target: 2, minQty: 1 } } } },
  targetDecisions: {}, openIndex: {}, refillRequests: {}, orders: {},
  rejectStreak: {}, retryState: {}, movements: [],
  stock: {
    "marathon-pe": { p1: { M: { qty: 0 }, L: { qty: 0 } }, p2: { M: { qty: 0 }, L: { qty: 0 } }, f1: { "8": { qty: 0 } } },
    hub2:          { p1: { M: { qty: 10 }, L: { qty: 10 } }, p2: { M: { qty: 10 }, L: { qty: 10 } }, f1: { "8": { qty: 10 } } },
    central:       { p1: { M: { qty: 10 }, L: { qty: 10 } }, p2: { M: { qty: 10 }, L: { qty: 10 } }, f1: { "8": { qty: 10 } } },
  },
  ...over,
});

const withDeactivated = (pids, over = {}) => snapshot({
  products: Object.fromEntries(Object.entries(PRODUCTS).map(([id, p]) =>
    [id, pids.includes(id) ? { ...p, deactivated: DEACTIVATED } : p])),
  ...over,
});

// onlyInCentral / onlyInHub2 are STRANDED-STOCK visibility lists, not work
// queues — a deactivated product still holding units must stay visible on
// them (the whole point of the trap guard: deactivated stock is never
// silently lost). Everything else must be silent about a deactivated pid.
const VISIBILITY_LISTS = new Set(["onlyInCentral", "onlyInHub2"]);
const mentions = (plan, pid) => {
  const hits = [];
  for (const i of plan.intents || []) if (i.productId === pid) hits.push(`intent:${i.dest}`);
  for (const [k, v] of Object.entries(plan.exceptions || {})) {
    if (VISIBILITY_LISTS.has(k)) continue;
    for (const item of v.items || []) if (item.pid === pid || item.productId === pid) hits.push(`${k}`);
  }
  return hits;
};

test("the fixture actually plans work for every product under test", () => {
  const plan = computeRefillPlan(snapshot());
  const pids = new Set((plan.intents || []).map((i) => i.productId));
  assert.ok(pids.has("p1") && pids.has("p2") && pids.has("f1"),
    `expected intents for p1, p2 and f1, got ${JSON.stringify([...pids])}`);
});

test("a deactivated rule-managed product raises no intent and no exception noise", () => {
  const plan = computeRefillPlan(withDeactivated(["p1"]));
  assert.deepEqual(mentions(plan, "p1"), [], "deactivated p1 must appear nowhere in the plan");
  assert.ok((plan.intents || []).some((i) => i.productId === "p2"), "active p2 still refills");
});

test("an explicit /stock_targets row cannot re-arm a deactivated product", () => {
  const plan = computeRefillPlan(withDeactivated(["f1"]));
  assert.deepEqual(mentions(plan, "f1"), [], "the guard sits above the explicit branch");
});

test("every other product's plan is byte-for-byte unchanged by a neighbour's deactivation", () => {
  const bare = computeRefillPlan(snapshot());
  const withD = computeRefillPlan(withDeactivated(["p1"]));
  const notP1 = (arr) => (arr || []).filter((x) => x.productId !== "p1" && x.pid !== "p1");
  assert.equal(JSON.stringify(notP1(withD.intents)), JSON.stringify(notP1(bare.intents)),
    "p2/f1 intents identical");
  for (const key of Object.keys(bare.exceptions)) {
    assert.equal(JSON.stringify(notP1(withD.exceptions[key].items)), JSON.stringify(notP1(bare.exceptions[key].items)),
      `exceptions.${key} identical for every non-deactivated product`);
  }
});

test("an in-flight open request is withdrawn no_longer_needed on the next scan", () => {
  const inflight = {
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "R003-2", orderCreatedAt: iso(1), qty: 2, source: "hub2", createdAt: iso(1) } } } },
    refillRequests: { r1: { status: "open", productId: "p1", size: "M", requestingLocation: "marathon-pe" } },
    orders: { "R003-2": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(1), clothingRefillStatus: null, status: "incoming" } },
  };
  // Sanity: while ACTIVE the request is still wanted (deficit persists).
  const active = computeRefillPlan(snapshot(inflight));
  assert.ok(!(active.closes || []).some((c) => c.reason === "no_longer_needed"), "active → request stays");
  const plan = computeRefillPlan(withDeactivated(["p1"], inflight));
  const c = (plan.closes || []).find((x) => x.reason === "no_longer_needed");
  assert.ok(c, "deactivation nulls the target → needGone → withdrawn");
  assert.equal(c.removeOrderId, "R003-2", "warehouse card deleted before anyone picks it");
});

test("a deactivated product owes no Decision Queue entry", () => {
  // p3: circulating clothing with NO targets anywhere — the exact unintroduced
  // shape — plus stranded central stock (the noTarget/new shape).
  const products = {
    ...PRODUCTS,
    p3: { id: "p3", name: "Old Line", productType: "clothing", category: "Clothing", sizes: ["M"], deactivated: DEACTIVATED },
  };
  const plan = computeRefillPlan(snapshot({
    products,
    config: { ...CONFIG, ruleBasedTargets: false },   // rules off → p3 unmanaged
    stock: {
      "marathon-pe": { p3: { M: { qty: 4 } } },
      hub2: {}, central: { p3: { M: { qty: 6 } } },
    },
    targets: {},
  }));
  assert.deepEqual(mentions(plan, "p3"), [], "no noTarget, no unintroduced, nothing");
});

test("reactivation restores the exact original plan byte-for-byte", () => {
  const bare = computeRefillPlan(snapshot());
  // Reactivation deletes the node (RTDB null) and stamps `reactivated` — the
  // engine must treat that record exactly like one never deactivated.
  const reactivated = snapshot({
    products: {
      ...PRODUCTS,
      p1: { ...PRODUCTS.p1, reactivated: { at: NOW - 60e3, by: "someUid", reason: "manual" } },
    },
  });
  assert.equal(JSON.stringify(computeRefillPlan(reactivated)), JSON.stringify(bare),
    "a reactivated product plans identically to one never touched");
});

test("a LOCK-LESS open request (Missing Footwear / on-hold writer) is withdrawn with no stock proof needed", () => {
  // No openIndex entry — the reconcile loop cannot reach it — and the
  // destination cell is EMPTY, so the satisfied-by-stock path would never
  // fire either. Deactivation alone must withdraw it.
  const plan = computeRefillPlan(withDeactivated(["f1"], {
    refillRequests: { rX: { status: "open", productId: "f1", size: "8", qty: 2, requestingLocation: "hub1", createdAt: iso(2) } },
    stock: { ...snapshot().stock, hub1: { f1: { "8": { qty: 0 } } } },
  }));
  const c = (plan.satisfiedClosures || []).find((x) => x.refillId === "rX");
  assert.ok(c, "lock-less request withdrawn on deactivation");
  assert.equal(c.cancelReason, "no_longer_needed");
  assert.equal(c.deactivated, true, "flag tells the apply pass to skip the live-cell proof");
  // And the same row for an ACTIVE product survives untouched.
  const active = computeRefillPlan(snapshot({
    refillRequests: { rX: { status: "open", productId: "f1", size: "8", qty: 2, requestingLocation: "hub1", createdAt: iso(2) } },
    stock: { ...snapshot().stock, hub1: { f1: { "8": { qty: 0 } } } },
  }));
  assert.ok(!(active.satisfiedClosures || []).some((x) => x.refillId === "rX"), "active → request stays open");
});

// ── the APPLY half: the live-cell proof is skipped for deactivation closures ──
const { _applySatisfied: applySatisfied } = require("../refill-scan.cjs");

function fakeDb({ stock = {}, requests = {} }) {
  const writes = {};
  return {
    writes,
    ref(path) {
      return {
        once: async () => ({ val: () => (path in stock ? stock[path] : null) }),
        transaction: async (fn) => {
          const id = path.split("/")[1];
          let out = fn(null);
          if (out === undefined) return { committed: false, snapshot: { val: () => requests[id] ?? null } };
          const cur = requests[id] ?? null;
          out = fn(cur);
          if (out === undefined) return { committed: false, snapshot: { val: () => cur } };
          if (out !== null) { requests[id] = out; writes[path] = out; }
          return { committed: true, snapshot: { val: () => (out === null ? null : requests[id]) } };
        },
      };
    },
  };
}

test("apply: a deactivation closure cancels with the destination cell EMPTY", async () => {
  const db = fakeDb({
    stock: { "stock/hub1/f1/8/qty": 0 },
    requests: { rX: { status: "open", productId: "f1", size: "8", qty: 2, requestingLocation: "hub1" } },
  });
  const r = await applySatisfied({
    db, startedAt: "2026-08-25T08:00:00.000Z",
    closures: [{ refillId: "rX", dest: "hub1", pid: "f1", sizeKey: "8", size: "8", qty: 0, have: 0, rrStatus: "cancelled", cancelReason: "no_longer_needed", deactivated: true }],
  });
  assert.equal(r.satisfied, 1, "not marked stale despite zero stock");
  const w = db.writes["refill_requests/rX"];
  assert.equal(w.status, "cancelled");
  assert.equal(w.cancelReason, "no_longer_needed");
  assert.equal(w.deactivatedProduct, true);
  assert.ok(!("satisfiedBy" in w), "no fake stock-proof audit on a deactivation withdrawal");
});

test("apply: a request resolved meanwhile is left alone even for a deactivation closure", async () => {
  const db = fakeDb({ requests: { rX: { status: "fulfilled", productId: "f1", size: "8" } } });
  const r = await applySatisfied({
    db, startedAt: "2026-08-25T08:00:00.000Z",
    closures: [{ refillId: "rX", dest: "hub1", pid: "f1", sizeKey: "8", size: "8", qty: 0, have: 0, rrStatus: "cancelled", cancelReason: "no_longer_needed", deactivated: true }],
  });
  assert.equal(r.satisfied, 0);
  assert.ok(!db.writes["refill_requests/rX"], "fulfilled row untouched");
});

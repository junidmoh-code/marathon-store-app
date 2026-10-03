// ─── A SCAN LANDING MID-PICK CANNOT TOUCH THE REQUEST (2026-10-03) ──────────
// RefillQueue claims a request (`picking`, server-stamped) BEFORE it moves
// stock and clears the claim in the same write as sentQty / fulfilled. Between
// those two writes the refill scan must not close, resize or withdraw it —
// not in the plan, and not at apply, where every transaction re-checks.
// Run: cd functions && node --test test/pick-marker.test.cjs
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");
const { pickInProgress, requestUntouched, PICK_MARKER_TTL_MS } = require("../lib/shop-source-rule.cjs");
const scan = require("../refill-scan.cjs");
const { processFirstBatchRequest } = require("../lib/first-batch.cjs");

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const T0 = "2026-10-03T08:00:00.000Z";
const cell = (qty) => ({ qty, v: 1, mv: "m", lastType: "received", updatedAt: "2026-09-01T00:00:00.000Z" });
const fresh = { atMs: NOW - 60e3, movementId: "rrf_r1", by: "u1" };
const stale = { atMs: NOW - PICK_MARKER_TTL_MS - 60e3, movementId: "rrf_r1", by: "u1" };
const CONFIG = {
  enabled: true, mode: { hub2: "live", trophy: "live" },
  routes: { hub2: "central", trophy: "hub2" },
  ruleBasedTargets: true, maxUnitsPerIntent: 20, maxIntentsPerRun: 50, staleIntentHours: 999,
  defaultRunByStore: { hub2: { M: 3 }, trophy: { M: 2 } },
};
const PRODUCTS = { tee: { id: "tee", name: "Tee", productType: "clothing", categoryKey: "t-shirts", sizes: ["M"] } };

// A Hub 2 request the engine would WITHDRAW (Hub 2 is already at target: the
// need is gone) and a shop ← Central first batch the shop-source rule would
// withdraw (Hub 2 holds the product) — both mid-pick.
function snap(picking) {
  return {
    nowMs: NOW, config: CONFIG, products: PRODUCTS, targets: {},
    stock: { central: { tee: { M: cell(9) } }, hub2: { tee: { M: cell(5) } }, trophy: { tee: { M: cell(0) } } },
    openIndex: {
      hub2: { tee: { M: { qty: 2, source: "central", createdAt: T0, runId: "scan", refillId: "h1" } } },
      trophy: { tee: { M: { qty: 2, source: "central", createdAt: T0, runId: "first_batch:x", refillId: "r1" } } },
    },
    refillRequests: {
      h1: { productId: "tee", size: "M", qty: 2, requestingLocation: "hub2", status: "open", createdAt: T0, createdFrom: { engine: true, source: "central" }, ...(picking ? { picking: { ...picking, movementId: "rrf_h1" } } : {}) },
      r1: { productId: "tee", size: "M", qty: 2, requestingLocation: "trophy", status: "open", createdAt: T0, createdFrom: { firstBatch: true, solveId: "x", source: "central", store: "trophy" }, ...(picking ? { picking } : {}) },
    },
    orders: {}, movements: [], heldLines: {},
    locations: { central: { kind: "warehouse" }, hub2: { kind: "warehouse" }, trophy: { kind: "store" } },
  };
}
const touching = (plan, id) => [...plan.closes.filter((c) => c.refillId === id), ...plan.resizes.filter((r) => r.refillId === id), ...plan.satisfiedClosures.filter((s) => s.refillId === id)];

test("the plan: no close, resize or withdrawal of a request a picker has claimed (fresh marker); a stale claim stops blocking", () => {
  const bare = computeRefillPlan(snap(null));
  assert.ok(touching(bare, "h1").length > 0, "control: unclaimed, the engine WOULD withdraw the Hub 2 request (need gone)");
  assert.ok(touching(bare, "r1").length > 0, "control: unclaimed, the shop-source rule WOULD withdraw the first batch");
  const mid = computeRefillPlan(snap(fresh));
  assert.deepEqual(touching(mid, "h1"), []);
  assert.deepEqual(touching(mid, "r1"), []);
  const old = computeRefillPlan(snap(stale));
  assert.ok(touching(old, "h1").length > 0 && touching(old, "r1").length > 0, "a claim older than the TTL no longer freezes the request");
});

test("the apply: close, resize and lock-less withdrawal transactions all refuse a claimed request", async () => {
  const row = { productId: "tee", size: "M", qty: 2, requestingLocation: "hub2", status: "open", createdAt: T0, picking: { ...fresh, atMs: Date.now() - 1000 } };
  // close (any kind — with and without requireUntouched)
  for (const c of [{ rrStatus: "cancelled", cancelReason: "no_longer_needed" }, { rrStatus: "cancelled", cancelReason: "first_batch_hub2_present", requireUntouched: true }]) {
    assert.equal(scan._closeRequestTxn(row, c, "2026-10-03T12:00:00.000Z"), undefined);
  }
  // resize
  const db = makeFakeDb({ refill_requests: { h1: row }, refill_engine: { open: { hub2: { tee: { M: { qty: 2, refillId: "h1" } } } } } });
  const rz = await scan._applyResizes({ db, resizes: [{ dest: "hub2", pid: "tee", sizeKey: "M", refillId: "h1", orderId: null, from: 2, to: 1 }], startedAt: "x", setFn: async () => true });
  assert.equal(rz.resized, 0);
  assert.equal(db.state.root.refill_requests.h1.qty, 2);
  // lock-less withdrawal (satisfied pass)
  const db2 = makeFakeDb({ refill_requests: { h1: row }, stock: { hub2: { tee: { M: cell(9) } } } });
  const sat = await scan._applySatisfied({ db: db2, closures: [{ refillId: "h1", dest: "hub2", pid: "tee", sizeKey: "M", size: "M", qty: 2, have: 9, rrStatus: "cancelled", cancelReason: "already_in_stock" }], startedAt: "x" });
  assert.equal(sat.satisfied, 0);
  assert.equal(db2.state.root.refill_requests.h1.status, "open");
});

test("the first-batch trigger's own withdrawal refuses a claimed request", async () => {
  const db = makeFakeDb({
    config: { refillEngine: { ...CONFIG, routes: { hub2: "central", trophy: "hub2" } } }, products: PRODUCTS,
    stock: { hub2: { tee: { M: cell(4) } }, central: { tee: { M: cell(9) } } },
    refill_requests: { r1: { productId: "tee", size: "M", qty: 2, requestingLocation: "trophy", status: "open", createdAt: T0,
      createdFrom: { firstBatch: true, solveId: "x", source: "central", store: "trophy" }, picking: { ...fresh, atMs: Date.now() - 1000 } } },
  });
  await processFirstBatchRequest({ db, requestId: "r1", nowIso: "2026-10-03T12:00:00.000Z", pathEnabled: true });
  assert.equal(db.state.root.refill_requests.r1.status, "open", "Hub 2 holds it — but a picker is mid-pick: never withdrawn under them");
});

test("the scan's close loop keeps the lock of any OPEN request whose close it refused", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "refill-scan.cjs"), "utf8");
  assert.match(src, /if \(!\(res && res\.committed\) && res\?\.snapshot\?\.val\(\)\?\.status === "open"\) continue;/);
});

test("pickInProgress / requestUntouched: fresh blocks, stale does not, undated blocks", () => {
  assert.equal(pickInProgress({ picking: fresh }, NOW), true);
  assert.equal(pickInProgress({ picking: stale }, NOW), false);
  assert.equal(pickInProgress({ picking: { movementId: "x" } }, NOW), true);
  assert.equal(pickInProgress({}, NOW), false);
  assert.equal(pickInProgress({ picking: { atMs: NOW + 5 * 3600e3 } }, NOW), false, "a marker from a clock hours ahead does not block");
  assert.equal(requestUntouched({ status: "open", picking: fresh }, NOW), false);
  assert.equal(requestUntouched({ status: "open", picking: stale }, NOW), true);
});

test("the plan: a claimed request is never RESIZED (Hub 2 needs 1 now, the request asks 2 — unclaimed it shrinks, claimed it does not)", () => {
  for (const [picking, expectResize] of [[null, true], [fresh, false]]) {
    const s = snap(picking);
    s.stock.hub2.tee.M = cell(2);                     // target 3 − have 2 = need 1; the request asks 2
    delete s.openIndex.trophy; delete s.refillRequests.r1;
    const plan = computeRefillPlan(s);
    assert.equal(plan.resizes.some((r) => r.refillId === "h1"), expectResize, picking ? "claimed" : "unclaimed");
  }
});

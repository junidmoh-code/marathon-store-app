// ─── FIRST BATCH DIRECT TO SHOP — the deferred Hub 2 leg, against the real engine ─
// Every test drives the REAL trigger core (processFirstBatchRequest) over the
// fake RTDB (which deletes empty children the way the live one does) and,
// where the claim is about the engine, runs the REAL computeRefillPlan over
// the resulting tree. No mirror, no restated implementation: the number the
// engine would propose is the number asserted.
// Run: cd functions && node --test test/first-batch.test.cjs
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { processFirstBatchRequest, FIRST_BATCH_RUN_PREFIX, SOLVE_UNDONE_REASON } = require("../lib/first-batch.cjs");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");

const NOW = Date.parse("2026-09-17T10:00:00.000Z");
const T1 = "2026-09-17T10:00:00.000Z";
const CONFIG = {
  enabled: true,
  mode: { hub1: "live", hub2: "live", trophy: "live", "marathon-pe": "live" },
  routes: { hub1: "central", hub2: "central", trophy: "hub2", "marathon-pe": "hub2" },
  ruleBasedTargets: true, maxUnitsPerIntent: 20, maxIntentsPerRun: 200, staleIntentHours: 48,
  defaultRunByStore: { hub2: { M: 3, L: 3 }, trophy: { M: 2, L: 2 }, "marathon-pe": { M: 2, L: 2 } },
};
// p1 and p2 are DUPLICATE-NAME TWINS — every assertion keys by id.
const PRODUCTS = {
  p1: { id: "p1", name: "Essentials Tee", productType: "clothing", sizes: ["M", "L"] },
  p2: { id: "p2", name: "Essentials Tee", productType: "clothing", sizes: ["M"] },
};
const cell = (qty) => ({ qty, v: 1, mv: "m", lastType: "received" });
const seed = () => ({ qty: 0, v: 0, mv: "seed", lastType: "count", state: "live" });
const SOLVE = "fb_p1_abc";
const shopReq = (over = {}) => ({
  productId: "p1", size: "M", qty: 2, requestingLocation: "trophy", status: "open",
  createdAt: "2026-09-17T09:00:00.000Z",
  createdFrom: { firstBatch: true, solveId: SOLVE, source: "central", store: "trophy", hub: "hub2" },
  ...over,
});
function world(over = {}) {
  return makeFakeDb({
    config: { refillEngine: CONFIG },
    products: PRODUCTS,
    // The Solve seeded the SHOP only; Central still holds the units.
    stock: { central: { p1: { M: cell(4), L: cell(0) } }, trophy: { p1: { M: seed(), L: seed() } } },
    refill_requests: { r1: shopReq() },
    ...over,
  });
}
const run = (db, id = "r1", nowIso = T1) => processFirstBatchRequest({ db, requestId: id, nowIso });
const hubRequests = (db) => Object.entries(db.state.root.refill_requests || {}).filter(([, r]) => r.requestingLocation === "hub2");
const lockAt = (db, loc, pid, sk) => db.state.root.refill_engine?.open?.[loc]?.[pid]?.[sk] ?? null;
const snapshot = (db) => ({
  nowMs: NOW, config: CONFIG, products: PRODUCTS,
  targets: db.state.root.stock_targets || {},
  stock: db.state.root.stock || {},
  openIndex: db.state.root.refill_engine?.open || {},
  refillRequests: db.state.root.refill_requests || {},
  orders: {}, movements: [],
});
const intentsFor = (plan, dest, pid) => plan.intents.filter((i) => i.dest === dest && i.productId === pid);

// ── the open-request guard (creation) ────────────────────────────────────────
test("creation claims the SHOP request's engine lock, source Central, and a second fire changes nothing", async () => {
  const db = world();
  const r = await run(db);
  assert.equal(r.lock.claimed, true);
  const lock = lockAt(db, "trophy", "p1", "M");
  assert.equal(lock.source, "central");
  assert.equal(lock.refillId, "r1");
  assert.equal(lock.qty, 2);
  assert.ok(String(lock.runId).startsWith(FIRST_BATCH_RUN_PREFIX), "stamped as this solve's own leg");
  assert.equal(db.state.root.refill_requests.r1.firstBatch.lock.claimedAt, T1);
  const before = JSON.stringify(db.state.root);
  await run(db, "r1", "2026-09-17T10:05:00.000Z");
  assert.equal(JSON.stringify(db.state.root), before, "idempotent: no second claim, no re-stamp");
  assert.equal(hubRequests(db).length, 0, "an open, untouched shop request raises NO Hub 2 leg");
});

test("with the shop lock the engine proposes NO hub2->shop while the request is open, and no hub2<-central either", async () => {
  const db = world();
  await run(db);
  const plan = computeRefillPlan(snapshot(db));
  assert.equal(intentsFor(plan, "trophy", "p1").length, 0, "the shop's row is inbound");
  assert.equal(intentsFor(plan, "hub2", "p1").length, 0, "Hub 2 has no cell — the engine cannot ask for it");
  assert.equal(plan.closes.filter((c) => c.dest === "trophy" && c.pid === "p1").length, 0, "the engine keeps the lock as a live request");
});

// ── the deferred leg ─────────────────────────────────────────────────────────
test("fulfil raises EXACTLY ONE Hub 2 request, sized from Central's remainder, with lock + seed + marker; a retry yields one", async () => {
  const db = world({ stock: { central: { p1: { M: cell(2) } }, trophy: { p1: { M: cell(2) } } } });   // 2 of 4 already sent
  await run(db);   // creation (claims the shop lock)
  db.state.root.refill_requests.r1 = { ...db.state.root.refill_requests.r1, status: "fulfilled", resolvedAt: T1 };
  const r = await run(db);
  assert.equal(r.raised, true);
  const hubs = hubRequests(db);
  assert.equal(hubs.length, 1);
  const [key, hr] = hubs[0];
  assert.notEqual(key, "r1", "the Hub 2 leg has its own id");
  assert.equal(hr.qty, 2, "hub2 target 3 capped by Central's remaining 2");
  assert.equal(hr.status, "open");
  assert.equal(hr.createdFrom.source, "central");
  assert.equal(hr.createdFrom.shopRequestId, "r1");
  assert.equal(hr.productId, "p1");
  const lock = lockAt(db, "hub2", "p1", "M");
  assert.equal(lock.refillId, key);
  assert.equal(lock.qty, 2);
  assert.equal(lock.pending, undefined, "finalised, never left pending");
  assert.deepEqual({ ...db.state.root.stock.hub2.p1.M, updatedAt: null }, { ...seed(), updatedAt: null, updatedBy: "first_batch" });
  assert.equal(db.state.root.refill_requests.r1.firstBatch.hub2Leg.refillId, key);
  const before = JSON.stringify(db.state.root);
  const again = await run(db, "r1", "2026-09-17T11:00:00.000Z");
  assert.equal(again.skipped, "hub2_leg_done");
  assert.equal(JSON.stringify(db.state.root), before, "double fire / retry: byte-identical");
  assert.equal(hubRequests(db).length, 1);
});

test("the Hub 2 target comes from the REAL resolveTarget — an explicit Hub 2 row outranks the run", async () => {
  const db = world({
    stock: { central: { p1: { M: cell(10) } }, trophy: { p1: { M: cell(2) } } },
    stock_targets: { hub2: { p1: { M: { target: 5, minQty: 2 } } } },
    refill_requests: { r1: shopReq({ status: "fulfilled" }) },
  });
  const r = await run(db);
  assert.equal(r.qty, 5, "explicit row 5, not the run's 3");
});

test("a PARTIAL send raises it, sized after the shop's remainder that Central still owes", async () => {
  // asked 2, sent 1 → qty 1 remains open; Central had 4, now 3.
  const db = world({
    stock: { central: { p1: { M: cell(3) } }, trophy: { p1: { M: cell(1) } } },
    refill_requests: { r1: shopReq({ qty: 1, sentQty: 1 }) },
  });
  const r = await run(db);
  assert.equal(r.raised, true);
  assert.equal(hubRequests(db)[0][1].qty, 2, "min(target 3, Central 3 − the shop's open 1)");
  assert.equal(db.state.root.refill_requests.r1.status, "open", "the shop's row stays open for its remainder");
});

test("a CANCEL (Out of Stock, no cancelReason) raises Hub 2's leg immediately", async () => {
  const db = world({ refill_requests: { r1: shopReq({ status: "cancelled", resolvedAt: T1, rejectedBy: "warehouse" }) } });
  const r = await run(db);
  assert.equal(r.raised, true);
  assert.equal(hubRequests(db)[0][1].qty, 3, "nothing was sent — Central still has all 4, target 3");
});

test("Central EMPTY → no request, a none:central_empty record, the seed lands, and the normal engine takes over", async () => {
  const db = world({
    stock: { central: { p1: { M: cell(0) } }, trophy: { p1: { M: cell(2) } } },
    refill_requests: { r1: shopReq({ status: "fulfilled" }) },
  });
  const r = await run(db);
  assert.equal(r.raised, false);
  assert.equal(r.none, "central_empty");
  assert.equal(hubRequests(db).length, 0, "never an empty request");
  assert.equal(lockAt(db, "hub2", "p1", "M"), null);
  assert.equal(db.state.root.stock.hub2.p1.M.mv, "seed", "Hub 2 now carries the size");
  assert.equal(db.state.root.refill_requests.r1.firstBatch.hub2Leg.none, "central_empty");
  // The engine: nothing to pick while Central is empty…
  assert.equal(intentsFor(computeRefillPlan(snapshot(db)), "hub2", "p1").length, 0);
  // …and the ordinary hub2<-central request the moment Central restocks.
  db.state.root.stock.central.p1.M = cell(5);
  const later = intentsFor(computeRefillPlan(snapshot(db)), "hub2", "p1");
  assert.equal(later.length, 1);
  assert.equal(later[0].source, "central");
  assert.equal(later[0].qty, 3);
});

test("the engine already holds the Hub 2 lock → NO second request; the demand is recorded as deferred to it", async () => {
  const db = world({
    refill_requests: {
      r1: shopReq({ status: "fulfilled" }),
      eng1: { productId: "p1", size: "M", qty: 3, requestingLocation: "hub2", status: "open", createdAt: T1, createdFrom: { engine: true, runId: "scan-1", source: "central" } },
    },
    refill_engine: { open: { hub2: { p1: { M: { qty: 3, source: "central", createdAt: T1, runId: "scan-1", refillId: "eng1" } } } } },
    stock: { central: { p1: { M: cell(2) } }, trophy: { p1: { M: cell(2) } }, hub2: { p1: { M: seed() } } },
  });
  const r = await run(db);
  assert.equal(r.raised, false);
  assert.equal(r.deferredTo, "engine");
  assert.equal(r.refillId, "eng1");
  assert.equal(hubRequests(db).length, 1, "the engine's own request stands alone");
  assert.equal(lockAt(db, "hub2", "p1", "M").refillId, "eng1", "the engine's lock is untouched");
});

test("after our raise the REAL engine proposes no further hub2 intent and keeps our lock as its own", async () => {
  const db = world({ stock: { central: { p1: { M: cell(2) } }, trophy: { p1: { M: cell(2) } } }, refill_requests: { r1: shopReq({ status: "fulfilled" }) } });
  await run(db);
  const plan = computeRefillPlan(snapshot(db));
  assert.equal(intentsFor(plan, "hub2", "p1").length, 0, "inbound from our lock covers the deficit");
  assert.equal(plan.closes.filter((c) => c.dest === "hub2" && c.pid === "p1").length, 0, "not withdrawn, not orphaned");
  const rz = (plan.resizes || []).filter((x) => x.dest === "hub2" && x.pid === "p1");
  assert.equal(rz.length, 0, "already sized exactly as the engine would size it");
});

test("PARTIAL: once Hub 2 holds its batch, the engine still raises NO hub2->shop while the shop's Central request is open — and the lock is what holds it", async () => {
  const db = world({
    stock: { central: { p1: { M: cell(3) } }, trophy: { p1: { M: cell(1) } } },
    refill_requests: { r1: shopReq() },
  });
  await run(db);                                                        // creation → shop lock
  db.state.root.refill_requests.r1 = { ...db.state.root.refill_requests.r1, qty: 1, sentQty: 1 };
  await run(db);                                                        // partial → Hub 2 leg
  // Central fulfils Hub 2's leg: stock lands, its request closes, its lock goes.
  const [hubKey] = hubRequests(db)[0];
  db.state.root.stock.hub2.p1.M = cell(2);
  db.state.root.refill_requests[hubKey].status = "fulfilled";
  delete db.state.root.refill_engine.open.hub2;
  const plan = computeRefillPlan(snapshot(db));
  assert.equal(intentsFor(plan, "trophy", "p1").length, 0, "the shop's open Central request is inbound");
  // The proof the guard is load-bearing: without the lock the engine WOULD ask Hub 2.
  delete db.state.root.refill_engine.open.trophy;
  const unguarded = intentsFor(computeRefillPlan(snapshot(db)), "trophy", "p1");
  assert.equal(unguarded.length, 1);
  assert.equal(unguarded[0].source, "hub2");
});

test("after a later sell-out the shop asks HUB 2, never Central; Hub 2 asks Central exactly as before", async () => {
  const db = world({
    stock: { central: { p1: { M: cell(2) } }, trophy: { p1: { M: cell(2) } } },
    refill_requests: { r1: shopReq({ status: "fulfilled" }) },
  });
  await run(db);
  const [hubKey] = hubRequests(db)[0];
  // Central fulfils Hub 2 (2 units); both requests are closed and both locks gone.
  db.state.root.stock.hub2.p1.M = cell(2);
  db.state.root.stock.central.p1.M = cell(0);
  db.state.root.refill_requests[hubKey].status = "fulfilled";
  delete db.state.root.refill_engine;
  // The shop sells out.
  db.state.root.stock.trophy.p1.M = cell(0);
  const plan = computeRefillPlan(snapshot(db));
  const shop = intentsFor(plan, "trophy", "p1");
  assert.equal(shop.length, 1);
  assert.equal(shop[0].source, "hub2");
  assert.equal(shop[0].qty, 2);
  assert.ok(plan.intents.every((i) => !(i.source === "central" && (i.dest === "trophy" || i.dest === "marathon-pe"))), "no engine path ever sends a shop to Central");
  // Hub 2 below its buffer with Central restocked → hub2<-central as always.
  db.state.root.stock.central.p1.M = cell(9);
  const hub = intentsFor(computeRefillPlan(snapshot(db)), "hub2", "p1");
  assert.equal(hub.length, 1);
  assert.equal(hub[0].source, "central");
});

// ── the exits that must NOT raise anything ───────────────────────────────────
test("the Solve's own undo (cancelReason solve_undone) raises nothing and seeds nothing", async () => {
  const db = world({ refill_requests: { r1: shopReq({ status: "cancelled", cancelReason: SOLVE_UNDONE_REASON, resolvedAt: T1 }) } });
  const r = await run(db);
  assert.equal(r.none, "solve_undone");
  assert.equal(hubRequests(db).length, 0);
  assert.equal(db.state.root.stock.hub2, undefined, "Hub 2 was never seeded");
  assert.equal(db.state.root.refill_engine, undefined, "no lock of any kind");
});

test("a row without the firstBatch tag is ignored byte-for-byte (engine, holds, Missing Sneakers, pre-deploy state)", async () => {
  const db = world({
    refill_requests: {
      e1: { productId: "p1", size: "M", qty: 2, requestingLocation: "trophy", status: "fulfilled", createdAt: T1, createdFrom: { engine: true, source: "hub2" } },
      s1: { productId: "p1", size: "M", qty: 1, requestingLocation: "hub1", status: "fulfilled", createdAt: T1, createdFrom: { manual: true, source: "central", via: "missing_sneakers_pick" } },
    },
    // A PRE-DEPLOY Solve: Hub 2 and the shop seeded, no rows — must stay exactly so.
    stock: { central: { p1: { M: cell(4) } }, hub2: { p1: { M: seed() } }, trophy: { p1: { M: seed() } } },
  });
  const before = JSON.stringify(db.state.root);
  assert.equal((await run(db, "e1")).skipped, "not_first_batch");
  assert.equal((await run(db, "s1")).skipped, "not_first_batch");
  assert.equal((await run(db, "missing")).skipped, "request_gone");
  assert.equal(JSON.stringify(db.state.root), before);
});

test("Hub 2's own leg row never recurses into a leg of its own", async () => {
  const db = world({ stock: { central: { p1: { M: cell(2) } }, trophy: { p1: { M: cell(2) } } }, refill_requests: { r1: shopReq({ status: "fulfilled" }) } });
  await run(db);
  const [hubKey] = hubRequests(db)[0];
  db.state.root.refill_requests[hubKey].status = "fulfilled";
  const before = JSON.stringify(db.state.root);
  assert.equal((await run(db, hubKey)).skipped, "hub_leg");
  assert.equal(JSON.stringify(db.state.root), before);
});

// ── data realities ───────────────────────────────────────────────────────────
test("empty-array children are DELETED like the real RTDB: an [] Hub 2 row and an [] lock table read as absent", async () => {
  const db = world({
    stock: { central: { p1: { M: cell(2) } }, trophy: { p1: { M: cell(2) } }, hub2: { p1: [] } },
    refill_engine: { open: { hub2: [] } },
    refill_requests: { r1: shopReq({ status: "fulfilled" }) },
  });
  assert.equal(db.state.root.stock.hub2, undefined, "the fake dropped the empty array on the way in");
  assert.equal(db.state.root.refill_engine, undefined);
  const r = await run(db);
  assert.equal(r.raised, true);
  assert.equal(r.seeded, true, "an [] row is no row — the seed is written");
  assert.equal(lockAt(db, "hub2", "p1", "M").refillId, r.refillId);
});

test("duplicate-name twins stay separate — one leg per productId, sized from each twin's own Central cell", async () => {
  const db = world({
    stock: { central: { p1: { M: cell(2) }, p2: { M: cell(1) } }, trophy: { p1: { M: cell(2) } }, "marathon-pe": { p2: { M: cell(2) } } },
    refill_requests: {
      r1: shopReq({ status: "fulfilled" }),
      r2: shopReq({ productId: "p2", requestingLocation: "marathon-pe", status: "fulfilled", createdFrom: { firstBatch: true, solveId: "fb_p2_xyz", source: "central", store: "marathon-pe", hub: "hub2" } }),
    },
  });
  await run(db, "r1"); await run(db, "r2");
  const hubs = hubRequests(db);
  assert.equal(hubs.length, 2);
  const byPid = Object.fromEntries(hubs.map(([, r]) => [r.productId, r]));
  assert.equal(byPid.p1.qty, 2);
  assert.equal(byPid.p2.qty, 1);
  assert.ok(lockAt(db, "hub2", "p1", "M") && lockAt(db, "hub2", "p2", "M"));
  assert.notEqual(lockAt(db, "hub2", "p1", "M").runId, lockAt(db, "hub2", "p2", "M").runId);
});

test("leg ids differ and are repeat-safe: the shop leg, Hub 2's leg and both locks have distinct identities; three runs = one run", async () => {
  const db = world({ stock: { central: { p1: { M: cell(2) } }, trophy: { p1: { M: cell(2) } } } });
  await run(db);   // open → shop lock
  db.state.root.refill_requests.r1.status = "fulfilled";
  await run(db);
  const after1 = JSON.stringify(db.state.root);
  await run(db, "r1", "2026-09-17T12:00:00.000Z");
  await run(db, "r1", "2026-09-17T13:00:00.000Z");
  assert.equal(JSON.stringify(db.state.root), after1);
  const [hubKey] = hubRequests(db)[0];
  assert.notEqual(hubKey, "r1");
  const shopLock = lockAt(db, "trophy", "p1", "M"), hubLock = lockAt(db, "hub2", "p1", "M");
  assert.notEqual(shopLock.refillId, hubLock.refillId);
  assert.equal(shopLock.runId, hubLock.runId, "one solve, two legs — same solve identity on both");
});

test("RACE: a lock that lands between the pre-read and the claim still means ONE request (the claim's own answer is trusted, never the earlier read)", async () => {
  const LOCK = "refill_engine/open/hub2/p1/M";
  let reads = 0;
  const db = makeFakeDb({
    config: { refillEngine: CONFIG }, products: PRODUCTS,
    stock: { central: { p1: { M: cell(2) } }, trophy: { p1: { M: cell(2) } } },
    refill_requests: { r1: shopReq({ status: "fulfilled" }), eng1: { productId: "p1", size: "M", qty: 3, requestingLocation: "hub2", status: "open", createdAt: T1, createdFrom: { engine: true, source: "central" } } },
  }, {
    // The lock path is read three times: the pre-read, the reservation walk,
    // and the claim transaction itself. A scan claims the cell just before the
    // THIRD — after both reads said "free".
    beforeRead: async (path, state) => {
      if (path !== LOCK) return;
      reads += 1;
      if (reads === 3) {
        state.root.refill_engine = { open: { hub2: { p1: { M: { qty: 3, source: "central", createdAt: T1, runId: "scan-9", refillId: "eng1" } } } } };
      }
    },
  });
  const r = await run(db);
  assert.equal(reads, 3, "pre-read, reservation walk, claim — the injected lock was seen by the claim alone");
  assert.equal(r.raised, false);
  assert.equal(r.deferredTo, "engine");
  assert.equal(hubRequests(db).length, 1, "the engine's request stands alone");
  assert.equal(lockAt(db, "hub2", "p1", "M").refillId, "eng1");
  assert.equal(db.state.root.refill_requests.r1.firstBatch.hub2Leg.deferredTo, "engine");
});

// ── the two HIGH findings of the PR #607 architect review ────────────────────
test("a real quantity landing in Hub 2's cell between the read and the seed is NEVER overwritten (seed is create-if-absent)", async () => {
  const SEED = "stock/hub2/p1/M";
  let injected = false;
  const db = makeFakeDb({
    config: { refillEngine: CONFIG }, products: PRODUCTS,
    stock: { central: { p1: { M: cell(2) } }, trophy: { p1: { M: cell(2) } } },
    refill_requests: { r1: shopReq({ status: "fulfilled" }) },
  }, {
    // The pre-read saw no Hub 2 row; a fulfil for another request lands 4
    // units in that very cell just before the seed transaction runs.
    beforeRead: async (path, state) => {
      if (path !== SEED || injected) return;
      injected = true;
      state.root.stock.hub2 = { p1: { M: { qty: 4, v: 3, mv: "other-fulfil", lastType: "transfer_in" } } };
    },
  });
  const r = await run(db);
  assert.equal(injected, true, "the race was exercised");
  assert.equal(r.raised, true, "the leg is still raised — the cell is simply not ours to write");
  assert.deepEqual(db.state.root.stock.hub2.p1.M, { qty: 4, v: 3, mv: "other-fulfil", lastType: "transfer_in" }, "the 4 real units survive");
  // same race on the central-empty branch
  const db2 = makeFakeDb({
    config: { refillEngine: CONFIG }, products: PRODUCTS,
    stock: { central: { p1: { M: cell(0) } }, trophy: { p1: { M: cell(2) } } },
    refill_requests: { r1: shopReq({ status: "fulfilled" }) },
  }, { beforeRead: async (path, state) => { if (path === SEED && !state.root.stock.hub2) state.root.stock.hub2 = { p1: { M: cell(4) } }; } });
  await run(db2);
  assert.equal(db2.state.root.stock.hub2.p1.M.qty, 4);
  assert.equal(db2.state.root.refill_requests.r1.firstBatch.hub2Leg.none, "central_empty");
});

test("a crash between the seed and the marker leaves a seed with no marker — the next fire finishes with exactly one request; never a marker with no seed", async () => {
  const db = world({ stock: { central: { p1: { M: cell(2) } }, trophy: { p1: { M: cell(2) } } }, refill_requests: { r1: shopReq({ status: "fulfilled" }) } });
  // First fire: the atomic request+lock+marker update throws (network drop).
  const realRef = db.ref.bind(db);
  let boom = true;
  db.ref = (p) => {
    const r = realRef(p);
    if ((p === undefined || p === "") && boom) { const u = r.update.bind(r); r.update = async (x) => { boom = false; throw new Error("network"); }; void u; }
    return r;
  };
  await assert.rejects(() => run(db), /network/);
  assert.equal(db.state.root.stock.hub2.p1.M.mv, "seed", "the seed landed before the crash");
  assert.equal(db.state.root.refill_requests.r1.firstBatch?.hub2Leg, undefined, "no marker — nothing claims 'done'");
  assert.equal(hubRequests(db).length, 0);
  const pending = lockAt(db, "hub2", "p1", "M");
  assert.equal(pending.pending, true, "our claimed lock is still pending");
  // The re-fire (the trigger's retry) completes it: one request, lock finalised, marker written.
  const r = await run(db, "r1", "2026-09-17T10:01:00.000Z");
  assert.equal(r.raised, true);
  assert.equal(hubRequests(db).length, 1);
  assert.equal(lockAt(db, "hub2", "p1", "M").refillId, hubRequests(db)[0][0]);
  assert.equal(db.state.root.refill_requests.r1.firstBatch.hub2Leg.refillId, hubRequests(db)[0][0]);
  // and a third fire is a no-op
  const after = JSON.stringify(db.state.root);
  await run(db, "r1", "2026-09-17T10:02:00.000Z");
  assert.equal(JSON.stringify(db.state.root), after);
});

test("Central's Out of Stock on the shop's batch is stamped as a withdrawal — the engine learns no shop-level cooldown, and the shop's later Hub 2 refill is not parked", async () => {
  const db = world({ refill_requests: { r1: shopReq({ status: "cancelled", resolvedAt: T1, rejectedBy: "warehouse" }) } });
  // (the shop lock exists from creation)
  db.state.root.refill_engine = { open: { trophy: { p1: { M: { qty: 2, source: "central", createdAt: T1, runId: `${FIRST_BATCH_RUN_PREFIX}${SOLVE}`, refillId: "r1" } } } } };
  const r = await run(db);
  assert.equal(r.raised, true, "Hub 2's leg is raised immediately on the cancel");
  assert.equal(db.state.root.refill_requests.r1.cancelReason, "first_batch_central_declined");
  // The REAL engine's reconcile: the shop lock closes as a plain cancel — no humanReject, no retry/streak op.
  const plan = computeRefillPlan(snapshot(db));
  const close = plan.closes.find((c) => c.dest === "trophy" && c.pid === "p1");
  assert.ok(close, "the lock is closed");
  assert.equal(close.humanReject, undefined, "not a human rejection");
  assert.equal((plan.retryOps || []).filter((o) => o.dest === "trophy" && o.pid === "p1").length, 0, "no 24h retry state for the shop's cell");
  // …and once Hub 2 holds its batch (locks gone), the shop's refill from Hub 2 is proposed at once.
  const [hubKey] = hubRequests(db)[0];
  db.state.root.refill_requests[hubKey].status = "fulfilled";
  db.state.root.stock.hub2.p1.M = cell(3);
  delete db.state.root.refill_engine;
  const later = intentsFor(computeRefillPlan(snapshot(db)), "trophy", "p1");
  assert.equal(later.length, 1);
  assert.equal(later[0].source, "hub2");
  // CONTRAST (the reason the stamp exists): the same cancel WITHOUT the stamp is a human "no" with a retry op.
  const db2 = world({ refill_requests: { r1: shopReq({ status: "cancelled", resolvedAt: T1 }) } });
  db2.state.root.refill_engine = { open: { trophy: { p1: { M: { qty: 2, source: "central", createdAt: T1, runId: "x", refillId: "r1" } } } } };
  const plan2 = computeRefillPlan(snapshot(db2));
  assert.equal(plan2.closes.find((c) => c.dest === "trophy" && c.pid === "p1").humanReject, true);
  assert.ok((plan2.retryOps || []).some((o) => o.dest === "trophy" && o.pid === "p1" && o.op === "reject"));
});

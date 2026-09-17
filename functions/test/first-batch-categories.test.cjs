// ─── FIRST BATCH, EVERY CATEGORY — mapped categories, explicit rows, perfume, one-size ─
// Owner rule 2026-09-17: everything except sneakers and slides takes the
// first-batch path, with its own shop policy and Hub 2 policy used as they
// are. PR #607 had left the MAPPED categories (bags, belts, caps & beanies,
// fitted caps, gloves, perfumes, soccer jerseys, sunglasses, underwear) and
// explicit-row products on the old path because the engine manages Hub 2 for
// them with no cell. These tests drive the REAL trigger core over the fake
// RTDB and the REAL computeRefillPlan over the resulting tree, for exactly
// those products: the number the engine would propose is the number asserted.
// Run: cd functions && node --test test/first-batch-categories.test.cjs
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { processFirstBatchRequest, FIRST_BATCH_RUN_PREFIX } = require("../lib/first-batch.cjs");
const { computeRefillPlan, resolveTarget } = require("../lib/refill-engine.cjs");

const NOW = Date.parse("2026-09-17T10:00:00.000Z");
const T1 = "2026-09-17T10:00:00.000Z";
// The LIVE map shapes (read 2026-09-17 18:16Z): one-size legs for bags /
// perfumes, a perSize leg for belts. Letter runs as live for the sized shops.
const CONFIG = {
  enabled: true,
  mode: { hub1: "live", hub2: "live", trophy: "live", "marathon-pe": "live" },
  routes: { hub1: "central", hub2: "central", trophy: "hub2", "marathon-pe": "hub2" },
  ruleBasedTargets: true, maxUnitsPerIntent: 20, maxIntentsPerRun: 200, staleIntentHours: 48,
  defaultRunByStore: { hub2: { S: 2, M: 3, L: 3 }, trophy: { S: 2, M: 2, L: 2 }, "marathon-pe": { S: 2, M: 2, L: 1 } },
  categoryPolicy: {
    bags: { hub2: { target: 4, minQty: 2 }, trophy: { target: 2, minQty: 1 } },
    belts: { perSize: true, hub2: { target: 5, minQty: 2 }, trophy: { target: 1, minQty: 1 } },
    perfumes: { hub2: { target: 10, minQty: 5 }, "marathon-pe": { target: 8, minQty: 4 } },
  },
};
const PRODUCTS = {
  // bag1 and bag2 are DUPLICATE-NAME twins — every assertion keys by id.
  bag1: { id: "bag1", name: "Gym Bag", productType: "clothing", categoryKey: "bags", sizes: ["_"] },
  bag2: { id: "bag2", name: "Gym Bag", productType: "clothing", categoryKey: "bags", sizes: ["_"] },
  belt1: { id: "belt1", name: "Belt", productType: "clothing", categoryKey: "belts", sizes: ["S", "M", "L"] },
  pf1: { id: "pf1", name: "Sauvage", categoryKey: "perfumes", sizes: ["_"] },                 // no productType, as live
  tee1: { id: "tee1", name: "Essentials Tee", productType: "clothing", categoryKey: "t-shirts", sizes: ["M", "L"] },
};
const cell = (qty) => ({ qty, v: 1, mv: "m", lastType: "received" });
const seed = () => ({ qty: 0, v: 0, mv: "seed", lastType: "count", state: "live" });
const req = (pid, size, store, qty, over = {}) => ({
  productId: pid, size, qty, requestingLocation: store, status: "open",
  createdAt: "2026-09-17T09:00:00.000Z",
  createdFrom: { firstBatch: true, solveId: `fb_${pid}_abc`, source: "central", store, hub: "hub2" },
  ...over,
});
function world(over = {}) {
  return makeFakeDb({ config: { refillEngine: CONFIG }, products: PRODUCTS, ...over });
}
const run = (db, id = "r1", nowIso = T1) => processFirstBatchRequest({ db, requestId: id, nowIso, pathEnabled: true });   // the path itself; live default OFF
const hubRequests = (db, pid) => Object.entries(db.state.root.refill_requests || {}).filter(([, r]) => r.requestingLocation === "hub2" && (!pid || r.productId === pid));
const lockAt = (db, loc, pid, sk) => db.state.root.refill_engine?.open?.[loc]?.[pid]?.[sk] ?? null;
const snapshot = (db, config = CONFIG) => ({
  nowMs: NOW, config, products: PRODUCTS,
  targets: db.state.root.stock_targets || {},
  stock: db.state.root.stock || {},
  openIndex: db.state.root.refill_engine?.open || {},
  refillRequests: db.state.root.refill_requests || {},
  orders: {}, movements: [],
});
const intentsFor = (plan, dest, pid) => plan.intents.filter((i) => i.dest === dest && i.productId === pid);

// ── each newly included class takes the path, sized by ITS policy ────────────
test("bags (one-size map, hub2 4 / trophy 2): fulfil raises ONE Hub 2 request for '_' sized by the MAP, seed + lock, and the engine proposes nothing more", async () => {
  const db = world({
    stock: { central: { bag1: { _: cell(10) } }, trophy: { bag1: { _: cell(2) } } },
    refill_requests: { r1: req("bag1", "_", "trophy", 2, { status: "fulfilled" }) },
  });
  const res = await run(db);
  assert.equal(res.raised, true);
  const hubs = hubRequests(db, "bag1");
  assert.equal(hubs.length, 1);
  const [key, hr] = hubs[0];
  assert.equal(hr.qty, 4, "Hub 2's map target, Central has 10");
  assert.equal(hr.size, "_");
  assert.equal(hr.requestingLocation, "hub2");
  assert.deepEqual(db.state.root.stock.hub2.bag1._ , { ...seed(), updatedAt: T1, updatedBy: "first_batch" });
  assert.equal(lockAt(db, "hub2", "bag1", "_").refillId, key);
  assert.equal(db.state.root.refill_requests.r1.firstBatch.hub2Leg.refillId, key);
  // The REAL engine: our lock is inbound — no second hub2 intent; the shop holds its map target — no trophy intent.
  const plan = computeRefillPlan(snapshot(db));
  assert.equal(intentsFor(plan, "hub2", "bag1").length, 0);
  assert.equal(intentsFor(plan, "trophy", "bag1").length, 0);
  // a retry changes nothing
  const before = JSON.stringify(db.state.root);
  await run(db, "r1", "2026-09-17T11:00:00.000Z");
  assert.equal(JSON.stringify(db.state.root), before);
});

test("belts (perSize map, hub2 5): the leg for M is sized by the map; a size with ZERO units anywhere is dead to the map (not this request's business)", async () => {
  const db = world({
    stock: { central: { belt1: { M: cell(3), S: cell(0) } }, trophy: { belt1: { M: cell(1), S: seed() } } },
    refill_requests: { r1: req("belt1", "M", "trophy", 1, { status: "fulfilled" }) },
  });
  const res = await run(db);
  assert.equal(res.raised, true);
  assert.equal(res.qty, 3, "min(map 5 − 0, Central 3, cap 20)");
  // the real resolver over the tree the trigger left behind: M armed at 5, S dead at 0
  const ctx = { config: CONFIG, products: PRODUCTS, stock: db.state.root.stock, targets: {} };
  assert.equal(resolveTarget(ctx, "hub2", "belt1", "M").target, 5);
  assert.equal(resolveTarget({ ...ctx, stock: { ...ctx.stock, hub2: { belt1: { S: seed() } } } }, "hub2", "belt1", "S").target, 0);
  assert.equal(intentsFor(computeRefillPlan(snapshot(db)), "hub2", "belt1").length, 0);
});

test("perfume (not clothing to the engine; one-size map hub2 10 / PE 8): fulfil at Marathon PE raises Hub 2's 10, and the engine adds nothing", async () => {
  const db = world({
    stock: { central: { pf1: { _: cell(12) } }, "marathon-pe": { pf1: { _: cell(8) } } },
    refill_requests: { r1: req("pf1", "_", "marathon-pe", 8, { status: "fulfilled" }) },
  });
  const res = await run(db);
  assert.equal(res.raised, true);
  assert.equal(res.qty, 10);
  const plan = computeRefillPlan(snapshot(db));
  assert.equal(intentsFor(plan, "hub2", "pf1").length, 0);
  assert.equal(intentsFor(plan, "marathon-pe", "pf1").length, 0);
});

test("an explicit Hub 2 row IS Hub 2's policy: the leg is sized by the row (6), not the run (3)", async () => {
  const db = world({
    stock: { central: { tee1: { M: cell(9) } }, trophy: { tee1: { M: cell(2) } } },
    stock_targets: { hub2: { tee1: { M: { target: 6, minQty: 3 } } } },
    refill_requests: { r1: req("tee1", "M", "trophy", 2, { status: "fulfilled" }) },
  });
  const res = await run(db);
  assert.equal(res.qty, 6);
  assert.equal(intentsFor(computeRefillPlan(snapshot(db)), "hub2", "tee1").length, 0);
});

test("Hub 2's target for a mapped category comes from the LIVE map: with the map gone, no target → seed only, no request, the marker says so", async () => {
  const db = world({
    config: { refillEngine: { ...CONFIG, categoryPolicy: {} } },
    stock: { central: { bag1: { _: cell(10) } }, trophy: { bag1: { _: cell(2) } } },
    refill_requests: { r1: req("bag1", "_", "trophy", 2, { status: "fulfilled" }) },
  });
  const res = await run(db);
  assert.equal(res.raised, false);
  assert.equal(res.none, "no_hub2_target");
  assert.equal(hubRequests(db, "bag1").length, 0);
  assert.ok(db.state.root.stock.hub2.bag1._, "the seed still lands so the engine takes over when a policy returns");
});

// ── exactly ONE Hub 2 request for a mapped category, whoever got there first ──
test("the ENGINE got there first (a mapped product is managed at Hub 2 with no cell): the trigger defers, no second request, and the engine proposes none", async () => {
  const db = world({
    stock: { central: { bag1: { _: cell(10) } }, trophy: { bag1: { _: cell(2) } } },
    refill_engine: { open: { hub2: { bag1: { _: { qty: 4, source: "central", createdAt: T1, runId: "scan-7", refillId: "eng1" } } } } },
    refill_requests: {
      r1: req("bag1", "_", "trophy", 2, { status: "fulfilled" }),
      eng1: { productId: "bag1", size: "_", qty: 4, requestingLocation: "hub2", status: "open", createdAt: T1, createdFrom: { engine: true, runId: "scan-7", source: "central" } },
    },
  });
  const res = await run(db);
  assert.equal(res.raised, false);
  assert.equal(res.deferredTo, "engine");
  assert.equal(res.refillId, "eng1");
  assert.equal(hubRequests(db, "bag1").length, 1, "the engine's own, and only that");
  assert.equal(lockAt(db, "hub2", "bag1", "_").refillId, "eng1", "the engine's lock is untouched");
  assert.deepEqual(db.state.root.refill_requests.r1.firstBatch.hub2Leg.deferredTo, "engine");
  const plan = computeRefillPlan(snapshot(db));
  assert.equal(intentsFor(plan, "hub2", "bag1").length, 0);
});

test("the TRIGGER got there first: the scan that follows finds our lock inbound and proposes no hub2<-central for the mapped product (proved by removing the lock)", async () => {
  const db = world({
    stock: { central: { bag1: { _: cell(10) } }, trophy: { bag1: { _: cell(2) } } },
    refill_requests: { r1: req("bag1", "_", "trophy", 2, { status: "fulfilled" }) },
  });
  await run(db);
  assert.equal(intentsFor(computeRefillPlan(snapshot(db)), "hub2", "bag1").length, 0);
  // Without our lock the engine WOULD ask — the map manages Hub 2 regardless of the cell.
  delete db.state.root.refill_engine.open.hub2;
  const unguarded = intentsFor(computeRefillPlan(snapshot(db)), "hub2", "bag1");
  assert.equal(unguarded.length, 1);
  assert.equal(unguarded[0].source, "central");
  assert.equal(unguarded[0].qty, 4);
});

test("a crash after the seed and before the atomic update, then a re-fire: still exactly one Hub 2 request for the mapped product", async () => {
  let crashed = false;
  const db = makeFakeDb(
    { config: { refillEngine: CONFIG }, products: PRODUCTS, stock: { central: { bag1: { _: cell(10) } }, trophy: { bag1: { _: cell(2) } } }, refill_requests: { r1: req("bag1", "_", "trophy", 2, { status: "fulfilled" }) } },
    { afterWrite: async (path) => { if (!crashed && path === "stock/hub2/bag1/_") { crashed = true; throw new Error("crash"); } } },
  );
  await assert.rejects(run(db), /crash/);
  assert.equal(hubRequests(db, "bag1").length, 0);
  assert.ok(db.state.root.stock.hub2.bag1._, "seed landed");
  assert.equal(db.state.root.refill_requests.r1.firstBatch?.hub2Leg, undefined, "no marker without a request");
  const res = await run(db, "r1", "2026-09-17T10:05:00.000Z");
  assert.equal(res.raised, true);
  assert.equal(hubRequests(db, "bag1").length, 1);
  assert.equal(intentsFor(computeRefillPlan(snapshot(db)), "hub2", "bag1").length, 0);
});

// ── Hub 2 presence at creation — THE INCIDENT'S RULE ─────────────────────────
test("Hub 2 ALREADY HOLDS the bag at creation: the shop's Central request is withdrawn (first_batch_hub2_present), no shop lock is claimed, and the REAL engine serves Trophy from Hub 2 — never from Central", async () => {
  const db = world({
    stock: { central: { bag1: { _: cell(6) } }, trophy: { bag1: { _: seed() } }, hub2: { bag1: { _: cell(4) } } },
    refill_requests: { r1: req("bag1", "_", "trophy", 2) },
  });
  const res = await run(db);
  assert.deepEqual(res, { raised: false, none: "hub2_present", withdrawn: true, signals: ["stock_cell"] });
  const r1 = db.state.root.refill_requests.r1;
  assert.equal(r1.status, "cancelled");
  assert.equal(r1.cancelReason, "first_batch_hub2_present");
  assert.equal(lockAt(db, "trophy", "bag1", "_"), null, "no shop lock, source central, ever");
  assert.equal(db.state.root.stock.hub2.bag1._.qty, 4, "Hub 2's units untouched");
  const plan = computeRefillPlan(snapshot(db));
  const shop = intentsFor(plan, "trophy", "bag1");
  assert.equal(shop.length, 1);
  assert.equal(shop[0].source, "hub2");
  assert.equal(shop[0].qty, 2);
  assert.ok(!plan.intents.some((i) => i.dest !== "hub2" && i.source === "central"), "no shop sources from Central");
  // the re-fire the cancel causes is a no-op
  const again = await run(db, "r1", "2026-09-17T10:05:00.000Z");
  assert.equal(again.skipped, "hub2_leg_done");
});

test("Hub 2 receives AFTER the shop lock was claimed (the request stood when Hub 2 held nothing): presence is judged ONCE, the request is not withdrawn, the engine raises NO hub2->trophy beside the open Central request, and the remainder comes from Hub 2 only once it has closed", async () => {
  const db = world({
    stock: { central: { bag1: { _: cell(1) } }, trophy: { bag1: { _: seed() } } },
    refill_requests: { r1: req("bag1", "_", "trophy", 1) },
  });
  await run(db);                                                    // creation: Hub 2 empty → shop lock, source central
  assert.equal(lockAt(db, "trophy", "bag1", "_").qty, 1);
  assert.equal(db.state.root.refill_requests.r1.status, "open");
  db.state.root.stock.hub2 = { bag1: { _: cell(4) } };              // Hub 2 receives its own batch
  const again = await run(db, "r1", "2026-09-17T10:05:00.000Z");
  assert.equal(again.skipped, "open_untouched");
  assert.equal(db.state.root.refill_requests.r1.status, "open", "judged once — a later Hub 2 arrival never withdraws a committed request");
  const plan = computeRefillPlan(snapshot(db));
  assert.equal(intentsFor(plan, "trophy", "bag1").length, 0, "no hub2->shop beside the open Central request");
  assert.ok(!plan.closes.some((c) => c.refillId === "r1"), "and the request is not withdrawn: Central can still supply its 1");
  // Central fulfils the 1; the request closes and its lock goes (the engine's fulfilled-close).
  db.state.root.stock.trophy.bag1._ = cell(1);
  db.state.root.stock.central.bag1._ = cell(0);
  db.state.root.refill_requests.r1.status = "fulfilled";
  delete db.state.root.refill_engine.open.trophy;
  const after = intentsFor(computeRefillPlan(snapshot(db)), "trophy", "bag1");
  assert.equal(after.length, 1);
  assert.equal(after[0].source, "hub2");
  assert.equal(after[0].qty, 1, "the remainder, from Hub 2, only now");
});

test("the ENGINE already holds the SHOP's lock at creation (structurally unreachable for a stranded card — no Hub 2 stock to serve it from): the claim is lost, recorded as heldBy, retried on the next write, and the engine's lock is never touched", async () => {
  const db = world({
    stock: { central: { bag1: { _: cell(6) } }, trophy: { bag1: { _: seed() } } },
    refill_engine: { open: { trophy: { bag1: { _: { qty: 2, source: "hub2", createdAt: T1, runId: "scan-3", refillId: "eng9" } } } } },
    refill_requests: { r1: req("bag1", "_", "trophy", 2), eng9: { productId: "bag1", size: "_", qty: 2, requestingLocation: "trophy", status: "open", createdAt: T1, createdFrom: { engine: true } } },
  });
  const res = await run(db);
  assert.deepEqual(res.lock, { claimed: false, heldBy: "scan-3" });
  assert.equal(lockAt(db, "trophy", "bag1", "_").refillId, "eng9");
  assert.deepEqual(db.state.root.refill_requests.r1.firstBatch.lock, { heldBy: "scan-3", refillId: "eng9", at: T1 });
  assert.equal(db.state.root.refill_requests.r1.firstBatch.lock.claimedAt, undefined, "a lost claim is never recorded as done");
  // the next write retries the claim (still lost while the engine holds it)
  const again = await run(db, "r1", "2026-09-17T10:05:00.000Z");
  assert.equal(again.lock.claimed, false);
});

// ── after the first batch: the normal route, exactly as before ───────────────
test("after a later sell-out the mapped shop asks HUB 2 (its map quantity), never Central; Hub 2 asks Central by ITS map", async () => {
  const db = world({
    stock: { central: { bag1: { _: cell(6) } }, trophy: { bag1: { _: cell(2) } } },
    refill_requests: { r1: req("bag1", "_", "trophy", 2, { status: "fulfilled" }) },
  });
  await run(db);
  const [hubKey] = hubRequests(db, "bag1")[0];
  // Central fulfils Hub 2's leg (4); both requests closed, locks gone; then Trophy sells out.
  db.state.root.stock.hub2.bag1._ = cell(4);
  db.state.root.stock.central.bag1._ = cell(2);
  db.state.root.refill_requests[hubKey].status = "fulfilled";
  delete db.state.root.refill_engine;
  db.state.root.stock.trophy.bag1._ = cell(0);
  const plan = computeRefillPlan(snapshot(db));
  const shop = intentsFor(plan, "trophy", "bag1");
  assert.equal(shop.length, 1);
  assert.equal(shop[0].source, "hub2");
  assert.equal(shop[0].qty, 2);
  assert.ok(plan.intents.every((i) => !(i.source === "central" && (i.dest === "trophy" || i.dest === "marathon-pe"))), "no engine path ever sends a shop to Central");
  // Hub 2 dips below its map (4 → 3 after the shop's pull): hub2<-central, as always.
  db.state.root.stock.hub2.bag1._ = cell(3);
  db.state.root.stock.central.bag1._ = cell(9);
  const hub = intentsFor(computeRefillPlan(snapshot(db)), "hub2", "bag1");
  assert.equal(hub.length, 1);
  assert.equal(hub[0].source, "central");
  assert.equal(hub[0].qty, 1);
});

// ── identity and the fake's delete semantics, for the one-size shape ─────────
test("duplicate-name one-size twins stay separate: one leg per productId, sized from each twin's own Central '_' cell", async () => {
  const db = world({
    stock: { central: { bag1: { _: cell(10) }, bag2: { _: cell(1) } }, trophy: { bag1: { _: cell(2) }, bag2: { _: cell(1) } } },
    refill_requests: { r1: req("bag1", "_", "trophy", 2, { status: "fulfilled" }), r2: req("bag2", "_", "trophy", 1, { status: "fulfilled", createdFrom: { firstBatch: true, solveId: "fb_bag2_abc", source: "central", store: "trophy", hub: "hub2" } }) },
  });
  await run(db, "r1");
  await run(db, "r2");
  const legs = hubRequests(db);
  assert.equal(legs.length, 2);
  const byPid = Object.fromEntries(legs.map(([, r]) => [r.productId, r.qty]));
  assert.deepEqual(byPid, { bag1: 4, bag2: 1 });
  assert.notEqual(lockAt(db, "hub2", "bag1", "_").runId, lockAt(db, "hub2", "bag2", "_").runId);
  assert.notEqual(lockAt(db, "hub2", "bag1", "_").refillId, lockAt(db, "hub2", "bag2", "_").refillId);
});

test("empty-array children are DELETED like the real RTDB: an [] Hub 2 row and an [] lock table for the one-size product read as absent, so the seed lands and the lock is claimed", async () => {
  const db = world({
    stock: { central: { bag1: { _: cell(10) } }, trophy: { bag1: { _: cell(2) } }, hub2: { bag1: [] } },
    refill_engine: { open: { hub2: { bag1: [] } } },
    refill_requests: { r1: req("bag1", "_", "trophy", 2, { status: "fulfilled" }) },
  });
  assert.equal(db.state.root.stock.hub2, undefined);
  assert.equal(db.state.root.refill_engine, undefined);
  const res = await run(db);
  assert.equal(res.raised, true);
  assert.equal(res.seeded, true);
  assert.ok(String(lockAt(db, "hub2", "bag1", "_").runId).startsWith(FIRST_BATCH_RUN_PREFIX));
});

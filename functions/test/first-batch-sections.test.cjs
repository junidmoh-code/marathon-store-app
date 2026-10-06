// ─── FIRST BATCH — THE HUB IS THE SHOP'S OWN, FROM THE REGISTRY ──────────────
// The trigger used to do everything at Hub 2. It now resolves the shop's
// back-stock hub from the network registry and does the same there. These
// tests drive the REAL trigger core over the fake RTDB:
//   • Section 2 resolves Hub 2, as it always was (first-batch*.test.cjs drive
//     the whole Hub 2 path and are unchanged);
//   • a LIVE Section 1 shop gets its leg at ITS hub (Hub 3, or the Concrete
//     Stockroom where the owner mapped the category), never at Hub 2;
//   • a shop or hub that is not live gets nothing at all.
// Run: cd functions && node --test test/first-batch-sections.test.cjs
"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { processFirstBatchRequest, hubForShop, FIRST_BATCH_HUB, NON_HUB_FLOW_KEYS, FIRST_BATCH_RUN_PREFIX } = require("../lib/first-batch.cjs");
const { normalizeNetwork, SEED_REGISTRY } = require("../lib/network-registry.cjs");
const { __resetNetworkCacheForTests } = require("../lib/network-load.cjs");

beforeEach(() => __resetNetworkCacheForTests());

const T1 = "2026-10-02T10:00:00.000Z";
const S1_LIVE = { locations: { "marathon-pine": { live: true }, concrete: { live: true }, hub3: { live: true }, "concrete-stockroom": { live: true } } };
const CONFIG = {
  enabled: true,
  mode: { hub1: "live", hub2: "live", hub3: "live", "concrete-stockroom": "live", trophy: "live", "marathon-pe": "live", "marathon-pine": "live", concrete: "live" },
  routes: { hub1: "central", hub2: "central", hub3: "central", "concrete-stockroom": "central", trophy: "hub2", "marathon-pe": "hub2", "marathon-pine": "hub3", concrete: "hub3" },
  ruleBasedTargets: true, maxUnitsPerIntent: 20, maxIntentsPerRun: 200, staleIntentHours: 48,
  defaultRunByStore: {
    hub2: { M: 3, L: 3 }, hub3: { M: 3, L: 3 }, "concrete-stockroom": { M: 3, L: 3 },
    trophy: { M: 2, L: 2 }, "marathon-pe": { M: 2, L: 2 }, "marathon-pine": { M: 2, L: 2 }, concrete: { M: 2, L: 2 },
  },
};
const PRODUCTS = {
  p1: { id: "p1", name: "Essentials Tee", productType: "clothing", categoryKey: "t-shirts", sizes: ["M", "L"] },
};
const cell = (qty) => ({ qty, v: 1, mv: "m", lastType: "received" });
const seed = () => ({ qty: 0, v: 0, mv: "seed", lastType: "count", state: "live" });
const shopReq = (store, over = {}) => ({
  productId: "p1", size: "M", qty: 2, requestingLocation: store, status: "open",
  createdAt: "2026-10-02T09:00:00.000Z",
  createdFrom: { firstBatch: true, solveId: `fb_p1_${store}`, source: "central", store, hub: "hub3" },
  ...over,
});
function world(store, { network = S1_LIVE, req = {}, extra = {} } = {}) {
  return makeFakeDb({
    ...(network ? { network } : {}),
    config: { refillEngine: CONFIG },
    products: PRODUCTS,
    stock: { central: { p1: { M: cell(6), L: cell(0) } }, [store]: { p1: { M: seed(), L: seed() } } },
    refill_requests: { r1: shopReq(store, req) },
    ...extra,
  });
}
const run = (db, id = "r1", nowIso = T1) => processFirstBatchRequest({ db, requestId: id, nowIso, pathEnabled: true });
const root = (db) => db.state.root;
const requestsAt = (db, loc) => Object.entries(root(db).refill_requests || {}).filter(([, r]) => r.requestingLocation === loc);
const lockAt = (db, loc) => root(db).refill_engine?.open?.[loc]?.p1?.M ?? null;
// Fulfil the shop's request the way Source does, then fire the trigger again.
async function fulfilAndFire(db) {
  await run(db);                                    // creation: the shop lock is claimed
  await db.ref("refill_requests/r1").update({ status: "fulfilled", sentQty: 2 });
  await db.ref("stock/central/p1/M/qty").set(4);
  return run(db);
}

test("the hub is the registry's answer: Hub 2 for Marathon PE and Trophy, Hub 3 for Pine and Concrete", () => {
  for (const store of ["marathon-pe", "trophy"]) {
    assert.equal(hubForShop(SEED_REGISTRY, store, PRODUCTS.p1, "p1"), FIRST_BATCH_HUB);
    assert.equal(hubForShop(SEED_REGISTRY, store, null, "p1"), "hub2");
    // sneakers and slides never take this path: their category's hub (Hub 1)
    // is never the answer here
    for (const categoryKey of NON_HUB_FLOW_KEYS) assert.equal(hubForShop(SEED_REGISTRY, store, { productType: "clothing", categoryKey }, "x"), "hub2");
    assert.equal(hubForShop(SEED_REGISTRY, store, { category: "Footwear", subcategory: "Sneakers" }, "x"), "hub2");
  }
  assert.deepEqual([...NON_HUB_FLOW_KEYS], ["sneakers", "slides"]);
  assert.equal(hubForShop(SEED_REGISTRY, "marathon-pine", PRODUCTS.p1, "p1"), "hub3");
  assert.equal(hubForShop(SEED_REGISTRY, "concrete", PRODUCTS.p1, "p1"), "hub3");
  // the owner flips a category, or one product, to the Concrete Stockroom
  const flipped = normalizeNetwork({ backStock: { concrete: { "t-shirts": "concrete-stockroom" } }, productOverrides: { concrete: { p9: "concrete-stockroom" } } });
  assert.equal(hubForShop(flipped, "concrete", PRODUCTS.p1, "p1"), "concrete-stockroom");
  assert.equal(hubForShop(flipped, "concrete", { categoryKey: "bags" }, "p2"), "hub3");
  assert.equal(hubForShop(flipped, "concrete", { categoryKey: "bags" }, "p9"), "concrete-stockroom");
  // …and it never reaches Pine, which the stockroom does not serve
  assert.equal(hubForShop(flipped, "marathon-pine", PRODUCTS.p1, "p1"), "hub3");
});

test("SECTION 2: a Trophy request is served at Hub 2 — seed, lock and leg at hub2, exactly as before", async () => {
  const db = world("trophy", { network: null, req: { createdFrom: { firstBatch: true, solveId: "fb_p1_trophy", source: "central", store: "trophy", hub: "hub2" } } });
  const res = await fulfilAndFire(db);
  assert.equal(res.raised, true);
  assert.equal(res.qty, 3);                          // Hub 2's target 3, Central has 4
  const [[, leg]] = requestsAt(db, "hub2");
  assert.deepEqual({ loc: leg.requestingLocation, qty: leg.qty, via: leg.createdFrom.via, store: leg.createdFrom.store }, { loc: "hub2", qty: 3, via: "first_batch_hub2_leg", store: "trophy" });
  assert.ok(root(db).stock.hub2.p1.M);
  assert.equal(lockAt(db, "hub2").runId, `${FIRST_BATCH_RUN_PREFIX}fb_p1_trophy`);
  assert.equal(root(db).stock.hub3, undefined);
  assert.equal(root(db).refill_engine.open.hub3, undefined);
});

test("SECTION 1, LIVE: a Pine request is served at Hub 3 — its seed, its lock and its leg are Hub 3's, and nothing is written at Hub 2", async () => {
  const db = world("marathon-pine");
  const first = await run(db);
  assert.deepEqual(first, { skipped: "open_untouched", lock: { claimed: true } });
  assert.equal(lockAt(db, "marathon-pine").source, "central");
  await db.ref("refill_requests/r1").update({ status: "fulfilled", sentQty: 2 });
  await db.ref("stock/central/p1/M/qty").set(4);
  const res = await run(db);
  assert.equal(res.raised, true);
  assert.equal(res.qty, 3);
  const legs = requestsAt(db, "hub3");
  assert.equal(legs.length, 1);
  assert.deepEqual(
    { qty: legs[0][1].qty, source: legs[0][1].createdFrom.source, store: legs[0][1].createdFrom.store, shop: legs[0][1].createdFrom.shopRequestId },
    { qty: 3, source: "central", store: "marathon-pine", shop: "r1" },
  );
  assert.equal(root(db).stock.hub3.p1.M.mv, "seed");
  assert.equal(lockAt(db, "hub3").refillId, legs[0][0]);
  assert.equal(root(db).refill_requests.r1.firstBatch.hub2Leg.refillId, legs[0][0]);   // the stored marker name is unchanged
  // THE WALL: nothing of Pine's is ever written at Hub 2
  assert.equal(root(db).stock.hub2, undefined);
  assert.equal(root(db).refill_engine.open.hub2, undefined);
  assert.equal(requestsAt(db, "hub2").length, 0);
});

test("SECTION 1, LIVE: Hub 3's own leg does not raise a leg of its own, and a re-fire raises no second one", async () => {
  const db = world("marathon-pine");
  await fulfilAndFire(db);
  const [[legId]] = requestsAt(db, "hub3");
  assert.deepEqual(await run(db, legId), { skipped: "hub_leg" });
  assert.equal((await run(db)).skipped, "hub2_leg_done");
  assert.equal(requestsAt(db, "hub3").length, 1);
});

test("SECTION 1, LIVE: Concrete's category flipped to the Concrete Stockroom — the leg is raised there, not at Hub 3", async () => {
  const network = { ...S1_LIVE, backStock: { concrete: { "t-shirts": "concrete-stockroom" } } };
  const db = world("concrete", { network });
  const res = await fulfilAndFire(db);
  assert.equal(res.raised, true);
  assert.equal(requestsAt(db, "concrete-stockroom").length, 1);
  assert.ok(root(db).stock["concrete-stockroom"].p1.M);
  assert.equal(requestsAt(db, "hub3").length, 0);
  assert.equal(root(db).stock.hub3, undefined);
  assert.equal(root(db).stock.hub2, undefined);
});

test("SECTION 1, LIVE: presence is judged at the shop's OWN hub — Hub 3 already holds it → withdrawn to the normal route; stock at Hub 2 is not presence for Pine", async () => {
  // Hub 2 holds the product: irrelevant to a Pine request.
  const elsewhere = world("marathon-pine", { extra: {} });
  await elsewhere.ref("stock/hub2/p1/M").set(cell(5));
  assert.deepEqual(await run(elsewhere), { skipped: "open_untouched", lock: { claimed: true } });
  // Hub 3 holds it: the shop is served from Hub 3, never from Central.
  const here = world("marathon-pine");
  await here.ref("stock/hub3/p1/M").set(cell(5));
  const res = await run(here);
  assert.equal(res.withdrawn, true);
  assert.deepEqual(res.signals, ["stock_cell"]);
  assert.equal(root(here).refill_requests.r1.status, "cancelled");
  assert.equal(root(here).refill_requests.r1.cancelReason, "first_batch_hub2_present");
  assert.equal(root(here).stock.hub2, undefined);
});

test("NOT LIVE: a Pine or Concrete request writes nothing at all — the seed registry holds Section 1 not live", async () => {
  for (const store of ["marathon-pine", "concrete"]) {
    __resetNetworkCacheForTests();
    const db = world(store, { network: null });
    const before = JSON.stringify(root(db));
    assert.deepEqual(await run(db), { skipped: "section_wall", store });
    assert.equal(JSON.stringify(root(db)), before);
  }
});

test("NOT LIVE: a live shop whose HUB is not live gets nothing either", async () => {
  const db = world("marathon-pine", { network: { locations: { "marathon-pine": { live: true } } } });
  const before = JSON.stringify(root(db));
  assert.deepEqual(await run(db), { skipped: "section_wall", store: "marathon-pine" });
  assert.equal(JSON.stringify(root(db)), before);
});

test("CENTRAL IS SHARED: a live Section 1 shop's open Central lock is a reservation when Hub 2's leg is sized, even where the routes do not name that shop", async () => {
  // The engine's routes do not name Pine; Pine holds an open first-batch lock
  // on 3 of Central's M (source central, stamped on the lock).
  const routes = { hub1: "central", hub2: "central", trophy: "hub2", "marathon-pe": "hub2" };
  const db = world("trophy", {
    req: { createdFrom: { firstBatch: true, solveId: "fb_p1_trophy", source: "central", store: "trophy", hub: "hub2" } },
    extra: {
      config: { refillEngine: { ...CONFIG, routes } },
      refill_engine: { open: { "marathon-pine": { p1: { M: { qty: 3, source: "central", createdAt: T1, runId: "first_batch:other", refillId: "rX" } } } } },
    },
  });
  await run(db);
  await db.ref("refill_requests/r1").update({ status: "fulfilled", sentQty: 2 });
  await db.ref("stock/central/p1/M/qty").set(4);
  const res = await run(db);
  // Central 4 − Pine's 3 = 1 free; Hub 2 wants 3 → 1.
  assert.equal(res.qty, 1);
});

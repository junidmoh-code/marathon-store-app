// ─── PAUSED LOCATIONS — Hub 3 recount (Junid, 6 Nov 2026) ─────────────────────
// /config/refillEngine/pausedLocations/hub3 = true holds Hub 3's share of every
// scan AS A DESTINATION: no new request there, nothing closed, resized or
// retried there. With the flag clear the plan
// is byte-identical to the plan without the feature.
// Run: cd functions && node --test test/paused-locations.test.cjs
"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");
const reg = require("../lib/network-registry.cjs");
const trust = require("../lib/stock-trust.cjs");
const pl = require("../lib/paused-locations.cjs");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { processFirstBatchRequest } = require("../lib/first-batch.cjs");
const { __resetNetworkCacheForTests } = require("../lib/network-load.cjs");
const FIXTURE = require("./fixtures/sections-routing-fixture.json");

beforeEach(() => __resetNetworkCacheForTests());

const NOW_MS = Date.parse("2026-11-06T10:00:00.000Z");
const T = "2026-11-06T08:00:00.000Z";
const clone = (v) => JSON.parse(JSON.stringify(v));
const trusted = (qty) => ({ qty, v: 1, mv: "m", lastType: "adjustment", ...trust.trustStamp("refill", T) });

// Hub 3 after the reset: every cell it holds reads 0 (positives and negatives alike).
function zeroedHub3Stock() {
  const stock = clone(FIXTURE.stock);
  for (const [pid, sizes] of Object.entries(stock.hub3 || {})) {
    for (const k of Object.keys(sizes || {})) stock.hub3[pid][k] = trusted(0);
  }
  return stock;
}
function plan({ config = clone(FIXTURE.config), stock = clone(FIXTURE.stock), openIndex = {}, refillRequests = {} } = {}) {
  return computeRefillPlan({
    nowMs: NOW_MS, config, targets: clone(FIXTURE.targets), stock, products: clone(FIXTURE.products),
    openIndex, refillRequests, orders: {}, movements: [], network: reg.SEED_REGISTRY,
  });
}
const withPause = (cfg, node) => ({ ...cfg, pausedLocations: node });

test("the flag: only `true` pauses; absent, false and junk never stop a location", () => {
  assert.deepEqual([...pl.pausedLocationSet({})], []);
  assert.deepEqual([...pl.pausedLocationSet(null)], []);
  assert.deepEqual([...pl.pausedLocationSet({ pausedLocations: "hub3" })], []);
  assert.deepEqual([...pl.pausedLocationSet({ pausedLocations: { hub3: false, hub2: "true", hub1: 1, central: null } })], []);
  assert.deepEqual([...pl.pausedLocationSet({ pausedLocations: { hub3: true, hub2: false } })], ["hub3"]);
  assert.equal(pl.isLocationPaused({ pausedLocations: { hub3: true } }, "hub3"), true);
  assert.equal(pl.isLocationPaused({ pausedLocations: { hub3: true } }, "hub2"), false);
});

test("FLAG SET: a scan over Hub 3 cells at 0 raises ZERO Hub 3 requests (and the rest of the network is unchanged)", () => {
  const stock = zeroedHub3Stock();
  const before = plan({ stock });
  // The fixture really does want Hub 3 refilled once it reads 0 — otherwise
  // this test would prove nothing.
  assert.ok(before.intents.some((i) => i.dest === "hub3"), "fixture must raise Hub 3 intents when unpaused");
  const cfg = withPause(clone(FIXTURE.config), { hub3: true });
  const raw = plan({ config: cfg, stock });
  const held = pl.withoutPausedDestinations(raw, pl.pausedLocationSet(cfg));
  assert.equal(held.intents.filter((i) => i.dest === "hub3").length, 0);
  for (const key of pl.DEST_LISTS) assert.equal((held[key] || []).filter((e) => e.dest === "hub3").length, 0, key);
  // Every other destination's intents are exactly what they were.
  const others = (p) => p.intents.filter((i) => i.dest !== "hub3").map((i) => JSON.stringify(i)).sort();
  assert.deepEqual(others(held), others(before));
});

test("FLAG SET: Hub 3's intents leave BEFORE the cap — a zeroed Hub 3 can never take another location's slots", () => {
  const stock = zeroedHub3Stock();
  const tight = { ...clone(FIXTURE.config), maxIntentsPerRun: 3 };
  const unpaused = plan({ config: tight, stock });
  const paused = plan({ config: withPause(tight, { hub3: true }), stock });
  assert.equal(paused.intents.some((i) => i.dest === "hub3"), false);
  // Clothing slots in the paused run = min(cap, the non-Hub-3 clothing demand):
  // nothing of the cap went to Hub 3. (The engine's own split — policy echo.)
  const clothingPlanned = (p) => p.policy.intentsPlanned - p.policy.footwearIntentsPlanned;
  const demand = clothingPlanned(plan({ config: withPause({ ...tight, maxIntentsPerRun: 10000 }, { hub3: true }), stock }));
  assert.ok(demand > 3, "fixture must have more non-Hub-3 clothing demand than the cap");
  assert.equal(clothingPlanned(paused), 3);
  assert.equal(clothingPlanned(unpaused), 3);
  assert.equal(paused.intents.some((i) => i.dest === "hub3"), false);
});

test("FLAG CLEAR: the plan is byte-identical — absent, {}, {hub3:false} and junk", () => {
  for (const stock of [clone(FIXTURE.stock), zeroedHub3Stock()]) {
    const base = JSON.stringify(plan({ stock }));
    for (const node of [undefined, {}, { hub3: false }, { hub3: "true" }, null]) {
      const cfg = node === undefined ? clone(FIXTURE.config) : withPause(clone(FIXTURE.config), node);
      const p = plan({ config: cfg, stock });
      const out = pl.withoutPausedDestinations(p, pl.pausedLocationSet(cfg));
      assert.equal(out, p, "nothing paused → the same plan object");
      assert.equal(JSON.stringify(out), base, JSON.stringify(node));
    }
  }
});

test("FLAG SET: every plan list drops its Hub 3 entries — and ONLY those (a shop request Hub 3 serves is not held)", () => {
  const paused = new Set(["hub3"]);
  const h3 = { dest: "hub3", pid: "p1", sizeKey: "M" };
  const pine = { dest: "marathon-pine", pid: "p1", sizeKey: "M" };
  const p = {
    errors: [],
    intents: [{ ...h3, source: "central" }, { ...pine, source: "hub3" }],
    closes: [{ ...h3, refillId: "r1", cancelReason: "no_longer_needed" }, { ...pine, refillId: "r2", reason: "awaiting_upstream", cancelReason: "awaiting_upstream" }],
    satisfiedClosures: [{ ...h3, refillId: "r3" }, { ...pine, refillId: "r4" }],
    resizes: [{ ...h3, refillId: "r5", from: 2, to: 3 }, { ...pine, refillId: "r6", from: 2, to: 1 }],
    retryOps: [{ ...h3, op: "retry" }, { ...pine, op: "reset" }],
    streakOps: [{ ...h3, op: "reset" }, { ...pine, op: "reset" }],
  };
  const out = pl.withoutPausedDestinations(p, paused);
  for (const key of pl.DEST_LISTS) {
    assert.deepEqual(out[key].map((e) => e.dest), ["marathon-pine"], key);
  }
  assert.deepEqual(out.pausedDropped, { intents: 1, closes: 1, satisfiedClosures: 1, resizes: 1, retryOps: 1, streakOps: 1 });
});

test("FLAG SET: a refusal write-off at Hub 3 is held; elsewhere it stands", () => {
  const w = [{ loc: "hub3", pid: "a" }, { loc: "hub2", pid: "b" }];
  assert.deepEqual(pl.withoutPausedWriteoffs(w, new Set(["hub3"])).map((x) => x.loc), ["hub2"]);
  assert.equal(pl.withoutPausedWriteoffs(w, new Set()), w);
});

// ── the first-batch trigger: Central → Hub 3 leg ────────────────────────────
const FB_CONFIG = {
  enabled: true,
  mode: { hub1: "live", hub2: "live", trophy: "live", "marathon-pe": "live" },
  routes: { hub1: "central", hub2: "central", trophy: "hub2", "marathon-pe": "hub2" },
  ruleBasedTargets: true, maxUnitsPerIntent: 20, maxIntentsPerRun: 200, staleIntentHours: 48,
  defaultRunByStore: { hub2: { M: 3, L: 3 }, trophy: { M: 2, L: 2 }, "marathon-pe": { M: 2, L: 2 } },
};
const PRODUCTS = { p1: { id: "p1", name: "Essentials Tee", productType: "clothing", categoryKey: "t-shirts", sizes: ["M", "L"] } };
const cell = (qty) => ({ qty, v: 1, mv: "m", lastType: "received" });
const seed = () => ({ qty: 0, v: 0, mv: "seed", lastType: "count", state: "live" });
function fbWorld(config) {
  return makeFakeDb({
    network: { locations: { "marathon-pine": { live: true }, concrete: { live: true }, hub3: { live: true } } },
    config: { refillEngine: config },
    products: PRODUCTS,
    stock: { central: { p1: { M: cell(6), L: cell(0) } }, "marathon-pine": { p1: { M: seed(), L: seed() } } },
    refill_requests: { r1: {
      productId: "p1", size: "M", qty: 2, requestingLocation: "marathon-pine", status: "open", createdAt: "2026-11-06T07:00:00.000Z",
      createdFrom: { firstBatch: true, solveId: "fb_p1_marathon-pine", source: "central", store: "marathon-pine", hub: "hub3" },
    } },
  });
}
async function fulfilAndFire(db) {
  const run = () => processFirstBatchRequest({ db, requestId: "r1", nowIso: T, pathEnabled: true });
  await run();
  await db.ref("refill_requests/r1").update({ status: "fulfilled", sentQty: 2 });
  await db.ref("stock/central/p1/M/qty").set(4);
  return run();
}
const hub3Requests = (db) => Object.values(db.state.root.refill_requests || {}).filter((r) => r.requestingLocation === "hub3");

test("FIRST BATCH, Hub 3 paused: no Hub 3 leg, no lock, no seed — the marker says location_paused", async () => {
  const db = fbWorld({ ...FB_CONFIG, pausedLocations: { hub3: true } });
  const res = await fulfilAndFire(db);
  assert.deepEqual(res, { raised: false, none: "location_paused" });
  assert.equal(hub3Requests(db).length, 0);
  assert.equal(db.state.root.refill_engine?.open?.hub3, undefined);
  assert.equal(db.state.root.stock.hub3, undefined);
  assert.equal(db.state.root.refill_requests.r1.firstBatch.hub2Leg.none, "location_paused");
});

test("FIRST BATCH, flag clear: the Hub 3 leg is raised exactly as before", async () => {
  const db = fbWorld({ ...FB_CONFIG, pausedLocations: { hub3: false } });
  const res = await fulfilAndFire(db);
  assert.equal(res.raised, true);
  assert.equal(hub3Requests(db).length, 1);
});

// Pine shop count (Junid, 11 Nov 2026): the same flag holds the Pine shop as a
// destination and nothing else.
test("pausedLocations/marathon-pine holds only Pine-destination entries", () => {
  const pl = require("../lib/paused-locations.cjs");
  const paused = pl.pausedLocationSet({ pausedLocations: { "marathon-pine": true } });
  const plan = { intents: [{ dest: "marathon-pine" }, { dest: "concrete" }, { dest: "hub3" }], closes: [{ dest: "marathon-pine" }, { dest: "marathon-pe" }] };
  const out = pl.withoutPausedDestinations(plan, paused);
  assert.deepEqual(out.intents.map((e) => e.dest), ["concrete", "hub3"]);
  assert.deepEqual(out.closes.map((e) => e.dest), ["marathon-pe"]);
  assert.deepEqual(pl.withoutPausedWriteoffs([{ loc: "marathon-pine" }, { loc: "trophy" }], paused), [{ loc: "trophy" }]);
});

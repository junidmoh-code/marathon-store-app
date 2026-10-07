// ─── THE SECTION WALL AND THE LIVE FLAG, SERVER SIDE ─────────────────────────
// The engine acts only on legs of config.routes that the network registry
// allows: both ends LIVE, and never a Section 1 location with a Section 2 one.
// The first-batch trigger writes nothing for a shop outside Hub 2's section.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { computeRefillPlan, walledRoutes } = require("../lib/refill-engine.cjs");
const reg = require("../lib/network-registry.cjs");
const { processFirstBatchRequest } = require("../lib/first-batch.cjs");
const { __resetNetworkCacheForTests } = require("../lib/network-load.cjs");

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/sections-routing-fixture.json"), "utf8"));
const NOW_MS = Date.parse("2026-10-01T10:00:00.000Z");
const clone = (v) => JSON.parse(JSON.stringify(v));
const S1 = ["hub3", "marathon-pine", "concrete", "concrete-stockroom"];
// Section 1 with BOTH switches off — what the seed shipped as before 7 Oct 2026
// (the seed itself now holds Section 1 Solve on + Auto-refill "solved").
const DARK = reg.normalizeNetwork({ locations: Object.fromEntries(["marathon-pine", "concrete", "hub3", "concrete-stockroom"].map((id) => [id, { solve: false, autoRefill: "off" }])) });

const TODAY = { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" };

const plan = (over = {}) => computeRefillPlan({
  nowMs: NOW_MS, config: clone(FIXTURE.config), targets: clone(FIXTURE.targets), stock: clone(FIXTURE.stock),
  products: clone(FIXTURE.products), openIndex: {}, refillRequests: {}, orders: {}, movements: [], ...over,
});

test("today's routes pass whole, in the same key order, with nothing withheld", () => {
  const w = walledRoutes(TODAY, DARK);
  assert.deepEqual(w.routes, TODAY);
  assert.deepEqual(Object.keys(w.routes), Object.keys(TODAY));
  assert.deepEqual(w.withheld, []);
  assert.deepEqual(walledRoutes(TODAY, null).routes, TODAY, "no registry at all = the seed");
});

test("a Section 1 leg is withheld while its locations are not live, and says why", () => {
  const routes = { ...TODAY, hub3: "central", "marathon-pine": "hub3", concrete: "hub3" };
  const w = walledRoutes(routes, DARK);
  assert.deepEqual(w.routes, TODAY);
  assert.deepEqual(w.withheld, [
    { dest: "hub3", source: "central", why: "not_live" },
    { dest: "marathon-pine", source: "hub3", why: "not_live" },
    { dest: "concrete", source: "hub3", why: "not_live" },
  ]);
});

const OFF = { solve: false, autoRefill: "off" };
const S1_OFF = Object.fromEntries(S1.map((id) => [id, OFF]));
test("a leg opens only when BOTH ends have Auto-refill on", () => {
  const routes = { hub3: "central", "marathon-pine": "hub3", concrete: "hub3" };
  const hubOnly = reg.normalizeNetwork({ locations: { ...S1_OFF, hub3: { live: true } } });
  assert.deepEqual(walledRoutes(routes, hubOnly).routes, { hub3: "central" });
  const hubAndPine = reg.normalizeNetwork({ locations: { ...S1_OFF, hub3: { live: true }, "marathon-pine": { live: true } } });
  assert.deepEqual(walledRoutes(routes, hubAndPine).routes, { hub3: "central", "marathon-pine": "hub3" });
});

test("a leg across the wall is withheld even when everything is live", () => {
  const allLive = reg.normalizeNetwork({ locations: Object.fromEntries(S1.map((id) => [id, { live: true }])) });
  const routes = { "marathon-pe": "hub3", "marathon-pine": "hub2", hub3: "hub2", concrete: "concrete-stockroom" };
  const w = walledRoutes(routes, allLive);
  assert.deepEqual(w.routes, { concrete: "concrete-stockroom" });
  assert.deepEqual(w.withheld.map((x) => x.why), ["cross_section", "cross_section", "cross_section"]);
});

test("a route naming a location the registry does not know is withheld", () => {
  const w = walledRoutes({ hubC: "central", "marathon-pe": "hub9" }, DARK);
  assert.deepEqual(w.routes, {});
});

test("ENGINE: Section 1 routes in config raise nothing while Section 1's Auto-refill is off — and Section 2's plan is untouched", () => {
  const before = plan({ network: DARK });
  const config = clone(FIXTURE.config);
  Object.assign(config.routes, { hub3: "central", "marathon-pine": "hub3", concrete: "hub3" });
  config.mode = { ...config.mode, hub3: "live", "marathon-pine": "live", concrete: "live" };
  // give Pine targets it is short of, so a leg WOULD be raised if the gate were missing
  const targets = clone(FIXTURE.targets);
  targets["marathon-pine"] = clone(FIXTURE.targets["marathon-pe"]);
  targets.hub3 = clone(FIXTURE.targets.hub2);
  const after = plan({ config, targets, network: DARK });
  for (const i of after.intents) assert.ok(!S1.includes(i.dest) && !S1.includes(i.source), `${i.source}→${i.dest}`);
  assert.deepEqual(after.intents, before.intents);
  assert.equal(after.routesWithheld.length, 3);
  assert.equal(before.routesWithheld, undefined, "the field is absent when nothing is withheld");
});

test("ENGINE: flipping Hub 3 and Pine live lets their legs through, and still never crosses the wall", () => {
  const config = clone(FIXTURE.config);
  Object.assign(config.routes, { hub3: "central", "marathon-pine": "hub3" });
  config.mode = { ...config.mode, hub3: "live", "marathon-pine": "live" };
  config.defaultRunByStore = { ...config.defaultRunByStore, "marathon-pine": config.defaultRunByStore["marathon-pe"], hub3: config.defaultRunByStore.hub2 };
  const targets = clone(FIXTURE.targets);
  targets["marathon-pine"] = clone(FIXTURE.targets["marathon-pe"]);
  targets.hub3 = clone(FIXTURE.targets.hub2);
  const network = reg.normalizeNetwork({ locations: { hub3: { live: true }, "marathon-pine": { live: true } } });
  const p = plan({ config, targets, network });
  const s1 = p.intents.filter((i) => S1.includes(i.dest));
  assert.ok(s1.length > 0, "a live Section 1 leg raises intents");
  for (const i of p.intents) {
    assert.ok(reg.wallAllows(network, i.source, i.dest), `${i.source}→${i.dest} crosses the wall`);
  }
  // Section 2's hub→shop legs are the same with Section 1 live…
  const shopLegs = (list) => list.filter((i) => ["marathon-pe", "trophy"].includes(i.dest));
  assert.deepEqual(shopLegs(p.intents), shopLegs(plan().intents));
  // …but CENTRAL IS SHARED. Once Hub 3 is live it asks Central for the same
  // products Hub 1 and Hub 2 do, and a unit Central has only one of goes to
  // one hub. This pins that fact rather than hiding it: every Section 2 intent
  // that differs is a Central→hub leg, never a shop leg.
  const key = (i) => `${i.source}>${i.dest}|${i.productId}|${i.sizeKey}|${i.qty}`;
  const after = new Set(p.intents.map(key));
  const lost = plan().intents.filter((i) => !after.has(key(i)));
  for (const i of lost) assert.equal(i.source, "central", `a non-Central Section 2 leg changed: ${key(i)}`);
});

// ── first batch ──────────────────────────────────────────────────────────────
function fakeDb(tree) {
  const writes = [];
  const at = (p) => p.split("/").reduce((n, k) => (n == null ? null : n[k]), tree) ?? null;
  return {
    writes,
    ref(p) {
      return {
        once: async () => ({ val: () => at(p) }),
        set: async (v) => { writes.push(["set", p, v]); },
        update: async (v) => { writes.push(["update", p, v]); },
        transaction: async (fn) => { writes.push(["txn", p]); const v = fn(at(p)); return { committed: v !== undefined, snapshot: { val: () => v } }; },
        push: () => ({ key: "k" }),
      };
    },
  };
}
const fbRequest = (store) => ({
  status: "open", productId: "p1", size: "M", qty: 2, requestingLocation: store,
  createdFrom: { firstBatch: true, solveId: "fb_p1_x", source: "central" },
});

test("FIRST BATCH: a request for a Section 1 shop whose Auto-refill is OFF writes nothing at all — no seed, no leg, no lock", async () => {
  for (const store of ["marathon-pine", "concrete"]) {
    __resetNetworkCacheForTests();
    const db = fakeDb({ refill_requests: { r1: fbRequest(store) }, config: { refillEngine: { routes: { [store]: "hub2" } } }, network: { locations: S1_OFF } });
    const res = await processFirstBatchRequest({ db, requestId: "r1", nowIso: "2026-10-02T09:00:00.000Z", pathEnabled: true });
    assert.deepEqual(res, { skipped: "section_wall", store });
    assert.deepEqual(db.writes, []);
  }
});

// The trigger resolves the shop's OWN back-stock hub from the registry (Hub 3
// for Pine and Concrete): a LIVE Section 1 shop is served at its hub, and
// nothing is ever written at Hub 2 for it — whatever a route in the config
// says. (functions/test/first-batch-sections.test.cjs drives the whole leg.)
test("FIRST BATCH: a LIVE Section 1 shop is never served at Hub 2 — no Hub 2 seed, no Hub 2 leg, no Hub 2 lock", async () => {
  for (const store of ["marathon-pine", "concrete"]) {
    __resetNetworkCacheForTests();
    const allLive = { locations: Object.fromEntries(S1.map((id) => [id, { live: true }])) };
    const db = fakeDb({ network: allLive, refill_requests: { r1: fbRequest(store) }, config: { refillEngine: { routes: { [store]: "hub2" } } } });
    const res = await processFirstBatchRequest({ db, requestId: "r1", nowIso: "2026-10-02T09:00:00.000Z", pathEnabled: true });
    assert.notEqual(res.skipped, "section_wall");
    for (const w of db.writes) assert.ok(!String(w[1]).includes("hub2"), `nothing at Hub 2: ${w[1]}`);
  }
});

test("FIRST BATCH: a shop that is not live gets nothing either", async () => {
  __resetNetworkCacheForTests();
  const db = fakeDb({ network: { locations: { trophy: { live: false } } }, refill_requests: { r1: fbRequest("trophy") } });
  const res = await processFirstBatchRequest({ db, requestId: "r1", nowIso: "2026-10-02T09:00:00.000Z", pathEnabled: true });
  assert.deepEqual(res, { skipped: "section_wall", store: "trophy" });
  assert.deepEqual(db.writes, []);
});

test("FIRST BATCH: Marathon PE and Trophy pass the gate and go on as before", async () => {
  for (const store of ["marathon-pe", "trophy"]) {
    __resetNetworkCacheForTests();
    const db = fakeDb({ refill_requests: { r1: fbRequest(store) } });
    const res = await processFirstBatchRequest({ db, requestId: "r1", nowIso: "2026-10-02T09:00:00.000Z", pathEnabled: true }).catch((e) => ({ threw: String(e.message || e) }));
    assert.notEqual(res.skipped, "section_wall");
  }
});

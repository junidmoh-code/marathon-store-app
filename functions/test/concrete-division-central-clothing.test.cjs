// ─── PINE/CONCRETE NON-FOOTWEAR FROM CENTRAL; HUB 3 SNEAKERS ONLY (Junid, 12 Nov 2026)
// Replaces the 10 Nov "Hub 3 keep off" rules: whatever Hub 3 holds, has held or
// has coming, a Pine or Concrete shop's non-footwear keep (2 per size, 5 per
// design) is asked of Central — and a Central line is never withdrawn on the
// grounds that Hub 3 holds the item.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan, networkRouting } = require("../lib/refill-engine.cjs");
const reg = require("../lib/network-registry.cjs");
const dv = require("../lib/concrete-division.cjs");
const { shopCentralWithdrawal, forbiddenShopSource } = require("../lib/shop-source-rule.cjs");
const { FOOTWEAR_CATEGORY_KEYS } = require("../lib/policy-resolve.cjs");

const ISO = "2026-11-12T09:00:00.000Z";
const NOW = Date.parse(ISO);
const cfg = () => ({
  routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
  mode: { hub1: "live", hub2: "live", "marathon-pe": "live", trophy: "live" },
  ruleBasedTargets: true, maxIntentsPerRun: 500, maxFootwearIntentsPerRun: 500, maxUnitsPerIntent: 20,
  concreteDivision: { shopOnly: { perSize: 2, oneSize: 5 } },
  policyGroups: { "footwear-all": { armed: true, memberCategoryKeys: FOOTWEAR_CATEGORY_KEYS.slice(), policy: { perSize: true } } },
});
const c = (qty) => ({ qty, v: 1, mv: "m", lastType: "count", trusted: true, trustedVia: "count", trustedAt: ISO });
const shelf = (qty) => ({ qty, v: 1, mv: "m", lastType: "transfer_in" });
const TEE = { id: "t1", name: "Tee", category: "Clothing", categoryKey: "t-shirts", productType: "clothing", sizes: ["S", "M", "L"] };
const BAG = { id: "b1", name: "Bag", category: "Accessories", categoryKey: "bags", sizes: [] };
const PERF = { id: "p1", name: "Scent", category: "Perfume", categoryKey: "perfumes", sizes: [] };
const UNCAT = { id: "u1", name: "Thing", sizes: [] };
const products = { t1: TEE, b1: BAG, p1: PERF, u1: UNCAT };
const central = { t1: { S: c(9), M: c(9), L: c(9) }, b1: { _: c(20) }, p1: { _: c(20) }, u1: { _: c(20) } };
const seat = { via: "stock", at: ISO };
const seatsFor = (node) => Object.fromEntries(Object.keys(node || {}).map((p) => [p, seat]));
const run = ({ hub3 = {}, concrete = {}, pine = {}, openIndex = {}, refillRequests = {}, heldLines = {}, seats = {} }) => computeRefillPlan({
  nowMs: NOW, config: cfg(), targets: {}, products, openIndex, refillRequests, heldLines, orders: {}, movements: [],
  stock: { central, hub3, concrete, "marathon-pine": pine }, network: reg.SEED_REGISTRY,
  seats: { concrete: seatsFor(concrete), "marathon-pine": seatsFor(pine), hub3: seatsFor(hub3), ...seats },
});
const lines = (p, dest = "concrete") => p.intents.filter((i) => i.dest === dest).map((i) => `${i.source}:${i.sizeKey}:${i.qty}`).sort();

test("Hub 3 holding units, zero cells, a box on its way or a lock: the shop still asks Central for every size", () => {
  const concrete = { t1: { S: shelf(0), M: shelf(0), L: shelf(1) } };
  const want = ["central:L:1", "central:M:2", "central:S:2"];
  assert.deepEqual(lines(run({ hub3: { t1: { S: c(3), M: c(0) } }, concrete })), want);
  assert.deepEqual(lines(run({ hub3: { t1: { S: c(0) } }, concrete, heldLines: { hub3: { h1: { productId: "t1", size: "M", qty: 2 } } } })), want);
  assert.deepEqual(lines(run({ concrete, openIndex: { hub3: { t1: { S: { qty: 1, source: "central", refillId: "x", createdAt: ISO } } } }, refillRequests: { x: { status: "open", productId: "t1", size: "S", requestingLocation: "hub3", createdAt: ISO } } })), want);
});

test("no size: 5 per design; a single piece short is asked for; nothing above the keep is ever removed", () => {
  assert.deepEqual(lines(run({ concrete: { b1: { _: shelf(4) } } })), ["central:_:1"]);
  const over = run({ concrete: { b1: { _: shelf(9) }, t1: { S: shelf(7), M: shelf(2), L: shelf(2) } } });
  assert.deepEqual(lines(over), []);
  assert.equal((over.closes || []).length, 0);
});

test("uncategorised items are kept like any non-footwear; perfume is kept at Pine but never at Concrete", () => {
  assert.deepEqual(lines(run({ pine: { u1: { _: shelf(0) }, p1: { _: shelf(2) } } }), "marathon-pine"), ["central:_:3", "central:_:5"]);
  assert.deepEqual(lines(run({ concrete: { u1: { _: shelf(0) }, p1: { _: shelf(0) } } })), ["central:_:5"]);
});

test("Hub 3 itself asks nothing for non-footwear, whatever it holds or is seated with", () => {
  const p = run({ hub3: { t1: { S: c(0), M: c(0), L: c(0) }, b1: { _: c(0) }, u1: { _: c(0) } } });
  assert.deepEqual(lines(p, "hub3"), []);
});

test("a Central line is never withdrawn because Hub 3 holds the item (no 'Hub 3 serves this')", () => {
  const config = cfg();
  const division = dv.divisionContext({ config, seats: {} });
  const routing = networkRouting(config, reg.SEED_REGISTRY, division);
  const hub3 = { t1: { S: c(3), M: c(0) } };
  for (const size of ["S", "M", "L"]) {
    const rr = { status: "open", productId: "t1", size, requestingLocation: "concrete", createdAt: "2026-11-12T08:00:00.000Z" };
    const args = { dest: "concrete", pid: "t1", entry: { source: "central" }, rr, inFlight: false, routes: config.routes, locations: null, routing, product: TEE, size, snapshot: { stock: { hub3 } }, nowMs: NOW };
    assert.equal(shopCentralWithdrawal(args), null, size);
    assert.equal(forbiddenShopSource({ dest: "concrete", source: "central", routes: config.routes, routing, product: TEE, pid: "t1", size }), false, size);
  }
  // …and the plan raises no withdrawal for an open Central line either.
  const p = run({ hub3, concrete: { t1: { S: shelf(0) } }, openIndex: { concrete: { t1: { S: { qty: 2, source: "central", refillId: "r1", createdAt: ISO } } } }, refillRequests: { r1: { status: "open", productId: "t1", size: "S", qty: 2, requestingLocation: "concrete", createdAt: ISO, createdFrom: { source: "central" } } } });
  assert.ok(!(p.closes || []).some((x) => x.refillId === "r1"), JSON.stringify(p.closes));
});

test("the source question: Central for every size of a non-footwear item at a shop; undefined for footwear and for Hub 3", () => {
  const division = dv.divisionContext({ config: cfg(), seats: {} });
  const SHOE = { category: "Footwear", categoryKey: "sneakers", sizes: ["8"] };
  assert.equal(dv.divisionSourceFor(division, "concrete", "t1", TEE, "central", "S"), "central");
  assert.equal(dv.divisionSourceFor(division, "marathon-pine", "t1", TEE, "central"), "central");
  assert.equal(dv.divisionSourceFor(division, "concrete", "s", SHOE, "central", "8"), undefined);
  assert.equal(dv.divisionSourceFor(division, "hub3", "t1", TEE, "central", "S"), undefined);
  assert.equal(dv.divisionSourceFor(null, "concrete", "t1", TEE, "central", "S"), undefined);
});

test("the policy key: the shop keep alone; an older key's Hub 3 fields are ignored; garbled → off", () => {
  assert.deepEqual(dv.concreteDivisionPolicy({ concreteDivision: { shopOnly: { perSize: 2, oneSize: 5 } } }), { shopOnly: { perSize: 2, oneSize: 5 } });
  assert.deepEqual(dv.concreteDivisionPolicy({ concreteDivision: { shopOnly: { perSize: 2, oneSize: 5 }, fromHub3: { perSize: 1, oneSize: 5 }, hub3Keep: { on: true, perSize: 2, oneSize: 10 } } }), { shopOnly: { perSize: 2, oneSize: 5 } });
  assert.equal(dv.concreteDivisionPolicy({ concreteDivision: { fromHub3: { perSize: 1, oneSize: 5 } } }), null);
  assert.equal(dv.concreteDivisionPolicy({ concreteDivision: { shopOnly: { perSize: 0, oneSize: 5 } } }), null);
  assert.equal(dv.concreteDivisionPolicy({}), null);
});

test("hub3Refuses / divisionRefuses: Hub 3 refuses every non-footwear item (uncategorised included); Concrete refuses perfume", () => {
  const SHOE = { category: "Footwear", categoryKey: "sneakers" };
  const LEGACY = { category: "Footwear", subcategory: "Boots" };
  assert.equal(dv.hub3Refuses("hub3", TEE), true);
  assert.equal(dv.hub3Refuses("hub3", UNCAT), true);
  assert.equal(dv.hub3Refuses("hub3", PERF), true);
  assert.equal(dv.hub3Refuses("hub3", SHOE), false);
  assert.equal(dv.hub3Refuses("hub3", LEGACY), false);
  assert.equal(dv.hub3Refuses("concrete", TEE), false);
  assert.equal(dv.hub3Refuses("hub3", null), false);
  assert.equal(dv.divisionRefuses("concrete", PERF), true);
  assert.equal(dv.divisionRefuses("marathon-pine", PERF), false);
  assert.equal(dv.divisionNeverKeeps("hub3", TEE), false, "the perfume rule is untouched and key-independent");
});

test("POLICY WRITE: setConcreteDivision takes the shop keep alone and refuses the old Hub 3 fields", async () => {
  const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
  const { applyCategoryPolicy, invalidateCensusCache } = require("../lib/category-policy-write.cjs");
  const { __resetNetworkCacheForTests } = require("../lib/network-load.cjs");
  __resetNetworkCacheForTests(); invalidateCensusCache();
  const OWNER = "gunidmoh@gmail.com";
  const OLD = { shopOnly: { perSize: 2, oneSize: 5 }, fromHub3: { perSize: 1, oneSize: 5, askAt: 0 }, hub3Keep: { on: false, perSize: 2, oneSize: 10 } };
  const db = makeFakeDb({ config: { refillEngine: { routes: { "marathon-pe": "hub2", trophy: "hub2", hub2: "central" }, concreteDivision: OLD } }, users: {} });
  const call = (data) => applyCategoryPolicy({ db, callerEmail: OWNER, adminEmail: OWNER, callerUid: "o", data, nowMs: NOW });
  for (const bad of [OLD, { ...OLD, hub3Keep: { on: true, perSize: 2, oneSize: 10 } }, { shopOnly: { perSize: 2, oneSize: 5 }, hub3Keep: { on: false, perSize: 2, oneSize: 10 } },
    { shopOnly: { perSize: 0, oneSize: 5 } }, { shopOnly: { perSize: 2 } }, { shopOnly: { perSize: 2, oneSize: 5, askAt: 0 } }, "x"]) {
    await assert.rejects(() => call({ action: "setConcreteDivision", policy: bad, expectedBefore: OLD }), /footwear only|whole number/, JSON.stringify(bad));
  }
  const res = await call({ action: "setConcreteDivision", policy: { shopOnly: { perSize: 2, oneSize: 5 } }, expectedBefore: OLD });
  assert.deepEqual([res.ok, res.after], [true, { shopOnly: { perSize: 2, oneSize: 5 } }]);
  assert.deepEqual(db.state.root.config.refillEngine.concreteDivision, { shopOnly: { perSize: 2, oneSize: 5 } });
  const hist = Object.values(db.state.root.engine_policy_history);
  assert.deepEqual(hist.map((h) => [h.kind, h.status]), [["concreteDivision", "applied"]]);
  assert.deepEqual(hist[0].before, OLD, "the history keeps what it replaced");
  const off = await call({ action: "setConcreteDivision", policy: null, expectedBefore: { shopOnly: { perSize: 2, oneSize: 5 } } });
  assert.equal(off.after, null, "null is still the rollback");
});

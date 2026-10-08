// ─── CENTRAL-FED CLOTHING (Concrete) — engine, scan, first-batch trigger, policy write
// Owner, 8 Oct 2026: Concrete keeps its clothing in the shop, N of every
// declared size, refilled STRAIGHT FROM CENTRAL. Pine clothing unchanged
// (Hub 3); Concrete sneakers/perfume unchanged (Hub 3); Marathon unchanged.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { computeRefillPlan, networkRouting, resolveTarget } = require("../lib/refill-engine.cjs");
const reg = require("../lib/network-registry.cjs");
const trust = require("../lib/stock-trust.cjs");
const cf = require("../lib/central-fed.cjs");
const { forbiddenShopSource } = require("../lib/shop-source-rule.cjs");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { processFirstBatchRequest } = require("../lib/first-batch.cjs");
const { __resetNetworkCacheForTests } = require("../lib/network-load.cjs");
const { applyCategoryPolicy, invalidateCensusCache } = require("../lib/category-policy-write.cjs");
const scan = require("../refill-scan.cjs");
const FIXTURE = require("./fixtures/sections-routing-fixture.json");

const NOW_MS = Date.parse("2026-10-08T10:00:00.000Z");
const T = "2026-10-08T08:00:00.000Z";
const SEED = reg.SEED_REGISTRY;
const clone = (v) => JSON.parse(JSON.stringify(v));
const trusted = (qty) => ({ qty, v: 1, mv: "m", lastType: "transfer_out", ...trust.trustStamp("refill", T) });
const S1 = new Set(["marathon-pine", "concrete", "hub3"]);
const cfgWith = (n = 4) => ({ ...clone(FIXTURE.config), centralFedClothing: { concrete: n } });
const TEE = "fx030";        // clothing, S–XXL
const SNEAKER = Object.values(FIXTURE.products).find((p) => p.categoryKey === "sneakers" && !p.deactivated).id;

function plan({ config = cfgWith(), stock, network = SEED }) {
  return computeRefillPlan({
    nowMs: NOW_MS, config, targets: clone(FIXTURE.targets), stock, products: clone(FIXTURE.products),
    openIndex: {}, refillRequests: {}, orders: {}, movements: [], network,
  });
}
const s2 = (p) => p.intents.filter((i) => !S1.has(i.dest)).map((i) => JSON.stringify(i)).sort();

test("the predicate: on for a registry store config.routes does not name; never Marathon; junk turns it off", () => {
  const cfg = { routes: { "marathon-pe": "hub2", trophy: "hub2" }, centralFedClothing: { concrete: 4, "marathon-pe": 4, trophy: 3, hub3: 4, "marathon-pine": 0 } };
  assert.equal(cf.centralFedPerSize(cfg, SEED, "concrete"), 4);
  for (const loc of ["marathon-pe", "trophy", "hub3", "marathon-pine", "nowhere"]) assert.equal(cf.centralFedPerSize(cfg, SEED, loc), null, loc);
  for (const junk of [null, "4", 4.5, 100, -1, true]) assert.equal(cf.centralFedPerSize({ centralFedClothing: { concrete: junk } }, SEED, "concrete"), null, String(junk));
  assert.equal(cf.centralFedPerSize({}, SEED, "concrete"), null);
  assert.equal(cf.isCentralFedProduct(cfg, SEED, "concrete", FIXTURE.products[TEE]), true);
  assert.equal(cf.isCentralFedProduct(cfg, SEED, "concrete", FIXTURE.products[SNEAKER]), false);
  assert.deepEqual(cf.centralFedSizes({ sizes: ["S", "M", "", null, "M"] }), ["S", "M"]);
  assert.deepEqual(cf.centralFedSizes({ sizes: [] }), ["_"]);
});

test("ROUTING: Concrete clothing ← Central; Concrete sneakers ← Hub 3; Pine clothing ← Hub 3", () => {
  const r = networkRouting(cfgWith(), SEED);
  assert.equal(r.sourceFor("concrete", FIXTURE.products[TEE], TEE), "central");
  assert.equal(r.sourceFor("concrete", FIXTURE.products[SNEAKER], SNEAKER), "hub3");
  assert.equal(r.sourceFor("marathon-pine", FIXTURE.products[TEE], TEE), "hub3");
  assert.ok(r.sourcesOf("concrete").includes("central"));
  // the rule off: Concrete clothing from Hub 3 as before
  assert.equal(networkRouting(clone(FIXTURE.config), SEED).sourceFor("concrete", FIXTURE.products[TEE], TEE), "hub3");
});

test("TARGET: N for every declared size, above the templated runs; nothing for an undeclared size", () => {
  const ctx = { targets: {}, config: cfgWith(4), products: FIXTURE.products, stock: {}, network: SEED };
  for (const s of FIXTURE.products[TEE].sizes) assert.deepEqual(resolveTarget(ctx, "concrete", TEE, s), { target: 4, minQty: 3, reorderPoint: null, source: "central_fed" }, s);
  assert.equal(resolveTarget(ctx, "concrete", TEE, "9"), null);
  // Pine unchanged
  assert.notEqual(resolveTarget(ctx, "marathon-pine", TEE, "M")?.source, "central_fed");
});

test("ENGINE: a trusted Concrete clothing cell is topped to N from Central; no Hub 3 leg for it; Pine still via Hub 3", () => {
  const stock = clone(FIXTURE.stock);
  stock.concrete = { [TEE]: { S: trusted(0), M: trusted(1), L: trusted(4) } };
  stock["marathon-pine"][TEE] = { M: trusted(0) };
  stock.hub3[TEE] = { M: trusted(5) };
  stock.central[TEE] = { S: trusted(9), M: trusted(9), L: trusted(9) };
  const p = plan({ stock });
  const conc = p.intents.filter((i) => i.dest === "concrete" && i.productId === TEE).map((i) => [i.source, i.sizeKey, i.qty]).sort();
  assert.deepEqual(conc, [["central", "M", 3], ["central", "S", 4]]);
  assert.equal(p.intents.some((i) => i.dest === "hub3" && i.productId === TEE && (i.forDests || []).includes("concrete")), false);
  assert.deepEqual(p.intents.filter((i) => i.dest === "marathon-pine" && i.productId === TEE).map((i) => i.source), ["hub3"]);
  assert.equal(p.errors.some((e) => /a shop refills from its hub/.test(e)), false);
});

test("ENGINE: untrusted Concrete cells are ignored; a size Central lacks raises nothing", () => {
  const stock = clone(FIXTURE.stock);
  stock.concrete = { [TEE]: { S: { qty: 0, v: 3, mv: "lx", lastType: "adjustment" }, M: trusted(0) } };
  stock.central[TEE] = {};   // Central has none of any size
  const p = plan({ stock });
  assert.deepEqual(p.intents.filter((i) => i.dest === "concrete" && i.productId === TEE), []);
  stock.central[TEE] = { S: trusted(9) };   // Central holds only S — still nothing: Concrete's S is untrusted, M has no Central units
  assert.deepEqual(plan({ stock }).intents.filter((i) => i.dest === "concrete" && i.productId === TEE), []);
});

test("MARATHON UNCHANGED: Section 2's plan is byte for byte the same with the key set", () => {
  const stock = clone(FIXTURE.stock);
  stock.concrete = { [TEE]: { S: trusted(0) } };
  assert.deepEqual(s2(plan({ stock })), s2(plan({ config: clone(FIXTURE.config), stock })));
});

test("SHOP-SOURCE RULE: Central is allowed only for a central-fed store's central-fed product", () => {
  const routing = networkRouting(cfgWith(), SEED);
  const base = { routes: routing.routes, locations: null, routing };
  assert.equal(forbiddenShopSource({ dest: "concrete", source: "central", ...base, product: FIXTURE.products[TEE], pid: TEE }), false);
  assert.equal(forbiddenShopSource({ dest: "concrete", source: "central", ...base, product: FIXTURE.products[SNEAKER], pid: SNEAKER }), true);
  assert.equal(forbiddenShopSource({ dest: "marathon-pine", source: "central", ...base, product: FIXTURE.products[TEE], pid: TEE }), true);
  assert.equal(forbiddenShopSource({ dest: "concrete", source: "central", ...base }), true);   // no product: "a shop ← Central row"
});

test("SCAN: a Central store leg shadows as a request row, never an order card; Marathon PE unchanged", () => {
  const p = { [TEE]: FIXTURE.products[TEE] };
  const node = (dest) => ({ [dest]: { [TEE]: { M: { qty: 2, source: "central", priority: "normal" } } } });
  const ctx = { products: p, orders: {}, refillRequests: {}, runId: "r", startedAt: T, network: SEED, config: cfgWith() };
  const upd = scan._shadowSyncUpdates({ ...ctx, shadowNode: node("concrete") });
  assert.ok(Object.keys(upd).some((k) => k.startsWith(`refill_requests/SHDWrr-concrete-${TEE}`)));
  assert.equal(Object.keys(upd).some((k) => k.startsWith("orders/")), false);
  const pe = scan._shadowSyncUpdates({ ...ctx, shadowNode: node("marathon-pe") });
  assert.ok(Object.keys(pe).some((k) => k.startsWith("orders/SHDW-marathon-pe")));
});

test("SCAN SOURCE: every helper refill-scan.cjs uses is imported (stockTrust was not — every live intent threw)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "refill-scan.cjs"), "utf8");
  for (const [name, mod] of [["stockTrust", "./lib/stock-trust.cjs"], ["isCentralFedProduct", "./lib/central-fed.cjs"], ["networkRegistry", "./lib/network-registry.cjs"]]) {
    if (new RegExp(`\\b${name}\\b`).test(src)) assert.ok(src.includes(`require("${mod}")`), `${name} used but ${mod} not required`);
  }
});

test("FIRST BATCH: a Concrete clothing request claims its Central lock, never withdraws on Hub 3 presence, and raises no hub leg", async () => {
  __resetNetworkCacheForTests();
  const db = makeFakeDb({
    config: { refillEngine: { ...clone(FIXTURE.config), enabled: true, centralFedClothing: { concrete: 4 } } },
    products: { [TEE]: FIXTURE.products[TEE] },
    stock: { central: { [TEE]: { M: trusted(6) } }, hub3: { [TEE]: { M: trusted(5) } }, concrete: { [TEE]: { M: trusted(0) } } },
    refill_requests: { r1: { productId: TEE, size: "M", qty: 4, requestingLocation: "concrete", status: "open", createdAt: T,
      createdFrom: { firstBatch: true, solveId: `fb_${TEE}_x`, source: "central", store: "concrete", hub: null } } },
  });
  const r1 = await processFirstBatchRequest({ db, requestId: "r1", nowIso: T, pathEnabled: true });
  assert.equal(r1.skipped, "open_untouched");
  assert.equal(r1.centralFed, true);
  assert.equal(db.state.root.refill_requests.r1.status, "open");                 // never withdrawn for Hub 3 presence
  assert.equal(db.state.root.refill_engine.open.concrete[TEE].M.source, "central");
  await db.ref("refill_requests/r1").update({ status: "fulfilled", sentQty: 4 });
  const r2 = await processFirstBatchRequest({ db, requestId: "r1", nowIso: T, pathEnabled: true });
  assert.deepEqual([r2.none, r2.raised], ["central_fed", false]);
  const hubRows = Object.values(db.state.root.refill_requests).filter((r) => r.requestingLocation === "hub3");
  assert.deepEqual(hubRows, []);
  assert.deepEqual(db.state.root.refill_requests.r1.firstBatch.hub2Leg.none, "central_fed");
});

test("POLICY WRITE: setCentralFed validates, writes with history, reads back, and reverts", async () => {
  __resetNetworkCacheForTests(); invalidateCensusCache();
  const OWNER = "gunidmoh@gmail.com";
  const db = makeFakeDb({ config: { refillEngine: { routes: { "marathon-pe": "hub2", trophy: "hub2", hub2: "central" } } }, users: {} });
  const call = (data) => applyCategoryPolicy({ db, callerEmail: OWNER, adminEmail: OWNER, callerUid: "o", data, nowMs: NOW_MS });
  for (const bad of [{ location: "marathon-pe", perSize: 4 }, { location: "hub3", perSize: 4 }, { location: "concrete", perSize: 0 }, { location: "concrete", perSize: 2.5 }, { location: "concrete" }]) {
    await assert.rejects(() => call({ action: "setCentralFed", ...bad }), undefined, JSON.stringify(bad));
  }
  const res = await call({ action: "setCentralFed", location: "concrete", perSize: 4 });
  assert.deepEqual([res.ok, res.before, res.after], [true, null, 4]);
  assert.equal(db.state.root.config.refillEngine.centralFedClothing.concrete, 4);
  const hist = Object.values(db.state.root.engine_policy_history);
  assert.deepEqual(hist.map((h) => [h.kind, h.location, h.before ?? null, h.after, h.status]), [["centralFed", "concrete", null, 4, "applied"]]);
  const census = await call({ action: "census" });
  assert.deepEqual(census.centralFedClothing, { concrete: 4 });
  assert.ok(census.centralFedStores.includes("concrete") && !census.centralFedStores.includes("marathon-pe"));
  // revert = write the entry's `before`
  const back = await call({ action: "setCentralFed", location: "concrete", perSize: null, expectedBefore: 4 });
  assert.deepEqual([back.before, back.after], [4, null]);
  assert.equal(db.state.root.config.refillEngine.centralFedClothing?.concrete ?? null, null);
  // drift refused
  await call({ action: "setCentralFed", location: "concrete", perSize: 3 });
  await assert.rejects(() => call({ action: "setCentralFed", location: "concrete", perSize: 5, expectedBefore: 4 }));
});

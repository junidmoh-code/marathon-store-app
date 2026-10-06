// ─── ENGINE POLICY PREVIEW / CENSUS — THE TEMPLATE AND THE REGISTRY ──────────
// The engine arms a LIVE Section 1 location that has no numbers of its own
// from its template (Pine / Concrete follow Marathon PE; Hub 3 / the Concrete
// Stockroom follow Hub 2) and routes it by the registry. The preview and the
// census took destinations from config.mode, sources from config.routes and
// numbers from the raw config, so they showed nothing there.
//
//   • MODEL vs ENGINE: on the routing fixture with Section 1 live, the model's
//     requests per destination equal computeRefillPlan's for every mapped
//     category — Section 1 legs included;
//   • a location that is NOT live is never added and never shown as armed;
//   • SECTION 2: with the seed registry handed in, the model's whole answer is
//     the answer with no registry at all, for every category;
//   • THE WRITE PATH STAYS RAW: a census → save round trip through the real
//     callable core leaves a follower with no entry of its own.
// Run: cd functions && node --test test/category-policy-sections.test.cjs
"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { computeRefillPlan, policyCategoryKey } = require("../lib/refill-engine.cjs");
const { modelCategoryPolicy, policyRouting } = require("../lib/category-policy.cjs");
const { applyCategoryPolicy, invalidateCensusCache } = require("../lib/category-policy-write.cjs");
const { normalizeNetwork, SEED_REGISTRY } = require("../lib/network-registry.cjs");
const { __resetNetworkCacheForTests } = require("../lib/network-load.cjs");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");

beforeEach(() => { __resetNetworkCacheForTests(); invalidateCensusCache(); });

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/sections-routing-fixture.json"), "utf8"));
const NOW = Date.parse("2026-10-01T10:00:00.000Z");
const clone = (v) => JSON.parse(JSON.stringify(v));
const S1 = ["marathon-pine", "concrete", "hub3", "concrete-stockroom"];
const S2 = ["hub1", "hub2", "marathon-pe", "trophy"];
const live = (ids = S1, extra = {}) => normalizeNetwork({ locations: Object.fromEntries(ids.map((id) => [id, { live: true }])), ...extra });
const MAPPED = Object.keys(FIXTURE.config.categoryPolicy);

// The fixture world with Section 1 stocked: Hub 3 and the stockroom hold what
// Hub 2 holds; Pine and Concrete hold a qty-0 cell for what Marathon PE
// carries (a category policy arms a store only for what it carries when
// carriedOnly, and a size run only where a cell exists).
function world() {
  const stock = clone(FIXTURE.stock);
  stock.hub3 = clone(FIXTURE.stock.hub2);
  stock["concrete-stockroom"] = clone(FIXTURE.stock.hub2);
  const empty = (row) => Object.fromEntries(Object.keys(row).map((k) => [k, { ...row[k], qty: 0 }]));
  for (const s of ["marathon-pine", "concrete"]) stock[s] = Object.fromEntries(Object.entries(FIXTURE.stock["marathon-pe"]).map(([pid, row]) => [pid, empty(row)]));
  const config = clone(FIXTURE.config);
  config.maxIntentsPerRun = 100000; config.maxFootwearIntentsPerRun = 100000;
  // …and the explicit rows Marathon PE has: the model lists a destination the
  // map does not arm only where it holds rows (as it always has, for every
  // location), so a follower with neither would be a leg the model never walks.
  const targets = clone(FIXTURE.targets);
  for (const s of ["marathon-pine", "concrete"]) targets[s] = clone(FIXTURE.targets["marathon-pe"]);
  for (const h of ["hub3", "concrete-stockroom"]) targets[h] = clone(FIXTURE.targets.hub2);
  return { config, stock, targets, products: clone(FIXTURE.products) };
}
const modelOf = (w, key, network) => modelCategoryPolicy({
  config: w.config, products: w.products, stock: w.stock, targets: w.targets, openIndex: {}, categoryKey: key,
  locations: Object.keys(w.stock), maxIntentsPerRun: w.config.maxIntentsPerRun, maxUnitsPerIntent: w.config.maxUnitsPerIntent,
  ...(network !== undefined ? { network } : {}),
});

test("the fixture config is production-shaped: no Section 1 location in mode, routes or any policy map", () => {
  const text = JSON.stringify(FIXTURE.config);
  for (const id of S1) assert.equal(text.includes(`"${id}"`), false, id);
});

test("policyRouting: live Section 1 followers are destinations, mode live, sourced by the registry; not-live ones are never added", () => {
  const cfg = FIXTURE.config;
  const none = policyRouting(cfg, undefined);
  assert.deepEqual(none.destinations, Object.keys(cfg.mode));
  assert.equal(none.configFor("hub3"), cfg);
  const seed = policyRouting(cfg, SEED_REGISTRY);
  assert.deepEqual(seed.destinations, Object.keys(cfg.mode));
  assert.deepEqual(seed.added, []);
  for (const loc of [...S1, ...S2]) { assert.equal(seed.modeOf(loc), cfg.mode[loc] || "off"); assert.deepEqual(seed.sourcesOf(loc), cfg.routes[loc] ? [cfg.routes[loc]] : []); }
  const on = policyRouting(cfg, live(S1, { backStock: { concrete: { hoodies: "concrete-stockroom" } } }));
  assert.deepEqual(on.destinations.slice(0, Object.keys(cfg.mode).length), Object.keys(cfg.mode));
  assert.deepEqual([...on.added].sort(), [...S1].sort());
  for (const loc of S1) assert.equal(on.modeOf(loc), "live");
  assert.equal(on.sourceFor("hub3", null, "x"), "central");
  assert.equal(on.sourceFor("marathon-pine", { categoryKey: "hoodies" }, "x"), "hub3");
  assert.equal(on.sourceFor("concrete", { categoryKey: "hoodies" }, "x"), "concrete-stockroom");
  assert.deepEqual(on.sourcesOf("concrete"), ["concrete-stockroom", "hub3"]);
  // whose numbers: the template for a follower, nothing for a location with its own
  assert.equal(on.followsIn(cfg.defaultRunByStore, "marathon-pine"), "marathon-pe");
  assert.equal(on.followsIn(cfg.defaultRunByStore, "hub3"), "hub2");
  assert.equal(on.followsIn(cfg.defaultRunByStore, "marathon-pe"), null);
  assert.equal(on.followsIn({ ...cfg.defaultRunByStore, hub3: { M: 1 } }, "hub3"), null);
  // only the shop live: its hub is not, so nothing is routed and nothing is added
  assert.deepEqual(policyRouting(cfg, live(["marathon-pine"])).added, []);
  // the templated config is a VIEW: the config handed in is not changed by it
  const before = JSON.stringify(cfg);
  assert.notEqual(on.configFor("hub3"), cfg);
  assert.equal(on.configFor("hub2"), on.configFor("hub3"));
  assert.equal(JSON.stringify(cfg), before);
});

test("SECTION 2: with the seed registry (Section 1 not live) the model is the no-registry model, field for field, for every category", () => {
  const w = world();
  const keys = [...new Set(Object.values(w.products).map(policyCategoryKey).filter(Boolean))].sort();
  assert.ok(keys.length > MAPPED.length);
  for (const key of keys) {
    const a = modelOf(w, key, undefined);
    assert.deepEqual(modelOf(w, key, SEED_REGISTRY), a, key);
    assert.deepEqual(modelOf(w, key, live(["marathon-pine"])), a, key);   // a shop alone, its hub not live: still nothing
    assert.deepEqual(a.follows, {});
    for (const l of a.legs) assert.equal(l.follows, null);
  }
});

test("SECTION 2 legs keep their policy when Section 1 goes live: same legs in the same order, same armed set, same numbers and cells", () => {
  // (What a leg would REQUEST can move: Central is shared, and a live Hub 3
  // asks it for the same units Hub 2 does — in the engine as in the model.)
  const w = world();
  const fixed = (l) => ({ loc: l.loc, armed: l.armed, mode: l.mode, shape: l.shape, carriedOnly: l.carriedOnly, target: l.target, minQty: l.minQty,
    reorderPoint: l.reorderPoint, sizes: l.sizes, source: l.source, cells: l.cells, onHand: l.onHand, overrides: l.overrides, legacyRows: l.legacyRows, follows: l.follows });
  for (const key of MAPPED) {
    const a = modelOf(w, key, undefined);
    const b = modelOf(w, key, live());
    const s2 = (m) => m.legs.filter((l) => S2.includes(l.loc)).map(fixed);
    assert.deepEqual(s2(b), s2(a), key);
    assert.deepEqual(b.armedLocations.filter((l) => S2.includes(l)), a.armedLocations, key);
  }
});

test("SECTION 1 LIVE: each follower is listed as an armed destination with the fact of whom it follows — and only when its template is armed", () => {
  const w = world();
  for (const key of MAPPED) {
    const raw = w.config.categoryPolicy[key];
    const m = modelOf(w, key, live());
    const expectFollows = {};
    if (raw.hub2) { expectFollows.hub3 = "hub2"; expectFollows["concrete-stockroom"] = "hub2"; }
    if (raw["marathon-pe"]) { expectFollows["marathon-pine"] = "marathon-pe"; expectFollows.concrete = "marathon-pe"; }
    assert.deepEqual(m.follows, expectFollows, key);
    for (const [loc, from] of Object.entries(expectFollows)) {
      const leg = m.legs.find((l) => l.loc === loc);
      const tpl = m.legs.find((l) => l.loc === from);
      assert.ok(leg, `${key} ${loc}`);
      assert.deepEqual(
        { armed: leg.armed, mode: leg.mode, follows: leg.follows, shape: leg.shape, target: leg.target, minQty: leg.minQty, sizes: leg.sizes },
        { armed: true, mode: "live", follows: from, shape: tpl.shape, target: tpl.target, minQty: tpl.minQty, sizes: tpl.sizes }, `${key} ${loc}`);
    }
    // a Section 1 location whose template is NOT armed for this category is not armed either (Trophy-only categories)
    for (const loc of S1) if (!expectFollows[loc]) assert.equal(m.armedLocations.includes(loc), false, `${key} ${loc}`);
  }
});

test("NOT LIVE is never armed: seed registry, and a registry with only some of Section 1 live", () => {
  const w = world();
  for (const key of MAPPED) {
    assert.deepEqual(modelOf(w, key, SEED_REGISTRY).armedLocations.filter((l) => S1.includes(l)), [], key);
    const part = modelOf(w, key, live(["hub3"]));     // Hub 3 live, nothing else
    assert.deepEqual(part.armedLocations.filter((l) => S1.includes(l) && l !== "hub3"), [], key);
    assert.deepEqual(Object.keys(part.follows).filter((l) => l !== "hub3"), [], key);
  }
});

test("a follower with an entry of its OWN reads its own and is not reported as following", () => {
  const w = world();
  const key = MAPPED.find((k) => w.config.categoryPolicy[k].hub2 && !w.config.categoryPolicy[k].perSize);
  w.config.categoryPolicy[key].hub3 = { target: 1, minQty: 1, reorderPoint: 0 };
  const m = modelOf(w, key, live());
  assert.equal(m.follows.hub3, undefined);
  const leg = m.legs.find((l) => l.loc === "hub3");
  assert.deepEqual({ armed: leg.armed, target: leg.target, follows: leg.follows }, { armed: true, target: 1, follows: null });
  assert.equal(m.follows["concrete-stockroom"], "hub2");
});

test("MODEL vs ENGINE with Section 1 live: requests and units per destination equal computeRefillPlan's, for every mapped category", () => {
  const w = world();
  const network = live(S1, { backStock: { concrete: { bags: "concrete-stockroom" } } });
  const plan = computeRefillPlan({
    nowMs: NOW, config: w.config, targets: w.targets, stock: w.stock, products: w.products,
    openIndex: {}, refillRequests: {}, orders: {}, movements: [], network,
  });
  let s1Requests = 0;
  for (const key of MAPPED) {
    const mine = plan.intents.filter((i) => policyCategoryKey(w.products[i.productId]) === key);
    const m = modelOf(w, key, network);
    // The model walks ONE category against an empty reservation table; the
    // engine walks every category in one pass. Two categories never share a
    // (source, product, size) cell, so per-destination counts are comparable.
    const byDest = (list, f) => list.reduce((o, i) => { o[i.dest] = (o[i.dest] || 0) + f(i); return o; }, {});
    const engineReq = byDest(mine.filter((i) => !i.passThrough), () => 1);
    const modelReq = Object.fromEntries(m.legs.filter((l) => l.wouldRequest > 0).map((l) => [l.loc, l.wouldRequest]));
    assert.deepEqual(modelReq, engineReq, `${key}: requests per destination`);
    const engineUnits = byDest(mine.filter((i) => !i.passThrough), (i) => i.qty);
    const modelUnits = Object.fromEntries(m.legs.filter((l) => l.unitsWanted > 0).map((l) => [l.loc, l.unitsWanted]));
    assert.deepEqual(modelUnits, engineUnits, `${key}: units per destination`);
    assert.equal(m.totalRequests, mine.length, `${key}: total incl. pass-through`);
    s1Requests += S1.reduce((n, l) => n + (modelReq[l] || 0), 0);
  }
  assert.ok(s1Requests > 0, "the fixture must actually produce Section 1 requests, or this proves nothing");
});

// ── THE WRITE PATH STAYS RAW ─────────────────────────────────────────────────
const OWNER = "owner@example.com";
function callableWorld() {
  return {
    network: { locations: Object.fromEntries(S1.map((id) => [id, { live: true }])) },
    config: { refillEngine: {
      maxIntentsPerRun: 75, maxUnitsPerIntent: 20, enabled: true, ruleBasedTargets: false,
      mode: { hub1: "live", hub2: "live", "marathon-pe": "live", trophy: "live" },
      routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
      categoryPolicy: { "caps-beanies": { hub2: { target: 10, minQty: 5, reorderPoint: 0 }, "marathon-pe": { target: 5, minQty: 3, reorderPoint: 0 } } },
    } },
    settings: { productTaxonomy: { cats: { "caps-beanies": { key: "caps-beanies", label: "Caps & Beanies", sizeMode: "one" } } } },
    locations: Object.fromEntries(["central", ...S1, ...S2].map((id) => [id, { kind: "x" }])),
    products: { c1: { name: "Black Cap", categoryKey: "caps-beanies", sizes: ["_"], productType: "clothing" } },
    stock: {
      central: { c1: { _: { qty: 40 } } }, hub2: { c1: { _: { qty: 3 } } }, hub3: { c1: { _: { qty: 2 } } },
      "marathon-pe": { c1: { _: { qty: 1 } } }, "marathon-pine": { c1: { _: { qty: 0 } } },
    },
  };
}
const call = (db, data) => applyCategoryPolicy({ db, callerEmail: OWNER, adminEmail: OWNER, callerUid: "u1", data, nowMs: NOW });

test("CALLABLE census: live Section 1 followers are destinations with `follows`; the stored entry handed back for editing is RAW", async () => {
  const w = callableWorld();
  const db = makeFakeDb(w);
  const res = await call(db, { action: "census" });
  const cb = res.categories.find((c) => c.key === "caps-beanies");
  assert.deepEqual(cb.follows, { "concrete-stockroom": "hub2", hub3: "hub2", "marathon-pine": "marathon-pe", concrete: "marathon-pe" });
  for (const loc of S1) assert.ok(res.destinations.includes(loc), loc);
  // what the card edits and saves: exactly what is stored
  assert.deepEqual(cb.entry, w.config.refillEngine.categoryPolicy["caps-beanies"]);
  assert.deepEqual(cb.effectiveEntry, w.config.refillEngine.categoryPolicy["caps-beanies"]);
  assert.deepEqual(cb.armed.sort(), ["hub2", "marathon-pe"]);
  // and with Section 1 NOT live nothing follows and nothing is added
  __resetNetworkCacheForTests(); invalidateCensusCache();
  const cold = callableWorld(); delete cold.network;
  const res2 = await call(makeFakeDb(cold), { action: "census" });
  assert.deepEqual(res2.categories.find((c) => c.key === "caps-beanies").follows, {});
  assert.deepEqual(res2.destinations.filter((l) => S1.includes(l)), []);
});

test("SAVE ROUND TRIP: census → edit Hub 2's number → save. The node gains no entry for any follower, and the followers follow the NEW number", async () => {
  const w = callableWorld();
  const db = makeFakeDb(w);
  const census = await call(db, { action: "census" });
  const cb = census.categories.find((c) => c.key === "caps-beanies");
  const edited = clone(cb.effectiveEntry);
  edited.hub2.target = 12; edited.hub2.minQty = 6;
  const dry = await call(db, { categoryKey: "caps-beanies", policy: edited, dryRun: true });
  // the preview shows the followers picking the new number up…
  const hub3After = dry.preview.after.legs.find((l) => l.loc === "hub3");
  assert.deepEqual({ target: hub3After.target, follows: hub3After.follows, armed: hub3After.armed }, { target: 12, follows: "hub2", armed: true });
  assert.equal(dry.preview.before.legs.find((l) => l.loc === "hub3").target, 10);
  // …and the dry run wrote nothing
  assert.deepEqual(db.state.root.config.refillEngine, w.config.refillEngine);
  const res = await call(db, { categoryKey: "caps-beanies", policy: edited, expectedBefore: dry.before, ...(dry.token ? { token: dry.token } : {}) });
  assert.equal(res.ok, true);
  const stored = db.state.root.config.refillEngine;
  assert.deepEqual(stored.categoryPolicy["caps-beanies"], edited);
  assert.deepEqual(Object.keys(stored.categoryPolicy["caps-beanies"]).sort(), ["hub2", "marathon-pe"]);
  // no follower anywhere in the stored engine config
  const text = JSON.stringify(stored);
  for (const id of S1) assert.equal(text.includes(`"${id}"`), false, id);
  // the engine, on the stored config, now arms Hub 3 at 12
  const { resolveTarget } = require("../lib/refill-engine.cjs");
  const { withPolicyTemplates } = require("../lib/policy-template.cjs");
  const t = resolveTarget({ targets: {}, config: withPolicyTemplates(stored, live()), products: w.products, stock: w.stock }, "hub3", "c1", "_");
  assert.equal(t.target, 12);
});

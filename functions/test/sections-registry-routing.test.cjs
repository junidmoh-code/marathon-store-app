// ─── THE ENGINE READS THE BACK-STOCK MAPPING ─────────────────────────────────
// config.routes still routes every location it names, exactly as before. A
// LIVE location it does not name is routed by the network registry: a hub from
// Central, a store PER PRODUCT from the hub holding its back stock (the
// product override, else the category, else the store's default).
//
// The synthetic routing fixture throughout (fixtures/sections-routing-fixture.json).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const engine = require("../lib/refill-engine.cjs");
const reg = require("../lib/network-registry.cjs");
const scan = require("../refill-scan.cjs");

const { computeRefillPlan, networkRouting, policyCategoryKey } = engine;
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/sections-routing-fixture.json"), "utf8"));
const NOW_MS = Date.parse("2026-10-01T10:00:00.000Z");
const clone = (v) => JSON.parse(JSON.stringify(v));
const S1 = ["hub3", "marathon-pine", "concrete"];
// Section 1 with BOTH switches off — what the seed shipped as before 7 Oct 2026
// (the seed itself now holds Section 1 Solve on + Auto-refill "solved").
const DARK = reg.normalizeNetwork({ locations: Object.fromEntries(["marathon-pine", "concrete", "hub3"].map((id) => [id, { solve: false, autoRefill: "off" }])) });

const S2 = ["hub1", "hub2", "marathon-pe", "trophy"];
const TODAY = { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" };

// The registry with the named Section 1 locations live. It also carries a
// STORED mapping of Concrete's hoodies, and of ONE tracksuit, to the Concrete
// Stockroom — which does not exist (8 Oct 2026): every test below pins that
// such a record is ignored and Concrete is served by Hub 3 for everything.
// Chosen from the fixture, not hardcoded: a tracksuit Marathon PE has a
// positive explicit row for and Hub 2 holds — so in the world() below Concrete
// wants it and the stockroom can supply it.
const OVERRIDE_PID = Object.values(FIXTURE.products).find((p) => {
  if (p.categoryKey !== "tracksuits") return false;
  const rows = FIXTURE.targets["marathon-pe"][p.id] || {};
  const hub = FIXTURE.stock.hub2[p.id] || {};
  return Object.keys(rows).some((k) => rows[k].target > 0 && hub[k] && hub[k].qty > 0);
}).id;
const liveNetwork = (ids = S1, extra = {}) => reg.normalizeNetwork({
  locations: Object.fromEntries(S1.map((id) => [id, ids.includes(id) ? { live: true } : { solve: false, autoRefill: "off" }])),
  backStock: { concrete: { hoodies: "concrete-stockroom" } },
  productOverrides: { concrete: { [OVERRIDE_PID]: "concrete-stockroom" } },
  ...extra,
});

// A Section 1 world on the fixture: Hub 3 holds what Hub 2
// holds, Pine keeps its own fixture stock, Concrete is new and empty and keeps
// what Marathon PE keeps.
function world({ network, config, uncapped = true } = {}) {
  const cfg = clone(config || FIXTURE.config);
  if (uncapped) { cfg.maxIntentsPerRun = 100000; cfg.maxFootwearIntentsPerRun = 100000; }
  const stock = clone(FIXTURE.stock);
  stock.hub3 = clone(FIXTURE.stock.hub2);
  stock.concrete = {};
  const targets = clone(FIXTURE.targets);
  targets.concrete = clone(FIXTURE.targets["marathon-pe"]);
  targets["marathon-pine"] = clone(FIXTURE.targets["marathon-pe"]);
  return {
    nowMs: NOW_MS, config: cfg, targets, stock, products: clone(FIXTURE.products),
    openIndex: {}, refillRequests: {}, orders: {}, movements: [],
    ...(network !== undefined ? { network } : {}),
  };
}
const section2Only = (list) => list.filter((i) => S2.includes(i.dest));
const lanesOf = (plan) => {
  const out = {};
  for (const i of plan.intents) out[`${i.source}→${i.dest}`] = (out[`${i.source}→${i.dest}`] || 0) + 1;
  return out;
};

// ── the routing table itself ────────────────────────────────────────────────

test("ROUTING: on the seed, the routes are today's four and nothing else", () => {
  for (const network of [undefined, null, DARK]) {
    const r = networkRouting({ routes: TODAY, mode: FIXTURE.config.mode }, network);
    assert.deepEqual(r.routes, TODAY);
    assert.deepEqual(Object.keys(r.routes), Object.keys(TODAY), "same key order");
    assert.deepEqual([...r.stores], []);
    assert.deepEqual([...r.registryRouted], []);
    assert.deepEqual([...r.locs].sort(), ["central", ...S2].sort(), "no Section 1 location is read");
    for (const d of S2) assert.equal(r.modeOf(d), "live");
  }
});

test("ROUTING: the destination order for today's routes is the order the engine has always used", () => {
  const before = Object.keys(TODAY).sort((a, b) => (TODAY[a] === b ? -1 : TODAY[b] === a ? 1 : a.localeCompare(b)));
  assert.deepEqual(networkRouting({ routes: TODAY }, DARK).dests, before);
  // …and Section 1 going live does not reorder them: they still come first.
  assert.deepEqual(networkRouting({ routes: TODAY }, liveNetwork()).dests.slice(0, before.length), before);
});

test("ROUTING: live Section 1 — hubs from Central, stores per product from their back-stock hub", () => {
  const r = networkRouting({ routes: TODAY, mode: FIXTURE.config.mode }, liveNetwork());
  assert.equal(r.routes.hub3, "central");
  assert.equal(r.routes["concrete-stockroom"], undefined, "the Concrete Stockroom does not exist");
  assert.equal(r.routes["marathon-pine"], undefined, "a registry store has no single source");
  assert.deepEqual([...r.stores].sort(), ["concrete", "marathon-pine"]);
  // Section 2 keeps config.routes — NOT the registry's "sneakers → Hub 1".
  const sneaker = Object.values(FIXTURE.products).find((p) => policyCategoryKey(p) === "sneakers");
  assert.equal(reg.backStockFor(liveNetwork(), "marathon-pe", "sneakers", "x"), "hub1", "the registry does say Hub 1");
  assert.equal(r.sourceFor("marathon-pe", sneaker, "x"), "hub2", "…and the engine still uses config.routes");
  assert.equal(r.sourceFor("trophy", sneaker, "x"), "hub2");
  // Pine: Hub 3 for everything.
  assert.equal(r.sourceFor("marathon-pine", { categoryKey: "hoodies" }, "p1"), "hub3");
  assert.equal(r.sourceFor("marathon-pine", sneaker, "p2"), "hub3");
  // Concrete: Hub 3 for everything — the stored Stockroom mappings are ignored.
  assert.equal(r.sourceFor("concrete", { categoryKey: "hoodies" }, "p3"), "hub3");
  assert.equal(r.sourceFor("concrete", { categoryKey: "tracksuits" }, OVERRIDE_PID), "hub3");
  assert.equal(r.sourceFor("concrete", { categoryKey: "tracksuits" }, "p4"), "hub3");
  assert.equal(r.sourceFor("concrete", { category: "Footwear", subcategory: "Sneakers" }, "p5"), "hub3", "keyless legacy sneaker → the default hub");
  assert.deepEqual(r.sourcesOf("concrete"), ["hub3"]);
  assert.deepEqual(r.sourcesOf("marathon-pine"), ["hub3"]);
  // a shop is planned before every hub it can pull from
  for (const shop of ["concrete", "marathon-pine"]) {
    for (const hub of r.sourcesOf(shop)) assert.ok(r.dests.indexOf(shop) < r.dests.indexOf(hub), `${shop} before ${hub}`);
  }
  // the scan's read list: both sections' locations and Central, once each
  assert.deepEqual([...r.locs].sort(), ["central", ...S1, ...S2].sort());
});

test("ROUTING: a location config.routes names keeps that entry, live or not", () => {
  // Hub 3 named in config with a source across the wall: withheld, and the
  // registry does NOT step in to route it from Central.
  const r = networkRouting({ routes: { ...TODAY, hub3: "hub2", "marathon-pine": "hub3" } }, liveNetwork());
  assert.equal(r.routes.hub3, undefined);
  assert.deepEqual(r.withheld, [{ dest: "hub3", source: "hub2", why: "cross_section" }]);
  assert.equal(r.routes["marathon-pine"], "hub3", "Pine's own config entry stands");
  assert.ok(!r.stores.has("marathon-pine"));
  assert.ok(!r.dests.includes("hub3"));
});

test("ROUTING: mode — a config.mode entry always wins; a registry-routed location without one is live", () => {
  const net = liveNetwork();
  const r = networkRouting({ routes: TODAY, mode: { ...FIXTURE.config.mode, hub3: "shadow", concrete: "off" } }, net);
  assert.equal(r.modeOf("hub3"), "shadow");
  assert.equal(r.modeOf("concrete"), "off");
  assert.equal(r.modeOf("marathon-pine"), "live");
  assert.equal(r.modeOf("concrete-stockroom"), "off", "not a location: never routed");
  // A config-routed destination with no mode entry is OFF, as it always was.
  assert.equal(networkRouting({ routes: TODAY, mode: {} }, net).modeOf("hub2"), "off");
});

test("ROUTING: a store whose hub is not live has no leg; a hub that is not live is not read", () => {
  const pineOnly = networkRouting({ routes: TODAY }, liveNetwork(["marathon-pine"]));
  assert.deepEqual([...pineOnly.stores], []);
  assert.ok(!pineOnly.locs.includes("marathon-pine") && !pineOnly.locs.includes("hub3"));
  // Concrete live, Hub 3 not: Concrete has no other hub, so nothing moves for it.
  const r = networkRouting({ routes: TODAY }, liveNetwork(["concrete"]));
  assert.deepEqual([...r.stores], []);
  assert.equal(r.sourceFor("concrete", { categoryKey: "hoodies" }, "p1"), undefined, "Hub 3 is not live");
  assert.ok(!r.locs.includes("hub3"));
});

// ── the plan ────────────────────────────────────────────────────────────────

test("SECTION 2: the plan is identical with no registry, the seed, and Section 1 stock present", () => {
  const none = computeRefillPlan(world({ uncapped: false }));
  const seed = computeRefillPlan(world({ uncapped: false, network: DARK }));
  assert.deepEqual(seed, none);
  for (const i of seed.intents) assert.ok(S2.includes(i.dest), `${i.source}→${i.dest}`);
});

test("NOT LIVE: Section 1 targets, stock and deficits raise nothing while it is not live", () => {
  const plan = computeRefillPlan(world({ network: DARK }));
  assert.ok(plan.intents.length > 0);
  for (const i of plan.intents) assert.ok(!S1.includes(i.dest) && !S1.includes(i.source), `${i.source}→${i.dest}`);
  for (const k of Object.keys(plan.exceptions)) {
    for (const row of plan.exceptions[k].items || []) assert.ok(!S1.includes(row.loc), `${k} lists ${row.loc}`);
  }
  assert.deepEqual(plan.exceptions.shortNotRequested.shops, ["marathon-pe", "trophy"]);
  assert.deepEqual(Object.keys(plan.policy.ruleBasedTargets).sort(), [...S2].sort());
});

test("LIVE: Pine, Concrete and Hub 3 raise the right legs from the right hub (Hub 3 for both shops)", () => {
  const net = liveNetwork();
  const snap = world({ network: net });
  const plan = computeRefillPlan(snap);
  const lanes = lanesOf(plan);
  for (const lane of ["hub3→marathon-pine", "hub3→concrete"]) {
    assert.ok(lanes[lane] > 0, `no ${lane} leg: ${JSON.stringify(lanes)}`);
  }
  const allowed = new Set([
    "central→hub1", "central→hub2", "hub2→marathon-pe", "hub2→trophy",
    "central→hub3", "hub3→marathon-pine", "hub3→concrete",
  ]);
  for (const lane of Object.keys(lanes)) assert.ok(allowed.has(lane), `unexpected lane ${lane}`);

  // Every Concrete leg comes from the hub the registry names for THAT product.
  let fromStockroom = 0, fromHub3 = 0, overridden = 0;
  for (const i of plan.intents.filter((x) => x.dest === "concrete")) {
    const want = reg.backStockFor(net, "concrete", policyCategoryKey(snap.products[i.productId]), i.productId);
    assert.equal(i.source, want, `${i.productId} (${policyCategoryKey(snap.products[i.productId])})`);
    if (i.source === "concrete-stockroom") fromStockroom += 1; else fromHub3 += 1;
    if (i.productId === OVERRIDE_PID) { overridden += 1; assert.equal(i.source, "hub3"); }
  }
  assert.ok(fromStockroom === 0 && fromHub3 > 0, "Concrete pulls from Hub 3 only");
  assert.ok(overridden > 0, "the product a stored record flipped is still refilled — from Hub 3");
  // the category a stored record flipped: every hoodie leg is a Hub 3 leg
  const hoodie = (i) => policyCategoryKey(snap.products[i.productId]) === "hoodies";
  assert.ok(plan.intents.some((i) => i.dest === "concrete" && hoodie(i)), "the fixture raises a Concrete hoodie leg");
  for (const i of plan.intents.filter(hoodie)) {
    if (i.dest === "concrete") assert.equal(i.source, "hub3");
    if (i.dest === "marathon-pine") assert.equal(i.source, "hub3", "Pine's hoodies still come from Hub 3");
  }
  // Pine: Hub 3 for everything
  for (const i of plan.intents.filter((x) => x.dest === "marathon-pine")) assert.equal(i.source, "hub3");
  // every Section 1 leg is live without a config.mode entry
  for (const i of plan.intents.filter((x) => S1.includes(x.dest))) assert.equal(i.mode, "live");
  // the Health check now covers the Section 1 shops too
  assert.deepEqual(plan.exceptions.shortNotRequested.shops, ["concrete", "marathon-pe", "marathon-pine", "trophy"]);
});

test("LIVE: a shop's shortfall its hub cannot cover is carried through — Central → its OWN hub", () => {
  const net = liveNetwork();
  const snap = world({ network: net });
  // Hub 3 holds nothing: every Concrete need must be asked of Central, FOR
  // the hub the registry names for that product — Hub 3, always.
  snap.stock.hub3 = {};
  snap.targets["marathon-pine"] = {};
  const plan = computeRefillPlan(snap);
  const pts = plan.intents.filter((i) => i.passThrough);
  assert.ok(pts.length > 0, "no pass-through leg raised");
  let hub3Legs = 0;
  for (const i of pts.filter((x) => (x.forDests || []).includes("concrete"))) {
    assert.equal(i.source, "central");
    const want = reg.backStockFor(net, "concrete", policyCategoryKey(snap.products[i.productId]), i.productId);
    assert.equal(i.dest, want, `${i.productId} carried through ${i.dest}, its hub is ${want}`);
    assert.equal(i.dest, "hub3");
    hub3Legs += 1;
  }
  assert.ok(hub3Legs > 0, "Concrete's need is carried through Hub 3");
  // and never through a Section 2 hub
  for (const i of pts) if (S2.includes(i.dest)) for (const d of i.forDests) assert.ok(S2.includes(d), `${d} via ${i.dest}`);
  // sneakers are sales-only at the hubs: never a pass-through
  for (const i of pts) assert.equal(engine.passThroughExcluded(snap.products[i.productId]), false);
});

test("LIVE: Section 2's legs are the same legs whether or not Section 1 is live", () => {
  const off = computeRefillPlan(world({ network: DARK }));
  const on = computeRefillPlan(world({ network: liveNetwork() }));
  assert.deepEqual(section2Only(on.intents), section2Only(off.intents));
  // Section 2 destinations are still planned FIRST, so Central's units are
  // offered to them before any Section 1 hub asks.
  assert.deepEqual(on.intents.filter((i) => S2.includes(i.dest)).length, off.intents.length);
});

test("LIVE: a config.mode entry for a Section 1 location wins over the registry", () => {
  const cfg = clone(FIXTURE.config);
  cfg.mode = { ...cfg.mode, "marathon-pine": "shadow", concrete: "off" };
  const plan = computeRefillPlan(world({ network: liveNetwork(), config: cfg }));
  const modes = (dest) => [...new Set(plan.intents.filter((i) => i.dest === dest).map((i) => i.mode))];
  assert.deepEqual(modes("marathon-pine"), ["shadow"]);
  assert.deepEqual(modes("concrete"), ["off"]);
});

test("PARTLY LIVE: Pine live with Hub 3 not live raises nothing for Pine", () => {
  const plan = computeRefillPlan(world({ network: liveNetwork(["marathon-pine"]) }));
  for (const i of plan.intents) assert.ok(S2.includes(i.dest), `${i.source}→${i.dest}`);
});

test("PARTLY LIVE: Concrete live, Hub 3 not — nothing moves for Concrete (Hub 3 is its only hub)", () => {
  const plan = computeRefillPlan(world({ network: liveNetwork(["concrete"]) }));
  for (const i of plan.intents) assert.ok(S2.includes(i.dest), `${i.source}→${i.dest}`);
});

test("WALL: no intent ever crosses it, or touches a location that is not live — over many registries", () => {
  // A small deterministic generator; every registry is passed through
  // normalizeNetwork exactly as /network would be, junk mappings included.
  let seed = 20261002;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const hubs = ["hub1", "hub2", "hub3", "concrete-stockroom"];
  const cats = ["hoodies", "sneakers", "pants", "t-shirts", "tracksuits", "_default"];
  const pids = Object.keys(FIXTURE.products);
  let sawSection1 = 0;
  for (let n = 0; n < 40; n++) {
    const raw = { locations: {}, backStock: {}, productOverrides: {} };
    // a legacy live flag, or the two switches in any combination; some absent (the seed decides)
    for (const id of [...S1, ...S2]) if (rnd() < 0.8) raw.locations[id] = rnd() < 0.4 ? { live: rnd() < 0.7 } : { solve: rnd() < 0.7, autoRefill: pick(["off", "solved", "all"]) };
    for (const store of ["marathon-pine", "concrete", "marathon-pe", "trophy"]) {
      raw.backStock[store] = {};
      for (const c of cats) if (rnd() < 0.5) raw.backStock[store][c] = pick(hubs);          // may name the wrong side
      raw.productOverrides[store] = {};
      for (let k = 0; k < 6; k++) raw.productOverrides[store][pick(pids)] = pick(hubs);     // ditto
    }
    const net = reg.normalizeNetwork(raw);
    // config.routes sometimes loses a Section 2 entry, sometimes gains a wrong one
    const cfg = clone(FIXTURE.config);
    if (rnd() < 0.3) delete cfg.routes[pick(S2)];
    if (rnd() < 0.3) cfg.routes[pick(S1)] = pick([...hubs, "central"]);
    const snap = world({ network: net, config: cfg });
    for (const loc of S1) snap.targets[loc] = snap.targets[loc] || clone(FIXTURE.targets.hub2);
    const plan = computeRefillPlan(snap);
    for (const i of plan.intents) {
      assert.ok(reg.autoRouteAllowed(net, i.source, i.dest), `run ${n}: ${i.source}→${i.dest} is not an allowed leg`);
      assert.ok(reg.wallAllows(net, i.source, i.dest), `run ${n}: ${i.source}→${i.dest} crosses the wall`);
      for (const d of i.forDests || []) assert.ok(reg.autoRouteAllowed(net, i.dest, d), `run ${n}: pass-through ${i.dest}→${d}`);
      if (S1.includes(i.dest)) sawSection1 += 1;
    }
    // …and the scan reads no stock for a location whose Auto-refill is off
    for (const loc of networkRouting(cfg, net).locs) assert.ok(reg.autoRefillOn(net, loc), `run ${n}: ${loc} is read but its Auto-refill is off`);
  }
  assert.ok(sawSection1 > 50, `the generator raised only ${sawSection1} Section 1 legs — it would prove nothing`);
});

test("POOLS: a size refused at both levels is confirmed out on THAT side of the wall only", () => {
  const net = liveNetwork();
  const base = world({ network: net });
  // A clothing cell both Marathon PE and Marathon Pine are sent today.
  const on = computeRefillPlan(base);
  const key = (i) => `${i.productId}|${i.sizeKey}`;
  const pineKeys = new Set(on.intents.filter((i) => i.dest === "marathon-pine").map(key));
  const leg = on.intents.find((i) => i.dest === "marathon-pe" && pineKeys.has(key(i)) && !engine.passThroughExcluded(base.products[i.productId]));
  assert.ok(leg, "the fixture raises the same clothing cell for Marathon PE and Marathon Pine");
  const iso = new Date(NOW_MS - 3600e3).toISOString();
  const denied = (requestingLocation, source) => ({
    productId: leg.productId, size: leg.size, qty: 1, requestingLocation, status: "cancelled",
    createdAt: iso, resolvedAt: iso, createdFrom: { engine: true, source },
  });
  const raised = (plan, dest) => plan.intents.some((i) => i.dest === dest && key(i) === key(leg));
  const outRow = (plan, loc) => plan.exceptions.missingSizes.items.find((r) => r.loc === loc && r.pid === leg.productId && r.size === leg.size && /confirmed out/.test(r.note));
  // `uncapped`: the exception lists are capped at 300 rows for the stored snapshot.
  const run = (refillRequests) => { const snap = world({ network: net }); snap.refillRequests = refillRequests; snap.uncapped = true; return computeRefillPlan(snap); };

  // Section 1 said no at both of ITS levels: Central refused Hub 3, Hub 3 refused Pine.
  const s1 = run({ a: denied("hub3", "central"), b: denied("marathon-pine", "hub3") });
  assert.ok(raised(s1, "marathon-pe"), "Section 2's leg for that size is still raised");
  assert.equal(outRow(s1, "marathon-pe"), undefined);
  assert.ok(!raised(s1, "marathon-pine"));
  assert.equal(outRow(s1, "marathon-pine").note, "denied at both Hub 3 and Central — confirmed out, reorder candidate");

  // The same two refusals inside Section 2 confirm it out there — as today —
  // and say nothing about Pine.
  const s2 = run({ a: denied("hub2", "central"), b: denied("marathon-pe", "hub2") });
  assert.ok(!raised(s2, "marathon-pe"));
  assert.equal(outRow(s2, "marathon-pe").note, "denied at both Hub 2 and Central — confirmed out, reorder candidate", "the note Section 2 has always shown");
  assert.ok(raised(s2, "marathon-pine"), "Pine's leg is still raised");
  assert.equal(outRow(s2, "marathon-pine"), undefined);

  // One level from each side is NOT two levels: Central refused Hub 3, and
  // Hub 2 refused Marathon PE. Nobody is confirmed out.
  const mixed = run({ a: denied("hub3", "central"), b: denied("marathon-pe", "hub2") });
  assert.equal(mixed.exceptions.missingSizes.items.filter((r) => r.pid === leg.productId && r.size === leg.size && /confirmed out/.test(r.note)).length, 0);
  assert.ok(raised(mixed, "marathon-pine"), "Pine was refused by nobody");
});

test("POOLS: a Section 1 deficit holds back none of Hub 2's surplus", () => {
  const off = computeRefillPlan(world({ network: DARK }));
  const on = computeRefillPlan(world({ network: liveNetwork() }));
  const hub2 = (plan) => plan.exceptions.excess.items.filter((r) => S2.includes(r.loc));
  assert.deepEqual(hub2(on), hub2(off));
});

// ── the scan's shop test ────────────────────────────────────────────────────

test("SCAN: the three shop universes are the values the literal list held, and Concrete is a shop", () => {
  const u = scan._shopUniverse;
  for (const network of [null, undefined, DARK, liveNetwork()]) {
    assert.equal(u(network, "marathon-pe"), "central");
    assert.equal(u(network, "trophy"), "central");
    assert.equal(u(network, "marathon-pine"), "pine");
    assert.equal(u(network, "concrete"), "concrete");
    for (const hub of ["hub1", "hub2", "hub3", "concrete-stockroom", "central", "nowhere", "toString", "__proto__"]) {
      assert.equal(u(network, hub), null, hub);
    }
  }
});

test("SCAN: a Concrete shadow plan is a store ORDER; a Hub 3 one is a hub request with the hub in its key", () => {
  const shadowNode = {
    concrete: { p1: { M: { qty: 2, source: "concrete-stockroom", priority: "normal" } } },
    hub3: { p1: { M: { qty: 3, source: "central", priority: "normal" } } },
    hub2: { p1: { M: { qty: 3, source: "central", priority: "normal" } } },
    trophy: { p1: { M: { qty: 1, source: "hub2", priority: "high" } } },
  };
  const upd = scan._shadowSyncUpdates({
    shadowNode, products: { p1: { name: "P" } }, orders: {}, refillRequests: {}, runId: "r", startedAt: "2026-10-02T08:00:00.000Z",
    network: liveNetwork(),
  });
  assert.equal(upd["orders/SHDW-concrete-p1-M"].placedStore, "concrete");
  assert.equal(upd["orders/SHDW-concrete-p1-M"].hub, "concrete-stockroom");
  assert.equal(upd["orders/SHDW-concrete-p1-M"].destShop, "concrete");
  assert.equal(upd["orders/SHDW-trophy-p1-M"].placedStore, "central", "Trophy's value is unchanged");
  assert.ok(upd["refill_requests/SHDWrr-hub3-p1-M"], "Hub 3 shadows as a hub request");
  assert.ok(upd["refill_requests/SHDWrr-p1-M"], "Hub 2 keeps its historic key");
  assert.equal(upd["orders/SHDW-hub3-p1-M"], undefined);
});

// ── the scan's wiring (runScan itself needs firebase-admin; no suite drives it) ─
test("SCAN: the read list, the mode and the write-time wall check come from the registry routing", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "..", "refill-scan.cjs"), "utf8");
  assert.match(SRC, /const routing = engine\.networkRouting\(config, network\);/);
  assert.match(SRC, /const locs = \[\.\.\.new Set\(\[\.\.\.Object\.keys\(liveRoutes\), \.\.\.Object\.values\(liveRoutes\), \.\.\.routing\.locs\]\)\];/);
  assert.match(SRC, /const mode = intent\.mode \|\| "off";/);
  assert.match(SRC, /if \(!networkRegistry\.autoRouteAllowed\(network, source, dest\)\) \{/);
  assert.doesNotMatch(SRC, /UNIVERSE_BY_SHOP\[/);
  // The read list for today's config is the five locations it always was, in
  // the order it always was (stock key order reaches the stored snapshot).
  const r = networkRouting({ routes: TODAY }, DARK);
  assert.deepEqual([...new Set([...Object.keys(r.routes), ...Object.values(r.routes), ...r.locs])],
    ["hub1", "hub2", "marathon-pe", "trophy", "central"]);
});

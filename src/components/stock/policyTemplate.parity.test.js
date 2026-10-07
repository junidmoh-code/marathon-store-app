// ─── THE BROWSER'S POLICY TEMPLATE = THE ENGINE'S ────────────────────────────
// policyTemplate.js is the one browser copy of functions/lib/policy-template.cjs.
// Pinned here, differentially:
//   1. withPolicyTemplates / policyTemplateKey / LOCATION_MAP_KEYS deep-equal
//      the server's over the routing fixture's config and over generated
//      configs and registries;
//   2. enginePlannedLocations is the engine's own destination list
//      (networkRouting(...).dests);
//   3. engineConfigView — the config every stock screen loads — reads, for
//      every location the engine plans, exactly what the engine's templated
//      config reads, and for every other location exactly the stored config;
//   4. the view never mutates the stored config, and a stored config put
//      through the view and "saved" by a careless caller is detectable: the
//      raw node has no follower entries (the round trip the write paths rely
//      on is proved against the real callable in
//      functions/test/category-policy-sections.test.cjs).
import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { normalizeNetwork, SEED_REGISTRY } from "../../utils/networkRegistry.js";
import { withPolicyTemplates, policyTemplateKey, LOCATION_MAP_KEYS, enginePlannedLocations, engineConfigView, followersIn } from "./policyTemplate.js";
import { resolveTarget as seatingResolve } from "./seatingCore.js";

const require = createRequire(import.meta.url);
const server = require("../../../functions/lib/policy-template.cjs");
const engine = require("../../../functions/lib/refill-engine.cjs");
const FIXTURE = require("../../../functions/test/fixtures/sections-routing-fixture.json");

const S1 = ["marathon-pine", "concrete", "hub3", "concrete-stockroom"];
const S2 = ["marathon-pe", "trophy", "hub1", "hub2"];
const ALL = [...S1, ...S2];
// Section 1 with both switches off (the seed before 7 Oct 2026), and with only `ids` fully live.
const OFF = { solve: false, autoRefill: "off" };
const DARK = normalizeNetwork({ locations: Object.fromEntries(S1.map((id) => [id, OFF])) });
const live = (ids = S1, extra = {}) => normalizeNetwork({ locations: Object.fromEntries(S1.map((id) => [id, ids.includes(id) ? { live: true } : OFF])), ...extra });
const clone = (v) => JSON.parse(JSON.stringify(v));

function rng(seedN) { let a = seedN >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function genRegistry(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const locations = {};
  for (const id of ALL) {
    if (r() < 0.75) locations[id] = r() < 0.4 ? { live: r() < 0.7 } : { solve: r() < 0.7, autoRefill: pick(["off", "solved", "all"]) };
    if (locations[id] && r() < 0.25) locations[id].policyLike = pick([...ALL, "ghost", id, ""]);
  }
  if (r() < 0.15) locations.newshop = { type: "store", section: pick([1, 2]), live: r() < 0.7, policyLike: pick(["trophy", "marathon-pe"]) };
  const raw = { locations };
  if (r() < 0.4) raw.backStock = { concrete: { hoodies: pick(["concrete-stockroom", "hub3"]) }, newshop: { _default: pick(["hub2", "hub3"]) } };
  return normalizeNetwork(raw);
}
function genConfig(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const entry = () => pick([{ target: 1 + Math.floor(r() * 9), minQty: 1 }, { sizes: { M: { target: 2 } } }, null, 0, false, "junk", { M: 2, L: 1 }, true]);
  const locMap = () => {
    if (r() < 0.12) return pick([true, false, null, undefined, [], "x"]);
    const m = {};
    for (const id of [...ALL, "newshop"]) if (r() < 0.45) m[id] = entry();
    return m;
  };
  const cfg = { enabled: true, routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" }, mode: { hub2: "live" } };
  for (let m = Math.floor(r() * 3); m > 0; m--) { const k = pick(ALL); if (r() < 0.4) delete cfg.routes[k]; else cfg.routes[k] = pick(["central", ...ALL]); }
  for (const k of LOCATION_MAP_KEYS) if (r() < 0.8) cfg[k] = locMap();
  if (r() < 0.85) { cfg.categoryPolicy = {}; for (const c of ["bags", "belts", "caps"]) if (r() < 0.7) { cfg.categoryPolicy[c] = locMap(); if (cfg.categoryPolicy[c] && typeof cfg.categoryPolicy[c] === "object" && r() < 0.4) cfg.categoryPolicy[c].perSize = true; } }
  if (r() < 0.7) { cfg.policyGroups = {}; for (const g of ["footwear-all", "g2"]) if (r() < 0.7) cfg.policyGroups[g] = pick([{ armed: r() < 0.6, memberCategoryKeys: ["sneakers"], policy: locMap() }, null, "x", { armed: true }]); }
  return cfg;
}

describe("policyTemplate.js is functions/lib/policy-template.cjs", () => {
  it("the map list is the server's", () => {
    expect([...LOCATION_MAP_KEYS]).toEqual([...server.LOCATION_MAP_KEYS]);
  });
  it("withPolicyTemplates on the routing fixture's config: seed registry, Section 1 live, no registry", () => {
    for (const network of [SEED_REGISTRY, live(), live(["hub3"]), undefined, null]) {
      const a = clone(FIXTURE.config); const b = clone(FIXTURE.config);
      expect(withPolicyTemplates(a, network)).toEqual(server.withPolicyTemplates(b, network));
      expect(a).toEqual(FIXTURE.config);             // never mutated
    }
  });
  it("withPolicyTemplates and policyTemplateKey over generated configs and registries — and the same 'untouched is the same object' answer", () => {
    const r = rng(4242);
    let filled = 0;
    const N = 1500;
    for (let i = 0; i < N; i++) {
      const cfg = genConfig(r); const network = genRegistry(r);
      const snapshot = JSON.stringify(cfg);
      const mine = withPolicyTemplates(cfg, network);
      const theirs = server.withPolicyTemplates(cfg, network);
      // (one assertion per world, built cheaply: vitest's expect is the slow part)
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) expect(mine, snapshot).toEqual(theirs);
      if ((mine === cfg) !== (theirs === cfg) || JSON.stringify(cfg) !== snapshot) throw new Error(`identity / mutation differs: ${snapshot}`);
      if (mine !== cfg) filled++;
      const keys = []; const want = [];
      for (const k of LOCATION_MAP_KEYS) for (const loc of [...ALL, "newshop", "ghost"]) {
        keys.push(policyTemplateKey(network, cfg[k], loc)); want.push(server.policyTemplateKey(network, cfg[k], loc));
      }
      expect(keys).toEqual(want);
    }
    expect(filled).toBeGreaterThan(N * 0.6);
    for (const junk of [null, undefined, "x", 7, []]) expect(withPolicyTemplates(junk, SEED_REGISTRY)).toBe(server.withPolicyTemplates(junk, SEED_REGISTRY));
  });
});

describe("enginePlannedLocations is the engine's destination list", () => {
  it("over generated routes and registries, and with no registry at all", () => {
    const r = rng(99);
    const sizes = new Set();
    for (let i = 0; i < 1500; i++) {
      const cfg = genConfig(r); const network = r() < 0.1 ? undefined : genRegistry(r);
      const want = [...engine.networkRouting(cfg, network).dests].sort();
      const got = [...enginePlannedLocations(cfg, network)].sort();
      if (got.join() !== want.join()) expect(got, JSON.stringify(cfg.routes)).toEqual(want);
      sizes.add(want.length);
    }
    expect(sizes.size).toBeGreaterThan(4);
    expect([...enginePlannedLocations(FIXTURE.config, DARK)].sort()).toEqual([...S2].sort());
    // the seed (7 Oct 2026): Section 1's Auto-refill is "solved" — the engine plans it (trusted cells only)
    expect([...enginePlannedLocations(FIXTURE.config, SEED_REGISTRY)].sort()).toEqual([...ALL].sort());
    expect([...enginePlannedLocations(FIXTURE.config, live())].sort()).toEqual([...ALL].sort());
  });
});

describe("engineConfigView — the config every stock screen loads", () => {
  const maps = (cfg) => [
    ...LOCATION_MAP_KEYS.map((k) => cfg?.[k]),
    ...Object.values(cfg?.categoryPolicy && typeof cfg.categoryPolicy === "object" ? cfg.categoryPolicy : {}),
    ...Object.values(cfg?.policyGroups && typeof cfg.policyGroups === "object" ? cfg.policyGroups : {}).map((g) => g && g.policy),
  ];
  const at = (map, loc) => (map && typeof map === "object" && !Array.isArray(map) ? map[loc] : map);

  it("a planned location reads the ENGINE's templated config; any other reads the stored config — over generated configs and registries", () => {
    const r = rng(7);
    let plannedFollows = 0; let unplannedFollowers = 0;
    for (let i = 0; i < 1500; i++) {
      const cfg = genConfig(r); const network = genRegistry(r);
      const snapshot = JSON.stringify(cfg);
      const view = engineConfigView(cfg, network);
      const engineCfg = server.withPolicyTemplates(cfg, network);       // what computeRefillPlan resolves from
      const planned = new Set(engine.networkRouting(cfg, network).dests);
      const [mv, me, mr] = [maps(view), maps(engineCfg), maps(cfg)];
      const got = []; const want = [];
      for (const loc of [...ALL, "newshop"]) {
        for (let k = 0; k < mr.length; k++) {
          // entries are shared by reference with the stored config, so identity is the comparison
          const expectIt = planned.has(loc) ? at(me[k], loc) : at(mr[k], loc);
          got.push(at(mv[k], loc) === expectIt); want.push(true);
          if (at(me[k], loc) !== at(mr[k], loc)) { if (planned.has(loc)) plannedFollows++; else unplannedFollowers++; }
        }
      }
      if (mv.length !== mr.length || got.includes(false)) expect({ got, n: mv.length }, snapshot).toEqual({ got: want, n: mr.length });
      if (JSON.stringify(cfg) !== snapshot) throw new Error("the view mutated the stored config");
      if (engineConfigView(cfg, network) !== view) throw new Error("not memoised");   // one view per (config, registry)
    }
    expect(plannedFollows).toBeGreaterThan(300);
    expect(unplannedFollowers).toBeGreaterThan(300);                    // the engine's config fills them; the view must not
  });

  it("Section 2 only (Section 1 off, or no registry): the stored node itself, the same object", () => {
    expect(engineConfigView(FIXTURE.config, DARK)).toBe(FIXTURE.config);
    expect(engineConfigView(FIXTURE.config, undefined)).toBe(FIXTURE.config);
    expect(engineConfigView(null, live())).toBeNull();
  });

  it("the fixture with Section 1 live: a target mirror (seatingCore.resolveTarget) now arms what the engine arms, and nothing where it is not live", () => {
    const products = FIXTURE.products;
    const stock = clone(FIXTURE.stock);
    stock.hub3 = clone(FIXTURE.stock.hub2);
    const network = live();
    const view = engineConfigView(FIXTURE.config, network);
    const engineCfg = server.withPolicyTemplates(FIXTURE.config, network);
    let armed = 0; let rawArmed = 0; let checked = 0;
    for (const pid of Object.keys(stock.hub3)) {
      // (A deactivated product: the engine resolves nothing; seatingCore does
      // not read the flag — a drift that predates sections and is the same at
      // Hub 2. Left out so this test is about the template alone.)
      if (products[pid]?.deactivated) continue;
      for (const sizeKey of Object.keys(stock.hub3[pid] || {})) {
        const size = (products[pid]?.sizes || []).map(String).find((s) => engine.encodeSizeKey(s) === sizeKey) ?? (sizeKey === "_" ? "" : sizeKey);
        const want = engine.resolveTarget({ targets: {}, config: engineCfg, products, stock }, "hub3", pid, size);
        const got = seatingResolve({ targets: {}, config: view, products, stock }, "hub3", pid, size);
        expect(got?.target ?? null, `${pid} ${sizeKey}`).toBe(want?.target ?? null);
        const raw = seatingResolve({ targets: {}, config: FIXTURE.config, products, stock }, "hub3", pid, size);
        if (want && want.target > 0) armed++;
        if (raw && raw.target > 0) rawArmed++;
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(armed).toBeGreaterThan(20);     // the engine arms Hub 3 from Hub 2's numbers…
    expect(rawArmed).toBe(0);              // …and the raw config (what the screens read before) armed none of it
  });

  it("followersIn: who follows whom in one map — live followers only, and only where the template has an entry", () => {
    const run = FIXTURE.config.defaultRunByStore;
    expect(followersIn(FIXTURE.config, live(), run)).toEqual({ "marathon-pine": "marathon-pe", concrete: "marathon-pe", hub3: "hub2", "concrete-stockroom": "hub2" });
    expect(followersIn(FIXTURE.config, DARK, run)).toEqual({});
    // the seed: Section 1 is planned, so its followers follow
    expect(followersIn(FIXTURE.config, SEED_REGISTRY, run)).toEqual({ "marathon-pine": "marathon-pe", concrete: "marathon-pe", hub3: "hub2", "concrete-stockroom": "hub2" });
    expect(followersIn(FIXTURE.config, live(["hub3"]), run)).toEqual({ hub3: "hub2" });
    expect(followersIn(FIXTURE.config, live(), { ...run, hub3: { M: 1 } }).hub3).toBeUndefined();
    expect(followersIn(FIXTURE.config, live(), { trophy: { M: 1 } })).toEqual({});
  });

  it("A VIEW IS NOT THE STORED NODE: what the view adds is exactly follower entries, so the stored node — the only thing a write path may send — has none", () => {
    const network = live();
    const view = engineConfigView(FIXTURE.config, network);
    expect(view).not.toBe(FIXTURE.config);
    const raw = JSON.stringify(FIXTURE.config);
    for (const id of S1) { expect(raw.includes(`"${id}"`)).toBe(false); expect(JSON.stringify(view).includes(`"${id}"`)).toBe(true); }
    // strip the follower keys from the view and it is the stored node again
    const strip = (v) => (Array.isArray(v) || !v || typeof v !== "object" ? v : Object.fromEntries(Object.entries(v).filter(([k]) => !S1.includes(k)).map(([k, x]) => [k, strip(x)])));
    expect(strip(view)).toEqual(FIXTURE.config);
  });
});

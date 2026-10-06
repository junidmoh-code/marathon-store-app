// ─── SOLVE, BOTH SECTIONS, ONE CONFIRM — the deciding part ───────────────────
// solveSections.js + sectionRouting.js + the hub parameter the Solve functions
// gained. Three promises, each tested for Section 2 (unchanged), Section 1,
// and a location that is not live:
//   • a store's excess goes to ITS OWN hub, from the registry's mapping;
//   • a store that is not live cannot be ticked, and nothing is planned for it;
//   • Central's units are dealt in tick order and never promised twice.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { normalizeNetwork, SEED_REGISTRY } from "../../utils/networkRegistry";
import {
  solveHubFor, solveHubsOfSection, solveStoreBlock,
  storeIds, hubIds, liveSections, centralId, NON_HUB_FLOW_KEYS, net,
} from "./sectionRouting";
import { withPolicyTemplates, engineConfigView } from "./policyTemplate";
import { solveBlocks, allocationOrder, registryOrder, planSectionSolve, mergeSolveUpdates, undoablePaths } from "./solveSections";
import { seedLocations, qualifyingSizes, solvePlan, resolvedRun } from "./solvePlan";
import {
  firstBatchEligible, buildFirstBatchSolveUpdate, firstBatchEstimate, firstBatchSizeHints, firstBatchSplit,
  isFirstBatchShopLeg, hubPresenceSignals, hub2PresenceSignals, EXCLUDED_KEYS, FIRST_BATCH_HUB,
} from "./firstBatchCore";
import { computeMissingProducts, missingProductSections, cardSection } from "./missingProductsCore";

const require = createRequire(import.meta.url);
const server = require("../../../functions/lib/first-batch.cjs");

const S1_LIVE = normalizeNetwork({ locations: { "marathon-pine": { live: true }, concrete: { live: true }, hub3: { live: true }, "concrete-stockroom": { live: true } } });
const TEE = { id: "tee", name: "Tee", productType: "clothing", categoryKey: "t-shirts", sizes: ["S", "M", "L"] };

describe("the hub behind a store comes from the registry", () => {
  it("Section 2: Hub 2 for Marathon PE and Trophy — for every product this tab owns", () => {
    for (const store of ["marathon-pe", "trophy"]) {
      expect(solveHubFor(SEED_REGISTRY, store, TEE)).toBe("hub2");
      expect(solveHubFor(SEED_REGISTRY, store, null, "x")).toBe("hub2");
      expect(solveHubFor(SEED_REGISTRY, store, { id: "b", categoryKey: "bags" })).toBe("hub2");
      // a clothing-typed record carrying a sneaker/slide key is this tab's,
      // and is routed like the rest of the tab — never to Hub 1
      for (const categoryKey of NON_HUB_FLOW_KEYS) expect(solveHubFor(SEED_REGISTRY, store, { id: "c", productType: "clothing", categoryKey })).toBe("hub2");
    }
    expect(solveHubsOfSection(SEED_REGISTRY, 2, TEE)).toEqual(["hub2"]);
    expect(FIRST_BATCH_HUB).toBe("hub2");
  });

  it("Section 1: Hub 3 for Pine and Concrete; Concrete's flipped category, or one product, goes to the Concrete Stockroom", () => {
    expect(solveHubFor(SEED_REGISTRY, "marathon-pine", TEE)).toBe("hub3");
    expect(solveHubFor(SEED_REGISTRY, "concrete", TEE)).toBe("hub3");
    const flipped = normalizeNetwork({ backStock: { concrete: { "t-shirts": "concrete-stockroom" } }, productOverrides: { concrete: { bag9: "concrete-stockroom" } } });
    expect(solveHubFor(flipped, "concrete", TEE)).toBe("concrete-stockroom");
    expect(solveHubFor(flipped, "concrete", { id: "bag1", categoryKey: "bags" })).toBe("hub3");
    expect(solveHubFor(flipped, "concrete", { id: "bag9", categoryKey: "bags" })).toBe("concrete-stockroom");
    expect(solveHubFor(flipped, "marathon-pine", TEE)).toBe("hub3");          // the stockroom serves Concrete only
    expect(solveHubsOfSection(flipped, 1, TEE)).toEqual(["hub3", "concrete-stockroom"]);
  });

  it("the wall holds by construction: no store is ever mapped to a hub of the other section, whatever /network says", () => {
    const hostile = normalizeNetwork({ backStock: { "marathon-pine": { _default: "hub2" }, trophy: { _default: "hub3" } }, productOverrides: { concrete: { tee: "hub1" } } });
    expect(solveHubFor(hostile, "marathon-pine", TEE)).toBe("hub3");
    expect(solveHubFor(hostile, "trophy", TEE)).toBe("hub2");
    expect(solveHubFor(hostile, "concrete", TEE)).toBe("hub3");
  });

  it("the server resolves the same hub (twin pinned): functions/lib/first-batch.cjs hubForShop", () => {
    expect([...server.NON_HUB_FLOW_KEYS]).toEqual([...NON_HUB_FLOW_KEYS]);
    expect([...NON_HUB_FLOW_KEYS]).toEqual([...EXCLUDED_KEYS]);
    const flipped = { backStock: { concrete: { "t-shirts": "concrete-stockroom" } }, productOverrides: { concrete: { bag9: "concrete-stockroom" } } };
    const serverReg = require("../../../functions/lib/network-registry.cjs");
    for (const raw of [null, flipped]) {
      const c = normalizeNetwork(raw), sv = serverReg.normalizeNetwork(raw);
      for (const store of storeIds(c)) {
        for (const p of [TEE, { id: "bag9", categoryKey: "bags" }, { id: "s", productType: "clothing", categoryKey: "sneakers" }, { id: "k", category: "Footwear", subcategory: "Sneakers" }, null]) {
          expect(server.hubForShop(sv, store, p, p?.id ?? "x"), `${store} ${p?.id}`).toBe(solveHubFor(c, store, p, p?.id ?? "x"));
        }
      }
    }
  });

  it("registry lists: Section 2 answers the lists the code used to spell out", () => {
    expect(storeIds(SEED_REGISTRY, { section: 2 })).toEqual(["marathon-pe", "trophy"]);
    expect(hubIds(SEED_REGISTRY, { section: 2 })).toEqual(["hub1", "hub2"]);
    expect(storeIds(SEED_REGISTRY, { section: 1 })).toEqual(["marathon-pine", "concrete"]);
    expect(hubIds(SEED_REGISTRY, { section: 1 })).toEqual(["hub3", "concrete-stockroom"]);
    expect(storeIds(SEED_REGISTRY, { liveOnly: true })).toEqual(["marathon-pe", "trophy"]);
    expect(hubIds(SEED_REGISTRY, { liveOnly: true })).toEqual(["hub1", "hub2"]);
    expect(liveSections(SEED_REGISTRY)).toEqual([2]);
    expect(liveSections(S1_LIVE)).toEqual([1, 2]);
    expect(centralId(SEED_REGISTRY)).toBe("central");
    // a careless second argument (an index from .map) is not a registry
    expect(net(3)).toBe(net(undefined));
  });
});

describe("the live gate and the wall, per store", () => {
  it("a store that is not live cannot be routed to, with a plain reason", () => {
    expect(solveStoreBlock(SEED_REGISTRY, { source: "central", store: "marathon-pine", hub: "hub3" })).toBe("not live yet — counted stock first");
    expect(solveStoreBlock(SEED_REGISTRY, { source: "central", store: "concrete", hub: "hub3" })).toBe("not live yet — counted stock first");
    // the shop live but its hub not
    const shopOnly = normalizeNetwork({ locations: { "marathon-pine": { live: true } } });
    expect(solveStoreBlock(shopOnly, { source: "central", store: "marathon-pine", hub: "hub3" })).toBe("its hub (Hub 3) is not live yet — counted stock first");
  });

  it("Section 2 is open, as it always was; Section 1 is open once live", () => {
    for (const store of ["marathon-pe", "trophy"]) expect(solveStoreBlock(SEED_REGISTRY, { source: "central", store, hub: "hub2" })).toBeNull();
    expect(solveStoreBlock(SEED_REGISTRY, { source: "hub2", store: "trophy", hub: "hub2" })).toBeNull();
    for (const store of ["marathon-pine", "concrete"]) expect(solveStoreBlock(S1_LIVE, { source: "central", store, hub: "hub3" })).toBeNull();
  });

  it("a product stranded at a hub can only be solved into that hub's own stores — never across the wall", () => {
    expect(solveStoreBlock(S1_LIVE, { source: "hub2", store: "marathon-pine", hub: "hub3" })).toMatch(/in the other section — send it back to Central first/);
    expect(solveStoreBlock(S1_LIVE, { source: "hub3", store: "trophy", hub: "hub2" })).toMatch(/in the other section — send it back to Central first/);
    expect(solveStoreBlock(S1_LIVE, { source: "hub3", store: "concrete", hub: "hub3" })).toBeNull();
    // same section, but this store is fed from another hub
    expect(solveStoreBlock(S1_LIVE, { source: "hub3", store: "concrete", hub: "concrete-stockroom" })).toMatch(/Concrete is fed from Concrete Stockroom/);
  });

  it("the blocks: Section 1 (Pine, Concrete) and Section 2 (Marathon PE, Trophy), each store with its hub and its reason", () => {
    const blocks = solveBlocks({ network: SEED_REGISTRY, sections: [2, 1], source: "central", product: TEE, productId: "tee" });
    expect(blocks.map((b) => [b.section, b.name, b.stores.map((s) => s.id)])).toEqual([
      [1, "Section 1", ["marathon-pine", "concrete"]],
      [2, "Section 2", ["marathon-pe", "trophy"]],
    ]);
    expect(blocks[0].stores.map((s) => [s.hub, s.blocked])).toEqual([["hub3", "not live yet — counted stock first"], ["hub3", "not live yet — counted stock first"]]);
    expect(blocks[1].stores.map((s) => [s.name, s.hub, s.hubName, s.blocked])).toEqual([["Marathon PE", "hub2", "Hub 2", null], ["Trophy", "hub2", "Hub 2", null]]);
    // a viewer who may see one section gets one block
    expect(solveBlocks({ network: SEED_REGISTRY, sections: [2], source: "central" }).map((b) => b.section)).toEqual([2]);
  });
});

describe("the Solve functions take the hub — Hub 2 by default, so Section 2 is untouched", () => {
  const std = { hub2: { S: 2, M: 3 }, hub3: { S: 1, M: 2 }, "marathon-pe": { S: 2, M: 2 }, "marathon-pine": { M: 2 } };
  it("seedLocations / qualifyingSizes", () => {
    expect(seedLocations("central", "trophy")).toEqual(["hub2", "trophy"]);
    expect(seedLocations("hub2", "trophy")).toEqual(["trophy"]);
    expect(seedLocations("central", "marathon-pine", "hub3")).toEqual(["hub3", "marathon-pine"]);
    expect(seedLocations("hub3", "marathon-pine", "hub3")).toEqual(["marathon-pine"]);
    expect(qualifyingSizes(["S", "M"], "central", "marathon-pe", std)).toEqual(["S", "M"]);
    expect(qualifyingSizes(["S", "M"], "central", "marathon-pe", std, "hub2")).toEqual(["S", "M"]);
    // Pine has no S target; Hub 3 has both
    expect(qualifyingSizes(["S", "M"], "central", "marathon-pine", std, "hub3")).toEqual(["M"]);
    // judged against the STORE'S hub: Pine against Hub 2 would need Hub 2's run, not Hub 3's
    expect(qualifyingSizes(["M"], "central", "marathon-pine", { "marathon-pine": { M: 2 }, hub2: { M: 3 } }, "hub3")).toEqual([]);
  });

  it("solvePlan: the hub's buffer leg and cover are the store's hub's", () => {
    const availAt = (loc) => ({ central: 9, hub2: 1, hub3: 5 }[loc] ?? 0);
    expect(solvePlan({ std, sizes: ["S", "M"], source: "central", store: "marathon-pe", availAt })).toEqual({ sizes: ["S", "M"], storeUnits: 4, twoLeg: true, hubUnits: 5, cover: 5, coverLoc: "Central" });
    expect(solvePlan({ std, sizes: ["S", "M"], source: "hub2", store: "marathon-pe", availAt })).toEqual({ sizes: ["S", "M"], storeUnits: 4, twoLeg: false, cover: 2, coverLoc: "Hub 2" });
    expect(solvePlan({ std, sizes: ["M"], source: "central", store: "marathon-pine", availAt, hub: "hub3" })).toEqual({ sizes: ["M"], storeUnits: 2, twoLeg: true, hubUnits: 2, cover: 2, coverLoc: "Central" });
    expect(solvePlan({ std, sizes: ["M"], source: "hub3", store: "marathon-pine", availAt, hub: "hub3" })).toEqual({ sizes: ["M"], storeUnits: 2, twoLeg: false, cover: 2, coverLoc: "Hub 3" });
  });

  it("firstBatchEligible: the store's route must run through ITS hub, and the presence judged is that hub's", () => {
    const routes = { "marathon-pe": "hub2", "marathon-pine": "hub3", concrete: "hub2" };
    const base = { source: "central", product: TEE, routes, enabled: true, hub2Present: false };
    expect(firstBatchEligible({ ...base, store: "marathon-pe" })).toBe(true);
    expect(firstBatchEligible({ ...base, store: "marathon-pe", hub: "hub2" })).toBe(true);
    expect(firstBatchEligible({ ...base, store: "marathon-pine", hub: "hub3" })).toBe(true);
    expect(firstBatchEligible({ ...base, store: "marathon-pine" })).toBe(false);              // Pine is not routed via Hub 2
    expect(firstBatchEligible({ ...base, store: "concrete", hub: "hub3" })).toBe(false);      // a route across the wall is not its hub's
    expect(firstBatchEligible({ ...base, store: "marathon-pine", hub: "hub3", hub2Present: true })).toBe(false);
    expect(firstBatchEligible({ ...base, store: "marathon-pine", hub: null })).toBe(false);
    expect(firstBatchEligible({ ...base, store: "trophy", routes: {} })).toBe(false);         // no route named: the old Solve, as always
  });

  it("buildFirstBatchSolveUpdate seeds the store's hub and names it on the request; the default is byte-for-byte Hub 2's", () => {
    const split = { firstBatch: [{ size: "M", qty: 2, target: 2, avail: 4 }], normal: ["S"], held: [] };
    let n = 0;
    const args = { pid: "tee", split, existing: {}, seedCell: () => ({ qty: 0 }), nowIso: "t", uid: "u", solveId: "fb", newKey: () => `r${++n}` };
    const s2 = buildFirstBatchSolveUpdate({ ...args, store: "trophy" });
    n = 0;
    expect(buildFirstBatchSolveUpdate({ ...args, store: "trophy", hub: "hub2" })).toEqual(s2);
    expect(Object.keys(s2.updates).sort()).toEqual(["refill_requests/r1", "stock/hub2/tee/M", "stock/hub2/tee/S", "stock/trophy/tee/M", "stock/trophy/tee/S"]);
    expect(s2.updates["refill_requests/r1"].createdFrom).toMatchObject({ hub: "hub2", store: "trophy", hub2Seeded: ["M"] });
    n = 0;
    const s1 = buildFirstBatchSolveUpdate({ ...args, store: "marathon-pine", hub: "hub3" });
    expect(Object.keys(s1.updates).sort()).toEqual(["refill_requests/r1", "stock/hub3/tee/M", "stock/hub3/tee/S", "stock/marathon-pine/tee/M", "stock/marathon-pine/tee/S"]);
    expect(s1.updates["refill_requests/r1"]).toMatchObject({ requestingLocation: "marathon-pine", createdFrom: { hub: "hub3", store: "marathon-pine", source: "central", hub2Seeded: ["M"] } });
    expect(Object.keys(s1.updates).some((k) => k.includes("hub2"))).toBe(false);
  });

  it("firstBatchEstimate / firstBatchSizeHints read and name the store's hub", () => {
    const split = { firstBatch: [{ size: "M", qty: 2 }], normal: [], held: [] };
    const run = { hub2: { M: 3 }, hub3: { M: 5 } };
    expect(firstBatchEstimate({ split, run }).hubAfter).toBe(3);
    expect(firstBatchEstimate({ split, run, hub: "hub3" }).hubAfter).toBe(5);
    const history = { key: "t-shirts", byStore: { trophy: { siblingCells: 0, categoryCarried: 12, sizeCarried: { M: 3 } }, "marathon-pine": { siblingCells: 0, categoryCarried: 12, sizeCarried: { M: 3 } } } };
    expect(firstBatchSizeHints({ history, store: "trophy", sizes: ["S"], labels: { trophy: "Trophy" } }).S.why)
      .toBe("S stays at Hub 2 first — none of the 12 t-shirts lines at Trophy carries S; the engine sends it to Trophy from Hub 2 when needed.");
    expect(firstBatchSizeHints({ history, store: "marathon-pine", sizes: ["S"], labels: { "marathon-pine": "Marathon Pine" }, hub: "hub3" }).S.why)
      .toBe("S stays at Hub 3 first — none of the 12 t-shirts lines at Marathon Pine carries S; the engine sends it to Marathon Pine from Hub 3 when needed.");
  });

  it("a hub's own leg is never a shop leg — Hub 3's as much as Hub 2's", () => {
    const leg = (loc) => ({ requestingLocation: loc, createdFrom: { firstBatch: true } });
    expect(isFirstBatchShopLeg(leg("trophy"))).toBe(true);
    expect(isFirstBatchShopLeg(leg("marathon-pe"))).toBe(true);
    expect(isFirstBatchShopLeg(leg("hub2"))).toBe(false);
    expect(isFirstBatchShopLeg(leg("marathon-pine"))).toBe(true);
    expect(isFirstBatchShopLeg(leg("hub3"))).toBe(false);
    expect(isFirstBatchShopLeg(leg("concrete-stockroom"))).toBe(false);
    expect([leg("trophy"), leg("hub3")].filter(isFirstBatchShopLeg)).toHaveLength(1);   // .filter passes an index — ignored
    expect(isFirstBatchShopLeg({ requestingLocation: "trophy", createdFrom: {} })).toBe(false);
  });

  it("presence under hub-neutral names is the same test", () => {
    const args = { sinceIso: "2026-10-02T09:00:00.000Z", pid: "tee" };
    const node = { M: { qty: 2 } };
    expect(hubPresenceSignals({ ...args, hubNode: node })).toEqual(hub2PresenceSignals({ ...args, hub2Node: node }));
    expect(hubPresenceSignals({ ...args, hubLocks: { M: { createdAt: "2026-10-01T00:00:00.000Z" } }, hubOpenRequestIds: ["r"], heldLines: { a: { productId: "tee" } } }))
      .toEqual(["engine_lock", "open_hub2_request", "held_inbound"]);
    expect(hubPresenceSignals(args)).toEqual([]);
  });
});

describe("the same policy for every store unless it has its own (policyTemplate.js — the one browser copy, pinned to the engine in policyTemplate.parity.test.js)", () => {
  const run = { "marathon-pe": { M: 2 }, hub2: { M: 3 }, trophy: { M: 1 } };
  const ROUTES = { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" };
  it("the template step: Section 1 locations read their template; a store-specific entry always wins; a config with nothing to fill is the same object", () => {
    const cfg = { defaultRunByStore: run };
    const t = withPolicyTemplates(cfg, SEED_REGISTRY).defaultRunByStore;
    expect(t).toEqual({ ...run, "marathon-pine": { M: 2 }, concrete: { M: 2 }, hub3: { M: 3 }, "concrete-stockroom": { M: 3 } });
    expect(withPolicyTemplates({ defaultRunByStore: { ...run, concrete: { M: 9 } } }, SEED_REGISTRY).defaultRunByStore.concrete).toEqual({ M: 9 });
    expect(withPolicyTemplates(null, SEED_REGISTRY)).toBeNull();
    const none = { routes: ROUTES, enabled: true };
    expect(withPolicyTemplates(none, SEED_REGISTRY)).toBe(none);
  });

  it("the config a screen reads: size run, subcategory run, each category's policy and the per-destination switch — for LIVE followers only", () => {
    const cfg = {
      defaultRunByStore: run,
      subcategoryRunByLocation: { "marathon-pe": { Watches: 2 } },
      ruleBasedTargets: { "marathon-pe": true, hub2: true, concrete: false },
      categoryPolicy: { bags: { perSize: false, "marathon-pe": { target: 2 }, hub2: { target: 4 } } },
      routes: ROUTES,
    };
    const before = JSON.stringify(cfg);
    const t = engineConfigView(cfg, S1_LIVE);
    expect(t.defaultRunByStore["marathon-pine"]).toEqual({ M: 2 });
    expect(t.subcategoryRunByLocation.concrete).toEqual({ Watches: 2 });
    expect(t.categoryPolicy.bags).toEqual({ perSize: false, "marathon-pe": { target: 2 }, hub2: { target: 4 }, "marathon-pine": { target: 2 }, concrete: { target: 2 }, hub3: { target: 4 }, "concrete-stockroom": { target: 4 } });
    expect(t.ruleBasedTargets).toMatchObject({ "marathon-pine": true, hub3: true, concrete: false });   // an explicit false is its own entry
    expect(t.routes).toBe(cfg.routes);                                                                  // routes are not a policy
    expect(JSON.stringify(cfg)).toBe(before);                                                           // a view: the stored node is not touched
    // Section 1 NOT live (the seed): the very same object — nothing follows anything
    expect(engineConfigView(cfg, SEED_REGISTRY)).toBe(cfg);
    // only Hub 3 live: Hub 3 follows, Pine (not live) reads what is stored — nothing
    const part = engineConfigView(cfg, normalizeNetwork({ locations: { hub3: { live: true } } }));
    expect(part.defaultRunByStore.hub3).toEqual({ M: 3 });
    expect(part.defaultRunByStore["marathon-pine"]).toBeUndefined();
    expect(part.categoryPolicy.bags["marathon-pine"]).toBeUndefined();
  });

  it("through resolvedRun, a live Pine qualifies exactly where Marathon PE does", () => {
    const cfg = engineConfigView({ routes: ROUTES, defaultRunByStore: { "marathon-pe": { S: 2, M: 2 }, hub2: { S: 2, M: 3 } }, ruleBasedTargets: true }, S1_LIVE);
    const r = resolvedRun({ std: cfg.defaultRunByStore, sizes: ["S", "M", "L"], targets: {}, pid: "tee", ruleBasedTargets: cfg.ruleBasedTargets });
    expect(qualifyingSizes(["S", "M", "L"], "central", "marathon-pine", r, "hub3")).toEqual(qualifyingSizes(["S", "M", "L"], "central", "marathon-pe", r, "hub2"));
    expect(qualifyingSizes(["S", "M", "L"], "central", "marathon-pine", r, "hub3")).toEqual(["S", "M"]);
  });
});

describe("Central runs short across two sections — dealt in tick order, never the same unit twice", () => {
  const run = { "marathon-pe": { S: 2, M: 2 }, trophy: { S: 2, M: 2 }, "marathon-pine": { S: 2, M: 2 }, concrete: { S: 2, M: 2 } };
  const info = (hubs) => (store) => ({ hub: hubs[store], sizes: ["S", "M"], eligible: true });
  const HUBS = { "marathon-pe": "hub2", trophy: "hub2", "marathon-pine": "hub3", concrete: "hub3" };
  const central = { S: 3, M: 5 };
  const plan = (stores, over = {}) => planSectionSolve({ stores, storeInfo: info(HUBS), run, centralFree: (sz) => central[sz] || 0, maxUnitsPerIntent: 20, ...over });

  it("one store: exactly firstBatchSplit's own answer (the single-store Solve it replaced)", () => {
    const p = plan(["marathon-pe"]);
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0].split).toEqual(firstBatchSplit({ sizes: ["S", "M"], run, store: "marathon-pe", centralAvail: (sz) => central[sz], maxUnitsPerIntent: 20 }));
    expect(p.lines[0]).toMatchObject({ store: "marathon-pe", hub: "hub2", firstBatch: true, units: 4, got: [{ size: "S", qty: 2 }, { size: "M", qty: 2 }] });
    expect([p.centralLeft("S"), p.centralLeft("M")]).toEqual([1, 3]);
  });

  it("three stores over 3 S and 5 M: the first ticked is served first, the last gets what is left", () => {
    const p = plan(["marathon-pine", "trophy", "marathon-pe"]);
    expect(p.lines.map((l) => [l.store, l.hub, l.got])).toEqual([
      ["marathon-pine", "hub3", [{ size: "S", qty: 2 }, { size: "M", qty: 2 }]],
      ["trophy", "hub2", [{ size: "S", qty: 1 }, { size: "M", qty: 2 }]],
      ["marathon-pe", "hub2", [{ size: "M", qty: 1 }]],
    ]);
    // the size Central ran out of takes the normal path for the last store
    expect(p.lines[2].split.normal).toEqual(["S"]);
    // NEVER THE SAME UNIT TWICE: the total dealt per size is at most what Central held
    for (const sz of ["S", "M"]) {
      const dealt = p.lines.reduce((t, l) => t + (l.got.find((g) => g.size === sz)?.qty || 0), 0);
      expect(dealt).toBeLessThanOrEqual(central[sz]);
      expect(p.centralLeft(sz)).toBe(central[sz] - dealt);
    }
  });

  it("the order ticked decides: reversed, the other store is short", () => {
    const a = plan(["marathon-pe", "marathon-pine"], { centralFree: (sz) => ({ S: 3, M: 3 }[sz]) });
    const b = plan(["marathon-pine", "marathon-pe"], { centralFree: (sz) => ({ S: 3, M: 3 }[sz]) });
    expect(a.lines.map((l) => [l.store, l.units])).toEqual([["marathon-pe", 4], ["marathon-pine", 2]]);
    expect(b.lines.map((l) => [l.store, l.units])).toEqual([["marathon-pine", 4], ["marathon-pe", 2]]);
  });

  it("is deterministic, and a fuzz never over-deals Central", () => {
    let seed = 7;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 300; i++) {
      const stores = ["marathon-pe", "trophy", "marathon-pine", "concrete"].filter(() => rnd(2)).sort(() => rnd(3) - 1);
      const c = { S: rnd(6), M: rnd(6) };
      const args = { stores, storeInfo: info(HUBS), run, centralFree: (sz) => c[sz], maxUnitsPerIntent: 1 + rnd(3) };
      const p = planSectionSolve(args);
      expect(planSectionSolve(args).lines).toEqual(p.lines);
      for (const sz of ["S", "M"]) {
        expect(p.lines.reduce((t, l) => t + (l.got.find((g) => g.size === sz)?.qty || 0), 0)).toBeLessThanOrEqual(c[sz]);
      }
    }
  });

  it("a store off the first-batch path takes nothing from Central in the Solve itself", () => {
    const p = planSectionSolve({
      stores: ["trophy", "marathon-pe"], run, centralFree: (sz) => central[sz], maxUnitsPerIntent: 20,
      storeInfo: (s) => ({ hub: "hub2", sizes: ["S", "M"], eligible: s === "marathon-pe" }),
    });
    expect(p.lines[0]).toMatchObject({ store: "trophy", split: null, firstBatch: false, units: 0, got: [] });
    expect(p.lines[1].got).toEqual([{ size: "S", qty: 2 }, { size: "M", qty: 2 }]);
  });

  it("the order is the order ticked; an untickable or repeated store is dropped; a set falls in registry order", () => {
    expect(allocationOrder({ network: S1_LIVE, ticked: ["trophy", "marathon-pine", "trophy", "nowhere", "marathon-pe"] })).toEqual(["trophy", "marathon-pine", "marathon-pe"]);
    expect(allocationOrder({ network: SEED_REGISTRY, ticked: ["marathon-pine", "trophy"], tickable: (s) => s !== "marathon-pine" })).toEqual(["trophy"]);
    expect(registryOrder(SEED_REGISTRY, ["trophy", "concrete", "marathon-pe", "marathon-pine", "trophy"])).toEqual(["marathon-pine", "concrete", "marathon-pe", "trophy"]);
  });
});

describe("one update, and an undo that leaves a shared hub seeded", () => {
  it("merges stores' parts: a seed two stores share is written once", () => {
    const a = { "stock/hub2/p/M": { qty: 0, n: 1 }, "stock/marathon-pe/p/M": { qty: 0 }, "refill_requests/r1": { x: 1 } };
    const b = { "stock/hub2/p/M": { qty: 0, n: 2 }, "stock/trophy/p/M": { qty: 0 }, "refill_requests/r2": { x: 2 } };
    const m = mergeSolveUpdates([a, b]);
    expect(Object.keys(m).sort()).toEqual(["refill_requests/r1", "refill_requests/r2", "stock/hub2/p/M", "stock/marathon-pe/p/M", "stock/trophy/p/M"]);
    expect(m["stock/hub2/p/M"].n).toBe(1);
    expect(mergeSolveUpdates([])).toEqual({});
  });

  it("an undo deletes only what no other standing solve of the product also wrote", () => {
    const pe = { key: "a", pid: "p", paths: ["stock/hub2/p/M", "stock/marathon-pe/p/M"] };
    const tr = { key: "b", pid: "p", paths: ["stock/hub2/p/M", "stock/trophy/p/M"] };
    const other = { key: "c", pid: "q", paths: ["stock/hub2/q/M"] };
    expect(undoablePaths(pe, [pe, tr, other])).toEqual(["stock/marathon-pe/p/M"]);
    // once Trophy's has been undone (gone from the list), Marathon PE's undo takes the hub seed too
    expect(undoablePaths(pe, [pe, other])).toEqual(pe.paths);
    // a one-store solve: every path, as before
    expect(undoablePaths(pe, [pe])).toEqual(pe.paths);
    expect(undoablePaths(pe, null)).toEqual(pe.paths);
  });
});

describe("Missing Products is evaluated per section", () => {
  const cell = (qty) => ({ qty });
  const products = [TEE, { id: "cap", name: "Cap", productType: "clothing", sizes: ["_"] }, { id: "bag", name: "Bag", productType: "clothing", categoryKey: "bags", sizes: ["_"] }];
  const allStock = {
    central: { tee: { M: cell(4) }, cap: { _: cell(2) }, bag: { _: cell(3) } },
    "marathon-pe": { tee: { M: cell(1) } },       // Section 2 carries the tee
    hub3: { cap: { _: cell(5) } },                // Hub 3 holds the cap; no Section 1 shop carries it
    hub2: { bag: { _: cell(1) } },                // Hub 2 holds the bag; no Section 2 shop carries it
  };

  it("Section 2 (the default) is the list it always was: Central ∪ Hub 2 upstream, Marathon PE and Trophy downstream", () => {
    const def = computeMissingProducts({ allStock, products });
    expect(def.map((c) => [c.pid, c.source, c.kind, c.missing])).toEqual([
      ["cap", "central", "Only in Central", ["hub2", "marathon-pe", "trophy"]],
      ["bag", "hub2", "Only in Hub 2", ["marathon-pe", "trophy"]],
    ]);
    expect(def.every((c) => !("section" in c))).toBe(true);
    // naming Section 2 gives the same cards, stamped
    const named = computeMissingProducts({ allStock, products, network: SEED_REGISTRY, section: 2 });
    expect(named.map(({ section, ...c }) => c)).toEqual(def);
    expect(named.every((c) => c.section === 2)).toBe(true);
    expect(cardSection(def[0], SEED_REGISTRY)).toBe(2);
  });

  it("Section 1 lists ITS stranded stock: carried at Marathon PE says nothing about Section 1; Hub 2's stock is not Section 1's", () => {
    const s1 = computeMissingProducts({ allStock, products, network: SEED_REGISTRY, section: 1 });
    // (largest stranded first: the cap's 5 at Hub 3, the tee's 4, the bag's 3)
    expect(s1.map((c) => [c.pid, c.source, c.kind, c.missing, c.section])).toEqual([
      ["cap", "hub3", "Only in Hub 3", ["marathon-pine", "concrete"], 1],
      ["tee", "central", "Only in Central", ["hub3", "marathon-pine", "concrete"], 1],
      ["bag", "central", "Only in Central", ["hub3", "marathon-pine", "concrete"], 1],
    ]);
    expect(cardSection(s1[0], SEED_REGISTRY)).toBe(1);
  });

  it("a section's hubs follow the mapping: a category Concrete keeps at the Concrete Stockroom is 'carried' there", () => {
    const flipped = normalizeNetwork({ backStock: { concrete: { bags: "concrete-stockroom" } } });
    const stock = { central: { bag: { _: cell(3) } }, "concrete-stockroom": { bag: { _: cell(0) } } };
    // the stockroom carries it (a qty-0 cell is carriage) → not "only in Central" for Section 1
    expect(computeMissingProducts({ allStock: stock, products, network: flipped, section: 1 })).toEqual([]);
    expect(computeMissingProducts({ allStock: stock, products, network: SEED_REGISTRY, section: 1 }).map((c) => c.pid)).toEqual(["bag"]);
  });

  it("the lists a screen builds by itself are the sections with a live shop", () => {
    expect(missingProductSections(SEED_REGISTRY)).toEqual([2]);
    expect(missingProductSections(S1_LIVE)).toEqual([1, 2]);
  });
});

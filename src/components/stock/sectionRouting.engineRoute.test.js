// ─── THE CLIENT'S "WHERE DOES THE ENGINE REFILL THIS STORE FROM" = THE ENGINE'S ─
// sectionRouting.engineSourceFor is a browser twin of the engine's
// networkRouting(...).sourceFor (functions/lib/refill-engine.cjs). The first
// batch Solve asks it before it starts a shop's first batch from Central, so
// it must never say "routed via its hub" where the engine would not then
// refill the shop from that hub. Pinned here over generated routes and
// registries, and used to prove the production case: a LIVE Section 1 shop
// (no config.routes entry) is eligible at ITS hub; one that is not live is not.
import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { normalizeNetwork, SEED_REGISTRY } from "../../utils/networkRegistry.js";
import { engineSourceFor, solveHubFor } from "./sectionRouting.js";
import { firstBatchEligible } from "./firstBatchCore.js";

const require = createRequire(import.meta.url);
const { networkRouting } = require("../../../functions/lib/refill-engine.cjs");
const FIXTURE = require("../../../functions/test/fixtures/sections-routing-fixture.json");

const S1 = ["marathon-pine", "concrete", "hub3", "concrete-stockroom"];
const S2 = ["marathon-pe", "trophy", "hub1", "hub2"];
const live = (ids = S1, extra = {}) => normalizeNetwork({ locations: Object.fromEntries(ids.map((id) => [id, { live: true }])), ...extra });
const PROD_ROUTES = { hub1: "central", hub2: "central", trophy: "hub2", "marathon-pe": "hub2" };
const TEE = { id: "tee", name: "Tee", productType: "clothing", categoryKey: "t-shirts", sizes: ["M"] };
const PRODUCTS = [
  TEE, { id: "hd", categoryKey: "hoodies" }, { id: "sn", category: "Footwear", subcategory: "Sneakers" }, { id: "sk", categoryKey: "sneakers" },
  { id: "sl", categoryKey: "slides" }, { id: "ov", categoryKey: "bags" }, { id: "none" }, null,
];

function rng(seedN) { let a = seedN >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

describe("engineSourceFor is the engine's sourceFor", () => {
  it("over generated config.routes and registries, for every location and product", () => {
    const r = rng(77);
    const pick = (a) => a[Math.floor(r() * a.length)];
    const ALL = [...S1, ...S2];
    let n = 0; const seen = new Set();
    for (let i = 0; i < 1500; i++) {
      const routes = { ...PROD_ROUTES };
      for (let m = Math.floor(r() * 4); m > 0; m--) { const k = pick(ALL); if (r() < 0.4) delete routes[k]; else routes[k] = pick(["central", ...ALL, "ghost"]); }
      const raw = { locations: Object.fromEntries(ALL.filter(() => r() < 0.8).map((id) => [id, { live: r() < 0.7 }])) };
      if (r() < 0.5) raw.backStock = { concrete: { [pick(["hoodies", "t-shirts", "sneakers"])]: pick(["concrete-stockroom", "hub3", "hub2"]) }, "marathon-pine": { hoodies: pick(["hub3", "concrete-stockroom"]) } };
      if (r() < 0.5) raw.productOverrides = { concrete: { ov: pick(["concrete-stockroom", "hub2"]) }, trophy: { ov: "hub1" } };
      const network = normalizeNetwork(raw);
      const routing = networkRouting({ routes }, network);
      for (const loc of ALL) for (const p of PRODUCTS) {
        const pid = p ? p.id : "nil";
        const want = routing.sourceFor(loc, p, pid);
        expect(engineSourceFor(network, routes, loc, p, pid), JSON.stringify({ loc, pid, routes, raw })).toBe(want);
        n++; seen.add(String(want));
      }
    }
    expect(n).toBe(1500 * 8 * 8);
    for (const src of ["undefined", "central", "hub1", "hub2", "hub3", "concrete-stockroom"]) expect(seen.has(src), src).toBe(true);
  });
  it("on the routing fixture's own config, seed registry and Section 1 live", () => {
    for (const network of [SEED_REGISTRY, live()]) {
      const routing = networkRouting(FIXTURE.config, network);
      for (const loc of [...S1, ...S2]) for (const p of Object.values(FIXTURE.products).slice(0, 200)) {
        expect(engineSourceFor(network, FIXTURE.config.routes, loc, p, p.id)).toBe(routing.sourceFor(loc, p, p.id));
      }
    }
  });
});

describe("first batch: a LIVE Section 1 shop is on the path at its own hub (production-shaped routes: Section 2 only)", () => {
  const base = { source: "central", product: TEE, productId: "tee", routes: PROD_ROUTES, hub2Present: false };
  it("Pine and Concrete, live, with no config.routes entry → eligible at Hub 3", () => {
    const network = live();
    for (const store of ["marathon-pine", "concrete"]) {
      const hub = solveHubFor(network, store, TEE, "tee");
      expect(hub).toBe("hub3");
      expect(firstBatchEligible({ ...base, network, store, hub })).toBe(true);
      expect(firstBatchEligible({ ...base, network, store, hub: "hub2" })).toBe(false);          // never Hub 2's
      expect(firstBatchEligible({ ...base, network, store, hub, hub2Present: true })).toBe(false); // Hub 3 already holds it
    }
  });
  it("Concrete's category or product mapped to the Concrete Stockroom → eligible THERE, not at Hub 3", () => {
    for (const extra of [{ backStock: { concrete: { "t-shirts": "concrete-stockroom" } } }, { productOverrides: { concrete: { tee: "concrete-stockroom" } } }]) {
      const network = live(S1, extra);
      const hub = solveHubFor(network, "concrete", TEE, "tee");
      expect(hub).toBe("concrete-stockroom");
      expect(firstBatchEligible({ ...base, network, store: "concrete", hub })).toBe(true);
      expect(firstBatchEligible({ ...base, network, store: "concrete", hub: "hub3" })).toBe(false);
      expect(firstBatchEligible({ ...base, network, store: "marathon-pine", hub: "hub3" })).toBe(true);   // Pine is untouched by Concrete's mapping
    }
  });
  it("NOT live — the seed, the shop alone, or the hub alone — → never eligible: the old seed-only Solve", () => {
    for (const network of [SEED_REGISTRY, live(["marathon-pine", "concrete"]), live(["hub3", "concrete-stockroom"])]) {
      for (const store of ["marathon-pine", "concrete"]) expect(firstBatchEligible({ ...base, network, store, hub: "hub3" })).toBe(false);
    }
    // and without a registry handed in at all, config.routes alone decides, as it always did
    expect(firstBatchEligible({ ...base, store: "marathon-pine", hub: "hub3" })).toBe(false);
  });
  it("Section 2 is the same answer with or without the registry", () => {
    for (const network of [SEED_REGISTRY, live()]) for (const store of ["marathon-pe", "trophy"]) for (const p of PRODUCTS.filter(Boolean)) {
      for (const hub of ["hub2", "hub1", "hub3", undefined]) {
        const args = { ...base, product: p, productId: p.id, store, ...(hub ? { hub } : {}) };
        expect(firstBatchEligible({ ...args, network }), `${store} ${p.id} ${hub}`).toBe(firstBatchEligible(args));
      }
    }
  });
});

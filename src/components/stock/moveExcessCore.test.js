// ─── MOVE EXCESS — the deficit pool is per section ───────────────────────────
// Three promises:
//   1. Section 2 is what it was. The card build is compared, over the real
//      routing fixture, against a frozen copy of the algorithm as it stood in
//      MoveExcess.jsx before sections (one network-wide pool, `loc === "hub2"`).
//   2. A surplus covers needs only in its own section; the rest goes back to
//      Central. A Section 1 need never holds, or attracts, Section 2 stock.
//   3. A location that is not live is listed (by hand), and its "need" pulls
//      nothing toward it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeSizeKey, decodeSizeKey } from "../../utils/sizeKey";
import { isDeactivated } from "../../utils/deactivation";
import { normalizeNetwork, SEED_REGISTRY } from "../../utils/networkRegistry";
import { sizeRank } from "./hubSizeRank";
import { computeMoveExcessCards, excessSources, registryRoutes, isBufferHub } from "./moveExcessCore";
import { excessHubLocations, EXCESS_HUB_LOCATIONS, computeHubExcess } from "./excessComputation";

/* global process */
const FIXTURE = JSON.parse(readFileSync(join(process.cwd(), "functions/test/fixtures/sections-routing-fixture.json"), "utf8"));

const isClothing = (p) =>
  p?.productType === "clothing" ||
  (!p?.productType && (p?.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s))));

// THE ALGORITHM AS IT WAS (MoveExcess.jsx on main, before sections). Frozen
// here; never "fixed" to match the new code.
function legacyCards({ allStock, allTargets, byId, openRequests, heldLines, routesCfg, storeMin }) {
  const SOURCES = ["hub2", "marathon-pe", "trophy"];
  const sources = (Object.keys(routesCfg).length ? Object.keys(routesCfg) : SOURCES).slice().sort((a, b) => {
    if (routesCfg[a] === b) return -1;
    if (routesCfg[b] === a) return 1;
    return a.localeCompare(b);
  });
  const out = [];
  const deficitBySize = new Map();
  const inbound = new Map();
  for (const r of openRequests || []) {
    if (!r?.productId || !r.requestingLocation || r.shadow) continue;
    const k = `${r.requestingLocation}|${r.productId}|${encodeSizeKey(r.size)}`;
    inbound.set(k, (inbound.get(k) || 0) + (Number(r.qty) || 1));
  }
  for (const [dest, byLine] of Object.entries(heldLines || {})) {
    for (const line of Object.values(byLine || {})) {
      if (!line?.productId || (line.sizeKey == null && line.size == null)) continue;
      const k = `${dest}|${line.productId}|${line.sizeKey != null ? String(line.sizeKey) : encodeSizeKey(line.size)}`;
      inbound.set(k, (inbound.get(k) || 0) + (Number(line.qty) || 1));
    }
  }
  for (const loc of sources) {
    for (const [pid, bySize] of Object.entries(allTargets?.[loc] || {})) {
      for (const [sizeKey, t] of Object.entries(bySize || {})) {
        if (!t || typeof t.target !== "number") continue;
        const have = Math.max(Number(allStock?.[loc]?.[pid]?.[decodeSizeKey(sizeKey)]?.qty) || 0, 0);
        const deficit = t.target - have - (inbound.get(`${loc}|${pid}|${sizeKey}`) || 0);
        if (deficit > 0) {
          const k = `${pid}|${sizeKey}`;
          deficitBySize.set(k, (deficitBySize.get(k) || 0) + deficit);
        }
      }
    }
  }
  for (const loc of sources) {
    const minEx = loc === "hub2" ? 1 : storeMin;
    for (const [pid, bySize] of Object.entries(allStock?.[loc] || {})) {
      const p = byId.get(pid);
      if (!isClothing(p)) continue;
      if (isDeactivated(p)) continue;
      const sizes = [];
      for (const [size, cell] of Object.entries(bySize || {})) {
        const qty = typeof cell?.qty === "number" ? cell.qty : 0;
        const t = allTargets?.[loc]?.[pid]?.[encodeSizeKey(size)];
        if (!t || typeof t.target !== "number") continue;
        const raw = qty - t.target;
        const dKey = `${pid}|${encodeSizeKey(size)}`;
        const lineMin = t.target === 0 ? 1 : minEx;
        if (loc === "hub2") {
          const held = Math.min(Math.max(raw, 0), deficitBySize.get(dKey) || 0);
          const excessQty = raw - held;
          if (excessQty >= lineMin) sizes.push({ size, have: qty, target: t.target, excess: excessQty, toHub: 0, toCentral: excessQty });
        } else if (raw >= lineMin) {
          const need = deficitBySize.get(dKey) || 0;
          const toHub = Math.min(raw, need);
          deficitBySize.set(dKey, need - toHub);
          sizes.push({ size, have: qty, target: t.target, excess: raw, toHub, toCentral: raw - toHub });
        }
      }
      if (!sizes.length) continue;
      sizes.sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
      out.push({ key: `${loc}|${pid}`, loc, pid, name: p?.name || pid, photo: p?.photoUrl, sizes, totalExcess: sizes.reduce((t, s) => t + s.excess, 0) });
    }
  }
  return { cards: out.sort((a, b) => b.totalExcess - a.totalExcess), sources };
}

function decodeStock(stock) {
  const out = {};
  for (const loc of Object.keys(stock)) {
    out[loc] = {};
    for (const pid of Object.keys(stock[loc])) {
      out[loc][pid] = Object.fromEntries(Object.entries(stock[loc][pid] || {}).map(([k, c]) => [decodeSizeKey(k), c]));
    }
  }
  return out;
}

// Section 1 with BOTH switches off — what the seed shipped as before 7 Oct 2026
// (the seed itself now holds Section 1 Solve on + Auto-refill "solved", so the
// engine — and this screen, which mirrors its routes — treats it as routed).
const OFF = { solve: false, autoRefill: "off" };
const S1_OFF = { "marathon-pine": OFF, concrete: OFF, hub3: OFF };
const DARK = normalizeNetwork({ locations: S1_OFF });

const newCards = ({ allStock, allTargets, byId, openRequests, heldLines, routesCfg, storeMin, network = DARK, canSee }) => {
  const { sources, routes } = excessSources(network, routesCfg, { canSee });
  return { cards: computeMoveExcessCards({ allStock, allTargets, byId, openRequests, heldLines, sources, routes, storeMin, network }), sources, routes };
};

describe("Section 2 is exactly what it was", () => {
  const allStock = decodeStock(FIXTURE.stock);
  const byId = new Map(Object.values(FIXTURE.products).map((p) => [p.id, p]));
  // The fixture's clothing rarely sits above target, so the comparison is run
  // on the real shelves AND on the same shelves with every shop and Hub 2
  // cell made generous — which exercises both legs and the netting.
  const generous = JSON.parse(JSON.stringify(allStock));
  for (const loc of ["hub2", "marathon-pe", "trophy", "hub1"]) for (const pid of Object.keys(FIXTURE.targets?.[loc] || {})) {
    for (const sizeKey of Object.keys(FIXTURE.targets[loc][pid] || {})) {
      const sz = decodeSizeKey(sizeKey);
      generous[loc] = generous[loc] || {};
      generous[loc][pid] = generous[loc][pid] || {};
      const n = (pid.length + sz.length + loc.length) % 7;       // deterministic spread 0..6
      generous[loc][pid][sz] = { qty: n, v: 1 };
    }
  }
  const openRequests = [
    { productId: Object.keys(FIXTURE.targets?.hub2 || {})[0], requestingLocation: "hub2", size: "M", qty: 2, status: "open" },
    { productId: Object.keys(FIXTURE.targets?.hub2 || {})[1], requestingLocation: "hub2", size: "L", qty: 1, status: "open", shadow: true },
  ];

  for (const [name, stock] of [["the fixture's shelves", allStock], ["generous shelves", generous]]) {
    // "no routes read yet": the screen used to fall back to a literal map
    // (engineConfig?.routes || {…}); the registry now answers the same map.
    const LITERAL_FALLBACK = { "marathon-pe": "hub2", trophy: "hub2", hub2: "central" };
    for (const [cfgName, routesCfg, oldRoutes] of [["the engine's routes", FIXTURE.config.routes, FIXTURE.config.routes], ["no routes read yet", undefined, LITERAL_FALLBACK]]) {
      for (const [netName, network] of [["Section 1 off", DARK], ["the seed (Section 1 Solve on + Auto-refill solved)", SEED_REGISTRY]]) {
        it(`${name}, ${cfgName}, ${netName}: every Section 2 card and number matches the old computation`, () => {
          const args = { allStock: stock, allTargets: FIXTURE.targets, byId, openRequests, heldLines: null, storeMin: 2 };
          const old = legacyCards({ ...args, routesCfg: oldRoutes });
          const now = newCards({ ...args, routesCfg, network });
          const s2 = (cards) => cards.filter((c) => SEED_REGISTRY.locations[c.loc]?.section === 2);
          expect(s2(now.cards)).toEqual(old.cards);
          // the configured locations keep their order, ahead of the registry's additions
          if (routesCfg) expect(now.sources.slice(0, old.sources.length)).toEqual(old.sources);
          else expect(now.sources.filter((l) => SEED_REGISTRY.locations[l]?.section === 2)).toEqual(old.sources);
        });
      }
    }
  }

  it("the comparison is not vacuous: the generous shelves produce both legs and a netted hub", () => {
    const { cards } = newCards({ allStock: generous, allTargets: FIXTURE.targets, byId, openRequests, heldLines: null, routesCfg: FIXTURE.config.routes, storeMin: 2 });
    expect(cards.length).toBeGreaterThan(20);
    expect(cards.some((c) => c.loc === "hub2")).toBe(true);
    expect(cards.some((c) => c.sizes.some((s) => s.toHub > 0))).toBe(true);
    expect(cards.some((c) => c.loc !== "hub2" && c.sizes.some((s) => s.toCentral > 0))).toBe(true);
  });

  it("the fallback routes are the literal map this replaced (Section 1 off), and Hub 2 is the only Section 2 buffer", () => {
    expect(registryRoutes(DARK)).toEqual({ "marathon-pe": "hub2", trophy: "hub2", hub2: "central" });
    // the seed: Section 1's Auto-refill is on, so the engine's routes — and this screen's — include it
    expect(registryRoutes(SEED_REGISTRY)).toEqual({ "marathon-pe": "hub2", trophy: "hub2", hub2: "central", "marathon-pine": "hub3", concrete: "hub3", hub3: "central" });
    const { sources, routes } = excessSources(SEED_REGISTRY, FIXTURE.config.routes);
    expect(sources.filter((l) => isBufferHub(l, sources, routes) && SEED_REGISTRY.locations[l].section === 2)).toEqual(["hub2"]);
    expect(isBufferHub("hub1", sources, routes)).toBe(false);
  });
});

// One clothing product, targets everywhere it matters.
const P = { id: "tee", name: "Tee", productType: "clothing", sizes: ["M"] };
const byId = new Map([[P.id, P]]);
const T = (target) => ({ tee: { M: { target } } });
const cell = (qty) => ({ tee: { M: { qty, v: 1 } } });
const ROUTES = { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" };
const LIVE1 = normalizeNetwork({ locations: { ...S1_OFF, "marathon-pine": { live: true }, concrete: { live: true }, hub3: { live: true } } });
const card = (cards, loc) => cards.find((c) => c.loc === loc)?.sizes[0] || null;

describe("a surplus covers needs only in its own section", () => {
  it("a Section 1 need does not hold back, or attract, a Section 2 surplus", () => {
    const allTargets = { "marathon-pe": T(2), hub2: T(3), hub3: T(5), "marathon-pine": T(2) };
    const allStock = { "marathon-pe": cell(6), hub2: cell(3), hub3: cell(0), "marathon-pine": cell(2) };
    const { cards } = newCards({ allStock, allTargets, byId, routesCfg: ROUTES, storeMin: 2, network: LIVE1 });
    // Hub 3 needs 5; Marathon PE is 4 over. None of it is held for Hub 3.
    expect(card(cards, "marathon-pe")).toMatchObject({ excess: 4, toHub: 0, toCentral: 4 });
  });

  it("a Section 2 need does not hold back a Section 1 surplus — and Hub 3's own surplus is netted against Section 1 only", () => {
    const allTargets = { "marathon-pe": T(4), hub2: T(3), hub3: T(1), "marathon-pine": T(2), concrete: T(3) };
    const allStock = { "marathon-pe": cell(0), hub2: cell(0), hub3: cell(6), "marathon-pine": cell(2), concrete: cell(1) };
    const { cards } = newCards({ allStock, allTargets, byId, routesCfg: ROUTES, storeMin: 2, network: LIVE1 });
    // Hub 3 is 5 over; Concrete (its own section) needs 2 → 3 back to Central.
    // Section 2's need of 7 is not its business.
    expect(card(cards, "hub3")).toMatchObject({ excess: 3, toHub: 0, toCentral: 3 });
  });

  it("inside a section it is the old two-leg split: the hub's need first, the rest to Central, the need consumed once", () => {
    const allTargets = { "marathon-pine": T(1), concrete: T(1), hub3: T(4) };
    const allStock = { "marathon-pine": cell(4), concrete: cell(5), hub3: cell(1) };
    const { cards, routes } = newCards({ allStock, allTargets, byId, routesCfg: ROUTES, storeMin: 2, network: LIVE1 });
    expect(routes.concrete).toBe("hub3");
    expect(routes["marathon-pine"]).toBe("hub3");
    // Hub 3 needs 3. Concrete (first in order) covers all 3; Pine sends everything to Central.
    expect(card(cards, "concrete")).toMatchObject({ excess: 4, toHub: 3, toCentral: 1 });
    expect(card(cards, "marathon-pine")).toMatchObject({ excess: 3, toHub: 0, toCentral: 3 });
  });

  it("the same product over in both sections: each section's stores serve their own hub", () => {
    const allTargets = { "marathon-pe": T(1), hub2: T(3), "marathon-pine": T(1), hub3: T(3) };
    const allStock = { "marathon-pe": cell(4), hub2: cell(2), "marathon-pine": cell(6), hub3: cell(0) };
    const { cards } = newCards({ allStock, allTargets, byId, routesCfg: ROUTES, storeMin: 2, network: LIVE1 });
    expect(card(cards, "marathon-pe")).toMatchObject({ toHub: 1, toCentral: 2 });      // Hub 2 needs 1
    expect(card(cards, "marathon-pine")).toMatchObject({ toHub: 3, toCentral: 2 });    // Hub 3 needs 3
  });
});

describe("a location whose Auto-refill is off", () => {
  it("is listed, and its whole excess goes back to Central — its hub's need attracts nothing", () => {
    const allTargets = { "marathon-pine": T(1), hub3: T(9) };
    const allStock = { "marathon-pine": cell(5), hub3: cell(0) };
    const { cards, sources } = newCards({ allStock, allTargets, byId, routesCfg: ROUTES, storeMin: 2, network: DARK });
    expect(sources).toContain("marathon-pine");
    expect(sources).toContain("hub3");
    expect(card(cards, "marathon-pine")).toMatchObject({ excess: 4, toHub: 0, toCentral: 4 });
  });

  it("an off hub's own excess is visible in full", () => {
    const allTargets = { hub3: T(1), "marathon-pine": T(6) };
    const allStock = { hub3: cell(5), "marathon-pine": cell(0) };
    const { cards } = newCards({ allStock, allTargets, byId, routesCfg: ROUTES, storeMin: 2, network: DARK });
    expect(card(cards, "hub3")).toMatchObject({ excess: 4, toCentral: 4 });
  });

  it("the SEED (7 Oct 2026): Section 1 is routed — Pine's excess serves Hub 3's need first, like any routed store", () => {
    const allTargets = { "marathon-pine": T(1), hub3: T(9) };
    const allStock = { "marathon-pine": cell(5), hub3: cell(0) };
    const { cards, routes } = newCards({ allStock, allTargets, byId, routesCfg: ROUTES, storeMin: 2, network: SEED_REGISTRY });
    expect(routes["marathon-pine"]).toBe("hub3");
    expect(card(cards, "marathon-pine")).toMatchObject({ excess: 4, toHub: 4, toCentral: 0 });
  });

  it("a viewer who cannot see Section 1 is not shown its locations; the configured ones are untouched", () => {
    const canSee = (l) => SEED_REGISTRY.locations[l]?.section !== 1;
    const { sources } = excessSources(SEED_REGISTRY, ROUTES, { canSee });
    expect(sources).toEqual(["hub1", "marathon-pe", "trophy", "hub2"]);
  });
});

describe("the hub → Central screen's hubs come from the registry", () => {
  it("the live hubs are the list it always had; the rest follow, visible", () => {
    expect(excessHubLocations(SEED_REGISTRY, { liveOnly: true })).toEqual([...EXCESS_HUB_LOCATIONS]);
    expect(excessHubLocations(SEED_REGISTRY)).toEqual(["hub1", "hub2", "hub3"]);
    expect(excessHubLocations(LIVE1, { liveOnly: true })).toEqual(["hub3", "hub1", "hub2"]);
  });

  it("a hub's excess is its own: Section 1 stock or need changes nothing at Hub 2, and Hub 3 is judged by Hub 3's numbers", () => {
    const products = { s: { id: "s", name: "Shoe", categoryKey: "sneakers", sizes: ["8"] } };
    const keep = { target: 2, reorderPoint: 1, minQty: 1 };
    const config = { categoryPolicy: { sneakers: { perSize: true, hub2: { carriedOnly: true, sizes: { 8: keep } }, hub3: { carriedOnly: true, sizes: { 8: keep } } } } };
    const stock = { hub2: { s: { 8: { qty: 5 } } }, hub3: { s: { 8: { qty: 9 } } } };
    const at = (locs, st = stock) => computeHubExcess({ products, stock: st, targets: {}, config }, new Map(), { locations: locs }).map((r) => [r.loc, r.excess]);
    expect(at(["hub2"])).toEqual([["hub2", 3]]);
    expect(at(["hub2"], { hub2: stock.hub2 })).toEqual([["hub2", 3]]);
    expect(at(["hub3"])).toEqual([["hub3", 7]]);
    // an open request FROM hub3 reserves hub3's units only
    const reserved = new Map([["hub3|s|8", 4]]);
    const rows = computeHubExcess({ products, stock, targets: {}, config }, reserved, { locations: ["hub2", "hub3"] }).map((r) => [r.loc, r.excess]);
    expect(rows).toEqual([["hub2", 3], ["hub3", 3]]);
  });
});

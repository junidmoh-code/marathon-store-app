// The Concrete division's Solve options (Junid, 12 Nov 2026: Concrete and Pine only,
// both from Central) and the sneaker pair split (9 Nov 2026).
import { describe, it, expect } from "vitest";
import { solveBlocks, divisionSolveOn } from "./solveSections";
import { footwearPairPlan } from "./missingFootwearCore";
import { sneakerSolvePairAllowed, concreteDivisionPolicy, divisionSizes, isDivisionOneSize } from "./concreteDivision";
import { isCentralFedProduct } from "./centralFed";
import { SEED_REGISTRY } from "../../utils/networkRegistry";

const CFG = { routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" }, concreteDivision: { shopOnly: { perSize: 2, oneSize: 5 } } };
const TEE = { id: "t", name: "T", categoryKey: "t-shirts", category: "Clothing", productType: "clothing", sizes: ["S", "M"] };
const CAP = { id: "c", name: "C", categoryKey: "caps-beanies", category: "Accessories", sizes: ["_"] };
const SHOE = { id: "s", name: "S", categoryKey: "soccer-boots", category: "Footwear", sizes: ["8"] };

describe("Concrete-division Solve options", () => {
  it("are exactly Concrete and Pine — Hub 3 is never offered for non-footwear", () => {
    for (const product of [TEE, CAP]) {
      const [b] = solveBlocks({ network: SEED_REGISTRY, sections: [1], source: "central", product, productId: product.id, engineConfig: CFG });
      expect(b.stores.map((s) => s.name)).toEqual(["Concrete", "Pine"]);
      expect(b.stores.some((s) => s.id === "hub3" || s.isDivisionHub)).toBe(false);
      expect(b.stores.every((s) => s.blocked === null)).toBe(true);
    }
  });
  it("each shop is supplied straight from Central, whatever Hub 3 ever held", () => {
    const [b] = solveBlocks({ network: SEED_REGISTRY, sections: [1], source: "central", product: TEE, productId: "t", engineConfig: CFG });
    for (const s of b.stores) { expect(s.centralFed).toBe(true); expect(s.hub).toBe(null); }
  });
  it("an old key with the Hub 3 fields offers the same two shops", () => {
    const old = { ...CFG, concreteDivision: { ...CFG.concreteDivision, fromHub3: { perSize: 1, oneSize: 5, askAt: 0 }, hub3Keep: { on: true, perSize: 2, oneSize: 10 } } };
    const [b] = solveBlocks({ network: SEED_REGISTRY, sections: [1], source: "central", product: TEE, productId: "t", engineConfig: old });
    expect(b.stores.map((s) => s.id)).toEqual(["concrete", "marathon-pine"]);
  });
  it("Marathon's options and a key-less config are untouched; sneakers never take this path", () => {
    expect(divisionSolveOn(CFG, 2, TEE)).toBe(false);
    expect(divisionSolveOn({}, 1, TEE)).toBe(false);
    expect(divisionSolveOn(CFG, 1, SHOE)).toBe(false);
    const [m] = solveBlocks({ network: SEED_REGISTRY, sections: [2], source: "central", product: TEE, productId: "t", engineConfig: CFG });
    expect(m.stores.map((s) => s.id)).toEqual(["marathon-pe", "trophy"]);
  });
  it("every non-footwear item is direct at a division shop; a cap has no size", () => {
    expect(isCentralFedProduct(CFG, SEED_REGISTRY, "marathon-pine", CAP)).toBe(true);
    expect(isCentralFedProduct(CFG, SEED_REGISTRY, "trophy", CAP)).toBe(false);
    expect(isCentralFedProduct(CFG, SEED_REGISTRY, "concrete", SHOE)).toBe(false);
    expect(isDivisionOneSize(CAP)).toBe(true);
    expect(divisionSizes(TEE)).toEqual(["S", "M"]);
    expect(concreteDivisionPolicy({ concreteDivision: "x" })).toBe(null);
  });
});

describe("Sneaker pair split", () => {
  const plan = (avail, wants = { hub2: 3, hub3: 3 }) => footwearPairPlan({
    catalogSizes: ["8"], hubs: ["hub2", "hub3"], marathonHub: "hub2",
    policies: { hub2: { 8: wants.hub2 }, hub3: { 8: wants.hub3 } },
    centralCells: { 8: { qty: avail } }, openSizes: {}, reserved: {},
  });
  const q = (p, h) => (p[h][0] ? p[h][0].qty : 0);
  it("covers both keeps when Central can", () => { const p = plan(6); expect([q(p, "hub2"), q(p, "hub3")]).toEqual([3, 3]); });
  it("splits evenly; an odd leftover goes to the Marathon hub", () => {
    let p = plan(4); expect([q(p, "hub2"), q(p, "hub3")]).toEqual([2, 2]);
    p = plan(5); expect([q(p, "hub2"), q(p, "hub3")]).toEqual([3, 2]);
    p = plan(1); expect([q(p, "hub2"), q(p, "hub3")]).toEqual([1, 0]);
  });
  it("never over a keep; what one hub cannot take goes to the other", () => {
    const p = plan(4, { hub2: 1, hub3: 3 });
    expect([q(p, "hub2"), q(p, "hub3")]).toEqual([1, 3]);
  });
  it("Hub 1 + Hub 2 is refused", () => {
    expect(sneakerSolvePairAllowed(["hub1", "hub2"])).toBe(false);
    expect(sneakerSolvePairAllowed(["hub2", "hub3"])).toBe(true);
  });
});

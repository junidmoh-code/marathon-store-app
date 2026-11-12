// ─── MARATHON SOLVE UNCHANGED — pinned before the 12 Nov 2026 division change ─
// Junid's 12 Nov model changes the Concrete division only. The Marathon list's
// Solve options (Marathon PE / Trophy through Hub 2) and the sneaker pair rule
// (Hub 1 + Hub 2 never together) must read the same under the old division key,
// the new one, and no key at all.
import { describe, it, expect } from "vitest";
import { solveBlocks } from "./solveSections";
import { sneakerSolvePairAllowed } from "./concreteDivision";
import { SEED_REGISTRY } from "../../utils/networkRegistry";

const ROUTES = { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" };
const OLD = { routes: ROUTES, concreteDivision: { shopOnly: { perSize: 2, oneSize: 5 }, fromHub3: { perSize: 1, oneSize: 5, askAt: 0 }, hub3Keep: { on: false, perSize: 2, oneSize: 10 } } };
const NEW = { routes: ROUTES, concreteDivision: { shopOnly: { perSize: 2, oneSize: 5 } } };
const NONE = { routes: ROUTES };
const PRODUCTS = [
  { id: "t", name: "T", categoryKey: "t-shirts", category: "Clothing", productType: "clothing", sizes: ["S", "M"] },
  { id: "c", name: "C", categoryKey: "caps-beanies", category: "Accessories", sizes: ["_"] },
  { id: "p", name: "P", categoryKey: "perfumes", category: "Perfume", sizes: ["_"] },
  { id: "s", name: "S", categoryKey: "sneakers", category: "Footwear", subcategory: "Sneakers", sizes: ["8", "9"] },
];

describe("the Marathon list's Solve options", () => {
  for (const product of PRODUCTS) {
    for (const source of ["central", "hub2"]) {
      it(`${product.categoryKey} from ${source}: same under old key, new key and no key`, () => {
        const at = (engineConfig, hub3Present) => solveBlocks({ network: SEED_REGISTRY, sections: [2], source, product, productId: product.id, engineConfig, hub3Present });
        const base = at(NONE, false);
        expect(at(OLD, false)).toEqual(base);
        expect(at(OLD, true)).toEqual(base);
        expect(at(NEW, false)).toEqual(base);
        expect(at(NEW, true)).toEqual(base);
        expect(base[0].stores.map((s) => s.id)).toEqual(["marathon-pe", "trophy"]);
      });
    }
  }
});

describe("the sneaker pair rule", () => {
  it("Hub 1 + Hub 2 refused; each with Hub 3 allowed; alone allowed", () => {
    expect(sneakerSolvePairAllowed(["hub1", "hub2"])).toBe(false);
    expect(sneakerSolvePairAllowed(["hub1", "hub3"])).toBe(true);
    expect(sneakerSolvePairAllowed(["hub2", "hub3"])).toBe(true);
    expect(sneakerSolvePairAllowed(["hub1"])).toBe(true);
    expect(sneakerSolvePairAllowed(["hub2"])).toBe(true);
  });
});

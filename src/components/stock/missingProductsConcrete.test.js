// Concrete-only products (Junid, 20 Nov 2026): listed under the Concrete
// division only, never as missing from Marathon. Ordinary products unchanged.
import { describe, it, expect } from "vitest";
import { computeMissingProducts, concreteSection, listedInSection } from "./missingProductsCore";

const TEE = { id: "t1", name: "Nike Tee", productType: "clothing", sizes: ["S", "M"] };
const PANT = { id: "c1", name: "Pant fashion 3306", productType: "clothing", sizes: ["S", "M"], concreteProduct: true };
const LEGACY = { id: "c2", name: "Legacy mark", productType: "clothing", sizes: ["S"], listOnConcrete: true };
const cell = (qty) => ({ qty });
const STOCK = { central: { t1: { S: cell(4) }, c1: { S: cell(3) }, c2: { S: cell(2) } } };
const ALL = [TEE, PANT, LEGACY];

describe("Concrete-only products and the division lists", () => {
  it("the Concrete division is the concrete store's section", () => {
    expect(concreteSection()).toBe(1);
  });
  it("Marathon's list (the default call) never carries a Concrete-only product", () => {
    const pids = computeMissingProducts({ allStock: STOCK, products: ALL }).map((c) => c.pid);
    expect(pids).toEqual(["t1"]);
    expect(computeMissingProducts({ allStock: STOCK, products: ALL, section: 2 }).map((c) => c.pid)).toEqual(["t1"]);
  });
  it("the Concrete division's list carries them, beside the ordinary products it always had", () => {
    const pids = computeMissingProducts({ allStock: STOCK, products: ALL, section: 1 }).map((c) => c.pid).sort();
    expect(pids).toEqual(["c1", "c2", "t1"]);
  });
  it("an explicit concreteProduct:false beats a legacy mark", () => {
    expect(listedInSection({ ...LEGACY, concreteProduct: false }, 2)).toBe(true);
    expect(listedInSection(LEGACY, 2)).toBe(false);
  });
  it("Concrete-only stock sitting only in Hub 2 is shown on the Concrete list (source Hub 2, Marathon's shops)", () => {
    const stock = { hub2: { c1: { S: cell(2) }, t9: { S: cell(5) } } };
    const T9 = { id: "t9", name: "Ordinary", productType: "clothing", sizes: ["S"] };
    const cards = computeMissingProducts({ allStock: stock, products: [PANT, T9], section: 1 });
    expect(cards.map((c) => c.pid)).toEqual(["c1"]);          // never an ordinary Hub 2 product
    expect(cards[0]).toMatchObject({ source: "hub2", missing: ["marathon-pe", "trophy"] });
    expect(computeMissingProducts({ allStock: stock, products: [PANT, T9] }).map((c) => c.pid)).toEqual(["t9"]);
  });
  it("ordinary products are byte-for-byte what they were in both lists", () => {
    const before = computeMissingProducts({ allStock: STOCK, products: [TEE] });
    const after = computeMissingProducts({ allStock: STOCK, products: ALL }).filter((c) => c.pid === "t1");
    expect(after).toEqual(before);
  });
});

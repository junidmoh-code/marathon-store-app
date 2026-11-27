import { describe, it, expect } from "vitest";
import { isCardClothing, subcategoryOf, cardList } from "./ConcreteProductsCard.jsx";

const P = (id, extra = {}) => ({ id, name: `Thing ${id}`, category: "Clothing", productType: "clothing", sizes: ["S", "M"], ...extra });

describe("isCardClothing — the existing taxonomy decides", () => {
  it("keeps clothing and accessories; drops sneakers, footwear keys, perfume, price records, merged records", () => {
    expect(isCardClothing(P("p1", { categoryKey: "t-shirts" }))).toBe(true);
    expect(isCardClothing(P("p2", { category: "Accessories", categoryKey: "bags", sizes: ["_"] }))).toBe(true);
    expect(isCardClothing({ id: "p3", category: "Footwear", productType: "sneaker", sizes: ["8"] })).toBe(false);
    expect(isCardClothing(P("p4", { categoryKey: "sneakers" }))).toBe(false); // clothing-typed but a footwear key
    expect(isCardClothing({ id: "p5", categoryKey: "perfumes", category: "Perfume", sizes: ["_"] })).toBe(false);
    expect(isCardClothing(P("p6", { priceProduct: true }))).toBe(false);
    expect(isCardClothing(P("p7", { mergedInto: "p1" }))).toBe(false);
    expect(isCardClothing(null)).toBe(false);
  });
});

describe("cardList", () => {
  const list = [
    P("p1", { categoryKey: "t-shirts", concreteProduct: true }),
    P("p3", { categoryKey: "pants" }),
    P("p2", { categoryKey: "pants", listOnConcrete: true }),
    { id: "p9", category: "Footwear", productType: "sneaker", sizes: ["9"] },
  ];
  it("newest first, clothing only", () => {
    expect(cardList(list).map((p) => p.id)).toEqual(["p3", "p2", "p1"]);
  });
  it("On / Off / All, honouring optimistic overrides", () => {
    expect(cardList(list, { mode: "on" }).map((p) => p.id)).toEqual(["p2", "p1"]);
    expect(cardList(list, { mode: "off" }).map((p) => p.id)).toEqual(["p3"]);
    expect(cardList(list, { mode: "on", overrides: { p3: true, p1: false } }).map((p) => p.id)).toEqual(["p3", "p2"]);
  });
  it("filters by subcategory label from the taxonomy", () => {
    expect(subcategoryOf(P("x", { categoryKey: "pants" }))).toBe("Pants");
    expect(subcategoryOf(P("x", { categoryKey: undefined, subcategory: "Polos" }))).toBe("Polos");
    expect(cardList(list, { sub: "Pants" }).map((p) => p.id)).toEqual(["p3", "p2"]);
  });
});

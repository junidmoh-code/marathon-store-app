import { describe, it, expect } from "vitest";
import { categorize, sizeClass, brandOf, CATEGORY_TREE, UNCATEGORIZED } from "./productCategory.js";

const SHOE = ["6", "7", "8", "9", "10", "11"];
const CLOTHES = ["S", "M", "L", "XL", "XXL"];
const ONE = ["_"];

describe("sizeClass", () => {
  it("numeric UK/US sizes → footwear", () => expect(sizeClass(SHOE)).toBe("footwear"));
  it("letter sizes → clothing", () => expect(sizeClass(CLOTHES)).toBe("clothing"));
  it("waist ≥ 28 → clothing", () => expect(sizeClass(["28", "30", "32", "34"])).toBe("clothing"));
  it("half shoe sizes → footwear", () => expect(sizeClass(["5.5", "6", "7"])).toBe("footwear"));
  it('one-size "_" → onesize', () => expect(sizeClass(ONE)).toBe("onesize"));
  it("keyed-object sizes work", () => expect(sizeClass({ a: "M", b: "L" })).toBe("clothing"));
});

describe("brandOf", () => {
  it("merges Air Jordan → Jordan", () => expect(brandOf("Air Jordan 1 Chicago")).toBe("Jordan"));
  it("Hugo Boss → Boss", () => expect(brandOf("Hugo Boss Tee Black")).toBe("Boss"));
  it("multi-word brands", () => {
    expect(brandOf("Karl Lagerfeld Hoodie")).toBe("Karl Lagerfeld");
    expect(brandOf("New Balance 550")).toBe("New Balance");
    expect(brandOf("Fear of God Essentials Tee")).toBe("Fear of God");
  });
  it("first token otherwise", () => expect(brandOf("Lacoste Polo White")).toBe("Lacoste"));
  it("null for code-only / unbranded", () => {
    expect(brandOf("Lx:1222")).toBeNull();
    expect(brandOf("8290 Barley")).toBeNull();
    expect(brandOf("")).toBeNull();
  });
});

describe("categorize — footwear", () => {
  it("plain sneaker (default)", () => {
    expect(categorize("Nike Air Max 90 Black", SHOE)).toMatchObject({ category: "Footwear", subcategory: "Sneakers", brand: "Nike" });
  });
  it("soccer boots by FG/keyword", () => {
    expect(categorize("Nike Mercurial Superfly FG", SHOE).subcategory).toBe("Soccer Boots");
    expect(categorize("Adidas Predator AG", SHOE).subcategory).toBe("Soccer Boots");
  });
  it("sandals / slides", () => {
    expect(categorize("Adidas Adilette Slides", SHOE).subcategory).toBe("Sandals & Slides");
    expect(categorize("Birkenstock Arizona", SHOE).subcategory).toBe("Sandals & Slides");
  });
  it("boots", () => {
    expect(categorize("Timberland 6 Inch Premium Boot", SHOE).subcategory).toBe("Boots");
  });
});

describe("categorize — clothing", () => {
  const C = (n) => categorize(n, CLOTHES);
  it("t-shirts", () => expect(C("Lacoste Tee White").subcategory).toBe("T-Shirts"));
  it("polos", () => expect(C("Lacoste Polo Navy").subcategory).toBe("Polos"));
  it("jeans", () => expect(C("Diesel Slim Jeans Blue").subcategory).toBe("Jeans & Denim"));
  it("tracksuits / sets", () => {
    expect(C("Nike Tech Fleece Black").subcategory).toBe("Tracksuits & Sets");
    expect(C("Alo Yoga Set Brown").subcategory).toBe("Tracksuits & Sets");
  });
  it("hoodies / sweats", () => expect(C("Nike Sweatshirt Grey").subcategory).toBe("Hoodies & Sweatshirts"));
  it("sweatshorts → Shorts (not Hoodies)", () => expect(C("Fear of God Essentials Sweatshorts Black").subcategory).toBe("Shorts & Vests"));
  it("jackets / windrunner", () => expect(C("Nike Windrunner Navy").subcategory).toBe("Jackets & Coats"));
  it("cargos", () => expect(C("Cargo Pants Olive").subcategory).toBe("Cargos & Pants"));
  it("football jerseys → Jerseys", () => {
    expect(C("Adidas Argentina Home Jersey").subcategory).toBe("Jerseys");
    expect(C("Nike FC Barcelona Away Jersey Orange").subcategory).toBe("Jerseys");
  });
  it("sweatpants → Tracksuits & Sets", () => expect(C("Blur Tie Dye Sweatpants").subcategory).toBe("Tracksuits & Sets"));
  it("underwear / socks → Underwear & Socks", () => {
    expect(C("On Men's Underwear").subcategory).toBe("Underwear & Socks");
    expect(C("Nike Crew Socks 3-Pack").subcategory).toBe("Underwear & Socks");
  });
  it("unmatched clothing → Uncategorized", () => expect(C("Barley 8290").subcategory).toBe(UNCATEGORIZED));
});

describe("categorize — accessories + caps + perfume (size-agnostic)", () => {
  it("balaclava → Accessories regardless of clothing size", () => {
    expect(categorize("Nike Balaclava Black", CLOTHES)).toMatchObject({ category: "Accessories", subcategory: "Balaclavas & Masks" });
  });
  it("bag / backpack", () => expect(categorize("Jordan Backpack Black", CLOTHES).subcategory).toBe("Bags"));
  it("belt", () => expect(categorize("Gucci Belt Black", ONE).subcategory).toBe("Belts"));
  it("gloves", () => expect(categorize("Nike Pacer Gloves Black", CLOTHES).subcategory).toBe("Gloves"));
  it("cap (one-size) → Caps & Hats under Clothing", () => {
    expect(categorize("NY Yankees Cap Navy", ONE)).toMatchObject({ category: "Clothing", subcategory: "Caps & Hats" });
  });
  it("one-size with no keyword → Perfume", () => {
    expect(categorize("Adore", ONE)).toMatchObject({ category: "Perfume", subcategory: "Perfume" });
  });
});

describe("tree", () => {
  it("every subcategory a classifier can emit is in the tree", () => {
    const all = new Set(Object.values(CATEGORY_TREE).flat());
    for (const sub of ["Sneakers", "Soccer Boots", "T-Shirts", "Bags", "Belts", "Perfume", UNCATEGORIZED]) {
      expect(all.has(sub)).toBe(true);
    }
  });
});

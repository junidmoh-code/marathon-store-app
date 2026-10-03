import { describe, it, expect } from "vitest";
import { categorize, sizeClass, brandOf, brandInfo, CATEGORY_TREE, TOP_CATEGORIES, UNCATEGORIZED, UNCATEGORIZED_TOP, topCategory, isPriceRecord, PRICE_RECORD_CATEGORY } from "./productCategory.js";

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
  it("known brands anywhere in the name", () => {
    expect(brandOf("Lacoste Polo White")).toBe("Lacoste");
    expect(brandOf("T-shirt white Karl Lagerfeld w700#")).toBe("Karl Lagerfeld");
    expect(brandOf("Furry slide BALENCIAGA brown")).toBe("Balenciaga");
  });
  it("NEVER the first word: first names, garment, colour and material words get no brand", () => {
    for (const n of ["T-shirt white GLFS T1024#1", "Denim pant black N9030#", "Black Striped T-Shirt", "Golf t-shirt cream white BC #1",
      "Sweater hoodie cream white", "Leather Jacket Brown", "Jerseys purple"]) expect(brandOf(n), n).toBeNull();
  });
  it("split first names resolve to the full brand", () => {
    expect(brandOf("Christian Louboutin Louis Junior Spikes Black")).toBe("Christian Louboutin");
    expect(brandOf("Christian loubiton Paris Black")).toBe("Christian Louboutin");
    expect(brandOf("CHRISTINA LOUBOUTIN LOUIS BROWN")).toBe("Christian Louboutin");
    expect(brandOf("Christians LOUBOUTIN LOUIS white")).toBe("Christian Louboutin");
    expect(brandOf("ALEXANDER MC QUEEN FULL BLACK")).toBe("Alexander McQueen");
    expect(brandOf("Alexandra maqueen")).toBe("Alexander McQueen");
    expect(brandOf("Daniel wellington watch gold")).toBe("Daniel Wellington");
    expect(brandOf("Dr. Martens Carlson Black Suede")).toBe("Dr. Martens");
    expect(brandOf("Christian Dior Saddle")).toBe("Dior");
  });
  it("staff typos of known brands", () => {
    expect(brandOf("Lacoster golf polo white")).toBe("Lacoste");
    expect(brandOf("Guccl bag black")).toBe("Gucci");
    expect(brandOf("Timbalend motion creem")).toBe("Timberland");
  });
  it("Air Jordan stays Jordan even after 'Nike'; collabs take the first brand named", () => {
    expect(brandOf("Nike Air Jordan 1 Low")).toBe("Jordan");
    expect(brandOf("Air Nike tracksuit red and black")).toBe("Nike");
    expect(brandOf("Supreme x Nike air force 1 purple")).toBe("Supreme");
  });
  it("word-brands only count as the first word", () => {
    expect(brandOf("On cloud brown")).toBe("On");
    expect(brandOf("Slide on black")).toBeNull();
    expect(brandOf("Alo bag green")).toBe("Alo");
  });
  it("brandInfo flags an unrecognised name; supplier labels and codes are unbranded, not flagged", () => {
    expect(brandInfo("Sweater hoodie cream white")).toEqual({ brand: null, flag: "unrecognised", source: null });
    expect(brandInfo("Shambeen long sleeve green 9536")).toEqual({ brand: null, flag: null, source: "supplier" });
    expect(brandInfo("Bs-8022 Grey")).toEqual({ brand: null, flag: null, source: "supplier" });
    expect(brandInfo("Jaja&Nana tee grey")).toEqual({ brand: null, flag: null, source: "supplier" });
    expect(brandOf("Nike 270 black")).toBe("Nike");
    expect(brandOf("Jordan 4 brue")).toBe("Jordan");
    expect(brandInfo("Shambeen Nike tee")).toEqual({ brand: null, flag: null, source: "supplier" });
    expect(brandInfo("Nike Air Max")).toEqual({ brand: "Nike", flag: null, source: "list" });
  });
  it("review findings: no colourway, comic, first-name or English-word brands", () => {
    expect(brandOf("Nike Dunk Michael Jordan tee")).toBe("Nike");
    expect(brandOf("Nike Air Force 1 Jordan blue")).toBe("Nike");
    expect(brandOf("Nike Air Jordan 1 Low")).toBe("Jordan");
    expect(brandOf("Nike Jordan 4 brue")).toBe("Jordan");
    expect(brandOf("Tiffany blue Nike Dunk")).toBe("Nike");
    expect(brandOf("Tiffany&Co watch")).toBe("Tiffany & Co.");
    expect(brandOf("Karl Kani tee")).toBe("Karl Kani");
    expect(brandOf("Karl beanie red")).toBe("Karl Lagerfeld");
    expect(brandOf("DC Comics Batman tee")).toBeNull();
    expect(brandOf("On sale Nike tee")).toBe("Nike");
    expect(brandOf("On cloud brown")).toBe("On");
    expect(brandOf("Black descent jacket")).toBeNull();
    expect(brandOf("Dr.Martens 1460")).toBe("Dr. Martens");
  });
});

import { brandOnRename } from "./brands.js";
import { brandFromLabel } from "./brands.js";
describe("brandFromLabel — a logo read is the brand mark itself", () => {
  it("exact short marks count on a label, not in a name", () => {
    expect(brandFromLabel("DC")).toBe("DC");
    expect(brandOf("DC Comics tee")).toBeNull();
    expect(brandFromLabel("DESCENTE")).toBe("Descente");
    expect(brandFromLabel("Emporio Armani")).toBe("Armani");
    expect(brandFromLabel("Giuseppe Zanotti")).toBe("Giuseppe Zanotti");
    expect(brandFromLabel("none")).toBeNull();
    expect(brandFromLabel("POP MART")).toBeNull();
  });
});

describe("brandOnRename — a rename never overwrites a set brand", () => {
  it("re-derives only an empty or flagged brand", () => {
    expect(brandOnRename({ brand: null, brandFlag: "unrecognised" }, "Nike Dunk Low")).toEqual({ brand: "Nike", brandFlag: null, brandSource: "list" });
    expect(brandOnRename({ brand: null }, "Shambeen tee")).toEqual({ brand: null, brandFlag: null, brandSource: "supplier" });
  });
  it("leaves a set or hand-set brand alone", () => {
    expect(brandOnRename({ brand: "Christian Louboutin" }, "Christian loubiton spikes")).toBeNull();
    expect(brandOnRename({ brand: null, brandSource: "manual" }, "Nike Dunk")).toBeNull();
  });
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
  it("'Polo Ralph Lauren Hoodie' is a Hoodie, not a Polo", () => {
    expect(C("Polo Ralph Lauren Hoodie Navy").subcategory).toBe("Hoodies & Sweatshirts");
    expect(C("Ralph Lauren Polo Shirt White").subcategory).toBe("Polos"); // a real polo still matches
  });
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
  it("watch → Watches (one-size would otherwise fall into Perfume)", () => {
    expect(categorize("Chanel Watch", ONE)).toMatchObject({ category: "Accessories", subcategory: "Watches", brand: "Chanel" });
    expect(categorize("Daniel Wellington Watch", ONE).subcategory).toBe("Watches");
  });
  it("glasses / sunglasses → Eyewear", () => {
    expect(categorize("Designer Glasses", ONE).subcategory).toBe("Eyewear");
    expect(categorize("Ray-Ban Sunglasses Black", ONE).subcategory).toBe("Eyewear");
  });
  it("necklace / bracelet → Jewellery", () => {
    expect(categorize("Necklace", ONE).subcategory).toBe("Jewellery");
    expect(categorize("Bracelet", ONE).subcategory).toBe("Jewellery");
  });
  it("'chain' in a sneaker name is NOT jewellery (no bare chain keyword)", () => {
    expect(categorize("Louis Vuitton Time Out White Monogram Canvas Silver Chain", ["4", "5", "6"]).category).toBe("Footwear");
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

describe("topCategory (display-only bucket)", () => {
  it("returns the real top-level category verbatim", () => {
    for (const c of TOP_CATEGORIES) expect(topCategory({ category: c })).toBe(c);
  });
  it("ignores productType — the field that mis-labels the data", () => {
    // Live reality: accessories carry productType "clothing", perfumes "sneaker".
    expect(topCategory({ category: "Accessories", productType: "clothing" })).toBe("Accessories");
    expect(topCategory({ category: "Perfume", productType: "sneaker" })).toBe("Perfume");
    expect(topCategory({ category: "Footwear", productType: undefined })).toBe("Footwear");
  });
  it("no / unknown / empty category → Uncategorized (never dropped)", () => {
    expect(topCategory({ productType: "sneaker" })).toBe(UNCATEGORIZED_TOP);
    expect(topCategory({ category: "" })).toBe(UNCATEGORIZED_TOP);
    expect(topCategory({ category: "Nonsense" })).toBe(UNCATEGORIZED_TOP);
    expect(topCategory({})).toBe(UNCATEGORIZED_TOP);
    expect(topCategory(null)).toBe(UNCATEGORIZED_TOP);
  });
});

// ── Price records ────────────────────────────────────────────────────────────
// The 35 live rows all carry ALL THREE signals; the predicate ORs them so that
// losing any one to an edit does not open the gate. Shape lifted from the
// 2026-08-16 census (p1785900000000 "Entry 30 Line").
describe("isPriceRecord — internal price carriers are not merchandise", () => {
  const REAL = {
    id: "p1785900000000", name: "Entry 30 Line", barcode: "30",
    priceProduct: true, category: "Price Products", subcategory: "Price Products",
    retailPrice: 30, stockPrice: 30, hasShoeBoxOption: false,
  };

  it("recognises a live price record", () => {
    expect(isPriceRecord(REAL)).toBe(true);
  });

  it("any ONE signal is enough — the rule cannot be edited open by halves", () => {
    expect(isPriceRecord({ priceProduct: true })).toBe(true);
    expect(isPriceRecord({ category: PRICE_RECORD_CATEGORY })).toBe(true);
    expect(isPriceRecord({ subcategory: PRICE_RECORD_CATEGORY })).toBe(true);
    // Re-categorised to a real category, flag left behind:
    expect(isPriceRecord({ priceProduct: true, category: "Clothing", subcategory: "T-Shirts" })).toBe(true);
    // Flag stripped, category left behind:
    expect(isPriceRecord({ category: PRICE_RECORD_CATEGORY, subcategory: "T-Shirts" })).toBe(true);
  });

  it("dropping any single field from a real record still reads as a price record", () => {
    for (const drop of ["priceProduct", "category", "subcategory"]) {
      const rec = { ...REAL };
      delete rec[drop];
      expect({ drop, priceRecord: isPriceRecord(rec) }).toEqual({ drop, priceRecord: true });
    }
  });

  it("a real product is never one — including a truthy-but-not-true flag", () => {
    expect(isPriceRecord({ id: "p1", name: "Slide brown", category: "Footwear", subcategory: "Sandals & Slides" })).toBe(false);
    // Only the literal boolean counts; a stray string must not smuggle a real
    // product out of the storefront.
    expect(isPriceRecord({ category: "Footwear", priceProduct: "no" })).toBe(false);
    expect(isPriceRecord({ category: "Footwear", priceProduct: 0 })).toBe(false);
  });

  it("matches the way resolveCollection normalises — whitespace and case cannot open the gate", () => {
    // The fail-open Kimi found on review: resolveCollection trims `category`
    // before its lookup, so a padded value used to slip past this predicate and
    // still match the "Price Products|*" row downstream — status "unmapped",
    // which publishes.
    expect(isPriceRecord({ category: "Price Products " })).toBe(true);
    expect(isPriceRecord({ category: " price products" })).toBe(true);
    expect(isPriceRecord({ category: "PRICE PRODUCTS" })).toBe(true);
    expect(isPriceRecord({ subcategory: "\tPrice Products\n" })).toBe(true);
    // …but it stays a match on the LABEL, not a substring of one.
    expect(isPriceRecord({ category: "Price Products Archive" })).toBe(false);
  });

  it("tolerates junk without throwing", () => {
    expect(isPriceRecord(null)).toBe(false);
    expect(isPriceRecord(undefined)).toBe(false);
    expect(isPriceRecord("Price Products")).toBe(false);
    expect(isPriceRecord({})).toBe(false);
  });
});

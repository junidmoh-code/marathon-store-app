// Brand-name search (sneaker wall, 2026-10-19): the dropdown went, so typing
// a brand name must filter by brand. Unit tests on the matcher, plus a pin
// that AssistantView's one search path actually calls it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildBrandIndex, matchBrandQuery, productInBrand, brandResults } from "./brandSearch";

const P = [
  { id: "1", name: "Air Force 1 Low QS Kobe Yellow", brand: "Nike" },
  { id: "2", name: "550 White Green", brand: "New Balance" },
  { id: "3", name: "Puma Suede Classic", brand: null },
  { id: "4", name: "Samba OG", brand: "adidas" },
  { id: "5", name: "Nikestyle Slide", brand: null },
];
const index = buildBrandIndex(P);

describe("matchBrandQuery", () => {
  it("a bare brand name, any case or spacing, is a brand query", () => {
    expect(matchBrandQuery(index, "nike")).toEqual({ key: "nike", rest: "" });
    expect(matchBrandQuery(index, "  NIKE ")).toEqual({ key: "nike", rest: "" });
    expect(matchBrandQuery(index, "Adidas")).toEqual({ key: "adidas", rest: "" });
  });
  it("a multi-word brand works, and what follows searches inside it", () => {
    expect(matchBrandQuery(index, "new  balance 550")).toEqual({ key: "new balance", rest: "550" });
  });
  it("a word that merely starts with a brand is a name search", () => {
    expect(matchBrandQuery(index, "nikes")).toBeNull();
    expect(matchBrandQuery(index, "samba")).toBeNull();
    expect(matchBrandQuery(index, "")).toBeNull();
  });
  it("brands come from the data — an unknown brand is not invented", () => {
    expect(matchBrandQuery(index, "puma")).toBeNull();
  });
});

describe("productInBrand", () => {
  it("matches on the product's own brand field", () => {
    expect(productInBrand(P[0], "nike")).toBe(true);    // name doesn't say Nike
    expect(productInBrand(P[3], "nike")).toBe(false);
  });
  it("a product with no brand counts only when the brand is a whole word of its name", () => {
    expect(productInBrand({ name: "Nike Dunk", brand: null }, "nike")).toBe(true);
    expect(productInBrand(P[4], "nike")).toBe(false);   // "Nikestyle"
  });
  it("a branded product is judged by its brand, not by its name", () => {
    expect(productInBrand({ name: "Nike-inspired runner", brand: "Puma" }, "nike")).toBe(false);
  });
  it("filtering the catalogue by a typed brand returns that brand only", () => {
    const bq = matchBrandQuery(index, "Nike");
    expect(P.filter(p => productInBrand(p, bq.key)).map(p => p.id)).toEqual(["1"]);
  });
});

describe("brandResults — the brand first, then names that carry it", () => {
  it("a Jordan-filed 'Nike Air Jordan' still answers 'nike', after the Nike-branded ones", () => {
    const pool = [...P, { id: "6", name: "Nike Air Jordan 1 Mid", brand: "Jordan" }];
    expect(brandResults(pool, "nike").map(p => p.id)).toEqual(["1", "6"]);
  });
  it("a two-letter brand on its own does not hijack a name search", () => {
    const idx = buildBrandIndex([{ name: "Cloud 5", brand: "On" }]);
    expect(matchBrandQuery(idx, "on")).toBeNull();
    expect(matchBrandQuery(idx, "on cloud")).toEqual({ key: "on", rest: "cloud" });
  });
});

describe("AssistantView's search uses it", () => {
  const app = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");
  it("the one search path consults the brand index before Fuse", () => {
    const i = app.indexOf("const bq = matchBrandQuery(brandIndex, q);");
    const j = app.indexOf("return merge(fuse.search(q).map(r => r.item));");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
  });
});

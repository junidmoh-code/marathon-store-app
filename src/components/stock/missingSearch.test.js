import { describe, it, expect } from "vitest";
import { searchTerms, matchesSearch } from "./missingSearch";

const row = (name) => ({ name });
const m = (q, name, product) => matchesSearch(searchTerms(q), row(name), product);

describe("Missing Products search", () => {
  it("matches the name case-insensitively, inside words and numbers", () => {
    expect(m("AIR", "Nike Air Force 1")).toBe(true);
    expect(m("forc", "Nike Air Force 1")).toBe(true);
    expect(m("5919", "Sweatshirt 25919 yomo")).toBe(true);
    expect(m("5919", "Sweatshirt 2606 yomo")).toBe(false);
  });

  it("every word typed must match somewhere", () => {
    expect(m("af1 white", "AF1 White/White")).toBe(true);
    expect(m("af1 black", "AF1 White/White")).toBe(false);
  });

  it("matches brand and style code from the product record already loaded", () => {
    const p = { brand: "Adidas", styleCode: "DD1391-100", styleCodeNormalised: "DD1391100" };
    expect(m("adidas", "Gazelle Bold", p)).toBe(true);
    expect(m("dd1391", "Gazelle Bold", p)).toBe(true);
    expect(m("dd1391-100", "Gazelle Bold", p)).toBe(true);
    expect(m("dd1391100", "Gazelle Bold", p)).toBe(true);
    expect(m("puma", "Gazelle Bold", p)).toBe(false);
  });

  it("an empty or blank query matches everything; a missing product record is fine", () => {
    expect(m("", "Anything")).toBe(true);
    expect(m("   ", "Anything")).toBe(true);
    expect(m("tee", "Essentials Tee", undefined)).toBe(true);
  });

  it("a non-breaking space in a name is an ordinary space", () => {
    expect(m("cream white", "Pant cream white")).toBe(true);
  });
});

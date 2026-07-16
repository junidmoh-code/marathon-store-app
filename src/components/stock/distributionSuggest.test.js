// Tests for the V1 initial-distribution suggestion engine. The tables are an
// owner-specified contract (spec 2026-07-16) — if a table value changes here,
// it must have changed in the spec first.
import { describe, it, expect } from "vitest";
import { suggestInitialDistribution, sizeFamily, DISTRIBUTION_DESTS } from "./distributionSuggest";

const clothing = (sizes) => ({ productType: "clothing", sizes });
const sneaker = (sizes) => ({ productType: "sneaker", sizes });

describe("sizeFamily", () => {
  it("classifies letter clothing", () => {
    expect(sizeFamily(clothing(["S", "M", "L"]))).toBe("letters");
  });
  it("classifies waist clothing (bottoms)", () => {
    expect(sizeFamily(clothing(["30", "32", "34"]))).toBe("waist");
  });
  it("classifies adult and kids sneakers as shoe — productType wins over numeric range", () => {
    expect(sizeFamily(sneaker(["7", "8", "9"]))).toBe("shoe");
    expect(sizeFamily(sneaker(["28", "30", "32"]))).toBe("shoe"); // kids sizes look like waists
  });
  it("legacy products without productType default to shoe", () => {
    expect(sizeFamily({ sizes: ["5.5", "6"] })).toBe("shoe");
  });
  it("handles empty/one-size products", () => {
    expect(sizeFamily({ sizes: [] })).toBe("unknown");
    expect(sizeFamily({ sizes: ["one size"] })).toBe("unknown");
  });
});

describe("suggestInitialDistribution — letter clothing", () => {
  const { suggestions } = suggestInitialDistribution({
    product: clothing(["S", "M", "L", "XL", "XXL", "XXXL"]),
  });
  it("covers every destination", () => {
    expect(Object.keys(suggestions).sort()).toEqual([...DISTRIBUTION_DESTS].sort());
  });
  it("matches the spec tables for shops", () => {
    expect(suggestions["marathon-pe"]).toEqual({ S: 0, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 1 });
    expect(suggestions.trophy).toEqual({ S: 0, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 1 });
    expect(suggestions["marathon-pine"]).toEqual({ S: 2, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 2 });
  });
  it("matches the spec tables for hub buffers", () => {
    const buffer = { S: 2, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 2 };
    expect(suggestions.hub1).toEqual(buffer);
    expect(suggestions.hub2).toEqual(buffer);
  });
  it("4XL defaults to zero (not in the spec tables)", () => {
    const r = suggestInitialDistribution({ product: clothing(["4XL"]) });
    for (const dest of DISTRIBUTION_DESTS) expect(r.suggestions[dest]["4XL"]).toBe(0);
  });
  it("only suggests for sizes the product actually has", () => {
    const r = suggestInitialDistribution({ product: clothing(["M", "L"]) });
    expect(Object.keys(r.suggestions.hub2)).toEqual(["M", "L"]);
  });
});

describe("suggestInitialDistribution — shoes", () => {
  it("gives hubs 2 per size and shops zero, half sizes included", () => {
    const { suggestions } = suggestInitialDistribution({
      product: sneaker(["3", "4", "5", "5.5", "6", "7", "8", "9", "10", "11"]),
    });
    for (const size of ["3", "5.5", "11"]) {
      expect(suggestions.hub1[size]).toBe(2);
      expect(suggestions.hub2[size]).toBe(2);
      expect(suggestions["marathon-pe"][size]).toBe(0);
      expect(suggestions.trophy[size]).toBe(0);
      expect(suggestions["marathon-pine"][size]).toBe(0);
    }
  });
  it("applies the same flat run to kids shoe sizes", () => {
    const { suggestions } = suggestInitialDistribution({ product: sneaker(["28", "31"]) });
    expect(suggestions.hub1["28"]).toBe(2);
    expect(suggestions["marathon-pe"]["28"]).toBe(0);
  });
});

describe("suggestInitialDistribution — bottoms (waist positional mapping)", () => {
  it("maps 28↔S … 40↔4XL onto the letter tables", () => {
    const { suggestions } = suggestInitialDistribution({
      product: clothing(["28", "30", "32", "34", "36", "38", "40"]),
    });
    // marathon-pe letter row: S0 M2 L2 XL1 XXL1 XXXL1 4XL0
    expect(suggestions["marathon-pe"]).toEqual({ 28: 0, 30: 2, 32: 2, 34: 1, 36: 1, 38: 1, 40: 0 });
    // pine/hub row: S2 M3 L3 XL2 XXL2 XXXL2 4XL0
    expect(suggestions.hub2).toEqual({ 28: 2, 30: 3, 32: 3, 34: 2, 36: 2, 38: 2, 40: 0 });
  });
  it("unmapped waist sizes default to zero", () => {
    const { suggestions } = suggestInitialDistribution({ product: clothing(["29"]) });
    for (const dest of DISTRIBUTION_DESTS) expect(suggestions[dest]["29"]).toBe(0);
  });
});

describe("suggestInitialDistribution — unknown family", () => {
  it("suggests zero everywhere so the operator drives", () => {
    const { family, suggestions } = suggestInitialDistribution({ product: { sizes: ["one size"] } });
    expect(family).toBe("unknown");
    expect(suggestions.hub2["one size"]).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import { classifyClothingProduct } from "./auditCore.mjs";

describe("classifyClothingProduct", () => {
  const bape = { productType: "clothing", category: "Footwear", categoryKey: "sneakers", sizes: ["6", "7", "8", "9", "10", "11"] };
  it("a Footwear sneaker with shoe sizes and sneaker orders is restored", () => {
    expect(classifyClothingProduct(bape, { sneaker: { n: 38 } })).toMatchObject({ score: 6, verdict: "restore" });
  });
  it("two signals are enough to restore; one is only listed", () => {
    expect(classifyClothingProduct(bape, {}).verdict).toBe("restore");
    const bag = { productType: "clothing", category: "Accessories", categoryKey: "packaging", sizes: ["3"] };
    expect(classifyClothingProduct(bag, { clothing: { n: 74 } })).toMatchObject({ score: 2, verdict: "look" });
  });
  it("a bottoms waist run is not a shoe-size run", () => {
    expect(classifyClothingProduct({ productType: "clothing", category: "Clothing", sizes: ["28", "30", "32", "34"] })).toBe(null);
  });
  it("sharing a style code with a Footwear product is a signal; a Hub 1 cell is not one", () => {
    const tee = { productType: "clothing", category: "Clothing", sizes: ["S"], styleCodeNormalised: "315122111" };
    expect(classifyClothingProduct(tee, {}, { footwearStyleCodes: new Set(["315122111"]) })).toMatchObject({ score: 2, verdict: "look" });
    expect(classifyClothingProduct({ ...tee, category: "Footwear" }, {}, { footwearStyleCodes: new Set(["315122111"]) }).verdict).toBe("restore");
  });
  it("real clothing, sneakers already typed as sneakers, and merged-away records are ignored", () => {
    expect(classifyClothingProduct({ productType: "clothing", category: "Clothing", sizes: ["S", "M", "L"] })).toBe(null);
    expect(classifyClothingProduct({ ...bape, productType: "sneaker" })).toBe(null);
    expect(classifyClothingProduct({ ...bape, mergedInto: "p2" })).toBe(null);
  });
});

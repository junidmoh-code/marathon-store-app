import { describe, it, expect } from "vitest";
import { hubLineCounts } from "./hubLineCounts";

const products = {
  shoe: { id: "shoe", category: "Footwear", categoryKey: "sneakers", sizes: ["8"] },
  tee: { id: "tee", category: "Clothing", categoryKey: "t-shirts", sizes: ["M"] },
};
const of = (pid) => products[pid];
const req = (over) => ({ status: "open", productId: "tee", size: "M", requestingLocation: "hub2", ...over });

describe("Source hub toggle counts (Junid, 24 Nov 2026)", () => {
  it("splits Hub 2 and Hub 3 open requests by the toggle's own classifier", () => {
    const out = hubLineCounts([
      req({}), req({}), req({ productId: "shoe", size: "8" }),
      req({ requestingLocation: "hub3", productId: "shoe", size: "8" }),
    ], of);
    expect(out).toEqual({ hub2: { sneakers: 1, clothing: 2 }, hub3: { sneakers: 1, clothing: 0 } });
  });

  it("counts what the tab badge counts: not closed, not a shadow preview, not other locations", () => {
    const out = hubLineCounts([
      req({ status: "fulfilled" }), req({ shadow: true }), req({ requestingLocation: "hub1" }),
      req({ requestingLocation: "concrete" }), req({ productId: null }),
    ], of);
    expect(out).toEqual({ hub2: { sneakers: 0, clothing: 0 }, hub3: { sneakers: 0, clothing: 0 } });
  });

  it("a request whose product is missing from the catalogue counts under Clothing, where the list shows it", () => {
    expect(hubLineCounts([req({ productId: "gone", size: "8" })], of).hub2).toEqual({ sneakers: 0, clothing: 1 });
  });

  it("a footwear product with a non-numeric size is a Clothing line, as on the list", () => {
    expect(hubLineCounts([req({ productId: "shoe", size: "UK 8" })], of).hub2).toEqual({ sneakers: 0, clothing: 1 });
  });

  it("tolerates no list at all", () => {
    expect(hubLineCounts(undefined, of).hub2).toEqual({ sneakers: 0, clothing: 0 });
  });
});

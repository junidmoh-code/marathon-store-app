// ─── MERGED PRODUCTS — the redirect contract, proven behaviourally ───────────
// The owner's mandatory proofs live here on the client side:
//   • after a merge the loser is unreachable from search and from every product
//     list (everything renders from the ONE filtered array);
//   • an old sale referencing the loser still resolves (followMerge).

import { describe, it, expect } from "vitest";
import { filterMergedProducts, followMerge, isMergedAway } from "./mergedProducts";
import { searchProducts } from "./productSearch";

const CATALOGUE = [
  { id: "pA", name: "Nike SB Dunk Low", category: "Footwear", sizes: ["6"] },
  { id: "pB", name: "Nike SB Dunk Low", category: "Footwear", sizes: ["6"], mergedInto: "pA" },
  { id: "pC", name: "Gucci Ace", category: "Footwear", sizes: ["8"] },
];

describe("the loser disappears from the operator's world", () => {
  it("is dropped from the products array every list renders from", () => {
    const visible = filterMergedProducts(CATALOGUE);
    expect(visible.map((p) => p.id)).toEqual(["pA", "pC"]);
  });

  it("is unreachable from search — the shared matcher never sees it", () => {
    const visible = filterMergedProducts(CATALOGUE);
    const hits = searchProducts(visible, "dunk");
    expect(hits.map((p) => p.id)).toEqual(["pA"]);
  });
});

describe("old references keep resolving", () => {
  const byId = Object.fromEntries(CATALOGUE.map((p) => [p.id, p]));

  it("an old sale's productId lands on the survivor", () => {
    expect(followMerge(byId, "pB").id).toBe("pA");
  });
  it("a chain of merges follows to the end", () => {
    const chained = { ...byId, pA: { ...byId.pA, mergedInto: "pC" } };
    expect(followMerge(chained, "pB").id).toBe("pC");
  });
  it("a dangling pointer still returns the loser's own record — never null for a real sale", () => {
    const dangling = { pX: { id: "pX", name: "Ghost", mergedInto: "pGone" } };
    expect(followMerge(dangling, "pX").name).toBe("Ghost");
  });
  it("a pointer cycle (bad data) stops instead of spinning", () => {
    const cyclic = {
      p1: { id: "p1", mergedInto: "p2" },
      p2: { id: "p2", mergedInto: "p1" },
    };
    expect(followMerge(cyclic, "p1")).toBeTruthy();
  });
  it("an id that never existed is null", () => {
    expect(followMerge(byId, "nope")).toBe(null);
  });
});

describe("isMergedAway", () => {
  it("only a real pointer counts", () => {
    expect(isMergedAway({ mergedInto: "x" })).toBe(true);
    expect(isMergedAway({ mergedInto: "" })).toBe(false);
    expect(isMergedAway({})).toBe(false);
    expect(isMergedAway(null)).toBe(false);
  });
});

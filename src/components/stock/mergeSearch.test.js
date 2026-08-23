// ─── merge target search tests — nothing a merge needs is unreachable ────────
// Every case is stated as "can the operator FIND this product", because that is
// the defect: a twin that cannot be found can never be merged.

import { describe, it, expect } from "vitest";
import { mergeTargetPool, mergeTargetMatches, matchesQuery, rowLabel, displayName } from "./mergeSearch.js";

const sneaker = (over = {}) => ({
  id: "s1", name: "Nike Air Force 1 White", categoryKey: "sneakers", ...over,
});
const LOSER = sneaker({ id: "loser", name: "Nike Air Force 1 White (dup)" });

describe("the pool", () => {
  it("a ZERO-STOCK footwear product is offered — stock is not a filter here", () => {
    const p = sneaker({ id: "z" });                     // no stock anywhere, no stock field
    expect(mergeTargetPool([p], LOSER).map((x) => x.id)).toEqual(["z"]);
  });

  it("a footwear product with NO PHOTO and NO CODE is offered", () => {
    const p = sneaker({ id: "bare", photoUrl: null, styleCodeNormalised: null });
    expect(mergeTargetPool([p], LOSER).map((x) => x.id)).toEqual(["bare"]);
  });

  it("a NON-footwear product is not offered for a footwear loser", () => {
    const shirt = { id: "t1", name: "Nike Tee", categoryKey: "t-shirts" };
    expect(mergeTargetPool([shirt, sneaker()], LOSER).map((x) => x.id)).toEqual(["s1"]);
  });

  it("a merged-away product is not offered — it is already a redirect", () => {
    const gone = sneaker({ id: "g", mergedInto: "s1" });
    expect(mergeTargetPool([gone, sneaker()], LOSER).map((x) => x.id)).toEqual(["s1"]);
  });

  it("the loser itself is never offered", () => {
    expect(mergeTargetPool([LOSER, sneaker()], LOSER).map((x) => x.id)).toEqual(["s1"]);
  });

  it("slides and soccer boots and kids shoes are footwear — the picker is not sneakers-only", () => {
    const pool = mergeTargetPool([
      sneaker({ id: "sl", categoryKey: "slides" }),
      sneaker({ id: "sb", categoryKey: "soccer-boots" }),
      sneaker({ id: "ks", categoryKey: "kids-shoes" }),
      sneaker({ id: "lg", categoryKey: null, category: "Footwear" }),
    ], LOSER);
    expect(pool.map((x) => x.id).sort()).toEqual(["ks", "lg", "sb", "sl"]);
  });

  it("a NON-footwear loser gets the WHOLE pool — never a dead end", () => {
    const shirtLoser = { id: "tl", name: "Nike Tee (dup)", categoryKey: "t-shirts" };
    const shirt = { id: "t1", name: "Nike Tee", categoryKey: "t-shirts" };
    const pool = mergeTargetPool([shirt, sneaker()], shirtLoser);
    expect(pool.map((x) => x.id).sort()).toEqual(["s1", "t1"]);
  });

  it("a BADLY-CATEGORISED shoe can still reach its real sneaker twin", () => {
    // designer-shoes is footwear in the live taxonomy but absent from the
    // cross-app classifier's key list, so it reads as NOT footwear. A symmetric
    // filter would have hidden its twin completely.
    const odd = { id: "ds", name: "Gucci Ace (dup)", categoryKey: "designer-shoes" };
    const twin = sneaker({ id: "real", name: "Gucci Ace" });
    expect(mergeTargetPool([twin], odd).map((x) => x.id)).toEqual(["real"]);
  });

  it("a legacy record with a non-'Footwear' category still reaches its twin", () => {
    const odd = { id: "lg", name: "Air Max (dup)", category: "Sneakers" };  // not the exact legacy string
    const twin = sneaker({ id: "real", name: "Nike Air Max" });
    expect(mergeTargetPool([twin], odd).map((x) => x.id)).toEqual(["real"]);
  });

  it("a FOOTWEAR loser still never sees a t-shirt — the property being protected", () => {
    const shirt = { id: "t1", name: "Nike Tee", categoryKey: "t-shirts" };
    expect(mergeTargetPool([shirt, sneaker()], LOSER).map((x) => x.id)).toEqual(["s1"]);
  });
});

describe("matching", () => {
  const MAP = { s1: { c: ["BQ6817302", "745SMA00421G"], a: [["CLOUDNOVA", "ONRUNNING"]] } };

  it("finds a product by its STYLE CODE", () => {
    expect(matchesQuery(sneaker(), "BQ6817302", MAP)).toBe(true);
  });

  it("finds it by the code as PRINTED, punctuation and all", () => {
    expect(matchesQuery(sneaker(), "745SMA004-21G", MAP)).toBe(true);
  });

  it("finds it by a partly-remembered code", () => {
    expect(matchesQuery(sneaker(), "68173", MAP)).toBe(true);
  });

  it("finds it by a LABEL ALIAS word", () => {
    expect(matchesQuery(sneaker(), "cloudnova", MAP)).toBe(true);
  });

  it("finds it by name, forgivingly, as before", () => {
    expect(matchesQuery(sneaker(), "nke air force", MAP)).toBe(true);
  });

  it("does not match an unrelated string", () => {
    expect(matchesQuery(sneaker(), "adidas samba", MAP)).toBe(false);
  });

  it("an EMPTY query matches everything — the list is never a dead end", () => {
    expect(matchesQuery(sneaker(), "", MAP)).toBe(true);
    expect(matchesQuery(sneaker(), "   ", null)).toBe(true);
  });

  it("with no identity map it still matches on the product's own fields", () => {
    expect(matchesQuery(sneaker({ styleCodeNormalised: "ZZ1" }), "ZZ1", null)).toBe(true);
  });
});

describe("results", () => {
  const many = Array.from({ length: 214 }, (_, i) =>
    sneaker({ id: `p${i}`, name: `Nike Air Force 1 Colour ${i}` }));

  it("is UNCAPPED — every match is returned, not the first twelve", () => {
    const hits = mergeTargetMatches(mergeTargetPool(many, LOSER), "air force", null);
    expect(hits.length).toBe(214);
  });

  it("an empty query returns the whole offerable pool, so scrolling reaches anything", () => {
    const hits = mergeTargetMatches(mergeTargetPool(many, LOSER), "", null);
    expect(hits.length).toBe(214);
  });

  it("results are in a stable, name-sorted order", () => {
    const hits = mergeTargetMatches(
      mergeTargetPool([sneaker({ id: "b", name: "Bravo" }), sneaker({ id: "a", name: "Alpha" })], LOSER),
      "", null,
    );
    expect(hits.map((h) => h.name)).toEqual(["Alpha", "Bravo"]);
  });
});

describe("a product with no usable name is still identifiable, and never leads", () => {
  const nameless = { id: "n1", categoryKey: "sneakers" };
  const objectName = { id: "n2", categoryKey: "sneakers", name: { en: "oops" } };

  it("renders a label naming its id rather than a blank card", () => {
    expect(rowLabel(nameless)).toBe("(no name — id n1)");
    expect(rowLabel(objectName)).toBe("(no name — id n2)");
    expect(rowLabel(sneaker())).toBe("Nike Air Force 1 White");
  });

  it("an object name never reaches the renderer as an object", () => {
    expect(typeof displayName(objectName)).toBe("string");
    expect(displayName(objectName)).toBe("");
  });

  it("nameless rows sort LAST, so they are never the first thing an operator taps", () => {
    const hits = mergeTargetMatches(
      mergeTargetPool([nameless, sneaker({ id: "z", name: "Zebra" }), sneaker({ id: "a", name: "Alpha" })], LOSER), "", null,
    );
    expect(hits.map((h) => h.id)).toEqual(["a", "z", "n1"]);
  });

  it("a nameless product is still findable by its code", () => {
    expect(matchesQuery(nameless, "BQ681", { n1: { c: ["BQ6817302"], a: [] } })).toBe(true);
  });
});

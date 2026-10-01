import { describe, it, expect } from "vitest";
import { normaliseShoeSize, shoeSizeKey, findMatchingSize, shoeSizeRange, productIsKidsGrid } from "./shoeSize";
import { SIZES_FOOTWEAR, SIZES_KIDS } from "./productTaxonomy";

describe("the labels actually in the catalogue (sampled 2026-10-01)", () => {
  // Every footwear label in a 1,600-record bounded sample of /products.
  const SEEN = ["3", "4", "5", "5.5", "6", "7", "8", "9", "10", "11", "12", "13"];
  it("every one reads as adult UK, and none is a child's size", () => {
    for (const s of SEEN) {
      const n = normaliseShoeSize(s);
      expect(n, s).not.toBe(null);
      expect(n.scale, s).toBe("uk");
      expect(n.kids, s).toBe(false);
      expect(n.key).toBe(`uk:${Number(s)}`);
    }
  });
  it("the seeded footwear run and the kids run both classify, on different scales", () => {
    for (const s of SIZES_FOOTWEAR) expect(normaliseShoeSize(s)?.scale, s).toBe("uk");
    for (const s of SIZES_KIDS) {
      const n = normaliseShoeSize(s);
      expect(n?.scale, s).toBe("eu");
      expect(n?.kids, s).toBe(true);
    }
  });
  // The one oddity in the sample: apparel letters on a sneaker record.
  it("apparel letters on a shoe are unclassifiable and match nothing", () => {
    for (const s of ["S", "XXL"]) expect(normaliseShoeSize(s), s).toBe(null);
  });
  it("the one-size sentinels match nothing", () => {
    for (const s of ["_", "Free Size", "", "  ", null, undefined, {}, []]) expect(normaliseShoeSize(s)).toBe(null);
  });
});

describe("spellings of the same size meet on one key", () => {
  it("half sizes in every spelling, including the RTDB key form", () => {
    for (const s of ["5.5", "5,5", "5_5", "5½", " 5.5 ", "UK 5.5", "uk5.5", "5.5 UK"]) expect(shoeSizeKey(s), s).toBe("uk:5.5");
  });
  it("a trailing .0 and a number are the same size", () => {
    expect(shoeSizeKey("8.0")).toBe("uk:8");
    expect(shoeSizeKey(8)).toBe("uk:8");
  });
  it("EU, labelled or bare", () => {
    for (const s of ["EU 42", "EUR42", "42 EU", "42"]) expect(shoeSizeKey(s), s).toBe("eu:42");
  });
});

describe("a kids size is never an adult size", () => {
  it("6Y is not 6", () => {
    expect(shoeSizeKey("6Y")).not.toBe(shoeSizeKey("6"));
  });
  it("youth / grade-school spellings meet each other", () => {
    for (const s of ["6Y", "6 Y", "6y", "GS 6", "6 GS", "YOUTH 6"]) {
      const n = normaliseShoeSize(s);
      expect(n?.key, s).toBe("youth:6");
      expect(n?.kids, s).toBe(true);
    }
  });
  it("pre-school and toddler are their own scales", () => {
    expect(shoeSizeKey("10C")).toBe("child:10");
    expect(shoeSizeKey("PS 10")).toBe("child:10");
    expect(shoeSizeKey("5T")).toBe("toddler:5");
    expect(shoeSizeKey("TD 5")).toBe("toddler:5");
    for (const s of ["10C", "5T"]) expect(normaliseShoeSize(s).kids).toBe(true);
  });
  it("no conversion between US and UK — a US 8 is not a UK 8", () => {
    expect(shoeSizeKey("US 8")).toBe("us:8");
    expect(shoeSizeKey("US M 8")).toBe("us:8");
    expect(shoeSizeKey("8 US")).toBe("us:8");
    expect(shoeSizeKey("US 8")).not.toBe(shoeSizeKey("8"));
    expect(shoeSizeKey("8W")).toBe("us-w:8");
    expect(shoeSizeKey("8W")).not.toBe(shoeSizeKey("US 8"));
  });
});

describe("what cannot be read with confidence is refused", () => {
  it.each(["8.3", "8 / 42", "8-9", "M", "XL", "57.5x", "OS", "0", "99", "5XL", "abc"])("%s", (s) => {
    expect(normaliseShoeSize(s)).toBe(null);
  });
  it("a fitted-cap / waist number is never an EU shoe", () => {
    for (const s of ["55", "57", "63"]) expect(normaliseShoeSize(s), s).toBe(null);
  });
});

describe("findMatchingSize returns the candidate's OWN label", () => {
  it("matches across spellings and hands back the label the candidate's cells are keyed by", () => {
    expect(findMatchingSize(["7", "8.5", "9"], "8,5")).toBe("8.5");
    expect(findMatchingSize(["UK 8", "UK 9"], "8")).toBe("UK 8");
  });
  it("never matches a kids size to an adult request, or the reverse", () => {
    expect(findMatchingSize(["5Y", "6Y", "7Y"], "6")).toBe(undefined);
    expect(findMatchingSize(["5", "6", "7"], "6Y")).toBe(undefined);
  });
  it("an unclassifiable request matches nothing, even a byte-equal label", () => {
    expect(findMatchingSize(["S", "M"], "S")).toBe(undefined);
  });
  it("is safe on junk", () => {
    expect(findMatchingSize(null, "8")).toBe(undefined);
    expect(findMatchingSize(["8"], null)).toBe(undefined);
  });
});

describe("shoeSizeRange", () => {
  it("Junid's case: the 3–6 Air Force and an adult 6–11", () => {
    expect(shoeSizeRange(["3", "4", "5", "5.5", "6"])).toMatchObject({ scale: "uk", lo: 3, hi: 6, kids: false });
    expect(shoeSizeRange(["6", "7", "8", "9", "10", "11"])).toMatchObject({ scale: "uk", lo: 6, hi: 11, kids: false });
  });
  it("reports what it could not read, and skips the sentinel and RTDB holes", () => {
    const r = shoeSizeRange(["6", "7", "S", "XXL", "_", null]);
    expect(r.keys).toEqual(["uk:6", "uk:7"]);
    expect(r.unclassified).toEqual(["S", "XXL"]);
  });
  it("tolerates the object shape RTDB returns for an array with a hole", () => {
    expect(shoeSizeRange({ 0: "6", 2: "8" })).toMatchObject({ lo: 6, hi: 8 });
  });
  it("a kids grid is flagged kids", () => {
    expect(shoeSizeRange(["4Y", "5Y", "6Y"])).toMatchObject({ scale: "youth", kids: true });
    expect(shoeSizeRange(SIZES_KIDS)).toMatchObject({ scale: "eu", kids: true });
  });
  it("null when there is nothing at all", () => {
    expect(shoeSizeRange([])).toBe(null);
    expect(shoeSizeRange(null)).toBe(null);
  });
});

describe("a bare number on a KIDS shoe is a kids size (architect review, PR #660)", () => {
  it("the kids category and the trade's kids markers flag a grid", () => {
    expect(productIsKidsGrid({ categoryKey: "kids-shoes" })).toBe(true);
    for (const name of ["Air Force 1 (GS) White", "Jordan 4 GS Bred", "Nike Dunk Kids Panda", "Yeezy 350 Infant", "Air Max PS"]) {
      expect(productIsKidsGrid({ name, categoryKey: "sneakers" }), name).toBe(true);
    }
  });
  it("…and adult names that merely look close are not flagged", () => {
    for (const name of ["Nike Air Force 1 Baby Blue", "Adidas Kid Cudi", "Nike Air Force 1 Low Stüssy Cream White", "Gsx runner"]) {
      expect(productIsKidsGrid({ name, categoryKey: "sneakers" }), name).toBe(false);
    }
    expect(productIsKidsGrid(null)).toBe(false);
  });
  it("a kids UK 10 never equals an adult UK 10", () => {
    expect(shoeSizeKey("10", { kidsGrid: true })).toBe("uk-kids:10");
    expect(shoeSizeKey("10", { kidsGrid: true })).not.toBe(shoeSizeKey("10"));
    expect(normaliseShoeSize("10", { kidsGrid: true }).kids).toBe(true);
    expect(findMatchingSize(["10", "11"], "10", { kidsGrid: true })).toBe(undefined);
    expect(findMatchingSize(["10", "11"], "10", { kidsGrid: true, requestedKidsGrid: true })).toBe("10");
  });
  it("labelled scales are untouched by the grid flag", () => {
    expect(shoeSizeKey("6Y", { kidsGrid: true })).toBe("youth:6");
    expect(shoeSizeKey("EU 30", { kidsGrid: true })).toBe("eu:30");
  });
});

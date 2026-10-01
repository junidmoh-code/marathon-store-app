// ─── DUPLICATE GROUPS — the join, the ranking, and the false positives ───────
// Every case here was found in the LIVE catalogue on 2026-08-31 while the
// builder was being tuned, so each one is a regression the shop actually has.

import { describe, it, expect } from "vitest";
import {
  buildDuplicateGroups, namesAreClose, normaliseName, brandKey, recommendSurvivor, memberFacts,
} from "./duplicateGroups.js";

const p = (id, name, over = {}) => ({ id, name, brand: "Nike", categoryKey: "sneakers", ...over });
const cell = (qty) => ({ qty, v: 0 });

describe("normalisation", () => {
  it("lowercases, strips punctuation and collapses whitespace", () => {
    expect(normaliseName("Diesel Slide  Black/Red ")).toBe("diesel slide black red");
    expect(normaliseName(null)).toBe("");
  });
  it("brandKey falls back to the first name token when the record has no brand", () => {
    expect(brandKey({ name: "Air foce 1" })).toBe("air");
    expect(brandKey({ name: "Air foce 1", brand: " Nike " })).toBe("nike");
  });
});

describe("namesAreClose — the ONE join", () => {
  it("joins identical normalised names", () => {
    expect(namesAreClose("Nike Air max plus black ", "Nike Air Max Plus Black")).toBe(true);
  });
  it("joins a pure word-order swap", () => {
    expect(namesAreClose("Alo bag black", "Alo black bag")).toBe(true);
  });
  it("joins a single-letter typo — the owner's own case", () => {
    expect(namesAreClose("Air foce 1", "Air force 1")).toBe(true);
  });
  it("does NOT join when two tokens differ", () => {
    expect(namesAreClose(
      "Adidas F50 Elite Laceless FG Dark Spark Soccer Boots",
      "Adidas F50 Elite Laceless FG Celestial Victory Soccer Boots")).toBe(false);
  });
  it("does NOT join different token counts", () => {
    expect(namesAreClose("Nike Air Force 1", "Nike Air Force 1 White")).toBe(false);
  });
  it("does NOT join when the differing token carries a DIGIT — a model number is not a typo", () => {
    // Live 2026-08-31: six different bags, six different T-shirts, two jeans.
    expect(namesAreClose("Essentials bag brown #9132", "Essentials bag brown #9165")).toBe(false);
    expect(namesAreClose("T-shirt black GLFS T1023", "T-shirt black GLFS T1012")).toBe(false);
    expect(namesAreClose("Nike Air Max 95", "Nike Air Max 97")).toBe(false);
  });
  it("does NOT join when the typo would eat the first letter", () => {
    expect(namesAreClose("Nike Shox Black", "Nike Chox Black")).toBe(false);
  });
});

describe("the builder", () => {
  const products = [
    p("pA", "Diesel Slide Black Red", { brand: "Diesel", styleCodeNormalised: "61250983", photoUrl: "u" }),
    p("pB", "Diesel Slide Black/Red", { brand: "Diesel" }),
    p("pLone", "Puma Suede Classic", { brand: "Puma" }),
  ];
  const allStock = {
    hub1: { pA: { 9: cell(200), 10: cell(62) }, pB: { 9: cell(9) } },
    trophy: { pA: { 9: cell(1) } },
  };

  it("groups the twins, leaves the lone product out entirely", () => {
    const g = buildDuplicateGroups({ products, allStock });
    expect(g).toHaveLength(1);
    expect(g[0].members.map((m) => m.id).sort()).toEqual(["pA", "pB"]);
  });

  it("recommends the copy with the stock, and says why in one line", () => {
    const [g] = buildDuplicateGroups({ products, allStock, salesByPid: { pA: { units: 71, lastMs: 5 }, pB: { units: 60, lastMs: 9 } } });
    expect(g.survivorId).toBe("pA");
    expect(g.reason).toContain("263 units across 2 locations");
    expect(g.reason).toContain("71 sold");
    expect(g.members[0].id).toBe("pA");   // ordered: the recommendation leads
  });

  it("flags the group as SPLIT when more than one copy holds stock", () => {
    const [g] = buildDuplicateGroups({ products, allStock });
    expect(g.split).toBe(true);
    const [g2] = buildDuplicateGroups({ products, allStock: { hub1: { pA: { 9: cell(5) } } } });
    expect(g2.split).toBe(false);
  });

  it("SHARED STYLE CODES DO NOT JOIN — colourway siblings are real products", () => {
    // Live: 315122111 is carried by four genuinely different Air Force 1s.
    const siblings = [
      p("s1", "Nike Air Force 1 White", { styleCodeNormalised: "315122111" }),
      p("s2", "Nike Air Force 1 White Blue Laces", { styleCodeNormalised: "315122111" }),
    ];
    expect(buildDuplicateGroups({ products: siblings, allStock: {} })).toHaveLength(0);
  });

  it("but different codes INSIDE a name group are reported as evidence", () => {
    const [g] = buildDuplicateGroups({
      products: [
        p("c1", "Nike SB Dunk Low Green White", { styleCodeNormalised: "DD1503120" }),
        p("c2", "Nike SB Dunk Low Green White", { styleCodeNormalised: "DM0807300" }),
      ], allStock: {},
    });
    expect(g.codesDiffer).toBe(true);
    expect(g.codes.sort()).toEqual(["DD1503120", "DM0807300"]);
  });

  it("merged-away records are never grouped — a completed merge is not a duplicate", () => {
    const withLoser = [...products, p("pB2", "Diesel Slide Black Red", { brand: "Diesel", mergedInto: "pA" })];
    const [g] = buildDuplicateGroups({ products: withLoser, allStock });
    expect(g.members.map((m) => m.id)).not.toContain("pB2");
  });

  it("worst first: split groups lead, then units", () => {
    const many = [
      p("x1", "Alpha Shoe", { brand: "A" }), p("x2", "Alpha Shoe", { brand: "A" }),
      p("y1", "Beta Shoe", { brand: "B" }),  p("y2", "Beta Shoe", { brand: "B" }),
    ];
    // Beta is split across two copies (2+2); Alpha holds more units but all on one copy.
    const st = { hub1: { x1: { 9: cell(50) }, y1: { 9: cell(2) }, y2: { 9: cell(2) } } };
    const g = buildDuplicateGroups({ products: many, allStock: st });
    expect(g[0].members[0].name).toBe("Beta Shoe");
  });

  it("memberFacts reports stock per location WITH sizes, and the deactivated flag", () => {
    const m = memberFacts(p("pA", "X", { deactivated: { at: 1, by: "u" } }), { allStock, identityMap: null, sales: null });
    expect(m.deactivated).toBe(true);
    expect(m.units).toBe(263);
    expect(m.byLoc[0]).toEqual({ loc: "hub1", qty: 262, sizes: [{ sizeKey: "9", qty: 200 }, { sizeKey: "10", qty: 62 }] });
    expect(m.sold).toBe(0);
  });
});

describe("recommendSurvivor never mutates and never picks blind", () => {
  it("leaves the caller's array alone", () => {
    const members = [
      { id: "a", name: "A", units: 1, locationsHolding: 1, sold: 0, hasPhoto: false, codes: [] },
      { id: "b", name: "B", units: 9, locationsHolding: 1, sold: 0, hasPhoto: false, codes: [] },
    ];
    const before = members.map((m) => m.id);
    const out = recommendSurvivor(members);
    expect(members.map((m) => m.id)).toEqual(before);
    expect(out.survivorId).toBe("b");
  });
  it("falls back to sold, then photo, then code, when neither holds stock", () => {
    const base = { units: 0, locationsHolding: 0, hasPhoto: false, codes: [], name: "X" };
    expect(recommendSurvivor([{ ...base, id: "a", sold: 3 }, { ...base, id: "b", sold: 9 }]).survivorId).toBe("b");
    expect(recommendSurvivor([{ ...base, id: "a", sold: 0 }, { ...base, id: "b", sold: 0, hasPhoto: true }]).survivorId).toBe("b");
    expect(recommendSurvivor([{ ...base, id: "a", sold: 0 }, { ...base, id: "b", sold: 0, codes: ["C1"] }]).survivorId).toBe("b");
  });
  it("says so plainly when nothing holds stock", () => {
    const base = { units: 0, locationsHolding: 0, hasPhoto: false, codes: [], name: "X", sold: 0 };
    expect(recommendSurvivor([{ ...base, id: "a" }, { ...base, id: "b" }]).reason).toContain("holds no stock either");
  });
});

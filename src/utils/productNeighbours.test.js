import { describe, it, expect } from "vitest";
import {
  SIMILARITY_WEIGHTS, SILHOUETTE_GROUP, MAX_NEIGHBOURS, MATCH_REASONS,
  silhouetteGroup, neighbourProfile, scorePair, topNeighbours,
  matchReasonCode, matchReasonText, encodeNeighbour, parseNeighbours,
} from "./productNeighbours.js";
import { SILHOUETTES, PRICE_BANDS, MAX_STYLE_TAGS } from "./productAttributes.js";

const ATTRS = {
  silhouette: "low-top", upperMaterial: "leather", primaryColour: "black",
  secondaryColour: "white", colourFamily: "black", pattern: "two-tone",
  toeShape: "round", soleColour: "white", priceBand: "core", styleTags: ["retro"],
};
const PRODUCT = { id: "p1", categoryKey: "sneakers", brand: "Nike", retailPrice: 750 };
const prof = (pid, a = {}, p = {}) =>
  neighbourProfile({ ...PRODUCT, id: pid, ...p }, { ...ATTRS, ...a });

describe("the silhouette group is a wall, not a weight", () => {
  it("covers every silhouette in the schema", () => {
    for (const s of SILHOUETTES) expect(silhouetteGroup(s), s).not.toBe("");
    expect(Object.keys(SILHOUETTE_GROUP).sort()).toEqual([...SILHOUETTES].sort());
  });
  it("scores zero across the wall no matter how alike everything else is", () => {
    const runner = prof("p1", { silhouette: "runner" });
    const slide = prof("p2", { silhouette: "slide" });
    expect(scorePair(runner, slide).score).toBe(0);
  });
  it("a cleat is never an alternative to a trainer, and a loafer never to a boot", () => {
    expect(scorePair(prof("p1", { silhouette: "low-top" }), prof("p2", { silhouette: "soccer-boot" })).score).toBe(0);
    expect(scorePair(prof("p1", { silhouette: "loafer" }), prof("p2", { silhouette: "boot" })).score).toBe(0);
  });
  it("trainers substitute for each other across their own group", () => {
    expect(scorePair(prof("p1", { silhouette: "low-top" }), prof("p2", { silhouette: "high-top" })).score).toBeGreaterThan(0);
  });
  it("an unknown silhouette produces no profile at all", () => {
    expect(neighbourProfile(PRODUCT, { ...ATTRS, silhouette: "moon-boot" })).toBe(null);
    expect(neighbourProfile(PRODUCT, null)).toBe(null);
  });
  it("a product is never its own alternative", () => {
    const a = prof("p1");
    expect(scorePair(a, a).score).toBe(0);
  });
});

// OWNER DECISION, and the one most likely to be quietly reversed by a later
// change: "a shopper who wanted an adidas may take a Nike".
describe("brand is a positive weight and NOT a filter", () => {
  const target = prof("p1", {}, { brand: "Nike" });
  it("a different brand still scores, and can still be a neighbour", () => {
    const other = prof("p2", {}, { brand: "Adidas" });
    expect(scorePair(target, other).score).toBeGreaterThan(0);
    expect(topNeighbours(target, [other]).map((n) => n.pid)).toEqual(["p2"]);
  });
  it("the same brand wins a tie", () => {
    const same = prof("p2", {}, { brand: "Nike" });
    const diff = prof("p3", {}, { brand: "Adidas" });
    expect(topNeighbours(target, [diff, same]).map((n) => n.pid)).toEqual(["p2", "p3"]);
  });
  it("but brand can NEVER outrank a shoe that is actually more alike", () => {
    // Same brand, but wrong silhouette, wrong colour, wrong material, wrong band.
    const sameBrandUnalike = prof("p2",
      { silhouette: "high-top", primaryColour: "yellow", colourFamily: "yellow", upperMaterial: "mesh", pattern: "solid", soleColour: "yellow", toeShape: "square", priceBand: "luxury", styleTags: [] },
      { brand: "Nike", categoryKey: "boots" });
    const otherBrandAlike = prof("p3", {}, { brand: "Adidas" });
    const ranked = topNeighbours(target, [sameBrandUnalike, otherBrandAlike]);
    expect(ranked[0].pid).toBe("p3");
  });
});

describe("the dominant terms dominate", () => {
  it("silhouette and categoryKey outweigh every look term put together", () => {
    const W = SIMILARITY_WEIGHTS;
    const look = W.colourFamily + W.colourExact + W.upperMaterial + W.pattern + W.soleColour + W.toeShape;
    expect(W.silhouette + W.categoryKey).toBeGreaterThan(look);
  });
  it("colourFamily outweighs the exact colour — burgundy ranks beside oxblood", () => {
    expect(SIMILARITY_WEIGHTS.colourFamily).toBeGreaterThan(SIMILARITY_WEIGHTS.colourExact);
    const target = prof("p1", { primaryColour: "burgundy", colourFamily: "red" });
    const sameFamily = prof("p2", { primaryColour: "maroon", colourFamily: "red" });
    const otherFamily = prof("p3", { primaryColour: "green", colourFamily: "green" });
    expect(scorePair(target, sameFamily).score).toBeGreaterThan(scorePair(target, otherFamily).score);
  });
  it("one price band apart still ranks; two apart contributes nothing", () => {
    const t = prof("p1", { priceBand: "core" });
    const one = scorePair(t, prof("p2", { priceBand: "mid" })).terms.priceBand;
    const two = scorePair(t, prof("p3", { priceBand: "premium" })).terms.priceBand;
    const same = scorePair(t, prof("p4", { priceBand: "core" })).terms.priceBand;
    expect(same).toBeGreaterThan(one);
    expect(one).toBeGreaterThan(0);
    expect(two).toBe(0);
  });
  it("every band is orderable — an unknown band contributes nothing rather than throwing", () => {
    for (const b of PRICE_BANDS) {
      expect(scorePair(prof("p1", { priceBand: b }), prof("p2", { priceBand: b })).terms.priceBand)
        .toBe(SIMILARITY_WEIGHTS.priceBand);
    }
    expect(scorePair(prof("p1", { priceBand: "" }), prof("p2", { priceBand: "core" })).terms.priceBand).toBe(0);
  });
  // buildAttributeRecord caps the MACHINE tags, but confirmed.styleTags is
  // human-supplied and resolveAttributes passes it through whole. Without a
  // clamp here, one six-tag correction would score six times the documented
  // cap and out-rank a shoe that matched on silhouette AND colour.
  it("clamps shared tags at the SCORING boundary, not only where the record is built", () => {
    const many = ["retro", "skate", "casual", "chunky", "luxury", "minimal"];
    const t = prof("p1", { styleTags: many });
    const u = prof("p2", { styleTags: many });
    expect(scorePair(t, u).terms.styleTag).toBe(SIMILARITY_WEIGHTS.styleTag * MAX_STYLE_TAGS);
  });
  it("…and a six-tag match still cannot outrank silhouette plus colour", () => {
    const t = prof("p1", { styleTags: ["retro", "skate", "casual", "chunky", "luxury", "minimal"] });
    const tagTwin = prof("p2",
      { silhouette: "high-top", primaryColour: "yellow", colourFamily: "yellow", upperMaterial: "mesh",
        pattern: "solid", soleType: "flat", finish: "plain", closure: "zip", soleColour: "yellow",
        toeShape: "square", priceBand: "luxury", styleTags: ["retro", "skate", "casual", "chunky", "luxury", "minimal"] },
      { brand: "Adidas", categoryKey: "boots" });
    const realTwin = prof("p3", { styleTags: [] }, { brand: "Adidas" });
    expect(topNeighbours(t, [tagTwin, realTwin])[0].pid).toBe("p3");
  });
  it("shared style tags add, and are capped by how many can be stored", () => {
    const t = prof("p1", { styleTags: ["retro", "skate", "casual"] });
    const all = scorePair(t, prof("p2", { styleTags: ["retro", "skate", "casual"] })).terms.styleTag;
    const one = scorePair(t, prof("p3", { styleTags: ["retro"] })).terms.styleTag;
    expect(all).toBe(SIMILARITY_WEIGHTS.styleTag * 3);
    expect(one).toBe(SIMILARITY_WEIGHTS.styleTag);
  });
});

describe("topNeighbours", () => {
  const target = prof("p0");
  const pool = Array.from({ length: 40 }, (_, i) => prof(`p${String(i + 1).padStart(3, "0")}`));
  it("respects the cap", () => {
    expect(topNeighbours(target, pool)).toHaveLength(MAX_NEIGHBOURS);
    expect(topNeighbours(target, pool, { limit: 5 })).toHaveLength(5);
  });
  it("is deterministic — ties break on pid, so a re-run gives the identical list", () => {
    const a = topNeighbours(target, pool).map((n) => n.pid);
    const b = topNeighbours(target, [...pool].reverse()).map((n) => n.pid);
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort());   // an all-tie field ranks by pid
  });
  it("is ordered best-first", () => {
    const scores = topNeighbours(target, pool).map((n) => n.score);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
  });
  it("never returns a zero-score neighbour — an empty list is a real answer", () => {
    const acrossTheWall = [prof("p9", { silhouette: "slide" }), prof("p8", { silhouette: "boot" })];
    expect(topNeighbours(prof("p1", { silhouette: "runner" }), acrossTheWall)).toEqual([]);
  });
  it("survives an empty pool and a null target", () => {
    expect(topNeighbours(target, [])).toEqual([]);
    expect(topNeighbours(null, pool)).toEqual([]);
  });
});

describe("the reason line never overstates the match", () => {
  it("every code it can emit has a sentence", () => {
    const codes = new Set();
    for (const sil of ["low-top", "high-top"]) for (const col of ["black", "red"]) {
      for (const brand of ["Nike", "Adidas"]) for (const mat of ["leather", "mesh"]) {
        for (const band of ["core", "luxury"]) {
          codes.add(matchReasonCode(
            prof("p1"),
            prof("p2", { silhouette: sil, primaryColour: col, colourFamily: col, upperMaterial: mat, priceBand: band }, { brand })));
        }
      }
    }
    for (const c of codes) expect(MATCH_REASONS[c], c).toBeTruthy();
  });
  it("only claims the brand when the brand really matches", () => {
    const t = prof("p1", {}, { brand: "Nike" });
    const other = prof("p2", {}, { brand: "Adidas" });
    expect(matchReasonText(matchReasonCode(t, other))).not.toMatch(/brand/i);
  });
  it("only claims the colour when the FAMILY really matches", () => {
    const t = prof("p1", { primaryColour: "black", colourFamily: "black" });
    const other = prof("p2", { primaryColour: "green", colourFamily: "green" }, { brand: "Adidas" });
    expect(matchReasonText(matchReasonCode(t, other))).not.toMatch(/colour/i);
  });
  it("falls back to the generic sentence rather than to nothing", () => {
    expect(matchReasonText("zzz")).toBe(MATCH_REASONS.x);
    expect(matchReasonText(undefined)).toBe(MATCH_REASONS.x);
  });
});

describe("storage encoding", () => {
  it("round-trips", () => {
    const list = [encodeNeighbour("p1777895684767", "s"), encodeNeighbour("p1785156678328", "a")];
    expect(parseNeighbours(list)).toEqual([
      { pid: "p1777895684767", code: "s", why: MATCH_REASONS.s },
      { pid: "p1785156678328", code: "a", why: MATCH_REASONS.a },
    ]);
  });
  // RTDB hands an array back as an OBJECT the moment it has a hole in it, and a
  // renderer that assumes an array shows nothing at all.
  it("reads the object shape RTDB returns for a holed array", () => {
    expect(parseNeighbours({ 0: "p1:s", 2: "p2:a" }).map((n) => n.pid)).toEqual(["p1", "p2"]);
  });
  it("drops a malformed entry rather than rendering it", () => {
    expect(parseNeighbours(["p1:s", "", ":x", "p2:", "nocolon", 7, null, { a: 1 }]).map((n) => n.pid)).toEqual(["p1"]);
  });
  it("an absent or empty list reads as no suggestions", () => {
    // RTDB deletes a child written as [] and it reads back NULL — both shapes
    // reach the renderer in the wild and both mean the same thing.
    expect(parseNeighbours(null)).toEqual([]);
    expect(parseNeighbours(undefined)).toEqual([]);
    expect(parseNeighbours([])).toEqual([]);
  });
  it("an unknown code still renders a sentence", () => {
    expect(parseNeighbours(["p1:Q"])[0].why).toBe(MATCH_REASONS.x);
  });
});

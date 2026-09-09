// ─── PRODUCT DUPLICATE MATCHING — TESTS ──────────────────────────────────────
// The load-bearing test in this file is "44712 does not match 144712 or 447120".
// Everything else guards the tiers and the ranking; that one guards the reason
// the module exists at all — a matcher that accepts substrings would route a
// clothing delivery into a neighbouring article's stock cells, silently.

import { describe, it, expect } from "vitest";
import {
  normaliseForMatch, extractTokens, scoreCandidate, rankCandidates,
  TIER_EXACT_CODE, TIER_PARTIAL_CODE, TIER_FUZZY_NAME,
  MAX_CANDIDATES, FUZZY_MIN_SHARED, FUZZY_FLOOR, CODE_DIGIT_MIN, WORD_MIN,
} from "./productDupMatch.js";

const prod = (id, name, extra = {}) => ({ id, name, ...extra });

describe("normaliseForMatch", () => {
  it("uppercases", () => expect(normaliseForMatch("nike air")).toBe("NIKE AIR"));
  it("reduces punctuation to a boundary rather than deleting it", () => {
    expect(normaliseForMatch("44712-01")).toBe("44712 01");
  });
  it("collapses runs of whitespace and punctuation into one space", () => {
    expect(normaliseForMatch("  a  --  b ")).toBe("A B");
  });
  it("returns empty for anything unusable", () => {
    for (const v of [null, undefined, 42, {}, "", "   ", "---"]) expect(normaliseForMatch(v)).toBe("");
  });
});

describe("extractTokens", () => {
  it("returns every alphanumeric run as a word", () => {
    expect(extractTokens("Nike Air Force 1").words).toEqual(["NIKE", "AIR", "FORCE", "1"]);
  });

  it(`treats a digit run of ${CODE_DIGIT_MIN}+ as a code and a shorter one as a word only`, () => {
    expect(extractTokens("44712").codes).toEqual(["44712"]);
    expect(extractTokens("447").codes).toEqual([]);
    expect(extractTokens("447").words).toEqual(["447"]);
  });

  it("recognises the brand shapes styleCode.js already knows", () => {
    expect(extractTokens("CT8527-016").codes).toEqual(["CT8527016"]);   // nike-alpha-6-3
    expect(extractTokens("ML574EVG").codes).toEqual(["ML574EVG"]);       // new-balance
    expect(extractTokens("IE3437").codes).toEqual(["IE3437"]);           // adidas-block
  });

  it("stores a segmented code by its IDENTITY spelling, separators removed", () => {
    expect(extractTokens("44712-01").codes).toEqual(["4471201"]);
  });

  it("yields a stem ONLY when the source string itself drew the boundary", () => {
    expect(extractTokens("44712-01").codeStems).toEqual(["44712"]);
    expect(extractTokens("447120").codeStems).toEqual([]);
    expect(extractTokens("44712 01").codeStems).toEqual([]); // a space is two runs, not one segmented run
  });

  it("refuses a stem that is not code-shaped in its own right", () => {
    expect(extractTokens("T-44712").codeStems).toEqual([]);
  });

  it("dedupes", () => {
    expect(extractTokens("44712 44712").codes).toEqual(["44712"]);
  });

  it("returns three empty lists for anything unusable", () => {
    for (const v of [null, undefined, 7, "", "   "]) {
      expect(extractTokens(v)).toEqual({ words: [], codes: [], codeStems: [] });
    }
  });
});

// ─── THE RULE ────────────────────────────────────────────────────────────────
describe("SUBSTRING MATCHING IS FORBIDDEN", () => {
  it("44712 does NOT match 144712", () => {
    expect(scoreCandidate("44712", prod("p1", "144712"))).toBeNull();
  });
  it("44712 does NOT match 447120", () => {
    expect(scoreCandidate("44712", prod("p2", "447120"))).toBeNull();
  });
  it("…in either direction", () => {
    expect(scoreCandidate("144712", prod("p1", "44712"))).toBeNull();
    expect(scoreCandidate("447120", prod("p2", "44712"))).toBeNull();
  });
  it("and neither neighbour reaches the panel", () => {
    const rows = rankCandidates("44712", [prod("a", "144712"), prod("b", "447120"), prod("c", "4471")]);
    expect(rows).toEqual([]);
  });
  it("a code embedded in a longer name still matches, because the name gives it a boundary", () => {
    const hit = scoreCandidate("44712", prod("p", "MENS TRACKSUIT 44712"));
    expect(hit.tier).toBe(TIER_EXACT_CODE);
  });
});

describe("scoreCandidate — exact_code", () => {
  it("matches a code token in the product name", () => {
    const hit = scoreCandidate("44712", prod("p", "44712"));
    expect(hit).toMatchObject({ tier: TIER_EXACT_CODE, score: 1 });
    expect(hit.reason).toContain("name");
  });
  it("matches styleCodeNormalised", () => {
    const hit = scoreCandidate("CT8527-016", prod("p", "Air Force Low", { styleCodeNormalised: "CT8527016" }));
    expect(hit).toMatchObject({ tier: TIER_EXACT_CODE, score: 1 });
    expect(hit.reason).toContain("style code");
  });
  it("matches a top-level barcode", () => {
    const hit = scoreCandidate("6009123456", prod("p", "Some Tracksuit", { barcode: "6009123456" }));
    expect(hit).toMatchObject({ tier: TIER_EXACT_CODE });
    expect(hit.reason).toContain("barcode");
  });
  it("matches a per-size barcode", () => {
    const hit = scoreCandidate("6009123456", prod("p", "Some Tracksuit", { barcodes: { M: "6009123456" } }));
    expect(hit.tier).toBe(TIER_EXACT_CODE);
  });
  it("matches the printed EAN a perfume carries", () => {
    const hit = scoreCandidate("3614273123", prod("p", "Sauvage", { printedBarcode: "3614273123" }));
    expect(hit.tier).toBe(TIER_EXACT_CODE);
  });
  it("matches the sku", () => {
    expect(scoreCandidate("MS4471", prod("p", "Tee", { sku: "MS4471" })).tier).toBe(TIER_EXACT_CODE);
  });
  it("ignores separators when comparing identities", () => {
    expect(scoreCandidate("44712-01", prod("p", "44712/01")).tier).toBe(TIER_EXACT_CODE);
  });
});

describe("scoreCandidate — partial_code", () => {
  it("typed stem against a stored segmented code", () => {
    const hit = scoreCandidate("44712", prod("p", "44712-01"));
    expect(hit).toMatchObject({ tier: TIER_PARTIAL_CODE, score: 0.9 });
  });
  it("typed segmented code against a stored stem", () => {
    const hit = scoreCandidate("44712-01", prod("p", "44712"));
    expect(hit).toMatchObject({ tier: TIER_PARTIAL_CODE, score: 0.9 });
  });
  it("two sibling colourways share a stem and rank below either", () => {
    const hit = scoreCandidate("44712-01", prod("p", "44712-99"));
    expect(hit).toMatchObject({ tier: TIER_PARTIAL_CODE, score: 0.75 });
    expect(hit.reason).toContain("colourway");
  });
  it("an exact code outranks a partial on the same product", () => {
    const hit = scoreCandidate("44712-01", prod("p", "44712-01 and 44712"));
    expect(hit.tier).toBe(TIER_EXACT_CODE);
  });
  it("…even when the SAME typed code is also a stem of that product's other code", () => {
    // "44712 44712-01" holds both the bare code and the segmented one, so the
    // typed 44712 satisfies BOTH branches. Identity must win: the product
    // literally answers to this code.
    expect(scoreCandidate("44712", prod("p", "44712 44712-01")).tier).toBe(TIER_EXACT_CODE);
  });
});

describe("scoreCandidate — fuzzy_name", () => {
  it(`needs at least ${FUZZY_MIN_SHARED} shared words`, () => {
    expect(scoreCandidate("Nike", prod("p", "Nike Air Force 1 Triple White"))).toBeNull();
    expect(scoreCandidate("Nike Air", prod("p", "Nike Air"))).toMatchObject({ tier: TIER_FUZZY_NAME });
  });
  it("one shared word is never enough, however well it scores", () => {
    // 1 of 2 clears the ratio floor exactly — and is still refused, because a
    // single shared word is a brand name and would surface the whole shop.
    expect(scoreCandidate("Nike", prod("p", "Nike Air"))).toBeNull();
  });
  it(`is floored at ${FUZZY_FLOOR} against the LARGER word set, so one brand word matches nothing`, () => {
    // 2 shared of 5 = 0.4 — below the floor.
    expect(scoreCandidate("Nike Air", prod("p", "Nike Air Force Triple White Low"))).toBeNull();
  });
  it("scores the overlap ratio", () => {
    const hit = scoreCandidate("Adidas Sport Shorts", prod("p", "Adidas Sport Shorts"));
    expect(hit).toMatchObject({ tier: TIER_FUZZY_NAME, score: 1 });
  });
  it(`ignores words shorter than ${WORD_MIN}`, () => {
    // "1" and "XL" carry no signal; only PUMA + HOODIE do.
    const hit = scoreCandidate("Puma Hoodie XL 1", prod("p", "Puma Hoodie"));
    expect(hit).toMatchObject({ tier: TIER_FUZZY_NAME, score: 1 });
  });
  it("a code is excluded from the RATIO as well as the shared count", () => {
    // "44712 Black Tracksuit" against "Black Tracksuit" is a complete word
    // overlap. If the code counted as a word the denominator would be 3, the
    // score would drop to 0.67, and a perfect name match would rank below a
    // worse one.
    expect(scoreCandidate("44712 Black Tracksuit", prod("p", "Black Tracksuit")))
      .toMatchObject({ tier: TIER_FUZZY_NAME, score: 1 });
  });
  it("never lets a code re-enter through the word list", () => {
    // Same code-shaped word on both sides, nothing else: the fuzzy tier must not
    // count it, so a non-matching pair stays non-matching.
    expect(scoreCandidate("44712 44713", prod("p", "44712 99999"))).not.toBeNull(); // exact on 44712
    expect(scoreCandidate("44712-01 tracksuit", prod("p", "44712-99 tracksuit"))?.tier).toBe(TIER_PARTIAL_CODE);
  });
  it("returns null when either side has no signal words", () => {
    expect(scoreCandidate("a b", prod("p", "Nike Air Force"))).toBeNull();
    expect(scoreCandidate("Nike Air Force", prod("p", "a b"))).toBeNull();
  });
});

describe("scoreCandidate — refusals", () => {
  it("refuses a product with no id", () => {
    expect(scoreCandidate("44712", { name: "44712" })).toBeNull();
  });
  it("refuses a non-object product", () => {
    for (const v of [null, undefined, "44712", 3]) expect(scoreCandidate("44712", v)).toBeNull();
  });
  it("survives a product with no name", () => {
    expect(scoreCandidate("44712", { id: "p" })).toBeNull();
    expect(scoreCandidate("44712", { id: "p", styleCodeNormalised: "44712" }).tier).toBe(TIER_EXACT_CODE);
  });
  it("empty typed input matches nothing", () => {
    expect(scoreCandidate("", prod("p", "44712"))).toBeNull();
    expect(scoreCandidate(null, prod("p", "44712"))).toBeNull();
  });
});

describe("rankCandidates", () => {
  const catalogue = [
    prod("exact", "44712"),
    prod("partial", "44712-01"),
    prod("fuzzy", "44712 MENS FLEECE TRACKSUIT"),
    prod("miss", "144712"),
  ];

  it("TIER BEFORE SCORE — a perfect fuzzy match still ranks below a partial code", () => {
    // All three tiers, with the fuzzy row scoring a full 1.0 and sorting BEFORE
    // the partial row by name. Only tier-first ordering puts them right.
    const rows = rankCandidates("44712 Black Tracksuit", [
      prod("exact", "44712"),
      prod("partial", "44712-01"),
      prod("fuzzy", "Black Tracksuit"),
    ]);
    expect(rows.map((r) => r.product.id)).toEqual(["exact", "partial", "fuzzy"]);
    expect(rows.map((r) => r.tier)).toEqual([TIER_EXACT_CODE, TIER_PARTIAL_CODE, TIER_FUZZY_NAME]);
  });

  it("orders exact before partial before fuzzy", () => {
    // "44712 MENS FLEECE TRACKSUIT" carries the code, so it is exact too —
    // use a typed string that separates the tiers cleanly.
    const rows = rankCandidates("44712", catalogue);
    expect(rows.map((r) => r.tier)).toEqual([TIER_EXACT_CODE, TIER_EXACT_CODE, TIER_PARTIAL_CODE]);
    expect(rows.some((r) => r.product.id === "miss")).toBe(false);
  });

  it("breaks score ties on name, deterministically", () => {
    const rows = rankCandidates("44712", [prod("b", "ZZ 44712"), prod("a", "AA 44712")]);
    expect(rows.map((r) => r.product.id)).toEqual(["a", "b"]);
  });

  it("dedupes by product id", () => {
    const p = prod("dup", "44712");
    expect(rankCandidates("44712", [p, { ...p }])).toHaveLength(1);
  });

  it(`caps at ${MAX_CANDIDATES} however large the limit asked for`, () => {
    const many = Array.from({ length: 30 }, (_, i) => prod(`p${i}`, `44712 variant ${i}`));
    expect(rankCandidates("44712", many, 100)).toHaveLength(MAX_CANDIDATES);
  });

  it("honours a smaller limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => prod(`p${i}`, `44712 variant ${i}`));
    expect(rankCandidates("44712", many, 3)).toHaveLength(3);
  });

  it("a limit of zero returns nothing", () => {
    expect(rankCandidates("44712", [prod("p", "44712")], 0)).toEqual([]);
  });

  it("tolerates junk in the catalogue", () => {
    const rows = rankCandidates("44712", [null, undefined, {}, { id: "" }, prod("p", "44712")]);
    expect(rows.map((r) => r.product.id)).toEqual(["p"]);
  });

  it("a non-array catalogue returns nothing", () => {
    for (const v of [null, undefined, "products", 5]) expect(rankCandidates("44712", v)).toEqual([]);
  });

  it("carries the product through untouched", () => {
    const p = prod("p", "44712", { photoUrl: "u", category: "Clothing" });
    expect(rankCandidates("44712", [p])[0].product).toBe(p);
  });
});

// ─── Search identity — the precedence that stops a guess erasing knowledge ───
// The field exists because `products/{pid}.name` is about to be rewritten by
// the vision namer, and the brand in that name is the ONLY thing the storefront
// search can match on. These pin the two rules that make the field safe:
// nothing blanks an identity out, and a machine guess never outranks the name
// the product was received under.
import { describe, it, expect } from "vitest";
import {
  SEARCH_IDENTITY_PATH, IDENTITY_SOURCES, identityRank, shouldReplaceIdentity,
  buildRecordIdentity, identityTextFor, identityExtras, isUnreviewedGuess,
} from "./searchIdentity.js";

const RECORD = { text: "Lacoste Gripshot Lace Boot White Navy", source: "record", confidence: null };
const VISION = (text, confidence) => ({ text, source: "vision", confidence });
const MANUAL = (text) => ({ text, source: "manual", confidence: null });

describe("the node", () => {
  it("is its own path, not a field on the product", () => {
    // Structural, not a promise: no renaming code writes here because no
    // renaming code knows this path.
    expect(SEARCH_IDENTITY_PATH).toBe("product_identity");
    expect(SEARCH_IDENTITY_PATH.startsWith("products")).toBe(false);
  });
  it("has exactly three sources, ranked manual > record > vision", () => {
    expect(IDENTITY_SOURCES).toEqual(["manual", "record", "vision"]);
    expect(identityRank("manual")).toBeGreaterThan(identityRank("record"));
    expect(identityRank("record")).toBeGreaterThan(identityRank("vision"));
    expect(identityRank("nonsense")).toBe(0);
    expect(identityRank(undefined)).toBe(0);
  });
});

describe("shouldReplaceIdentity — a guess never beats knowledge", () => {
  it("anything beats nothing", () => {
    expect(shouldReplaceIdentity(null, VISION("Adidas Samba", 0.4))).toBe(true);
    expect(shouldReplaceIdentity(undefined, RECORD)).toBe(true);
    expect(shouldReplaceIdentity({ text: "" }, RECORD)).toBe(true);
    expect(shouldReplaceIdentity({ text: "   " }, RECORD)).toBe(true);
  });

  it("NEVER blanks an identity out", () => {
    for (const bad of ["", "   ", null, undefined]) {
      expect(shouldReplaceIdentity(RECORD, { text: bad, source: "manual" })).toBe(false);
    }
    expect(shouldReplaceIdentity(RECORD, null)).toBe(false);
  });

  it("THE LOAD-BEARING RULE: a vision guess cannot overwrite supplier data", () => {
    // However sure the model claims to be. A model that is confidently wrong is
    // the exact failure this ranking contains — a shopper searching one brand
    // being shown another.
    for (const c of [0.5, 0.9, 0.99, 1]) {
      expect({ c, replaced: shouldReplaceIdentity(RECORD, VISION("Nike Air Force 1", c)) })
        .toEqual({ c, replaced: false });
    }
  });

  it("and cannot overwrite a human's correction either", () => {
    expect(shouldReplaceIdentity(MANUAL("Lacoste Gripshot"), VISION("Nike Dunk", 1))).toBe(false);
    expect(shouldReplaceIdentity(MANUAL("Lacoste Gripshot"), RECORD)).toBe(false);
  });

  it("a human always wins", () => {
    expect(shouldReplaceIdentity(RECORD, MANUAL("Lacoste Gripshot Mid"))).toBe(true);
    expect(shouldReplaceIdentity(VISION("x", 0.9), MANUAL("y"))).toBe(true);
  });

  it("supplier data beats a guess", () => {
    expect(shouldReplaceIdentity(VISION("Nike Dunk", 0.95), RECORD)).toBe(true);
  });

  it("one guess replaces another only when it is strictly more confident", () => {
    expect(shouldReplaceIdentity(VISION("a", 0.6), VISION("b", 0.7))).toBe(true);
    expect(shouldReplaceIdentity(VISION("a", 0.6), VISION("b", 0.6))).toBe(false);
    expect(shouldReplaceIdentity(VISION("a", 0.6), VISION("b", 0.5))).toBe(false);
    // A missing confidence is treated as zero, not as "trust me".
    expect(shouldReplaceIdentity(VISION("a", 0.1), VISION("b", undefined))).toBe(false);
  });

  it("a re-run of the SAME non-vision source is a correction, not a downgrade", () => {
    expect(shouldReplaceIdentity(RECORD, { ...RECORD, text: "Lacoste Gripshot Mid Black" })).toBe(true);
    expect(shouldReplaceIdentity(MANUAL("a"), MANUAL("b"))).toBe(true);
  });
});

describe("buildRecordIdentity — what the migration seeds", () => {
  it("takes the record's own name as supplier data", () => {
    const id = buildRecordIdentity(
      { name: "  Lacoste Gripshot Lace Boot White Navy ", brand: "Lacoste" },
      { at: 111, by: "test" }
    );
    expect(id).toEqual({
      text: "Lacoste Gripshot Lace Boot White Navy",
      source: "record", confidence: null, brand: "Lacoste",
      capturedAt: 111, capturedBy: "test",
    });
  });
  it("omits an absent brand rather than writing an empty one", () => {
    expect(buildRecordIdentity({ name: "Slide brown" }).brand).toBeUndefined();
    expect(buildRecordIdentity({ name: "Slide brown", brand: "  " }).brand).toBeUndefined();
  });
  it("returns null when there is nothing worth keeping", () => {
    expect(buildRecordIdentity({ name: "" })).toBeNull();
    expect(buildRecordIdentity({ name: "   " })).toBeNull();
    expect(buildRecordIdentity({})).toBeNull();
    expect(buildRecordIdentity(null)).toBeNull();
  });
});

describe("identityTextFor — search never gets worse than today", () => {
  it("prefers the stored identity", () => {
    expect(identityTextFor(RECORD, { name: "Lace Boot White Navy" }))
      .toBe("Lacoste Gripshot Lace Boot White Navy");
  });
  it("falls back to the record's name while the migration is incomplete", () => {
    expect(identityTextFor(null, { name: "Adidas Samba" })).toBe("Adidas Samba");
    expect(identityTextFor({ text: "" }, { name: "Adidas Samba" })).toBe("Adidas Samba");
  });
  it("tolerates having neither", () => {
    expect(identityTextFor(null, null)).toBe("");
    expect(identityTextFor(undefined, {})).toBe("");
  });
});

describe("identityExtras — the structured fields, deduped against the sentence", () => {
  it("adds only what the text does not already say", () => {
    const id = { text: "Lacoste Gripshot Lace Boot", brand: "Lacoste", model: "Gripshot", colourway: "White Navy" };
    expect(identityExtras(id)).toBe("White Navy");
  });
  it("keeps everything the text is missing", () => {
    expect(identityExtras({ text: "Low-top sneaker", brand: "Adidas", model: "Samba" })).toBe("Adidas Samba");
  });
  it("is empty when there is nothing structured", () => {
    expect(identityExtras({ text: "Adidas Samba" })).toBe("");
    expect(identityExtras(null)).toBe("");
  });
});

describe("isUnreviewedGuess — what the review surface must show", () => {
  it("is true only for a vision identity nobody has confirmed", () => {
    expect(isUnreviewedGuess(VISION("Nike Dunk", 0.8))).toBe(true);
    expect(isUnreviewedGuess({ ...VISION("Nike Dunk", 0.8), reviewedAt: 1 })).toBe(false);
    expect(isUnreviewedGuess(RECORD)).toBe(false);
    expect(isUnreviewedGuess(MANUAL("x"))).toBe(false);
    expect(isUnreviewedGuess(null)).toBe(false);
  });
});

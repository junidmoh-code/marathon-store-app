import { describe, it, expect } from "vitest";
import {
  EXTRACTOR_VERSION, ATTRIBUTE_KEYS, VISION_FIELDS, MAX_STYLE_TAGS,
  COLOURS, COLOUR_FAMILIES, SILHOUETTES, UPPER_MATERIALS, PATTERNS, STYLE_TAGS,
  PRICE_BANDS, SOLE_TYPES, CLOSURES, FINISHES, priceBandOf, colourFamily, isLegalAttribute,
  buildAttributeRecord, resolveAttributes, confirmedFields, isCurrentExtraction, serverStamp,
  usableAttributes, nameFromAttributes, handleFromName, distinctNamesFor, MAX_NAME_LENGTH,
  nameVocabularyTriggers,
} from "./productAttributes.js";
import { validateVisionName } from "./visionNaming.js";

const FULL = {
  silhouette: "low-top", upperMaterial: "leather", primaryColour: "black",
  secondaryColour: "white", colourFamily: "black", pattern: "two-tone",
  toeShape: "round", soleColour: "cream", priceBand: "core", styleTags: ["retro"],
  // v2, the widening the pilot forced
  soleType: "cup", closure: "laced", finish: "perforated",
};

describe("the vocabulary is closed", () => {
  it("every colour rolls up to a family", () => {
    for (const c of COLOURS) expect(COLOUR_FAMILIES).toContain(colourFamily(c));
  });
  it("a colour outside the vocabulary has no family and is never coerced", () => {
    for (const junk of ["ecru", "off-white", "aubergine", "", null, undefined, "BLACK "]) {
      if (junk === "BLACK ") { expect(colourFamily(junk)).toBe("black"); continue; } // trimmed + lowered only
      expect(colourFamily(junk)).toBe("");
    }
  });
  it("refuses an out-of-vocabulary value rather than picking the nearest", () => {
    expect(isLegalAttribute("silhouette", "sneaker")).toBe(false);
    expect(isLegalAttribute("primaryColour", "off-white")).toBe(false);
    expect(isLegalAttribute("upperMaterial", "suede")).toBe(false); // a PUMA model — see visionNaming
    expect(isLegalAttribute("pattern", "stripes")).toBe(false);
  });
  it("empty is legal for an optional field and illegal for a required one", () => {
    expect(isLegalAttribute("secondaryColour", "")).toBe(true);
    expect(isLegalAttribute("silhouette", "")).toBe(false);
    expect(isLegalAttribute("primaryColour", null)).toBe(false);
  });
  it("caps styleTags and refuses an unknown tag", () => {
    expect(isLegalAttribute("styleTags", ["retro", "minimal"])).toBe(true);
    expect(isLegalAttribute("styleTags", STYLE_TAGS.slice(0, MAX_STYLE_TAGS + 1))).toBe(false);
    expect(isLegalAttribute("styleTags", ["retro", "gorpcore"])).toBe(false);
  });
  it("an unknown field is never legal", () => {
    expect(isLegalAttribute("heelHeight", "40mm")).toBe(false);
  });
});

// THE SUEDE LESSON, as a test. The old prompt suggested a material word its own
// validator refused, and every name that took the advice was refused,
// regenerated at full price, then refused for good.
describe("no word the namer can emit is a compliance trigger", () => {
  it("the whole name vocabulary is trigger-free", () => {
    expect(nameVocabularyTriggers()).toEqual([]);
  });
  it("suede is absent from the material vocabulary, deliberately", () => {
    expect(UPPER_MATERIALS).not.toContain("suede");
  });
  it("every name the namer can build passes the SAME validator a typed name faces", () => {
    for (const sil of SILHOUETTES) for (const mat of UPPER_MATERIALS) for (const pat of PATTERNS) {
      for (const level of [0, 1, 2, 3]) {
        const name = nameFromAttributes(
          { ...FULL, silhouette: sil, upperMaterial: mat, pattern: pat }, { discriminate: level });
        expect(name, `${sil}/${mat}/${pat}@${level}`).not.toBe("");
        expect(validateVisionName(name).ok, `${name}`).toBe(true);
      }
    }
  });
  it("every v2 word survives the validator too", () => {
    for (const soleType of SOLE_TYPES) for (const closure of CLOSURES) for (const finish of FINISHES) {
      const n = nameFromAttributes({ ...FULL, soleType, closure, finish }, { discriminate: 3 });
      expect(validateVisionName(n).ok, n).toBe(true);
      expect(n.length, n).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    }
  });
  it("every colour in the vocabulary survives the validator too", () => {
    for (const c of COLOURS) {
      const name = nameFromAttributes({ ...FULL, primaryColour: c, secondaryColour: "", soleColour: "" });
      expect(validateVisionName(name).ok, name).toBe(true);
    }
  });
});

describe("priceBandOf is arithmetic, never a call", () => {
  it("bands the live distribution without collapsing it", () => {
    // p10 550 · p25 700 · median 750 · p75 800 · p90 1100 · max 6009
    expect(priceBandOf(550)).toBe("budget");
    expect(priceBandOf(700)).toBe("core");
    expect(priceBandOf(750)).toBe("core");
    expect(priceBandOf(800)).toBe("mid");
    expect(priceBandOf(1100)).toBe("premium");
    expect(priceBandOf(6009)).toBe("luxury");
  });
  it("no price is no band — never a guessed one", () => {
    for (const v of [0, -1, null, undefined, "", "abc", NaN]) expect(priceBandOf(v)).toBe("");
  });
  it("every band is reachable", () => {
    const seen = new Set([300, 700, 900, 1200, 3000].map(priceBandOf));
    expect([...seen].sort()).toEqual([...PRICE_BANDS].sort());
  });
});

describe("buildAttributeRecord", () => {
  const product = { brand: "Nike", category: "Footwear", retailPrice: 750 };
  const vision = {
    silhouette: "low-top", upperMaterial: "leather", primaryColour: "black",
    secondaryColour: "white", pattern: "two-tone", toeShape: "round",
    soleColour: "cream", styleTags: ["retro", "casual"],
    confidence: { silhouette: 0.9, primaryColour: 0.95, upperMaterial: 0.7 },
  };
  const rec = () => buildAttributeRecord({ vision, product, model: "gemini-3.7-flash", at: 1757000000000 });

  it("reads brand/category from the record and never from the model", () => {
    const r = buildAttributeRecord({ vision: { ...vision, brand: "Adidas" }, product, model: "m", at: 1 });
    expect(r.a.brand).toBe("Nike");
    expect(r.from.brand).toBe("record");
  });
  it("derives colourFamily and priceBand rather than asking for them", () => {
    const r = rec();
    expect(r.a.colourFamily).toBe("black");
    expect(r.a.priceBand).toBe("core");
    expect(r.from.colourFamily).toBe("derived");
    expect(r.from.priceBand).toBe("derived");
    expect(VISION_FIELDS).not.toContain("colourFamily");
    expect(VISION_FIELDS).not.toContain("priceBand");
  });
  it("drops an illegal vision value instead of storing it", () => {
    const r = buildAttributeRecord({ vision: { ...vision, silhouette: "sneaker", pattern: "stripey" }, product, model: "m", at: 1 });
    expect(r.a.silhouette).toBeUndefined();
    expect(r.a.pattern).toBeUndefined();
    expect(r.a.primaryColour).toBe("black");   // the legal ones still land
  });
  // THE at:0 BUG. Number(ServerValue.TIMESTAMP) is NaN because the sentinel is
  // the OBJECT {".sv":"timestamp"}, and `|| 0` wrote a zero timestamp onto the
  // first 205 records. It looked right in the code and was wrong in the
  // database, which is the only place it matters.
  it("passes an RTDB server sentinel through UNTOUCHED", () => {
    const sentinel = { ".sv": "timestamp" };
    expect(buildAttributeRecord({ vision, product, model: "m", at: sentinel }).at).toBe(sentinel);
  });
  it("keeps a real client timestamp, and refuses a junk one", () => {
    expect(buildAttributeRecord({ vision, product, model: "m", at: 1757000000000 }).at).toBe(1757000000000);
    for (const junk of [0, -1, NaN, "", null, undefined, "abc"]) {
      expect(buildAttributeRecord({ vision, product, model: "m", at: junk }).at).toBe(0);
    }
  });
  it("stamps the version and the model so a run is diffable", () => {
    const r = rec();
    expect(r.v).toBe(EXTRACTOR_VERSION);
    expect(EXTRACTOR_VERSION).toBe(2);   // the pilot's widening
    expect(r.model).toBe("gemini-3.7-flash");
    expect(r.at).toBe(1757000000000);
  });
  it("records supersededV only when the version actually moved", () => {
    expect(buildAttributeRecord({ vision, product, model: "m", at: 1 }).supersededV).toBe(null);
    expect(buildAttributeRecord({ vision, product, model: "m", at: 1, previousVersion: EXTRACTOR_VERSION }).supersededV).toBe(null);
    expect(buildAttributeRecord({ vision, product, model: "m", at: 1, previousVersion: 1 }).supersededV).toBe(1);
  });
  it("keeps per-field confidence and invents none", () => {
    const r = rec();
    expect(r.conf.silhouette).toBe(0.9);
    expect(r.conf.toeShape).toBeUndefined();   // not reported → absent, not 0
  });
  it("clamps a confidence outside 0..1", () => {
    const r = buildAttributeRecord({ vision: { ...vision, confidence: { silhouette: 4, primaryColour: -2 } }, product, model: "m", at: 1 });
    expect(r.conf.silhouette).toBe(1);
    expect(r.conf.primaryColour).toBe(0);
  });
  // RTDB DELETES A CHILD WRITTEN AS AN EMPTY ARRAY, and it reads back null.
  it("OMITS styleTags when empty — never writes []", () => {
    const r = buildAttributeRecord({ vision: { ...vision, styleTags: [] }, product, model: "m", at: 1 });
    expect("styleTags" in r.a).toBe(false);
    expect(JSON.stringify(r)).not.toContain("[]");
  });
  it("truncates styleTags to the cap", () => {
    const r = buildAttributeRecord({ vision: { ...vision, styleTags: ["retro", "casual", "skate", "minimal"] }, product, model: "m", at: 1 });
    expect(r.a.styleTags).toHaveLength(MAX_STYLE_TAGS);
  });
  it("CANNOT produce a `confirmed` child — the structural reason a re-run is safe", () => {
    const r = buildAttributeRecord({ vision: { ...vision, confirmed: { silhouette: "boot" } }, product, model: "m", at: 1 });
    expect(r.confirmed).toBeUndefined();
  });
});

describe("human values are never overwritten by machine ones", () => {
  const node = {
    v: 1, a: { ...FULL }, confirmed: { silhouette: "high-top", styleTags: ["skate"] },
  };
  it("resolveAttributes prefers the confirmed value field by field", () => {
    const r = resolveAttributes(node);
    expect(r.silhouette).toBe("high-top");      // human
    expect(r.primaryColour).toBe("black");      // machine, untouched
    expect(r.styleTags).toEqual(["skate"]);     // human list wins whole
  });
  it("an empty confirmed value does not mask a machine one", () => {
    const r = resolveAttributes({ a: { ...FULL }, confirmed: { silhouette: "", styleTags: [] } });
    expect(r.silhouette).toBe("low-top");
    expect(r.styleTags).toEqual(["retro"]);
  });
  it("confirmedFields names exactly what a person set", () => {
    expect(confirmedFields(node).sort()).toEqual(["silhouette", "styleTags"]);
    expect(confirmedFields({ a: FULL })).toEqual([]);
  });
  it("resolves every key, so a caller never tests for undefined", () => {
    const r = resolveAttributes({ a: {} });
    expect(Object.keys(r).sort()).toEqual([...ATTRIBUTE_KEYS].sort());
    expect(r.styleTags).toEqual([]);
    expect(r.silhouette).toBe("");
  });
  it("survives a null node", () => {
    expect(resolveAttributes(null).silhouette).toBe("");
    expect(confirmedFields(null)).toEqual([]);
  });
});

describe("resumability", () => {
  it("a product at the current version is current — and one at another version is not", () => {
    expect(isCurrentExtraction({ v: EXTRACTOR_VERSION, a: FULL })).toBe(true);
    expect(isCurrentExtraction({ v: EXTRACTOR_VERSION - 1, a: FULL })).toBe(false);
    expect(isCurrentExtraction({ v: EXTRACTOR_VERSION })).toBe(false);   // stamped but empty
    expect(isCurrentExtraction(null)).toBe(false);
  });
});

describe("usableAttributes — unenriched stays absent, never half-filled", () => {
  it("returns null when a required field is missing", () => {
    expect(usableAttributes({ a: { ...FULL, silhouette: "" } })).toBe(null);
    expect(usableAttributes({ a: { ...FULL, colourFamily: "" } })).toBe(null);
    expect(usableAttributes({})).toBe(null);
    expect(usableAttributes(null)).toBe(null);
  });
  it("a human confirmation can COMPLETE an otherwise unusable extraction", () => {
    expect(usableAttributes({ a: { ...FULL, silhouette: "" } })).toBe(null);
    expect(usableAttributes({ a: { ...FULL, silhouette: "" }, confirmed: { silhouette: "boot" } }).silhouette).toBe("boot");
  });
  it("an optional gap does not disqualify", () => {
    expect(usableAttributes({ a: { ...FULL, secondaryColour: "", toeShape: "" } })).toBeTruthy();
  });
});

describe("the name is derived from the attributes", () => {
  it("says nothing when the attributes cannot support a name", () => {
    expect(nameFromAttributes({ silhouette: "low-top" })).toBe("");
    expect(nameFromAttributes(null)).toBe("");
  });
  it("names both colours when there are two", () => {
    expect(nameFromAttributes(FULL)).toBe("Two-tone perforated leather low-top in black and white");
  });
  it("does not repeat a colour against itself", () => {
    expect(nameFromAttributes({ ...FULL, secondaryColour: "black" })).toBe("Two-tone perforated leather low-top in black");
  });
  it("a solid shoe gets no pattern word", () => {
    expect(nameFromAttributes({ silhouette: "runner", upperMaterial: "mesh", primaryColour: "navy", pattern: "solid" }))
      .toBe("Mesh runner in navy");
  });
  // THE ORDER IS A MEASUREMENT, NOT A PREFERENCE. v1 spent toe shape first;
  // the pilot measured toeShape at 82.9% "round", so tier 1 bought almost
  // nothing and the name was already long by the time a useful term was
  // reached. v2 spends the sole first.
  it("escalation spends the sole, then the closure, then the toe", () => {
    const SHORT = { ...FULL, secondaryColour: "", pattern: "solid", finish: "plain", soleColour: "",
                    closure: "buckle", toeShape: "square", styleTags: [] };
    expect(nameFromAttributes(SHORT, { discriminate: 1 })).toContain("cup sole");
    expect(nameFromAttributes(SHORT, { discriminate: 2 })).toContain("with a buckle");
    expect(nameFromAttributes(SHORT, { discriminate: 3 })).toContain("squared-toe");
    expect(nameFromAttributes(SHORT, { discriminate: 0 })).not.toContain("sole");
  });
  it("never spends a word on a value that is true of most of the catalogue", () => {
    // toeShape "round" (82.9%) and closure "laced" are the defaults; naming
    // them lengthens every name and separates nothing.
    const n = nameFromAttributes({ ...FULL, toeShape: "round", closure: "laced" }, { discriminate: 3 });
    expect(n).not.toContain("round-toe");
    expect(n).not.toContain("laces");
    expect(nameFromAttributes({ ...FULL, finish: "plain" })).not.toContain("plain");
  });
  it("the toe-shape article agrees with the word", () => {
    const SHORT = { ...FULL, secondaryColour: "", pattern: "solid", finish: "plain", styleTags: [], soleType: "", soleColour: "" };
    expect(nameFromAttributes({ ...SHORT, toeShape: "almond" }, { discriminate: 3 })).toContain("with an almond-toe");
    expect(nameFromAttributes({ ...SHORT, toeShape: "square" }, { discriminate: 3 })).toContain("with a squared-toe");
  });
  // The 80-character publish gate. A fully escalated two-colour shoe reaches 89
  // characters, so the ceiling is REACHABLE, and a name over it is a product
  // blocked from the storefront rather than a slightly long title.
  it("never exceeds the publish ceiling, dropping clauses lowest-value-first", () => {
    const n3 = nameFromAttributes(FULL, { discriminate: 3 });
    expect(n3.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    expect(n3).not.toContain("with a retro finish");   // the style tag goes first
    expect(n3).toContain("cup sole");                  // the sole survives
  });
  it("no attribute combination can produce a name over the ceiling", () => {
    for (const sil of SILHOUETTES) for (const mat of UPPER_MATERIALS) for (const c of COLOURS) {
      const n = nameFromAttributes(
        { ...FULL, silhouette: sil, upperMaterial: mat, primaryColour: c, secondaryColour: "multicolour",
          soleColour: "chocolate", soleType: "vulcanised", closure: "velcro", toeShape: "pointed" },
        { discriminate: 3 });
      expect(n.length, n).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    }
  });
  it("never claims a sole COLOUR that is one of the upper's colours", () => {
    // The sole TYPE still shows — it is a different fact.
    expect(nameFromAttributes({ ...FULL, soleColour: "black" }, { discriminate: 1 })).toContain("on a cup sole");
    expect(nameFromAttributes({ ...FULL, soleColour: "black" }, { discriminate: 1 })).not.toContain("black sole");
    expect(nameFromAttributes({ ...FULL, soleColour: "white", soleType: "" }, { discriminate: 1 })).not.toContain("sole");
  });
  it("a name never starts with a digit and never ALL CAPS — the publish gates", () => {
    for (const sil of SILHOUETTES) {
      const n = nameFromAttributes({ ...FULL, silhouette: sil });
      expect(/^\d/.test(n)).toBe(false);
      expect(n).not.toBe(n.toUpperCase());
    }
  });
});

describe("handleFromName mirrors the slug the collisions were actually about", () => {
  it("reproduces the blocked handles", () => {
    expect(handleFromName("Sneaker Black")).toBe("sneaker-black");
    expect(handleFromName("Low-top sneaker Navy Blue")).toBe("low-top-sneaker-navy-blue");
    expect(handleFromName("  Two-tone  leather low-top in black & white ")).toBe("two-tone-leather-low-top-in-black-white");
  });
  it("is stable and empty-safe", () => {
    expect(handleFromName("")).toBe("");
    expect(handleFromName(null)).toBe("");
    expect(handleFromName("---")).toBe("");
  });
});

describe("distinctNamesFor escalates only where a handle collides", () => {
  const A = { ...FULL, toeShape: "round", soleColour: "cream", styleTags: ["retro"] };
  const B = { ...FULL, toeShape: "square", soleColour: "gold", styleTags: ["luxury"] };
  it("leaves an already-unique name alone", () => {
    const out = distinctNamesFor([["p1", A], ["p2", { ...A, primaryColour: "red" }]]);
    expect(out.get("p1").level).toBe(0);
    expect(out.get("p2").level).toBe(0);
  });
  it("splits two products whose base name is identical", () => {
    const out = distinctNamesFor([["p1", A], ["p2", B]]);
    expect(out.get("p1").handle).not.toBe(out.get("p2").handle);
  });
  it("omits a product whose attributes cannot name it — never a fallback", () => {
    const out = distinctNamesFor([["p1", A], ["p2", { silhouette: "boot" }]]);
    expect(out.has("p2")).toBe(false);
  });
  it("is order-independent: the same set gives the same names", () => {
    const a = distinctNamesFor([["p1", A], ["p2", B]]);
    const b = distinctNamesFor([["p2", B], ["p1", A]]);
    expect(a.get("p1").name).toBe(b.get("p1").name);
    expect(a.get("p2").name).toBe(b.get("p2").name);
  });
  it("truly identical shoes stay identical — the schema does not invent difference", () => {
    const out = distinctNamesFor([["p1", A], ["p2", { ...A }]]);
    expect(out.get("p1").handle).toBe(out.get("p2").handle);
  });
});

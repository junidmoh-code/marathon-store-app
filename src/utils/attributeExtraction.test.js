import { describe, it, expect } from "vitest";
import {
  ATTRIBUTE_PROMPT, parseAttributeResponse, attributeRetryNote,
  projectExtractionCost, COST_PER_EXTRACTION_USD,
} from "./attributeExtraction.js";
import {
  SILHOUETTES, UPPER_MATERIALS, COLOURS, PATTERNS, TOE_SHAPES, STYLE_TAGS,
  SOLE_TYPES, CLOSURES, FINISHES, VISION_FIELDS, MAX_STYLE_TAGS,
} from "./productAttributes.js";

const GOOD = {
  silhouette: "low-top", upperMaterial: "leather", primaryColour: "black",
  secondaryColour: "white", pattern: "two-tone", toeShape: "round",
  soleColour: "cream", soleType: "cup", closure: "laced", finish: "perforated",
  styleTags: ["retro"],
  confidence: { silhouette: 0.9, upperMaterial: 0.8, primaryColour: 0.95, pattern: 0.7 },
};
const parse = (o) => parseAttributeResponse(JSON.stringify(o));

// THE SUEDE LESSON, structurally. The old prompt listed material words its own
// validator refused, and every name that took its advice was refused,
// regenerated at full price, then refused for good. The vocabularies are
// interpolated from the frozen constants so there is no second copy to drift —
// this proves the interpolation actually happened.
describe("the prompt lists exactly the vocabularies the validator accepts", () => {
  it("every legal value appears in the prompt", () => {
    for (const list of [SILHOUETTES, UPPER_MATERIALS, COLOURS, PATTERNS, TOE_SHAPES,
                        STYLE_TAGS, SOLE_TYPES, CLOSURES, FINISHES]) {
      for (const v of list) expect(ATTRIBUTE_PROMPT, v).toContain(v);
    }
  });
  it("it asks for every vision field and for nothing the record already holds", () => {
    for (const f of VISION_FIELDS) expect(ATTRIBUTE_PROMPT).toContain(`"${f}"`);
    expect(ATTRIBUTE_PROMPT).not.toContain('"brand"');
    expect(ATTRIBUTE_PROMPT).not.toContain('"priceBand"');
    expect(ATTRIBUTE_PROMPT).not.toContain('"colourFamily"');
  });
  it("it never suggests a word the vocabulary refuses", () => {
    expect(ATTRIBUTE_PROMPT).not.toContain("suede");
    expect(ATTRIBUTE_PROMPT).not.toContain("off-white");
  });
});

describe("parsing an answer", () => {
  it("reads a clean one", () => {
    const r = parse(GOOD);
    expect(r.ok).toBe(true);
    expect(r.vision.silhouette).toBe("low-top");
    expect(r.dropped).toEqual([]);
  });
  it("strips a code fence, because models add one however much you ask them not to", () => {
    expect(parseAttributeResponse("```json\n" + JSON.stringify(GOOD) + "\n```").ok).toBe(true);
  });
  it("a half-read answer is a hard failure, never a salvage", () => {
    for (const raw of ["", "   ", "not json", "[1,2]", '"a string"', "null"]) {
      expect(parseAttributeResponse(raw).ok, raw).toBe(false);
    }
  });
  it("normalises case and whitespace but nothing else", () => {
    expect(parse({ ...GOOD, silhouette: "  LOW-TOP " }).vision.silhouette).toBe("low-top");
  });
});

describe("an illegal value is DROPPED and COUNTED, never coerced", () => {
  it("names the field it dropped — a run where 300 products lost one field is a prompt problem", () => {
    const r = parse({ ...GOOD, toeShape: "roundish", soleType: "waffle" });
    expect(r.ok).toBe(true);
    expect(r.vision.toeShape).toBeUndefined();
    expect(r.vision.soleType).toBeUndefined();
    expect(r.dropped.sort()).toEqual(["soleType", "toeShape"]);
  });
  it("refuses the whole answer when a REQUIRED field does not survive", () => {
    const r = parse({ ...GOOD, silhouette: "sneaker" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("silhouette");
  });
  it("an honest blank is not a drop", () => {
    const r = parse({ ...GOOD, toeShape: "", soleColour: "" });
    expect(r.ok).toBe(true);
    expect(r.dropped).toEqual([]);
  });
});

describe("styleTags", () => {
  it("keeps only legal tags and reports the rest as dropped", () => {
    const r = parse({ ...GOOD, styleTags: ["retro", "gorpcore"] });
    expect(r.vision.styleTags).toEqual(["retro"]);
    expect(r.dropped).toContain("styleTags");
  });
  it("deduplicates — three copies of one tag is one thing said, not three", () => {
    expect(parse({ ...GOOD, styleTags: ["retro", "retro", "retro"] }).vision.styleTags).toEqual(["retro"]);
  });
  it("caps at the storable limit", () => {
    expect(parse({ ...GOOD, styleTags: STYLE_TAGS.slice(0, 6) }).vision.styleTags)
      .toHaveLength(MAX_STYLE_TAGS);
  });
  it("normalises the one accidental shape — a bare string — and refuses the rest", () => {
    expect(parse({ ...GOOD, styleTags: "retro" }).vision.styleTags).toEqual(["retro"]);
    expect(parse({ ...GOOD, styleTags: 7 }).dropped).toContain("styleTags");
  });
  it("an empty list yields NO key, so nothing ever writes []", () => {
    const r = parse({ ...GOOD, styleTags: [] });
    expect("styleTags" in r.vision).toBe(false);
  });
});

// ABSENT AND "CERTAINLY WRONG" ARE DIFFERENT CLAIMS, and Number() cannot tell
// them apart: Number(null), Number("") and Number([]) are all 0.
describe("confidence", () => {
  it("keeps what was reported and invents nothing", () => {
    const r = parse(GOOD);
    expect(r.vision.confidence.silhouette).toBe(0.9);
    expect(r.vision.confidence.toeShape).toBeUndefined();
  });
  it("a non-number stays ABSENT rather than becoming a confident zero", () => {
    const r = parse({ ...GOOD, confidence: { silhouette: null, upperMaterial: "", primaryColour: [], pattern: "0.9" } });
    expect(r.vision.confidence).toEqual({});
  });
  it("a flat number is spread across the fields that WERE reported", () => {
    const r = parse({ ...GOOD, confidence: 0.6 });
    expect(r.vision.confidence.silhouette).toBe(0.6);
    expect(r.vision.confidence.toeShape).toBe(0.6);
  });
  it("a junk confidence block does not fail the extraction — it is not the answer", () => {
    const r = parse({ ...GOOD, confidence: "very sure" });
    expect(r.ok).toBe(true);
    expect(r.vision.confidence).toEqual({});
  });
  it("clamps to 0..1", () => {
    const r = parse({ ...GOOD, confidence: { silhouette: 5, upperMaterial: -3 } });
    expect(r.vision.confidence.silhouette).toBe(1);
    expect(r.vision.confidence.upperMaterial).toBe(0);
  });
});

describe("the retry note names what was wrong", () => {
  // A bare "try again" gets the same answer back — the model has no way to know
  // which field was the problem.
  it("quotes the error and the dropped fields", () => {
    const note = attributeRetryNote({ error: "missing required attribute(s): silhouette", dropped: ["toeShape", "toeShape"] });
    expect(note).toContain("silhouette");
    expect(note).toContain("toeShape");
    expect(note.match(/toeShape/g)).toHaveLength(1);   // deduplicated
  });
  it("still says something useful with nothing to name", () => {
    expect(attributeRetryNote({})).toMatch(/required shape/);
  });
});

describe("the cost quote", () => {
  it("is a constant so a batch can be quoted before it spends", () => {
    expect(projectExtractionCost(1000).usd).toBeCloseTo(COST_PER_EXTRACTION_USD * 1000, 4);
    expect(projectExtractionCost(0).usd).toBe(0);
  });
  it("carries the rand figure the operator actually reads", () => {
    expect(projectExtractionCost(1000).zar).toBeGreaterThan(projectExtractionCost(1000).usd);
  });
});

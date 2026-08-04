// ─── STYLE CODE — NORMALISATION, FORMATS, AND THE COLLAPSE GATE ──────────────
// The load-bearing test in this file is "codes sharing the first six characters
// never collapse". CT8527-016 and CT8527-700 are two different shoes; a
// normaliser that truncated, capped length or matched on a prefix would merge
// them into one catalogue record and one stock cell, and the error would only
// surface as inexplicable stock drift weeks later.
//
// It also pins the ESM client copy (src/utils/styleCode.js) against the CJS
// server copy (functions/lib/style-code.cjs). The two cannot share a file across
// the module boundary, so this imports BOTH and asserts identical output on
// every case — the same guard pattern as saDateParity.test.js.

import { describe, it, expect } from "vitest";
import {
  STYLE_CODE_FORMATS,
  brandFamilyForStyleCode,
  normaliseStyleCode,
  styleCodeFormat,
  isKnownStyleCodeFormat,
  formatStyleCodeForDisplay,
  styleCodeQueryCandidates,
} from "./styleCode";
import * as server from "../../functions/lib/style-code.cjs";

// Real codes off real tongue labels, one per brand format we accept.
const BRAND_CASES = [
  // [typed on the label, normalised, format name, display form]
  ["CT8527-016", "CT8527016", "nike-alpha-6-3", "CT8527-016"], // Nike 6+3
  ["CT8527-700", "CT8527700", "nike-alpha-6-3", "CT8527-700"], // …the sibling colorway
  ["DD1391-100", "DD1391100", "nike-alpha-6-3", "DD1391-100"],
  ["315122-111", "315122111", "numeric-6-3", "315122-111"],    // Nike legacy all-numeric
  ["IE3437", "IE3437", "adidas-block", "IE3437"],              // adidas single block
  ["S79770", "S79770", "adidas-block", "S79770"],
  ["ML574EVG", "ML574EVG", "new-balance", "ML574EVG"],         // New Balance
  ["U574WR2", "U574WR2", "new-balance", "U574WR2"],
  ["380190-01", "38019001", "puma-6-2", "380190-01"],          // Puma 6+2
];

describe("normaliseStyleCode", () => {
  it.each(BRAND_CASES)("%s → %s", (typed, normalised) => {
    expect(normaliseStyleCode(typed)).toBe(normalised);
  });

  it("uppercases and strips every separator staff actually type", () => {
    for (const variant of ["ct8527-016", "CT8527 016", "ct8527/016", "CT8527.016", " CT8527-016 ", "CT-8527-016"]) {
      expect(normaliseStyleCode(variant)).toBe("CT8527016");
    }
  });

  it("returns '' for unusable input rather than throwing", () => {
    for (const bad of [null, undefined, 42, {}, [], "", "   ", "---", "///"]) {
      expect(normaliseStyleCode(bad)).toBe("");
    }
  });

  it("NEVER truncates — output keeps every alphanumeric the input had", () => {
    const long = "ABCD1234567890EFGH";
    expect(normaliseStyleCode(long)).toBe(long);
    for (const [typed] of BRAND_CASES) {
      const alnum = typed.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
      expect(normaliseStyleCode(typed)).toHaveLength(alnum.length);
    }
  });

  it("does NOT 'fix' O↔0 or I↔1 — a substitution could merge two real codes", () => {
    expect(normaliseStyleCode("CT8527-O16")).toBe("CT8527O16");
    expect(normaliseStyleCode("CT8527-016")).toBe("CT8527016");
    expect(normaliseStyleCode("CT8527-O16")).not.toBe(normaliseStyleCode("CT8527-016"));
  });

  it("always produces a legal RTDB key (no . # $ / [ ])", () => {
    const dirty = "ct85.27#016$/[]-x";
    expect(normaliseStyleCode(dirty)).toMatch(/^[A-Z0-9]+$/);
  });
});

// ── THE GATE ─────────────────────────────────────────────────────────────────
describe("codes sharing the first six characters are DIFFERENT products", () => {
  const A = "CT8527-016";
  const B = "CT8527-700";

  it("normalise to different keys", () => {
    const a = normaliseStyleCode(A);
    const b = normaliseStyleCode(B);
    expect(a).toBe("CT8527016");
    expect(b).toBe("CT8527700");
    expect(a).not.toBe(b);
    // The shared prefix is real — that is exactly why a prefix match is unsafe.
    expect(a.slice(0, 6)).toBe(b.slice(0, 6));
  });

  it("keep distinct display forms and distinct query candidates", () => {
    expect(formatStyleCodeForDisplay(A)).toBe("CT8527-016");
    expect(formatStyleCodeForDisplay(B)).toBe("CT8527-700");
    const ca = styleCodeQueryCandidates(A);
    const cb = styleCodeQueryCandidates(B);
    expect(ca.some((c) => cb.includes(c))).toBe(false); // zero overlap, any spelling
  });

  it("stay distinct through every spelling a human might type", () => {
    const spellingsA = ["CT8527-016", "ct8527016", "CT8527 016", "Ct-8527-016"];
    const spellingsB = ["CT8527-700", "ct8527700", "CT8527 700", "Ct-8527-700"];
    const normA = new Set(spellingsA.map(normaliseStyleCode));
    const normB = new Set(spellingsB.map(normaliseStyleCode));
    expect(normA.size).toBe(1);
    expect(normB.size).toBe(1);
    expect([...normA][0]).not.toBe([...normB][0]);
  });

  it("holds for the other brand formats too", () => {
    // adidas: same first six, different code.
    expect(normaliseStyleCode("IE34371")).not.toBe(normaliseStyleCode("IE34372"));
    // New Balance: identical model block, different colour suffix.
    expect(normaliseStyleCode("ML574EVG")).not.toBe(normaliseStyleCode("ML574EVW"));
    // Puma: identical 6-digit body, different 2-digit tail.
    expect(normaliseStyleCode("380190-01")).not.toBe(normaliseStyleCode("380190-02"));
  });
});

describe("styleCodeFormat / isKnownStyleCodeFormat", () => {
  it.each(BRAND_CASES)("%s is recognised as %s", (typed, _norm, format) => {
    expect(styleCodeFormat(typed)).toBe(format);
    expect(isKnownStyleCodeFormat(typed)).toBe(true);
  });

  it("recognises the normalised form as readily as the hyphenated one", () => {
    for (const [typed, normalised, format] of BRAND_CASES) {
      expect(styleCodeFormat(normalised)).toBe(format);
      expect(styleCodeFormat(typed)).toBe(format);
    }
  });

  it("rejects the things a vision model hallucinates into the code field", () => {
    for (const junk of ["AIR JORDAN 4", "NIKE", "SIZE 9", "", "   ", "MADE IN VIETNAM", "US 10 UK 9", null, 7]) {
      expect(isKnownStyleCodeFormat(junk)).toBe(false);
    }
  });

  it("every format entry has a name and a regex (no half-added shapes)", () => {
    for (const f of STYLE_CODE_FORMATS) {
      expect(typeof f.name).toBe("string");
      expect(f.name.length).toBeGreaterThan(0);
      expect(f.re).toBeInstanceOf(RegExp);
    }
  });
});

// Feeds the coverage-by-brand miss log. It exists so we can MEASURE where the
// catalog is thin (the free tier is StockX-sourced, so adidas/Puma/Reebok are
// weaker than Jordan/Dunk) — it must never decide what a product IS.
describe("brandFamilyForStyleCode (observability only)", () => {
  it("maps each shape to its brand family", () => {
    expect(brandFamilyForStyleCode("CT8527-016")).toBe("Nike/Jordan");
    expect(brandFamilyForStyleCode("315122-111")).toBe("Nike/Jordan");
    expect(brandFamilyForStyleCode("IE3437")).toBe("adidas");
    expect(brandFamilyForStyleCode("ML574EVG")).toBe("New Balance");
    expect(brandFamilyForStyleCode("380190-01")).toBe("Puma");
  });

  it("says 'unknown' rather than guessing when the shape is unrecognised", () => {
    for (const x of ["AIR JORDAN 4", "", null, "ABCD1234567890EFGH"]) {
      expect(brandFamilyForStyleCode(x)).toBe("unknown");
    }
  });
});

describe("formatStyleCodeForDisplay", () => {
  it.each(BRAND_CASES)("%s displays as %s", (typed, _n, _f, display) => {
    expect(formatStyleCodeForDisplay(typed)).toBe(display);
  });

  it("leaves shapes with no canonical separator alone", () => {
    expect(formatStyleCodeForDisplay("IE3437")).toBe("IE3437");
    expect(formatStyleCodeForDisplay("ML574EVG")).toBe("ML574EVG");
  });

  it("round-trips: display form re-normalises to the same key", () => {
    for (const [typed, normalised] of BRAND_CASES) {
      expect(normaliseStyleCode(formatStyleCodeForDisplay(typed))).toBe(normalised);
    }
  });

  it("returns '' for unusable input", () => {
    expect(formatStyleCodeForDisplay(null)).toBe("");
    expect(formatStyleCodeForDisplay("---")).toBe("");
  });
});

describe("styleCodeQueryCandidates", () => {
  it("asks with what was typed, the hyphenated form, then the bare form", () => {
    expect(styleCodeQueryCandidates("ct8527016")).toEqual(["ct8527016", "CT8527-016", "CT8527016"]);
  });

  it("de-duplicates when the spellings coincide", () => {
    expect(styleCodeQueryCandidates("CT8527-016")).toEqual(["CT8527-016", "CT8527016"]);
    expect(styleCodeQueryCandidates("IE3437")).toEqual(["IE3437"]);
  });

  it("every candidate normalises back to the SAME key — we widen the ask, not the accept", () => {
    for (const [typed, normalised] of BRAND_CASES) {
      for (const c of styleCodeQueryCandidates(typed)) {
        expect(normaliseStyleCode(c)).toBe(normalised);
      }
    }
  });

  it("returns [] for unusable input", () => {
    expect(styleCodeQueryCandidates(null)).toEqual([]);
    expect(styleCodeQueryCandidates("  ")).toEqual([]);
  });
});

// ── CLIENT ↔ FUNCTIONS PARITY ────────────────────────────────────────────────
// The client decides what to send; the server decides what key to store it
// under. If these two ever disagree, a code typed in the intake flow is cached
// under a key the intake flow will never look up again — a silent, permanent
// cache miss on every future scan of that shoe.
describe("client/functions style-code parity", () => {
  const ALL_INPUTS = [
    ...BRAND_CASES.map(([typed]) => typed),
    ...BRAND_CASES.map(([, normalised]) => normalised),
    "ct8527-016", "CT8527 016", "  CT8527.016  ", "CT-8527-016",
    "AIR JORDAN 4", "SIZE 9", "", "   ", "---", "ABCD1234567890EFGH",
    null, undefined, 42, {}, [],
  ];

  it.each(ALL_INPUTS.map((i) => [JSON.stringify(i) ?? String(i), i]))(
    "normaliseStyleCode agrees on %s",
    (_label, input) => {
      expect(server.normaliseStyleCode(input)).toBe(normaliseStyleCode(input));
    },
  );

  it("styleCodeFormat, display form, candidates and brand family all agree", () => {
    for (const input of ALL_INPUTS) {
      expect(server.styleCodeFormat(input)).toBe(styleCodeFormat(input));
      expect(server.isKnownStyleCodeFormat(input)).toBe(isKnownStyleCodeFormat(input));
      expect(server.formatStyleCodeForDisplay(input)).toBe(formatStyleCodeForDisplay(input));
      expect(server.styleCodeQueryCandidates(input)).toEqual(styleCodeQueryCandidates(input));
      expect(server.brandFamilyForStyleCode(input)).toBe(brandFamilyForStyleCode(input));
    }
  });

  it("the two format tables are the same shapes in the same order", () => {
    expect(server.STYLE_CODE_FORMATS.map((f) => f.name)).toEqual(STYLE_CODE_FORMATS.map((f) => f.name));
    expect(server.STYLE_CODE_FORMATS.map((f) => f.re.source)).toEqual(STYLE_CODE_FORMATS.map((f) => f.re.source));
  });
});

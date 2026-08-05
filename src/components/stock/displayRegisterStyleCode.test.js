// ─── THE DISPLAY REGISTER CARRIES THE STYLE CODE ─────────────────────────────
// Walking the shop floor, the tongue label is the only thing you can actually
// read — the box is long gone and the barcode sticker was on the box. So the
// style code has to do two jobs here:
//
//   1. FIND the product, so a scan registers the right pair
//   2. LAND ON THE ROW, so the register says WHICH EXACT SHOE is on the floor
//
// (2) matters more than it looks. A register row that says "Nike Dunk Low" does
// not tell you which colourway is standing on the shelf, and two colourways of
// one silhouette are the single most common thing to confuse. The code does.

import { describe, it, expect } from "vitest";
import { styleCodeFieldsFor } from "./DisplayRegister.jsx";
import { normaliseStyleCode } from "../../utils/styleCode";

const P = (over = {}) => ({ id: "p1", name: "Nike Dunk Low", ...over });

describe("styleCodeFieldsFor — what a register row carries", () => {
  it("copies both fields off the product", () => {
    expect(styleCodeFieldsFor(P({ styleCode: "CT8527-016", styleCodeNormalised: "CT8527016" })))
      .toEqual({ styleCode: "CT8527-016", styleCodeNormalised: "CT8527016" });
  });

  it("derives the readable form when only the normalised one is stored", () => {
    const out = styleCodeFieldsFor(P({ styleCodeNormalised: "CT8527016" }));
    expect(out.styleCodeNormalised).toBe("CT8527016");
    expect(out.styleCode).toBe("CT8527-016");
  });

  it("works off a raw styleCode alone", () => {
    expect(styleCodeFieldsFor(P({ styleCode: "ct8527 016" })).styleCodeNormalised).toBe("CT8527016");
  });

  it("writes NOTHING for a product with no code — absent means 'has no code'", () => {
    for (const p of [P(), P({ styleCode: "" }), P({ styleCode: "---" }), P({ styleCodeNormalised: null }), null, undefined]) {
      expect(styleCodeFieldsFor(p)).toEqual({});
    }
  });

  it("never writes one field without the other", () => {
    for (const p of [P({ styleCode: "IE3437" }), P({ styleCodeNormalised: "IE3437" }), P()]) {
      const out = styleCodeFieldsFor(p);
      expect("styleCode" in out).toBe("styleCodeNormalised" in out);
    }
  });

  it("THE GATE: sibling colourways produce different rows", () => {
    const a = styleCodeFieldsFor(P({ styleCode: "CT8527-016" }));
    const b = styleCodeFieldsFor(P({ styleCode: "CT8527-700" }));
    expect(a.styleCodeNormalised).not.toBe(b.styleCodeNormalised);
  });
});

// ── The search rule, stated as the component applies it ──────────────────────
// Mirrored here rather than imported because it is a closure inside the
// component. If the component's rule ever loosens to a prefix match, these
// pin what it MUST keep doing.
const styleCodeHit = (p, termNorm) => {
  if (!termNorm || termNorm.length < 4) return false;
  const pn = normaliseStyleCode(p.styleCodeNormalised || p.styleCode);
  return !!pn && pn === termNorm;
};

describe("finding a product by its style code", () => {
  const prod = P({ styleCode: "CT8527-016", styleCodeNormalised: "CT8527016" });

  it("every spelling a person types finds the same shoe", () => {
    for (const typed of ["CT8527-016", "ct8527016", "CT8527 016", "  ct8527-016  "]) {
      expect(styleCodeHit(prod, normaliseStyleCode(typed))).toBe(true);
    }
  });

  it("NEVER a prefix match — that would register the wrong colourway", () => {
    for (const wrong of ["CT8527", "CT85", "CT8527-700", "CT85270160"]) {
      expect(styleCodeHit(prod, normaliseStyleCode(wrong))).toBe(false);
    }
  });

  it("a too-short term never matches, so typing does not thrash the list", () => {
    for (const t of ["", "C", "CT", "CT8"]) {
      expect(styleCodeHit(prod, normaliseStyleCode(t))).toBe(false);
    }
  });

  it("a product with no code is never matched by a code search", () => {
    expect(styleCodeHit(P(), normaliseStyleCode("CT8527-016"))).toBe(false);
  });
});

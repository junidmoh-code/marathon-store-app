// ─── PRINTED BARCODE VALUE MODEL — the check digit is the whole guarantee ────
// These are mutation tests, not coverage. The three fixtures are REAL codes off
// real bottles in the shop (Honeyed Fantasy, Oud Mood, Epic), so a check-digit
// implementation that is subtly wrong — weights applied left-to-right instead
// of right-to-left, or the check digit included in its own sum — fails here
// rather than in production against stock nobody can scan.

import { describe, it, expect } from "vitest";
import {
  eanCheckDigit,
  hasValidCheckDigit,
  normalisePrintedBarcode,
  indexCodesFor,
  printedBarcodeOutcome,
  REFUSE_CHECK_DIGIT,
  REFUSE_LENGTH,
  REFUSE_EMPTY,
  PRINTED_FREE,
  PRINTED_ALREADY,
  PRINTED_CONFLICT,
} from "./eanBarcode";

// The three bottles already on the shelf.
const HONEYED_FANTASY = "6298750137969";
const OUD_MOOD = "6291106065114";
const EPIC = "6291103660466";

describe("check digit — the real bottles", () => {
  it("accepts all three live perfume EAN-13s", () => {
    for (const code of [HONEYED_FANTASY, OUD_MOOD, EPIC]) {
      expect(hasValidCheckDigit(code), code).toBe(true);
      expect(normalisePrintedBarcode(code)).toEqual({ ok: true, code });
    }
  });

  it("computes the check digit each bottle actually prints", () => {
    expect(eanCheckDigit(HONEYED_FANTASY.slice(0, 12))).toBe(9);
    expect(eanCheckDigit(OUD_MOOD.slice(0, 12))).toBe(4);
    expect(eanCheckDigit(EPIC.slice(0, 12))).toBe(6);
  });

  it("REFUSES a single mistyped digit anywhere in the code", () => {
    // Every position, one digit bumped by 1 — the misread OCR and a shaky
    // decoder both produce. Not one of them may be accepted.
    for (let i = 0; i < OUD_MOOD.length; i++) {
      const bumped = OUD_MOOD.slice(0, i) + ((Number(OUD_MOOD[i]) + 1) % 10) + OUD_MOOD.slice(i + 1);
      if (bumped === OUD_MOOD) continue;
      const result = normalisePrintedBarcode(bumped);
      expect(result.ok, `${bumped} (position ${i}) must be refused`).toBe(false);
      expect(result.reason).toBe(REFUSE_CHECK_DIGIT);
    }
  });

  it("refuses two transposed digits (the classic typing slip)", () => {
    // 6291106065114 → swap the "11" run's neighbours: 62911 → 62191.
    expect(normalisePrintedBarcode("6219106065114").ok).toBe(false);
  });

  it("validates EAN-8 and UPC-A with the same rule", () => {
    expect(hasValidCheckDigit("96385074")).toBe(true);     // canonical EAN-8
    expect(hasValidCheckDigit("96385075")).toBe(false);
    expect(hasValidCheckDigit("036000291452")).toBe(true); // canonical UPC-A
    expect(hasValidCheckDigit("036000291453")).toBe(false);
  });
});

describe("normalisePrintedBarcode — what may become an identity", () => {
  it("strips the spaces and hyphens a box prints or a human types", () => {
    expect(normalisePrintedBarcode("6 291106 065114")).toEqual({ ok: true, code: OUD_MOOD });
    expect(normalisePrintedBarcode("6-291106-065114")).toEqual({ ok: true, code: OUD_MOOD });
    expect(normalisePrintedBarcode("  6291106065114  ")).toEqual({ ok: true, code: OUD_MOOD });
  });

  it("refuses a length that is not one of the three symbologies", () => {
    expect(normalisePrintedBarcode("62911060651").reason).toBe(REFUSE_LENGTH);    // 11
    expect(normalisePrintedBarcode("62911060651145").reason).toBe(REFUSE_LENGTH); // 14
    expect(normalisePrintedBarcode("629110").reason).toBe(REFUSE_LENGTH);         // 6
    expect(normalisePrintedBarcode("6291106065114" + "0").reason).toBe(REFUSE_LENGTH);
  });

  it("a TRUNCATED EAN-13 that happens to be 12 digits is caught by the check digit", () => {
    // Dropping the last digit leaves a UPC-A-shaped string, so length alone
    // cannot save us here — the check digit is what refuses it.
    expect(normalisePrintedBarcode(OUD_MOOD.slice(0, 12)).reason).toBe(REFUSE_CHECK_DIGIT);
  });

  it("never salvages digits out of a string that was not a barcode", () => {
    // Letters disqualify the whole reading — extracting the digits from
    // "EAN6291106065114X" would invent a code from a label caption.
    expect(normalisePrintedBarcode("EAN6291106065114").ok).toBe(false);
    expect(normalisePrintedBarcode("6291106065114X").ok).toBe(false);
    expect(normalisePrintedBarcode("CT8527-016").ok).toBe(false);
  });

  it("refuses empty / null input distinctly from a malformed one", () => {
    expect(normalisePrintedBarcode("").reason).toBe(REFUSE_EMPTY);
    expect(normalisePrintedBarcode(null).reason).toBe(REFUSE_EMPTY);
    expect(normalisePrintedBarcode(undefined).reason).toBe(REFUSE_EMPTY);
  });

  it("carries a message naming the actual problem, not a blanket refusal", () => {
    expect(normalisePrintedBarcode("6291106065115").message).toMatch(/check digit/i);
    expect(normalisePrintedBarcode("629110").message).toMatch(/13 digits|EAN-13/);
  });

  it("never confuses an 8-digit SHOP code with an EAN-8", () => {
    // Our own minted codes are 8 digits and zero-padded — "00000042". They are
    // NOT manufacturer codes and must not pass this gate by accident.
    expect(normalisePrintedBarcode("00000042").ok).toBe(false);
  });
});

describe("indexCodesFor — UPC-A and EAN-13 are one number", () => {
  it("registers a UPC-A under BOTH its forms", () => {
    expect(indexCodesFor("036000291452")).toEqual(["036000291452", "0036000291452"]);
  });

  it("padding a UPC-A to 13 does not change its check digit", () => {
    expect(hasValidCheckDigit("0036000291452")).toBe(true);
  });

  it("is SYMMETRIC — a 13-digit code beginning with 0 also gives its UPC-A form", () => {
    // Handling only the 12→13 direction left a box captured from its EAN-13
    // print unfindable to a reader that strips the pad. Same gap, other way.
    expect(indexCodesFor("0036000291452")).toEqual(["0036000291452", "036000291452"]);
  });

  it("leaves a normal EAN-13 and an EAN-8 as themselves alone", () => {
    expect(indexCodesFor(OUD_MOOD)).toEqual([OUD_MOOD]);         // starts with 6
    expect(indexCodesFor("96385074")).toEqual(["96385074"]);
  });
});

describe("printedBarcodeOutcome — what an already-indexed code means", () => {
  it("FREE when no form of the code is in the index", () => {
    const out = printedBarcodeOutcome([{ code: OUD_MOOD, productId: null }], "p1");
    expect(out.kind).toBe(PRINTED_FREE);
    expect(out.codes).toEqual([OUD_MOOD]);
  });

  it("ALREADY when every form already points at THIS product", () => {
    expect(printedBarcodeOutcome([{ code: OUD_MOOD, productId: "p1" }], "p1").kind).toBe(PRINTED_ALREADY);
  });

  it("CONFLICT when a form points at a DIFFERENT product", () => {
    const out = printedBarcodeOutcome([{ code: OUD_MOOD, productId: "pOther" }], "p1");
    expect(out.kind).toBe(PRINTED_CONFLICT);
    expect(out.otherProductId).toBe("pOther");
    expect(out.code).toBe(OUD_MOOD);
  });

  it("treats every existing owner as a conflict while CREATING a product", () => {
    // productId is null before the product exists — so anyone holding the code
    // is by definition somebody else.
    expect(printedBarcodeOutcome([{ code: OUD_MOOD, productId: "pOther" }], null).kind).toBe(PRINTED_CONFLICT);
  });

  it("a conflict on the TWIN form outranks a free primary form", () => {
    // Registering the free half would spread one duplicate across two rows.
    const out = printedBarcodeOutcome([
      { code: "036000291452", productId: null },
      { code: "0036000291452", productId: "pOther" },
    ], "p1");
    expect(out.kind).toBe(PRINTED_CONFLICT);
  });

  it("registers only the MISSING form when we already own the other", () => {
    const out = printedBarcodeOutcome([
      { code: "036000291452", productId: "p1" },
      { code: "0036000291452", productId: null },
    ], "p1");
    expect(out.kind).toBe(PRINTED_FREE);
    expect(out.codes).toEqual(["0036000291452"]);   // never re-writes the owned one
  });
});

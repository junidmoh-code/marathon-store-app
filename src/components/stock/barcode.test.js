// Tests for the per-(product,size) barcode value model (barcode.js, pure).
// The permanence/idempotency contract is the critical, get-it-right part: a code
// is reused if present and a fresh number is reserved only when missing, never
// regenerated. These lock the pure pieces that decision rests on; the Firebase
// transaction wiring lives in barcodeStore.js.

import { describe, it, expect } from "vitest";
import {
  BARCODE_MAX,
  formatBarcode,
  isValidBarcode,
  reuseOrNull,
  nextBarcodeFromMeta,
  barcodeSizeKey,
  barcodeIndexRecord,
  code128Symbols,
  code128Modules,
} from "./barcode";

describe("formatBarcode", () => {
  it("zero-pads to 8 digits", () => {
    expect(formatBarcode(1)).toBe("00000001");
    expect(formatBarcode(42)).toBe("00000042");
    expect(formatBarcode(99999999)).toBe("99999999");
  });
});

describe("isValidBarcode", () => {
  it("accepts exactly 8 digits", () => {
    expect(isValidBarcode("00000001")).toBe(true);
    expect(isValidBarcode("99999999")).toBe(true);
  });
  it("rejects wrong length / non-digits / non-strings", () => {
    expect(isValidBarcode("1234")).toBe(false);
    expect(isValidBarcode("123456789")).toBe(false);
    expect(isValidBarcode("0000000a")).toBe(false);
    expect(isValidBarcode("")).toBe(false);
    expect(isValidBarcode(null)).toBe(false);
    expect(isValidBarcode(42)).toBe(false);
  });
});

describe("reuseOrNull — the permanence guard (reuse-if-present, reserve-if-missing)", () => {
  it("returns the existing code when valid (reuse, never regenerate)", () => {
    expect(reuseOrNull("00000007")).toBe("00000007");
  });
  it("returns null when absent or invalid (caller must reserve a fresh number)", () => {
    expect(reuseOrNull(null)).toBe(null);
    expect(reuseOrNull(undefined)).toBe(null);
    expect(reuseOrNull("")).toBe(null);
    expect(reuseOrNull("nope")).toBe(null);
  });
});

describe("nextBarcodeFromMeta — shared sequential counter", () => {
  it("starts at 1 when the counter is unset", () => {
    expect(nextBarcodeFromMeta(null)).toEqual({ next: 1, code: "00000001" });
    expect(nextBarcodeFromMeta({})).toEqual({ next: 1, code: "00000001" });
  });
  it("advances monotonically from the existing counter (no reuse of numbers)", () => {
    expect(nextBarcodeFromMeta({ lastBarcode: 41 })).toEqual({ next: 42, code: "00000042" });
    // Each call is one ahead of the prior committed value — applied in a
    // transaction, so concurrent reservers get distinct numbers.
    expect(nextBarcodeFromMeta({ lastBarcode: 42 })).toEqual({ next: 43, code: "00000043" });
  });
  it("ignores a non-numeric counter (treats as 0)", () => {
    expect(nextBarcodeFromMeta({ lastBarcode: "x" })).toEqual({ next: 1, code: "00000001" });
  });
  it("throws on exhaustion rather than wrapping", () => {
    expect(() => nextBarcodeFromMeta({ lastBarcode: BARCODE_MAX })).toThrow(/exhausted/i);
  });
  it("preserves separate sku/barcode counters by only reading lastBarcode", () => {
    // sku advances per product elsewhere; this helper never touches it.
    expect(nextBarcodeFromMeta({ lastSku: 999, lastBarcode: 7 })).toEqual({ next: 8, code: "00000008" });
  });
});

describe("barcodeSizeKey — canonical encoder, shared with /stock + POS", () => {
  it("leaves dot-free sizes untouched", () => {
    expect(barcodeSizeKey("M")).toBe("M");
    expect(barcodeSizeKey("XXL")).toBe("XXL");
    expect(barcodeSizeKey("10")).toBe("10");
  });
  it("encodes the illegal '.' as '_' (half-sizes) — matches /stock + POS, NOT the old '-'", () => {
    expect(barcodeSizeKey("5.5")).toBe("5_5");
    expect(barcodeSizeKey("10.5")).toBe("10_5");
    expect(barcodeSizeKey("5.5")).not.toMatch(/-/);
  });
  it("maps one-size / null / empty to the '_' sentinel (cell parity with /stock)", () => {
    expect(barcodeSizeKey(null)).toBe("_");
    expect(barcodeSizeKey(undefined)).toBe("_");
    expect(barcodeSizeKey("")).toBe("_");
  });
});

describe("barcodeIndexRecord — /barcodes/{code} reverse-index shape", () => {
  it("sized: carries the RAW size value (half-size + S–XXL)", () => {
    expect(barcodeIndexRecord("p1", "5.5", "T")).toEqual({ productId: "p1", at: "T", size: "5.5" });
    expect(barcodeIndexRecord("p1", "M", "T")).toEqual({ productId: "p1", at: "T", size: "M" });
    expect(barcodeIndexRecord("p1", "XXL", "T")).toEqual({ productId: "p1", at: "T", size: "XXL" });
  });
  it("unsized: OMITS the size field entirely (not null, not '')", () => {
    for (const unsized of [null, undefined, ""]) {
      const rec = barcodeIndexRecord("cap-1", unsized, "T");
      expect(rec).toEqual({ productId: "cap-1", at: "T" });
      expect("size" in rec).toBe(false);   // resolver reads missing size as null
    }
  });
});

describe("unsized barcode end-to-end key+record contract", () => {
  it("one-size product → slot keys at '_' AND index omits size (POS resolves to null)", () => {
    // forward slot key
    expect(barcodeSizeKey(null)).toBe("_");
    // reverse index record the POS reads: no size → `barcode.size ?? null` → null,
    // valid for a sizes:[] product (sizes.length === 0 ? size == null).
    const rec = barcodeIndexRecord("cap-1", null, "T");
    expect(rec.size).toBeUndefined();
  });
  it("sized product → encoded slot key, raw size in the record", () => {
    expect(barcodeSizeKey("5.5")).toBe("5_5");
    expect(barcodeIndexRecord("shoe-1", "5.5", "T").size).toBe("5.5");
  });
});

describe("code128Symbols — deterministic, scanner-correct checksum", () => {
  it("encodes a single '0' with the hand-computed checksum", () => {
    // StartB(104) + '0'(16); checksum = (104 + 16*1) % 103 = 17; Stop(106).
    expect(code128Symbols("0")).toEqual([104, 16, 17, 106]);
  });
  it("encodes the 8-digit code 00000001 with the hand-computed checksum", () => {
    // vals: seven '0'(16) + '1'(17); Σ val_i*i = 16*(1..7) + 17*8 = 584;
    // checksum = (104 + 584) % 103 = 70.
    expect(code128Symbols("00000001")).toEqual([104, 16, 16, 16, 16, 16, 16, 16, 17, 70, 106]);
  });
  it("is deterministic", () => {
    expect(code128Symbols("00000042")).toEqual(code128Symbols("00000042"));
  });
  it("rejects non-encodable characters", () => {
    expect(() => code128Symbols("é")).toThrow();
  });
});

describe("code128Modules — renderable bar/space widths", () => {
  it("starts with a bar and uses positive widths only", () => {
    const mods = code128Modules("00000042");
    expect(mods.length).toBeGreaterThan(0);
    expect(mods[0].bar).toBe(true);
    expect(mods.every(m => m.width >= 1 && m.width <= 4)).toBe(true);
  });
});

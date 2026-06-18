// Tests for the RTDB-key-safe size encoder (src/utils/sizeKey.js).
// CRITICAL cross-app contract: a half-size shoe ("5.5") must NOT reach RTDB as a
// key containing "." (RTDB rejects it). The encoding MUST be byte-identical to
// marathon-pos-app/src/shared/sizeKey.js so both apps key /stock and /inventory
// the same. Vectors below mirror the POS test suite exactly.

import { describe, it, expect } from "vitest";
import { encodeSizeKey, decodeSizeKey, stockCellPath } from "./sizeKey";

describe("encodeSizeKey — identical to the POS encoder", () => {
  it("encodes half-sizes dot-free (the bug): '.' → '_'", () => {
    expect(encodeSizeKey("5.5")).toBe("5_5");
    expect(encodeSizeKey("6.5")).toBe("6_5");
    expect(encodeSizeKey("10.5")).toBe("10_5");
    expect(encodeSizeKey("12.5")).toBe("12_5");
  });
  it("leaves dot-free sizes untouched", () => {
    expect(encodeSizeKey("5")).toBe("5");
    expect(encodeSizeKey("12")).toBe("12");
    expect(encodeSizeKey("XL")).toBe("XL");
    expect(encodeSizeKey("XXL")).toBe("XXL");
  });
  it("strips every RTDB-illegal char (defensive) and whitespace", () => {
    expect(encodeSizeKey("a.b#c$d/e[f]g h")).toBe("a_b_c_d_e_f_g_h");
  });
  it("never leaves a '.' in the result", () => {
    for (const s of ["5.5", "6.5", "10.5", "12.5"]) {
      expect(encodeSizeKey(s)).not.toMatch(/\./);
    }
  });
  it("coerces a NUMERIC half-size before encoding (no '.' leaks via a number)", () => {
    expect(encodeSizeKey(5.5)).toBe("5_5");
    expect(encodeSizeKey(10.5)).toBe("10_5");
    expect(encodeSizeKey(12)).toBe("12");
    expect(encodeSizeKey(5.5)).not.toMatch(/\./);
  });
  it("passes null/undefined through untouched (defensive)", () => {
    expect(encodeSizeKey(undefined)).toBe(undefined);
    expect(encodeSizeKey(null)).toBe(null);
  });
});

describe("decodeSizeKey — round-trips real sizes", () => {
  it("digit_digit → digit.digit", () => {
    expect(decodeSizeKey("5_5")).toBe("5.5");
    expect(decodeSizeKey("10_5")).toBe("10.5");
  });
  it("leaves non-numeric underscores + the no-size sentinel intact", () => {
    expect(decodeSizeKey("XL")).toBe("XL");
    expect(decodeSizeKey("ONE_SIZE")).toBe("ONE_SIZE");
    expect(decodeSizeKey("_")).toBe("_");
  });
  it("round-trips encode→decode for realistic sizes", () => {
    for (const s of ["5", "5.5", "10.5", "M", "XL"]) {
      expect(decodeSizeKey(encodeSizeKey(s))).toBe(s);
    }
  });
});

describe("stockCellPath — half-size /stock key is dot-free", () => {
  it("encodes the size segment of the /stock path", () => {
    expect(stockCellPath("studio", "p1700000000000", "5.5")).toBe("stock/studio/p1700000000000/5_5");
  });
  it("leaves whole sizes as-is", () => {
    expect(stockCellPath("marathon-pe", "pABC", "M")).toBe("stock/marathon-pe/pABC/M");
  });
  it("never emits a '.' in the size segment (would be rejected by RTDB)", () => {
    const path = stockCellPath("hub1", "pX", "12.5");
    expect(path.split("/").pop()).toBe("12_5");
    expect(path.split("/").pop()).not.toMatch(/\./);
  });
  it("encodes a numeric half-size too", () => {
    expect(stockCellPath("hub1", "pX", 5.5)).toBe("stock/hub1/pX/5_5");
  });
});

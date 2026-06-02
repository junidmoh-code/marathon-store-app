// Tests for customer phone normalisation (E.164 / South Africa). Covers the
// flexible entry formats staff use, including the short / no-leading-0 numbers.

import { describe, it, expect } from "vitest";
import { normalizeSAPhone, isValidLocalSAPhone, toLocalSA } from "./phone";

describe("normalizeSAPhone", () => {
  it("keeps empty / whitespace-only input empty (phone is optional)", () => {
    expect(normalizeSAPhone("")).toBe("");
    expect(normalizeSAPhone("   ")).toBe("");
    expect(normalizeSAPhone(null)).toBe("");
    expect(normalizeSAPhone(undefined)).toBe("");
  });

  it("returns empty for input with no digits", () => {
    expect(normalizeSAPhone("abc")).toBe("");
    expect(normalizeSAPhone("---")).toBe("");
  });

  it("normalises a local number with a leading 0", () => {
    expect(normalizeSAPhone("0712345678")).toBe("+27712345678");
  });

  it("normalises a bare 9-digit national number (no leading 0)", () => {
    expect(normalizeSAPhone("712345678")).toBe("+27712345678");
  });

  it("strips spaces, dashes and parens", () => {
    expect(normalizeSAPhone("071 234 5678")).toBe("+27712345678");
    expect(normalizeSAPhone("071-234-5678")).toBe("+27712345678");
    expect(normalizeSAPhone("71 234 5678")).toBe("+27712345678");
    expect(normalizeSAPhone("(071) 234 5678")).toBe("+27712345678");
  });

  it("handles the 27 country code with or without +", () => {
    expect(normalizeSAPhone("27712345678")).toBe("+27712345678");
    expect(normalizeSAPhone("+27712345678")).toBe("+27712345678");
    expect(normalizeSAPhone("+27 71 234 5678")).toBe("+27712345678");
  });

  it("handles the 00 international prefix", () => {
    expect(normalizeSAPhone("0027712345678")).toBe("+27712345678");
  });

  it("preserves a +-prefixed non-SA international number (separators stripped)", () => {
    expect(normalizeSAPhone("+1 415 555 0123")).toBe("+14155550123");
  });
});

describe("isValidLocalSAPhone", () => {
  it("accepts exactly 10 digits starting with 0", () => {
    expect(isValidLocalSAPhone("0712345678")).toBe(true);
    expect(isValidLocalSAPhone("071 234 5678")).toBe(true); // separators ignored
  });
  it("rejects short, overlong, or non-0-leading numbers", () => {
    expect(isValidLocalSAPhone("071234567")).toBe(false);   // 9 digits (short)
    expect(isValidLocalSAPhone("07123456789")).toBe(false); // 11 digits (over)
    expect(isValidLocalSAPhone("712345678")).toBe(false);   // no leading 0
    expect(isValidLocalSAPhone("2712345678")).toBe(false);  // wrong prefix
    expect(isValidLocalSAPhone("+27712345678")).toBe(false);// E.164, not local
  });
  it("rejects empty / digit-less input", () => {
    expect(isValidLocalSAPhone("")).toBe(false);
    expect(isValidLocalSAPhone(null)).toBe(false);
    expect(isValidLocalSAPhone("abc")).toBe(false);
  });
});

describe("toLocalSA", () => {
  it("converts stored +27 / 27 numbers to local 0-form", () => {
    expect(toLocalSA("+27712345678")).toBe("0712345678");
    expect(toLocalSA("27712345678")).toBe("0712345678");
  });
  it("leaves a valid local number unchanged and pads a bare 9-digit", () => {
    expect(toLocalSA("0712345678")).toBe("0712345678");
    expect(toLocalSA("712345678")).toBe("0712345678");
  });
  it("the result of a SA number passes isValidLocalSAPhone", () => {
    expect(isValidLocalSAPhone(toLocalSA("+27712345678"))).toBe(true);
  });
});

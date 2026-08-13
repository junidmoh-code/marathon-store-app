// Tests for customer phone normalisation (E.164 / South Africa). Covers the
// flexible entry formats staff use, including the short / no-leading-0 numbers.

import { describe, it, expect } from "vitest";
import { normalizeSAPhone, isValidLocalSAPhone, toLocalSA, saSignificantDigits, phoneKeyVariants, customerWriteKey, phoneGroupKey } from "./phone";

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

  it("refuses to +27-mangle digits that match no SA shape (census-found bug)", () => {
    expect(normalizeSAPhone("81399533")).toBe("81399533");      // truncated 8-digit
    expect(normalizeSAPhone("2712345678")).toBe("2712345678");  // 27-prefix, wrong length
    expect(normalizeSAPhone("26651463")).toBe("26651463");      // foreign cc, no +
    expect(normalizeSAPhone("07123456789")).toBe("07123456789"); // 0-lead, 11 digits
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

describe("saSignificantDigits", () => {
  it("reduces every stored format to the same national digits", () => {
    expect(saSignificantDigits("+27712345678")).toBe("712345678");
    expect(saSignificantDigits("27712345678")).toBe("712345678");
    expect(saSignificantDigits("0712345678")).toBe("712345678");
    expect(saSignificantDigits("712345678")).toBe("712345678");
  });
  it("lets a typed local query prefix-match an international-stored number", () => {
    const stored = saSignificantDigits("+27712345678");
    expect(stored.startsWith(saSignificantDigits("0712"))).toBe(true); // partial local query
    expect(stored.startsWith(saSignificantDigits("0712345678"))).toBe(true); // full local query
  });
});

// /customers record resolution: reads probe every key shape (phoneKeyVariants,
// first hit wins in resolveCustomerKey) so an existing record is found and
// updated in place, never duplicated; new records are minted at the canonical
// local 0-form key (customerWriteKey).
describe("phoneKeyVariants", () => {
  it("probes typed digits, local 0-form, 27-form, then the bare 9-digit form", () => {
    expect(phoneKeyVariants("+27656996104")).toEqual(["27656996104", "0656996104", "656996104"]);
    expect(phoneKeyVariants("0656996104")).toEqual(["0656996104", "27656996104", "656996104"]);
  });

  it("every input dialect covers ALL live key dialects (0-form, 27-form, bare-9), so an existing record in any shape is found", () => {
    for (const input of ["0656996104", "+27656996104", "27656996104", "656996104"]) {
      const variants = phoneKeyVariants(input);
      expect(variants).toContain("0656996104");  // POS-minted local key
      expect(variants).toContain("27656996104"); // legacy international key
      expect(variants).toContain("656996104");   // bare-9 key (census: 4 live records)
    }
  });

  it("pads a bare 9-digit national number to the local form", () => {
    expect(phoneKeyVariants("656996104")).toEqual(["656996104", "0656996104", "27656996104"]);
  });

  it("returns no variants for empty / digit-less input", () => {
    expect(phoneKeyVariants("")).toEqual([]);
    expect(phoneKeyVariants("abc")).toEqual([]);
    expect(phoneKeyVariants(null)).toEqual([]);
  });

  it("leaves a non-SA international number at its typed key only", () => {
    expect(phoneKeyVariants("+14155550123")).toEqual(["14155550123"]);
  });
});

describe("customerWriteKey (key new /customers records are minted at)", () => {
  it("a new customer via order (+27 phone) lands at the local 0-form key, not 27", () => {
    expect(customerWriteKey("+27656996104")).toBe("0656996104");
  });

  it("0-form, +27, 27 and bare 9-digit inputs all mint the same local key", () => {
    expect(customerWriteKey("0656996104")).toBe("0656996104");
    expect(customerWriteKey("+27656996104")).toBe("0656996104");
    expect(customerWriteKey("27656996104")).toBe("0656996104");
    expect(customerWriteKey("656996104")).toBe("0656996104");
  });

  it("the minted key is a valid local SA phone shape", () => {
    expect(isValidLocalSAPhone(customerWriteKey("+27656996104"))).toBe(true);
  });

  it("falls back to typed digits for a non-SA number, 'unknown' when digit-less", () => {
    expect(customerWriteKey("+14155550123")).toBe("14155550123");
    expect(customerWriteKey("")).toBe("unknown");
    expect(customerWriteKey(null)).toBe("unknown");
  });
});

// Read-side aggregation identity: every dialect of one SA number groups under
// one key; non-SA numbers keep their own digits (never folded); junk → unknown.
describe("phoneGroupKey", () => {
  it("collapses all four stored dialects of one number to one group key", () => {
    for (const input of ["0813995333", "+27813995333", "27813995333", "813995333"]) {
      expect(phoneGroupKey(input)).toBe("0813995333");
    }
  });
  it("keeps a non-SA number distinct instead of folding it into an SA group", () => {
    expect(phoneGroupKey("+14155550123")).toBe("14155550123");
  });
  it("maps digit-less input to 'unknown'", () => {
    expect(phoneGroupKey("")).toBe("unknown");
    expect(phoneGroupKey(null)).toBe("unknown");
    expect(phoneGroupKey("abc")).toBe("unknown");
  });
});

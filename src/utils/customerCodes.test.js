// Tests for the customer-code helpers + atomic counter reservation.
// The counter transaction mirrors marathon-pos-app's codeAssignment.js exactly.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatCustomerCode, parseCustomerCode, isValidCustomerCode, STARTING_COUNTER } from "./customerCodes";

// Mock the Firebase layer so reserveNextCode's runTransaction is driven by a
// controllable `current` counter value.
let current;
let commit;
const runTransactionMock = vi.fn(async (r, fn) => {
  const next = fn(current);
  if (next === undefined) return { committed: false, snapshot: { val: () => current } };
  if (commit) current = next;
  return { committed: commit, snapshot: { val: () => (commit ? next : current) } };
});
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  runTransaction: (...a) => runTransactionMock(...a),
}));
vi.mock("../firebase.js", () => ({ database: {} }));

const { reserveNextCode } = await import("./customerCodes.js");

beforeEach(() => { current = null; commit = true; runTransactionMock.mockClear(); });

describe("formatCustomerCode", () => {
  it("pads to 4 digits and grows naturally past the width", () => {
    expect(formatCustomerCode(7)).toBe("C-0007");
    expect(formatCustomerCode(1001)).toBe("C-1001");
    expect(formatCustomerCode(12345)).toBe("C-12345");
  });
  it("returns null for non-positive / non-integer / non-finite input", () => {
    expect(formatCustomerCode(0)).toBe(null);
    expect(formatCustomerCode(-5)).toBe(null);
    expect(formatCustomerCode(1.5)).toBe(null);
    expect(formatCustomerCode(NaN)).toBe(null);
    expect(formatCustomerCode("1042")).toBe(null);
  });
});

describe("parseCustomerCode / isValidCustomerCode", () => {
  it("parses C- prefixed codes case-insensitively, with surrounding space trimmed", () => {
    expect(parseCustomerCode("C-1042")).toBe(1042);
    expect(parseCustomerCode("c-1042")).toBe(1042);
    expect(parseCustomerCode("  C-1042 ")).toBe(1042);
  });
  it("rejects anything that isn't a customer code", () => {
    for (const bad of ["1042", "C-", "", null, undefined, 42, "C-abc", "X-1042"]) {
      expect(parseCustomerCode(bad)).toBe(null);
      expect(isValidCustomerCode(bad)).toBe(false);
    }
  });
});

describe("reserveNextCode — the shared /customers_meta/lastCode transaction", () => {
  it("bootstraps from null to STARTING_COUNTER + 1 (first code C-1001)", async () => {
    current = null;
    await expect(reserveNextCode()).resolves.toEqual({ counter: STARTING_COUNTER + 1, code: "C-1001" });
    expect(runTransactionMock.mock.calls[0][0].path).toBe("customers_meta/lastCode");
  });

  it("increments an existing counter", async () => {
    current = 1042;
    await expect(reserveNextCode()).resolves.toEqual({ counter: 1043, code: "C-1043" });
  });

  it("recovers from a corrupt or pre-start counter value", async () => {
    current = "abc";
    await expect(reserveNextCode()).resolves.toEqual({ counter: 1001, code: "C-1001" });
    current = 999; // below STARTING_COUNTER
    await expect(reserveNextCode()).resolves.toEqual({ counter: 1001, code: "C-1001" });
  });

  it("throws when the transaction does not commit (never hands out a phantom code)", async () => {
    commit = false;
    await expect(reserveNextCode()).rejects.toThrow(/did not commit/);
  });
});

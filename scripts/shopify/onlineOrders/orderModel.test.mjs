import { describe, it, expect } from "vitest";
import { holdRowsFor, sameHold, isIngestible, attentionFromLines, cents } from "./orderModel.mjs";

const line = (over = {}) => ({ pid: "P", sizeKey: "M", qty: 1, title: "Tee", size: "M", source: { locationId: "marathon-pe", status: "display" }, ...over });

describe("holdRowsFor", () => {
  it("sums every line of a pid/size and names where the units are", () => {
    const rows = holdRowsFor({ status: "picking", ref: "WEB-1", lines: [line(), line({ source: { locationId: "hub2", status: "pick" } }), line({ sizeKey: "L" })] });
    expect(rows).toEqual({
      "P/M": { qty: 2, ref: "WEB-1", locs: { "marathon-pe": 1, hub2: 1 } },
      "P/L": { qty: 1, ref: "WEB-1", locs: { "marathon-pe": 1 } },
    });
  });

  it("holds through needs_attention (a paid order waiting on a person still owns its units)", () => {
    expect(holdRowsFor({ status: "needs_attention", ref: "WEB-1", lines: [line()] })["P/M"].qty).toBe(1);
  });

  it("a packed or cancelled order holds nothing, whatever its lines say", () => {
    for (const status of ["packed", "cancelled"]) {
      expect(holdRowsFor({ status, ref: "WEB-1", lines: [line()] })).toEqual({});
    }
  });

  it("a no_stock unit is held (Shopify must not resell it) but in no location", () => {
    expect(holdRowsFor({ status: "needs_attention", ref: "WEB-1", lines: [line({ source: { status: "no_stock" } })] }))
      .toEqual({ "P/M": { qty: 1, ref: "WEB-1" } });
  });

  it("an unresolved line (no pid) and a cancelled line hold nothing", () => {
    expect(holdRowsFor({ status: "new", ref: "WEB-1", lines: [line({ pid: undefined }), line({ source: { status: "cancelled", locationId: "hub1" } })] })).toEqual({});
  });
});

describe("sameHold", () => {
  it("ignores `at` and key order, notices qty, ref and locations", () => {
    expect(sameHold({ qty: 1, ref: "A", locs: { a: 1, b: 2 }, at: 1 }, { qty: 1, ref: "A", locs: { b: 2, a: 1 } })).toBe(true);
    expect(sameHold({ qty: 1, ref: "A" }, { qty: 2, ref: "A" })).toBe(false);
    expect(sameHold({ qty: 1, ref: "A", locs: { a: 1 } }, { qty: 1, ref: "A", locs: { b: 1 } })).toBe(false);
    expect(sameHold(null, null)).toBe(true);
    expect(sameHold(null, { qty: 1 })).toBe(false);
  });
});

describe("isIngestible", () => {
  const ok = { displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED", cancelledAt: null };
  it("only paid, unfulfilled, not cancelled", () => {
    expect(isIngestible(ok)).toBe(true);
    expect(isIngestible({ ...ok, displayFinancialStatus: "PENDING" })).toBe(false);
    expect(isIngestible({ ...ok, displayFinancialStatus: "PARTIALLY_REFUNDED" })).toBe(false);
    expect(isIngestible({ ...ok, displayFulfillmentStatus: "FULFILLED" })).toBe(false);
    expect(isIngestible({ ...ok, cancelledAt: "2026-10-21T09:00:00Z" })).toBe(false);
  });
});

describe("attentionFromLines", () => {
  it("names every line that needs a person, kind from the first", () => {
    const a = attentionFromLines({ lines: [line(), line({ source: { status: "no_stock" } }), line({ title: "Cap", size: "_", source: { status: "not_found", locationId: "trophy" } })] }, 5);
    expect(a.kind).toBe("no_stock");
    expect(a.at).toBe(5);
    expect(a.reason).toContain("Tee size M ×1: no stock");
    expect(a.reason).toContain("Cap ×1: not found at Trophy");
  });
  it("is null when nothing needs a person", () => {
    expect(attentionFromLines({ lines: [line()] }, 1)).toBeNull();
  });
});

describe("cents", () => {
  it("reads Shopify money strings exactly", () => {
    expect(cents({ shopMoney: { amount: "199.99" } })).toBe(19999);
    expect(cents({ shopMoney: { amount: "0.10" } })).toBe(10);
    expect(cents(null)).toBe(0);
  });
});

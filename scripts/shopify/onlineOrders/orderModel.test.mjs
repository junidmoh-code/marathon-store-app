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

// ── One line = one unit (Junid, 20 Nov 2026) ────────────────────────────────
import { allocateCents, lineTotalCents, unitPieces, buildItemLines } from "./orderModel.mjs";

describe("one line per unit", () => {
  const item = (over = {}) => ({
    id: "gid://shopify/LineItem/7", title: "Nike T-shirt", variantTitle: "M", quantity: 2, currentQuantity: 2,
    variant: { id: "gid://shopify/ProductVariant/1", product: { id: "gid://shopify/Product/1" } },
    discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: "333.33" } }, ...over,
  });
  const resolved = { pid: "P", size: "M", sizeKey: "M", product: { name: "Nike T-shirt" }, isFootwear: false };

  it("allocateCents sums back exactly, the extra cents on the first units", () => {
    expect(allocateCents(100000, 3)).toEqual([33334, 33333, 33333]);
    expect(allocateCents(99999, 3)).toEqual([33333, 33333, 33333]);
    expect(allocateCents(5, 2)).toEqual([3, 2]);
    expect(allocateCents(500, 1)).toEqual([500]);
  });

  it("lineTotalCents takes the original total less every discount allocation, falling back to unit × qty", () => {
    expect(lineTotalCents(item({ originalTotalSet: { shopMoney: { amount: "700.00" } }, discountAllocations: [{ allocatedAmountSet: { shopMoney: { amount: "33.34" } } }] }))).toBe(66666);
    expect(lineTotalCents(item())).toBe(66666);
    // A unit removed on Shopify: the allocations cover the old quantity — unit price × what is left.
    expect(lineTotalCents(item({ quantity: 3, currentQuantity: 2, originalTotalSet: { shopMoney: { amount: "1050.00" } }, discountAllocations: [] }))).toBe(66666);
    // A total far from the unit price is not trusted.
    expect(lineTotalCents(item({ originalTotalSet: { shopMoney: { amount: "9000.00" } }, discountAllocations: [] }))).toBe(66666);
  });

  it("unitPieces turns every routed piece into qty-1 pieces in order", () => {
    expect(unitPieces([{ qty: 2, locationId: "marathon-pe", status: "display" }, { qty: 1, locationId: "hub2", status: "pick" }])).toEqual([
      { qty: 1, locationId: "marathon-pe", status: "display" }, { qty: 1, locationId: "marathon-pe", status: "display" }, { qty: 1, locationId: "hub2", status: "pick" },
    ]);
  });

  it("buildItemLines: a ×2 item is two qty-1 lines, same Shopify line, unit 1/2 and 2/2, cents summing to the line", () => {
    const lines = buildItemLines({ startIndex: 3, item: item({ discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: "333.335" } }, originalTotalSet: { shopMoney: { amount: "666.67" } }, discountAllocations: [] }), resolved, pieces: [{ qty: 2, locationId: "marathon-pe", status: "display" }] });
    expect(lines.map((l) => [l.lineId, l.qty, l.unit, l.units, l.shopifyLineItemId, l.unitPriceCents, l.source.locationId])).toEqual([
      ["l3", 1, 1, 2, "gid://shopify/LineItem/7", 33334, "marathon-pe"],
      ["l4", 1, 2, 2, "gid://shopify/LineItem/7", 33333, "marathon-pe"],
    ]);
  });

  it("buildItemLines: a ×1 item carries no unit fields; an unresolved ×2 item is two unresolved qty-1 lines", () => {
    const one = buildItemLines({ startIndex: 0, item: item({ quantity: 1, currentQuantity: 1 }), resolved, pieces: [{ qty: 1, locationId: "hub2", status: "pick" }] });
    expect(one).toHaveLength(1);
    expect(one[0].unit).toBeUndefined();
    expect(one[0].units).toBeUndefined();
    const lost = buildItemLines({ startIndex: 0, item: item(), resolved: { reason: "not linked" }, pieces: null });
    expect(lost.map((l) => [l.qty, l.unit, l.source.status])).toEqual([[1, 1, "unresolved"], [1, 2, "unresolved"]]);
  });
});

// MOVED HERE note (Junid, 26 Nov 2026)
import { movedNoteOf, hubOrderRecord as _hor, displayEntry as _de } from "./orderModel.mjs";
import { describe as _d, it as _it, expect as _ex } from "vitest";
_d("movedNoteOf", () => {
  _it("names the place a moved line came from, on the hub record and the strip entry", () => {
    const line = { pid: "p1", title: "Jersey", size: "S", sizeKey: "S", qty: 1, source: { status: "display", locationId: "marathon-pe", movedFrom: "concrete" } };
    _ex(movedNoteOf(line)).toBe("Moved here from Concrete");
    _ex(_de({ orderId: "1", order: { orderNumber: 2481 }, index: 2, line, checkId: "c", nowMs: 1, saDate: "2026-11-26", assignedTo: null }).movedNote).toBe("Moved here from Concrete");
    const hubLine = { ...line, source: { status: "pick", locationId: "hub1", movedFrom: "hub2" } };
    _ex(_hor({ key: "ABC", line: hubLine, onlineOrderId: "1", lineIndex: 0, section: 2, nowIso: "x" }).movedNote).toBe("Moved here from Hub 2");
  });
  _it("no note for a line that did not move", () => {
    _ex(movedNoteOf({ source: { locationId: "hub1" } })).toBe(null);
    _ex(movedNoteOf({ source: { locationId: "hub1", movedFrom: "hub1" } })).toBe(null);
  });
});

// refusalGuard.js — the transaction body behind "Out of Stock" on a request.
import { describe, it, expect } from "vitest";
import { alreadySent, refusalTxn } from "./refusalGuard";

const OPEN = { productId: "p", size: "M", qty: 2, requestingLocation: "hub2", status: "open", createdAt: "2026-09-23T06:00:00.000Z" };
const FIELDS = { status: "cancelled", resolvedAt: "2026-09-23T09:00:00.000Z", rejectedBy: "warehouse", cancelReason: null, resolvedBy: "u1" };

describe("alreadySent", () => {
  it("a fulfilled request, or one carrying fulfilledBy, has been sent", () => {
    expect(alreadySent({ ...OPEN, status: "fulfilled" })).toBe(true);
    expect(alreadySent({ ...OPEN, fulfilledBy: { movementId: "rrf_x", qty: 2 } })).toBe(true);
    // the live corrupted shape: cancelled over a real send
    expect(alreadySent({ ...OPEN, status: "cancelled", fulfilledBy: { movementId: "rrf_x", qty: 1 } })).toBe(true);
  });
  it("open, partly sent, withdrawn or missing is not", () => {
    expect(alreadySent(OPEN)).toBe(false);
    expect(alreadySent({ ...OPEN, qty: 1, sentQty: 1 })).toBe(false);
    expect(alreadySent({ ...OPEN, status: "cancelled", cancelReason: "no_longer_needed" })).toBe(false);
    expect(alreadySent(null)).toBe(false);
    expect(alreadySent({ ...OPEN, fulfilledBy: "junk" })).toBe(false);
  });
});

describe("refusalTxn", () => {
  it("probes with null on a cold cache (never aborts on the first pass)", () => {
    expect(refusalTxn(null, FIELDS)).toBeNull();
    expect(refusalTxn(undefined, FIELDS)).toBeNull();
  });
  it("aborts (undefined) on a sent request — nothing about it changes", () => {
    const sent = { ...OPEN, status: "fulfilled", fulfilledBy: { movementId: "rrf_x", qty: 2 }, resolvedBy: "u9" };
    const copy = JSON.parse(JSON.stringify(sent));
    expect(refusalTxn(sent, FIELDS)).toBeUndefined();
    expect(sent).toEqual(copy);
  });
  it("refuses an open request: sets the fields, deletes the nulls, keeps the rest", () => {
    const next = refusalTxn({ ...OPEN, cancelReason: "awaiting_upstream", sentQty: 1 }, FIELDS);
    expect(next).toEqual({ ...OPEN, sentQty: 1, status: "cancelled", resolvedAt: FIELDS.resolvedAt, rejectedBy: "warehouse", resolvedBy: "u1" });
    expect(next).not.toHaveProperty("cancelReason");
  });
  it("never mutates the value it was handed", () => {
    const cur = { ...OPEN };
    refusalTxn(cur, FIELDS);
    expect(cur).toEqual(OPEN);
  });
});

// ─── UNDOING A WALL-WALK REQUEST — WHAT MAY BE TAKEN BACK ────────────────────
// The undo deletes a real order out of the warehouse queue, so every refusal
// here is load-bearing. The two that matter most:
//
//   • THE WAREHOUSE HAS STARTED. Once the order is Ready somebody has picked a
//     pair off a shelf for it. Deleting it then leaves that pair in a hand with
//     nothing to say why, and the shelf count already moved.
//   • THE ID WAS RECYCLED. /orders ids reset with the daily counter, so an id
//     alone does not name an order — tomorrow's #42 is not today's. An undo
//     left on screen across midnight must not delete a stranger's order.

import { describe, it, expect } from "vitest";
import {
  canCancelDisplayRequest, CANCEL_GONE, CANCEL_NOT_OURS, CANCEL_STARTED,
} from "./displayRequestStore.js";

const AT = "2026-09-09T10:00:00.000Z";
const ours = (over = {}) => ({
  createdAt: AT, wallWalk: true, requestDisplayPartner: true,
  destShop: "trophy", status: "incoming",
  readyAt: null, collectedAt: null, outOfStockAt: null, comingTomorrowAt: null,
  ...over,
});
const expect_ = { createdAt: AT, store: "trophy" };

describe("canCancelDisplayRequest", () => {
  it("allows the undo it was written for", () => {
    expect(canCancelDisplayRequest(ours(), expect_)).toEqual({ ok: true });
  });

  it("an order that is already gone is not an error to shout about", () => {
    const r = canCancelDisplayRequest(null, expect_);
    expect(r.reason).toBe(CANCEL_GONE);
    expect(r.message).toContain("no longer there");
  });

  it("REFUSES A RECYCLED ID — tomorrow's #42 is not today's", () => {
    const r = canCancelDisplayRequest(ours({ createdAt: "2026-09-10T08:00:00.000Z" }), expect_);
    expect(r.reason).toBe(CANCEL_NOT_OURS);
    expect(r.message).toContain("different order");
  });

  it("…and refuses when the undo carries no stamp at all", () => {
    expect(canCancelDisplayRequest(ours(), { store: "trophy" }).reason).toBe(CANCEL_NOT_OURS);
  });

  it("refuses an order this walk did not raise", () => {
    expect(canCancelDisplayRequest(ours({ wallWalk: false }), expect_).reason).toBe(CANCEL_NOT_OURS);
    expect(canCancelDisplayRequest(ours({ requestDisplayPartner: false }), expect_).reason).toBe(CANCEL_NOT_OURS);
  });

  it("refuses another wall's request", () => {
    const r = canCancelDisplayRequest(ours({ destShop: "marathon-pe" }), expect_);
    expect(r.reason).toBe(CANCEL_NOT_OURS);
    expect(r.message).toContain("another wall");
  });

  it("THE WAREHOUSE HAS STARTED — every way that shows, it refuses", () => {
    for (const started of [
      { readyAt: AT }, { collectedAt: AT }, { outOfStockAt: AT }, { comingTomorrowAt: AT },
      { status: "ready" }, { status: "collected" },
    ]) {
      const r = canCancelDisplayRequest(ours(started), expect_);
      expect(r.reason, JSON.stringify(started)).toBe(CANCEL_STARTED);
      expect(r.message).toContain("already started");
    }
  });

  it("survives junk rather than deleting on it", () => {
    for (const v of [undefined, "order", 7, []]) {
      expect(canCancelDisplayRequest(v, expect_).ok).not.toBe(true);
    }
  });

  it("a store-less expectation still checks the stamp and the shape", () => {
    expect(canCancelDisplayRequest(ours(), { createdAt: AT })).toEqual({ ok: true });
    expect(canCancelDisplayRequest(ours({ wallWalk: false }), { createdAt: AT }).ok).toBe(false);
  });
});

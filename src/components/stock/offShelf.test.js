// ─── OFF-SHELF MATH — booked − known off-shelf = expected on shelf ───────────
// These pins ARE the count-integrity contract: a display at a shop lowers the
// shelf expectation by one; legacy storeless registrations count honestly as
// unverifiable; a slot supersedes the register row it was written beside (one
// physical display, never two); ready orders subtract; a cell with nothing
// off-shelf behaves exactly as before.

import { describe, it, expect, vi } from "vitest";

vi.mock("firebase/database", () => ({ ref: vi.fn(), child: vi.fn(), get: vi.fn(), update: vi.fn() }));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));

const { offShelfForCell, shelfLine, expectedOnShelf } = await import("./offShelf");

const labelOf = (s) => ({ "marathon-pe": "Marathon PE", trophy: "Trophy" }[s] || s);
const liveSlot = (over = {}) => ({ productId: "p1", size: "6", sizeKey: "6", bookedHub: "hub1", ...over });

describe("offShelfForCell", () => {
  it("the worked example: booked 2, one on display at PE → expect 1 on the shelf", () => {
    const sources = { slots: { "marathon-pe": { p1: liveSlot() } }, register: {}, readyCells: {} };
    const off = offShelfForCell({ hub: "hub1", productId: "p1", sizeKey: "6", sources, labelOf });
    expect(off.total).toBe(1);
    expect(off.parts[0]).toEqual({ qty: 1, label: "on display at Marathon PE", verified: true });
    expect(expectedOnShelf(2, off)).toBe(1);
  });

  it("legacy register row with no slot counts as shop-unknown (unverifiable)", () => {
    const sources = { slots: {}, register: { p1__6: { qty: 1 } }, readyCells: {} };
    const off = offShelfForCell({ hub: "hub1", productId: "p1", sizeKey: "6", sources, labelOf });
    expect(off.total).toBe(1);
    expect(off.parts[0].verified).toBe(false);
    expect(off.parts[0].label).toMatch(/shop unknown/);
  });

  it("a slot written beside its register row is ONE display, not two (max, not sum)", () => {
    const sources = {
      slots: { "marathon-pe": { p1: liveSlot() } },
      register: { p1__6: { qty: 1 } },
      readyCells: {},
    };
    const off = offShelfForCell({ hub: "hub1", productId: "p1", sizeKey: "6", sources, labelOf });
    expect(off.total).toBe(1);
    expect(off.parts).toHaveLength(1);
    expect(off.parts[0].verified).toBe(true); // the store-labelled fact wins
  });

  it("register qty above the slot count keeps the unexplained remainder", () => {
    const sources = {
      slots: { "marathon-pe": { p1: liveSlot() } },
      register: { p1__6: { qty: 2 } },       // two registered, one slot-explained
      readyCells: {},
    };
    const off = offShelfForCell({ hub: "hub1", productId: "p1", sizeKey: "6", sources, labelOf });
    expect(off.total).toBe(2);
    expect(off.parts.find((p) => !p.verified).qty).toBe(1);
  });

  it("ready orders awaiting collection subtract from the shelf", () => {
    const sources = { slots: {}, register: {}, readyCells: { "p1::6": [{ qty: 1, destShop: "trophy", orderId: "42" }] } };
    const off = offShelfForCell({ hub: "hub1", productId: "p1", sizeKey: "6", sources, labelOf });
    expect(off.total).toBe(1);
    expect(off.parts[0].label).toBe("awaiting collection at Trophy");
  });

  it("a cell with nothing off-shelf is untouched — zero subtraction, no parts", () => {
    const sources = { slots: {}, register: {}, readyCells: {} };
    const off = offShelfForCell({ hub: "hub1", productId: "p1", sizeKey: "6", sources, labelOf });
    expect(off.total).toBe(0);
    expect(off.parts).toHaveLength(0);
    expect(expectedOnShelf(5, off)).toBe(5);
  });

  it("sources for the WRONG cell never leak in", () => {
    const sources = {
      slots: { "marathon-pe": { p1: liveSlot({ sizeKey: "7", size: "7" }) } }, // different size
      register: { p1__8: { qty: 1 } },                                        // different size
      readyCells: { "p2::6": [{ qty: 1 }] },                                  // different product
    };
    const off = offShelfForCell({ hub: "hub1", productId: "p1", sizeKey: "6", sources, labelOf });
    expect(off.total).toBe(0);
  });
});

describe("shelfLine — the plain-warehouse-language breakdown", () => {
  it('reads "12 booked · 1 on display at Marathon PE · expect 11 here"', () => {
    const off = { total: 1, parts: [{ qty: 1, label: "on display at Marathon PE", verified: true }] };
    expect(shelfLine({ booked: 12, offShelf: off })).toBe("12 booked · 1 on display at Marathon PE · expect 11 here");
  });
  it("floors the display at zero when the books disagree", () => {
    const off = { total: 2, parts: [{ qty: 2, label: "registered as a display (shop unknown)", verified: false }] };
    expect(shelfLine({ booked: 1, offShelf: off })).toMatch(/expect 0 here/);
  });
});

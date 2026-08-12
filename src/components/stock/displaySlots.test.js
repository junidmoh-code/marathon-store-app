// ─── DISPLAY SLOTS — pure-helper behaviour pins ──────────────────────────────
// The count reads the slot's CURRENT state: these tests pin that a display
// changing size mid-count moves the off-shelf unit to the NEW size's cell with
// no re-walk of the floor, and that cleared slots stop counting entirely.

import { describe, it, expect, vi } from "vitest";

vi.mock("firebase/database", () => ({
  ref: vi.fn(), child: vi.fn(), get: vi.fn(), update: vi.fn(),
}));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));

const { slotIsLive, slotsForCell, liveSlotsForProduct } = await import("./displaySlots");

const liveSlot = (over = {}) => ({
  productId: "p1", productName: "Air Force 1", size: "6", sizeKey: "6",
  bookedHub: "hub1", source: "registration", at: "2026-08-12T08:00:00.000Z", by: "u1",
  ...over,
});

describe("slotIsLive", () => {
  it("live only when a real size is on the floor", () => {
    expect(slotIsLive(liveSlot())).toBe(true);
    expect(slotIsLive(liveSlot({ sizeKey: null, size: null }))).toBe(false);  // cleared tombstone
    expect(slotIsLive(liveSlot({ sizeKey: "_" }))).toBe(false);               // one-size sentinel is never a display
    expect(slotIsLive(null)).toBe(false);
  });
});

describe("slotsForCell — the count's off-shelf source", () => {
  const slots = {
    "marathon-pe": { p1: liveSlot() },
    trophy: { p1: liveSlot({ sizeKey: "8", size: "8" }), p2: liveSlot({ productId: "p2", bookedHub: "hub2" }) },
  };

  it("matches hub + product + size exactly", () => {
    expect(slotsForCell(slots, { hub: "hub1", productId: "p1", sizeKey: "6" })).toHaveLength(1);
    expect(slotsForCell(slots, { hub: "hub1", productId: "p1", sizeKey: "8" })).toHaveLength(1);
    expect(slotsForCell(slots, { hub: "hub2", productId: "p1", sizeKey: "6" })).toHaveLength(0); // other hub's books
    expect(slotsForCell(slots, { hub: "hub1", productId: "p2", sizeKey: "6" })).toHaveLength(0); // booked at hub2
  });

  it("a display that CHANGES SIZE mid-count is read at its current size", () => {
    // Size 6 sold at PE, size 7 replaced it: the slot now says 7.
    const after = { "marathon-pe": { p1: liveSlot({ sizeKey: "7", size: "7" }) } };
    expect(slotsForCell(after, { hub: "hub1", productId: "p1", sizeKey: "6" })).toHaveLength(0);
    expect(slotsForCell(after, { hub: "hub1", productId: "p1", sizeKey: "7" })).toHaveLength(1);
  });

  it("a cleared slot (display sold, nothing out) counts nowhere", () => {
    const cleared = { "marathon-pe": { p1: liveSlot({ sizeKey: null, size: null, source: "display_sold" }) } };
    expect(slotsForCell(cleared, { hub: "hub1", productId: "p1", sizeKey: "6" })).toHaveLength(0);
  });

  it("two stores can each hold one display of the same product+size", () => {
    const both = {
      "marathon-pe": { p1: liveSlot() },
      trophy: { p1: liveSlot() },
    };
    expect(slotsForCell(both, { hub: "hub1", productId: "p1", sizeKey: "6" })).toHaveLength(2);
  });
});

describe("liveSlotsForProduct", () => {
  it("lists every live slot for the product at the hub, any size", () => {
    const slots = {
      "marathon-pe": { p1: liveSlot({ sizeKey: "6" }) },
      trophy: { p1: liveSlot({ sizeKey: "9", size: "9" }) },
    };
    const out = liveSlotsForProduct(slots, { hub: "hub1", productId: "p1" });
    expect(out.map((s) => s.slot.sizeKey).sort()).toEqual(["6", "9"]);
  });
});

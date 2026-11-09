import { describe, it, expect } from "vitest";
import { normalizeNetwork } from "./networkRegistry";
import { keyInOrderRanges, tvOrderKeyRanges } from "./orderNumbering";
import { siblingOrderShop, mergeSharedOrders, withSharedRange, boardShowsOrder, tvSectionForShop } from "./sharedOrders";

const NET = normalizeNetwork(null);
const feed = (rows, extra = {}) => Object.assign(rows, { settled: true }, extra);

describe("siblingOrderShop", () => {
  it("Pine and Concrete are each other's sibling, by any spelling", () => {
    expect(siblingOrderShop(NET, "concrete")).toBe("marathon-pine");
    expect(siblingOrderShop(NET, "marathon-pine")).toBe("concrete");
    expect(siblingOrderShop(NET, "pine")).toBe("concrete");
  });
  it("Marathon PE, Trophy, a hub, no shop and an unknown shop have none", () => {
    for (const s of ["marathon-pe", "trophy", "hub3", null, undefined, "nowhere"]) expect(siblingOrderShop(NET, s)).toBe(null);
  });
});

describe("mergeSharedOrders", () => {
  it("no sibling rows: the same array back, so Marathon's feed is untouched", () => {
    const own = feed([{ id: "001" }]);
    expect(mergeSharedOrders(own, [])).toBe(own);
    expect(mergeSharedOrders(own, feed([]))).toBe(own);
    expect(mergeSharedOrders(own, undefined)).toBe(own);
  });
  it("both shops' orders, newest first", () => {
    const m = mergeSharedOrders(feed([{ id: "001", createdAt: "2026-11-09T08:00:00Z" }]), feed([{ id: "002", createdAt: "2026-11-09T09:00:00Z" }]));
    expect(m.map((o) => o.id)).toEqual(["002", "001"]);
  });
  it("one id once, and the shop's own copy wins", () => {
    const m = mergeSharedOrders(feed([{ id: "001", from: "own" }]), feed([{ id: "001", from: "sib" }]));
    expect(m).toHaveLength(1);
    expect(m[0].from).toBe("own");
  });
  it("settled and error are the shop's own feed's, whatever the sibling did", () => {
    const sib = Object.assign([{ id: "002" }], { settled: false, error: true });
    expect(mergeSharedOrders(feed([{ id: "001" }]), sib).settled).toBe(true);
    expect(mergeSharedOrders(feed([{ id: "001" }]), sib).error).toBe(undefined);
    expect(mergeSharedOrders(Object.assign([{ id: "001" }], { settled: false, error: true }), feed([{ id: "002" }]))).toMatchObject({ settled: false, error: true });
  });
});

describe("tvSectionForShop", () => {
  it("Pine and Concrete's in-app TV is Section 1's; everyone else's has no section, as before", () => {
    expect(tvSectionForShop(NET, "concrete")).toBe(1);
    expect(tvSectionForShop(NET, "marathon-pine")).toBe(1);
    for (const s of ["marathon-pe", "trophy", null, undefined]) expect(tvSectionForShop(NET, s)).toBe(2);
  });
});

describe("the Section 1 kiosk", () => {
  const ranges = withSharedRange(tvOrderKeyRanges(NET, 1), 1);
  it("reads plain keys as well as prefixed ones, never a refill cart", () => {
    for (const k of ["399", "P001", "C120"]) expect(keyInOrderRanges(k, ranges)).toBe(true);
    for (const k of ["R001-1", "RC014-2"]) expect(keyInOrderRanges(k, ranges)).toBe(false);
  });
  it("shows Pine and Concrete, not Marathon", () => {
    expect(boardShowsOrder(NET, 1, { destShop: "concrete" })).toBe(true);
    expect(boardShowsOrder(NET, 1, { destShop: "marathon-pine" })).toBe(true);
    expect(boardShowsOrder(NET, 1, { destShop: "marathon-pe" })).toBe(false);
    expect(boardShowsOrder(NET, 1, { destShop: "trophy" })).toBe(false);
    expect(boardShowsOrder(NET, 1, {})).toBe(false);
  });
  it("Section 2's board and a board with no section change nothing", () => {
    for (const s of [2, null]) {
      const r = tvOrderKeyRanges(NET, s);
      expect(withSharedRange(r, s)).toBe(r);
    }
    expect(boardShowsOrder(NET, null, { destShop: "concrete" })).toBe(true);
  });
});

describe("each TV board shows its own division's orders (Junid, 9 Nov 2026)", () => {
  it("Marathon's board: Marathon PE and Trophy only, Pine and Concrete gone", () => {
    expect(boardShowsOrder(NET, 2, { destShop: "marathon-pe" })).toBe(true);
    expect(boardShowsOrder(NET, 2, { destShop: "trophy" })).toBe(true);
    expect(boardShowsOrder(NET, 2, { destShop: "marathon-pine" })).toBe(false);
    expect(boardShowsOrder(NET, 2, { destShop: "concrete" })).toBe(false);
  });
  it("Pine and Concrete's board: their own only, Marathon's gone", () => {
    expect(boardShowsOrder(NET, 1, { destShop: "concrete" })).toBe(true);
    expect(boardShowsOrder(NET, 1, { destShop: "marathon-pe" })).toBe(false);
    expect(boardShowsOrder(NET, 1, { destShop: "trophy" })).toBe(false);
  });
  it("an order's section stamp decides when it has one, and the legacy Pine record reads as Pine", () => {
    expect(boardShowsOrder(NET, 2, { section: 1 })).toBe(false);
    expect(boardShowsOrder(NET, 1, { section: 1 })).toBe(true);
    expect(boardShowsOrder(NET, 2, { placedStore: "pine" })).toBe(false);
    expect(boardShowsOrder(NET, 2, { placedAtHub: "hub3" })).toBe(false);
    expect(boardShowsOrder(NET, 1, { placedAtHub: "hub3" })).toBe(true);
    expect(boardShowsOrder(NET, 2, { placedAtHub: "hub1" })).toBe(true);
  });
  it("a row naming no shop stays on Marathon's board, off Section 1's", () => {
    expect(boardShowsOrder(NET, 2, {})).toBe(true);
    expect(boardShowsOrder(NET, 2, { destShop: "unknown-shop" })).toBe(true);
    expect(boardShowsOrder(NET, 1, {})).toBe(false);
  });
  it("a board naming no section is unfiltered", () => {
    expect(boardShowsOrder(NET, null, { destShop: "concrete" })).toBe(true);
  });
});

// An order for a shop-held item books against the shop that holds it; only when
// the shop is out and Hub 3 holds it does it go to Hub 3 (Junid, 9 Nov 2026).
import { describe, it, expect } from "vitest";
import { shopHeldView, shopHeldBookings } from "./sectionSneakerHubs";
import { orderPlacementCheck, orderIsAtHub } from "./sectionRouting";
import { normalizeNetwork } from "./networkRegistry";

const NET = normalizeNetwork(null);
const state = (cells, settled = true, error = false) => ({ cells, settled, error });
const book = (lines, shelfCells, hubCells) => shopHeldBookings(lines, {
  shelf: "concrete", shelfCells, hubs: [{ id: "hub3", cells: hubCells }], isShopHeld: () => true,
});
const line = (size = "M", pid = "tee") => ({ product: { id: pid }, size });

describe("which location a shop-held line books against", () => {
  it("the shop while it holds the size", () => {
    const l = line();
    expect(book([l], { tee: { M: { qty: 1 } } }, { tee: { M: { qty: 9 } } }).get(l)).toBe("concrete");
  });
  it("Hub 3 only when the shop is out and Hub 3 holds it", () => {
    const l = line();
    expect(book([l], { tee: { M: { qty: 0 } } }, { tee: { M: { qty: 2 } } }).get(l)).toBe("hub3");
    expect(book([l], {}, { tee: { M: { qty: 2 } } }).get(l)).toBe("hub3");
  });
  it("neither holds it: the shop, so the submit guard refuses it there, never Hub 3", () => {
    const l = line();
    expect(book([l], { tee: { M: { qty: 0 } } }, { tee: { M: { qty: 0 } } }).get(l)).toBe("concrete");
  });
  it("counts each unit in the cart: the shelf first, then Hub 3", () => {
    const a = line(), b = line(), c = line(), d = line();
    const m = book([a, b, c, d], { tee: { M: { qty: 1 } } }, { tee: { M: { qty: 2 } } });
    expect([m.get(a), m.get(b), m.get(c), m.get(d)]).toEqual(["concrete", "hub3", "hub3", "concrete"]);
  });
  it("a size and a product are counted apart; half sizes read the decoded cell", () => {
    const a = line("M"), b = line("L"), c = line("M", "cap"), d = line("5.5", "cap");
    const m = book([a, b, c, d], { tee: { M: { qty: 1 } }, cap: { M: { qty: 1 }, "5.5": { qty: 1 } } }, {});
    expect([m.get(a), m.get(b), m.get(c), m.get(d)]).toEqual(["concrete", "concrete", "concrete", "concrete"]);
  });
  it("leaves every other line alone, and Marathon (no shelf) books nothing here", () => {
    const l = line();
    expect(shopHeldBookings([l], { shelf: "concrete", shelfCells: {}, hubs: [], isShopHeld: () => false }).has(l)).toBe(false);
    expect(shopHeldBookings([l], { shelf: null, shelfCells: {}, hubs: [], isShopHeld: () => true }).size).toBe(0);
  });
  it("a negative shelf cell is out, not a credit", () => {
    const l = line();
    expect(book([l], { tee: { M: { qty: -2 } } }, { tee: { M: { qty: 1 } } }).get(l)).toBe("hub3");
  });
});

describe("what the screen offers for a shop-held item", () => {
  it("adds the hub's units to the shelf and leaves the shelf's own state alone", () => {
    const shelf = state({ tee: { M: { qty: 1, v: 7 } } });
    const v = shopHeldView(shelf, [state({ tee: { M: { qty: 2 }, L: { qty: 3 } }, cap: { _: { qty: 1 } } })]);
    expect(v.cells.tee.M).toEqual({ qty: 3, v: 7 });
    expect(v.cells.tee.L.qty).toBe(3);
    expect(v.cells.cap._.qty).toBe(1);
    expect(shelf.cells.tee.M.qty).toBe(1);
  });
  it("a hub's empty or negative cell adds nothing and a shelf negative counts as none", () => {
    const v = shopHeldView(state({ tee: { M: { qty: -1 } } }), [state({ tee: { M: { qty: 2 }, L: { qty: 0 }, S: { qty: -4 } } })]);
    expect(v.cells.tee.M.qty).toBe(2);
    expect(v.cells.tee.L).toBeUndefined();
    expect(v.cells.tee.S).toBeUndefined();
  });
  it("is settled only when the shelf and every hub have answered, and errors with any of them", () => {
    expect(shopHeldView(state({}), [state({})]).settled).toBe(true);
    expect(shopHeldView(state({}), [state({}, false)]).settled).toBe(false);
    expect(shopHeldView(state({}, false), [state({})]).settled).toBe(false);
    expect(shopHeldView(state({}), [state({}, true, true)]).error).toBe(true);
    expect(shopHeldView(state({}, true, true), []).error).toBe(true);
  });
});

describe("an order booked against the shop", () => {
  it("passes the placement wall and is not on any hub's queue", () => {
    expect(orderPlacementCheck(NET, { hub: "concrete", destShop: "concrete" }).ok).toBe(true);
    expect(orderPlacementCheck(NET, { hub: "marathon-pine", destShop: "marathon-pine" }).ok).toBe(true);
    const o = { hub: "concrete", placedAtHub: "concrete", destShop: "concrete" };
    for (const h of ["hub1", "hub2", "hub3"]) expect(orderIsAtHub(NET, o, h)).toBe(false);
  });
});

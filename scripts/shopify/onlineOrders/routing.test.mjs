import { describe, it, expect } from "vitest";
import { routeLine, routeLines, availableAt, ROUTED_LOCATIONS } from "./routing.mjs";

const pick = (locationId, qty = 1) => ({ qty, locationId, status: "pick" });
const display = (locationId, qty = 1) => ({ qty, locationId, status: "display" });
const none = (qty = 1) => ({ qty, locationId: null, status: "no_stock" });

describe("routeLine — footwear and slides", () => {
  it("hub1 when it has the size", () => {
    expect(routeLine({ qty: 1, isFootwear: true, available: { hub1: 1, hub2: 5 } })).toEqual([pick("hub1")]);
  });
  it("hub2 when hub1 does not", () => {
    expect(routeLine({ qty: 1, isFootwear: true, available: { hub1: 0, hub2: 2 } })).toEqual([pick("hub2")]);
  });
  it("never a shop, even when a shop shows units", () => {
    expect(routeLine({ qty: 1, isFootwear: true, available: { "marathon-pe": 3, trophy: 3 } })).toEqual([none()]);
  });
  it("no_stock when neither hub has it", () => {
    expect(routeLine({ qty: 1, isFootwear: true, available: {} })).toEqual([none()]);
  });
  it("qty 2 with one at hub1 splits hub1 ×1 then hub2 ×1", () => {
    expect(routeLine({ qty: 2, isFootwear: true, available: { hub1: 1, hub2: 4 } })).toEqual([pick("hub1"), pick("hub2")]);
  });
  it("qty 2 both at hub1 stays one line", () => {
    expect(routeLine({ qty: 2, isFootwear: true, available: { hub1: 2 } })).toEqual([pick("hub1", 2)]);
  });
  it("qty 3, one at each hub, leaves the third as no_stock", () => {
    expect(routeLine({ qty: 3, isFootwear: true, available: { hub1: 1, hub2: 1 } })).toEqual([pick("hub1"), pick("hub2"), none()]);
  });
});

describe("routeLine — everything else", () => {
  it("Marathon PE first", () => {
    expect(routeLine({ qty: 1, isFootwear: false, available: { "marathon-pe": 1, trophy: 1, hub2: 1 } })).toEqual([display("marathon-pe")]);
  });
  it("Trophy when PE has none", () => {
    expect(routeLine({ qty: 1, isFootwear: false, available: { trophy: 2, hub2: 1 } })).toEqual([display("trophy")]);
  });
  it("Hub 2 as a pick when neither shop has it", () => {
    expect(routeLine({ qty: 1, isFootwear: false, available: { hub2: 1 } })).toEqual([pick("hub2")]);
  });
  it("never hub1 (sneakers only)", () => {
    expect(routeLine({ qty: 1, isFootwear: false, available: { hub1: 9 } })).toEqual([none()]);
  });
  it("no_stock when nowhere has it", () => {
    expect(routeLine({ qty: 1, isFootwear: false, available: {} })).toEqual([none()]);
  });
  it("qty 2 with one at PE: PE ×1 then Trophy ×1", () => {
    expect(routeLine({ qty: 2, isFootwear: false, available: { "marathon-pe": 1, trophy: 1 } })).toEqual([display("marathon-pe"), display("trophy")]);
  });
  it("qty 2 with one at PE and none at Trophy: PE ×1 then Hub 2 ×1", () => {
    expect(routeLine({ qty: 2, isFootwear: false, available: { "marathon-pe": 1, hub2: 3 } })).toEqual([display("marathon-pe"), pick("hub2")]);
  });
  it("qty 4 across all three, remainder no_stock", () => {
    expect(routeLine({ qty: 4, isFootwear: false, available: { "marathon-pe": 1, trophy: 1, hub2: 1 } }))
      .toEqual([display("marathon-pe"), display("trophy"), pick("hub2"), none()]);
  });
  it("quantities always sum to the order quantity", () => {
    for (let qty = 1; qty <= 6; qty++) {
      const pieces = routeLine({ qty, isFootwear: false, available: { "marathon-pe": 1, trophy: 2, hub2: 1 } });
      expect(pieces.reduce((n, p) => n + p.qty, 0)).toBe(qty);
      expect(new Set(pieces.map((p) => p.locationId)).size).toBe(pieces.length);
    }
  });
  it("treats negative and junk availability as nothing", () => {
    expect(routeLine({ qty: 1, isFootwear: false, available: { "marathon-pe": -2, trophy: "x", hub2: NaN } })).toEqual([none()]);
  });
  it("routes nothing for a zero quantity", () => {
    expect(routeLine({ qty: 0, isFootwear: false, available: { "marathon-pe": 1 } })).toEqual([]);
  });
});

describe("routeLines — one availability picture per order", () => {
  it("two lines of the same pid/size cannot both take the last unit", () => {
    const out = routeLines(
      [{ key: "p|M", qty: 1, isFootwear: false }, { key: "p|M", qty: 1, isFootwear: false }],
      { "p|M": { "marathon-pe": 1, trophy: 1 } },
    );
    expect(out).toEqual([[display("marathon-pe")], [display("trophy")]]);
  });
  it("different sizes do not share a pool", () => {
    const out = routeLines(
      [{ key: "p|M", qty: 1, isFootwear: false }, { key: "p|L", qty: 1, isFootwear: false }],
      { "p|M": { "marathon-pe": 1 }, "p|L": { "marathon-pe": 1 } },
    );
    expect(out).toEqual([[display("marathon-pe")], [display("marathon-pe")]]);
  });
  it("does not mutate the caller's picture", () => {
    const available = { "p|M": { "marathon-pe": 1 } };
    routeLines([{ key: "p|M", qty: 1, isFootwear: false }], available);
    expect(available).toEqual({ "p|M": { "marathon-pe": 1 } });
  });
});

describe("availableAt — live cells minus other orders' holds", () => {
  it("subtracts other orders' units at that location only", () => {
    const a = availableAt({
      stockQty: { "marathon-pe": 2, trophy: 1, hub1: 3, hub2: 0 },
      holdsCell: { o1: { qty: 1, locs: { "marathon-pe": 1 } }, o2: { qty: 2, locs: { hub1: 2 } } },
      orderId: "o9",
    });
    expect(a).toEqual({ hub1: 1, hub2: 0, "marathon-pe": 1, trophy: 1 });
  });
  it("never counts the order's own hold against it", () => {
    const a = availableAt({ stockQty: { "marathon-pe": 1 }, holdsCell: { o1: { qty: 1, locs: { "marathon-pe": 1 } } }, orderId: "o1" });
    expect(a["marathon-pe"]).toBe(1);
  });
  it("floors at zero when holds exceed the cell", () => {
    const a = availableAt({ stockQty: { "marathon-pe": 1 }, holdsCell: { o1: { locs: { "marathon-pe": 3 } } } });
    expect(a["marathon-pe"]).toBe(0);
  });
  it("covers exactly the routed locations", () => {
    expect(Object.keys(availableAt({})).sort()).toEqual([...ROUTED_LOCATIONS].sort());
  });
});

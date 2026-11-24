import { describe, it, expect } from "vitest";
import { owedByCentral, owedBySize, centralSize, cardFigure, figureChanged, productAtCentral, owedIndex } from "./missingFigures";

const cells = { 8: { qty: 5 }, "8.5": { qty: 3 }, 9: { qty: 0 }, 10: { qty: -2 } };
const req = (o) => ({ productId: "p1", size: "8", qty: 2, status: "open", requestingLocation: "hub1", createdFrom: { source: "central" }, ...o });

describe("what a Central figure counts", () => {
  it("an open request owes its qty less what was sent; shadows, closed and hub-sourced requests owe nothing", () => {
    expect(owedByCentral(req({ qty: 5, sentQty: 2 }))).toBe(3);
    expect(owedByCentral(req({ shadow: true }))).toBe(0);
    expect(owedByCentral(req({ status: "fulfilled" }))).toBe(0);
    expect(owedByCentral(req({ requestingLocation: "trophy", createdFrom: { source: "hub2" } }))).toBe(0);
    expect(owedByCentral(req({ requestingLocation: "trophy", createdFrom: null }), { trophy: "hub2" })).toBe(0);
    expect(owedByCentral(req({ requestingLocation: "hub3", createdFrom: null }), {})).toBe(2);   // unrouted hub → Central
  });
  it("free = on hand − owed, floored per size; 5.5-style sizes key the same on both sides", () => {
    const owed = owedBySize([req({ qty: 4 }), req({ size: "8.5", qty: 1 }), req({ size: "9", qty: 3 })], "p1");
    expect(owed).toEqual({ 8: 4, "8_5": 1, 9: 3 });
    expect(centralSize(cells, owed, "8")).toEqual({ onHand: 5, owed: 4, free: 1 });
    expect(centralSize(cells, owed, "8.5")).toEqual({ onHand: 3, owed: 1, free: 2 });
    expect(centralSize(cells, owed, "9")).toEqual({ onHand: 0, owed: 3, free: 0 });
    expect(centralSize(cells, owed, "10").onHand).toBe(0);                       // a negative cell is 0
  });
  it("THE SIZES ADD UP TO THE TOTAL, exactly, whatever the data", () => {
    for (let i = 0; i < 300; i++) {
      const c = {}, rs = [];
      for (const s of ["6", "7", "7.5", "8", "9"]) { c[s] = { qty: Math.floor(Math.random() * 7) - 1 }; if (Math.random() < 0.6) rs.push(req({ size: s, qty: Math.floor(Math.random() * 6), sentQty: Math.floor(Math.random() * 3), shadow: Math.random() < 0.1 })); }
      const row = { dests: [{ sizes: ["6", "7.5"] }, { sizes: ["7.5", "8", "9"] }] };
      const f = cardFigure(row, c, owedBySize(rs, "p1"));
      expect(f.total).toBe(f.sizes.reduce((t, s) => t + s.free, 0));
      expect(f.sizes.map((s) => s.size)).toEqual(["6", "7.5", "8", "9"]);         // each size once
      expect(f.sizes.every((s) => s.free >= 0 && s.free <= s.onHand)).toBe(true);
    }
  });
  it("a change in any size is a change, even when the total is the same", () => {
    const row = { dests: [{ sizes: ["8", "9"] }] };
    const a = { cells: { 8: { qty: 2 }, 9: { qty: 1 } }, owed: {} };
    const b = { cells: { 8: { qty: 1 }, 9: { qty: 2 } }, owed: {} };
    expect(figureChanged(row, a, a)).toBe(null);
    expect(figureChanged(row, a, b)).toMatchObject({ was: { total: 3 }, now: { total: 3 } });
  });
  it("Not listed: the product's free and promised units at Central", () => {
    const idx = owedIndex([req({ qty: 7 }), req({ productId: "p2", qty: 1 })]);
    expect(productAtCentral(cells, idx.get("p1"))).toEqual({ onHand: 8, owed: 5, free: 3 });
    expect(idx.get("p2")).toEqual({ 8: 1 });
  });
});

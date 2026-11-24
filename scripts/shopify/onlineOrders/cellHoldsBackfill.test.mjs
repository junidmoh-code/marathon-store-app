// The back-fill plan (cell-holds.mjs): only shelves still exactly as they were
// when they rejected a website pick are held.
import { describe, it, expect } from "vitest";
import { planBackfill, deadHolds, prunableHolds, KEEP_DEAD_HOLD_MS } from "./cell-holds.mjs";

const T = Date.parse("2026-11-10T09:00:00Z");
const rej = (over = {}) => ({ pid: "P", sizeKey: "8", loc: "hub1", at: T, kind: "hub_out_of_stock", orderId: "9001", line: 0, order: "#2001", product: "Air Runner", ...over });
const cell = (qty, at) => ({ qty, updatedAt: new Date(at).toISOString() });

describe("planBackfill", () => {
  it("holds a shelf that still shows the piece and has not moved since the rejection", () => {
    const { write } = planBackfill([rej()], { "P|8|hub1": cell(2, T - 864e5) });
    expect(write).toHaveLength(1);
    expect(write[0]).toMatchObject({ path: "online_cell_holds/P/8/hub1", qty: 2, value: { at: T, kind: "hub_out_of_stock", orderId: "9001", line: 0, qty: 2 } });
  });
  it("leaves a shelf that has moved since (trusted again) or is already empty", () => {
    const { write, skipped } = planBackfill([rej(), rej({ sizeKey: "9" })], { "P|8|hub1": cell(2, T + 1), "P|9|hub1": cell(0, T - 1) });
    expect(write).toEqual([]);
    expect(skipped).toMatchObject({ moved: 1, empty: 1 });
  });
  it("one hold per shelf, stamped with its LATEST rejection", () => {
    const { write } = planBackfill([rej(), rej({ at: T + 5000, orderId: "9002" }), rej({ at: T - 5000 })], { "P|8|hub1": cell(1, T - 864e5) });
    expect(write).toHaveLength(1);
    expect(write[0].value).toMatchObject({ at: T + 5000, orderId: "9002" });
  });
  it("never replaces a newer standing hold the poller wrote", () => {
    const { write, skipped } = planBackfill([rej()], { "P|8|hub1": cell(1, T - 864e5) }, { "P|8|hub1": { at: T + 60e3, kind: "hub_out_of_stock" } });
    expect(write).toEqual([]);
    expect(skipped.held).toBe(1);
  });
  it("a size key that cannot be a path segment is skipped, not written", () => {
    const { write, skipped } = planBackfill([rej({ sizeKey: "5.5" })], { "P|5.5|hub1": cell(1, T - 1) });
    expect(write).toEqual([]);
    expect(skipped.unkeyable).toBe(1);
  });
});

describe("deadHolds", () => {
  it("a hold is dead once its cell moved or emptied", () => {
    const rows = [
      { pid: "P", sizeKey: "8", loc: "hub1", hold: { at: T }, cell: cell(1, T - 1) },
      { pid: "P", sizeKey: "9", loc: "hub1", hold: { at: T }, cell: cell(1, T + 1) },
      { pid: "P", sizeKey: "7", loc: "hub1", hold: { at: T }, cell: null },
    ];
    expect(deadHolds(rows).map((r) => r.sizeKey)).toEqual(["9", "7"]);
  });
});

describe("the nightly tidy-up keeps a dead hold for a while: it is the router's note that the shelf rejected a website pick lately", () => {
  const NOW = Date.parse("2026-11-24T10:00:00Z");
  const moved = (at) => ({ pid: "p", sizeKey: "M", loc: "hub1", hold: { at }, cell: { qty: 1, updatedAt: new Date(at + 1000).toISOString() } });
  it("ended rows older than 45 days go; newer ended rows and standing rows stay", () => {
    const old = moved(NOW - KEEP_DEAD_HOLD_MS - 1), recent = moved(NOW - 3 * 864e5), edge = moved(NOW - KEEP_DEAD_HOLD_MS);
    const standing = { pid: "p", sizeKey: "L", loc: "hub1", hold: { at: NOW - 90 * 864e5 }, cell: { qty: 2, updatedAt: new Date(NOW - 100 * 864e5).toISOString() } };
    expect(prunableHolds([old, recent, edge, standing], NOW)).toEqual([old, edge]);
    expect(KEEP_DEAD_HOLD_MS).toBe(45 * 864e5);
  });
});

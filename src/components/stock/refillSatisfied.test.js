// Tests for the client half of the satisfied-request rule (refillSatisfied.js).
//
// This is what stops the Hub 1 / Hub 2 refill queue showing work the shelf has
// already answered. The durable withdrawal lives in the engine
// (functions/test/refill-satisfied.test.cjs); these pin that the queue's view
// agrees with it — same allocation, same tie-break, same floor-at-zero rule.
import { describe, it, expect } from "vitest";
import { partitionSatisfied, onHandFor } from "./refillSatisfied.js";

// useStockCells() DECODES size keys, so a client-side cell map is keyed by the
// raw size ("5.5"), not the stored key ("5_5"). The fixtures use that shape.
const cells = (map) => Object.fromEntries(Object.entries(map).map(([k, qty]) => [k, { qty, v: 1 }]));
const req = (over = {}) => ({
  id: "r1", productId: "boot", size: "7", qty: 2,
  requestingLocation: "hub1", status: "open",
  createdAt: "2026-08-06T20:50:09.106Z", ...over,
});
const ids = (rows) => rows.map((r) => r.id);

describe("onHandFor", () => {
  it("reads the cell for a size", () => {
    expect(onHandFor(cells({ 7: 3, 8: 1 }), "7")).toBe(3);
  });
  it("floors a negative (oversold) cell at zero — never available stock", () => {
    expect(onHandFor(cells({ 7: -3 }), "7")).toBe(0);
  });
  it("returns 0 for an absent cell or product", () => {
    expect(onHandFor(cells({ 7: 3 }), "9")).toBe(0);
    expect(onHandFor(undefined, "7")).toBe(0);
  });
  it("ignores the _meta child", () => {
    expect(onHandFor({ _meta: { anything: 1 }, 7: { qty: 2 } }, "7")).toBe(2);
  });
  it("matches a half size across encodings", () => {
    // decoded "5.5" on the cell, request carries "5.5" — and a numeric 5.5 must
    // find the same cell rather than silently reading zero.
    expect(onHandFor(cells({ "5.5": 2 }), "5.5")).toBe(2);
    expect(onHandFor(cells({ "5.5": 2 }), 5.5)).toBe(2);
  });
  it("folds the one-size sentinel and its 'Free Size' label onto one cell", () => {
    // The Free_Size phantom-cell class of bug: the label must never get a cell
    // of its own — real one-size stock lives in "_".
    expect(onHandFor(cells({ _: 4 }), "Free Size")).toBe(4);
    expect(onHandFor(cells({ _: 4 }), "")).toBe(4);
    expect(onHandFor(cells({ _: 4 }), null)).toBe(4);
  });
});

describe("partitionSatisfied", () => {
  it("covers a request whose destination cell already holds enough", () => {
    const { actionable, covered } = partitionSatisfied([req()], { boot: cells({ 7: 3 }) });
    expect(ids(actionable)).toEqual([]);
    expect(ids(covered)).toEqual(["r1"]);
    expect(covered[0].onHand).toBe(3);
  });

  it("keeps a still-genuinely-short request as work", () => {
    // the live size-10 case: asked 2, one left on the shelf
    const { actionable, covered } = partitionSatisfied(
      [req({ id: "r10", size: "10", qty: 2 })], { boot: cells({ 10: 1 }) });
    expect(ids(actionable)).toEqual(["r10"]);
    expect(ids(covered)).toEqual([]);
  });

  it("keeps a request against an empty cell", () => {
    const { actionable } = partitionSatisfied([req()], { boot: cells({ 7: 0 }) });
    expect(ids(actionable)).toEqual(["r1"]);
  });

  it("never treats a negative cell as covered", () => {
    const { actionable } = partitionSatisfied([req({ qty: 1 })], { boot: cells({ 7: -3 }) });
    expect(ids(actionable)).toEqual(["r1"]);
  });

  it("gives one pair to one request — siblings on a cell cannot both be retired", () => {
    // 3 on hand, two asks of 2. Retiring both would tell Central a size still
    // needing a pair was fully handled.
    const { actionable, covered } = partitionSatisfied([
      req({ id: "newer", createdAt: "2026-08-06T21:10:00.000Z" }),
      req({ id: "older", createdAt: "2026-08-06T20:50:00.000Z" }),
    ], { boot: cells({ 7: 3 }) });
    expect(ids(covered)).toEqual(["older"]);
    expect(ids(actionable)).toEqual(["newer"]);
  });

  it("is order-independent — input order cannot change the split", () => {
    const rows = [
      req({ id: "b", createdAt: "2026-08-06T21:10:00.000Z" }),
      req({ id: "a", createdAt: "2026-08-06T20:50:00.000Z" }),
    ];
    const one = partitionSatisfied(rows, { boot: cells({ 7: 3 }) });
    const two = partitionSatisfied([...rows].reverse(), { boot: cells({ 7: 3 }) });
    expect(ids(one.covered)).toEqual(ids(two.covered));
    expect(ids(one.actionable)).toEqual(ids(two.actionable));
  });

  it("breaks a createdAt tie on the id, deterministically", () => {
    // The engine stamps a whole run with ONE createdAt, so identical timestamps
    // are the normal case. Without the tie-break the split could flip on rerender.
    const rows = [req({ id: "bbb" }), req({ id: "aaa" })];
    expect(ids(partitionSatisfied(rows, { boot: cells({ 7: 2 }) }).covered)).toEqual(["aaa"]);
    expect(ids(partitionSatisfied([...rows].reverse(), { boot: cells({ 7: 2 }) }).covered)).toEqual(["aaa"]);
  });

  it("keeps different sizes of one product independent", () => {
    const { actionable, covered } = partitionSatisfied([
      req({ id: "s7", size: "7", qty: 2 }),
      req({ id: "s8", size: "8", qty: 2 }),
    ], { boot: cells({ 7: 3, 8: 1 }) });
    expect(ids(covered)).toEqual(["s7"]);
    expect(ids(actionable)).toEqual(["s8"]);
  });

  it("keeps different products independent", () => {
    const { covered, actionable } = partitionSatisfied([
      req({ id: "a", productId: "boot" }),
      req({ id: "b", productId: "other" }),
    ], { boot: cells({ 7: 4 }) });
    expect(ids(covered)).toEqual(["a"]);
    expect(ids(actionable)).toEqual(["b"]);
  });

  it("treats a missing qty as one unit", () => {
    const { covered } = partitionSatisfied([req({ qty: undefined })], { boot: cells({ 7: 1 }) });
    expect(ids(covered)).toEqual(["r1"]);
  });

  it("skips malformed rows rather than guessing", () => {
    const { actionable, covered } = partitionSatisfied(
      [null, { id: "x" }, { id: "y", productId: "boot" }], { boot: cells({ 7: 9 }) });
    expect(covered).toEqual([]);
    expect(actionable).toEqual([]);
  });

  it("covers nothing when the destination has no stock node at all", () => {
    const { actionable, covered } = partitionSatisfied([req()], {});
    expect(ids(actionable)).toEqual(["r1"]);
    expect(covered).toEqual([]);
  });
});

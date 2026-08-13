import { describe, it, expect } from "vitest";
import { seedCellUntouched, solveUndoBlockers, undoUpdate } from "./solveUndo";

// The exact cell a Solve writes — copied from the live incident this module
// was born from (LV bag → Marathon PE, 2026-08-13 17:20:40Z).
const SEED = { lastType: "count", mv: "seed", qty: 0, state: "live", updatedAt: "2026-08-13T17:20:40.110Z", updatedBy: "someUid", v: 0 };
const SOLVED_AT = Date.parse("2026-08-13T17:20:40.110Z");

describe("seedCellUntouched — the only state an undo may delete", () => {
  it("accepts the exact untouched seed", () => {
    expect(seedCellUntouched(SEED)).toBe(true);
  });
  it("refuses the moment anything real lands on the cell", () => {
    expect(seedCellUntouched({ ...SEED, qty: 1 })).toBe(false);                       // stock arrived
    expect(seedCellUntouched({ ...SEED, v: 1 })).toBe(false);                          // any versioned write
    expect(seedCellUntouched({ ...SEED, mv: "sold:xyz" })).toBe(false);                // movement replaced the marker
    expect(seedCellUntouched(null)).toBe(false);
    expect(seedCellUntouched(undefined)).toBe(false);
  });
});

describe("solveUndoBlockers — every refusal is a sentence, silence means safe", () => {
  const paths = ["stock/marathon-pe/p1/_", "stock/hub2/p1/_"];
  const untouched = { [paths[0]]: { ...SEED }, [paths[1]]: { ...SEED } };

  it("clean seed pair, no engine work → no blockers", () => {
    expect(solveUndoBlockers({ cellsByPath: untouched, openByLoc: { "marathon-pe": null, hub2: null }, solvedAtMs: SOLVED_AT })).toEqual([]);
  });
  it("a touched cell blocks, and the sentence points at Adjust, not at deleting history", () => {
    const b = solveUndoBlockers({ cellsByPath: { ...untouched, [paths[0]]: { ...SEED, qty: 2, v: 1, mv: "recv" } }, openByLoc: {}, solvedAtMs: SOLVED_AT });
    expect(b.length).toBe(1);
    expect(b[0]).toMatch(/touched since the solve/);
    expect(b[0]).toMatch(/Adjust/);
  });
  it("a cell already gone blocks (nothing to undo)", () => {
    const b = solveUndoBlockers({ cellsByPath: { ...untouched, [paths[1]]: null }, openByLoc: {}, solvedAtMs: SOLVED_AT });
    expect(b.length).toBe(1);
    expect(b[0]).toMatch(/already gone/);
  });
  it("an engine intent raised AFTER the solve blocks and names the queue and order", () => {
    const b = solveUndoBlockers({
      cellsByPath: untouched,
      openByLoc: { hub2: { _: { createdAt: "2026-08-13T17:45:04.829Z", qty: 3, orderId: "R036-99" } } },
      solvedAtMs: SOLVED_AT,
    });
    expect(b.length).toBe(1);
    expect(b[0]).toMatch(/reject it in the queue first/);
    expect(b[0]).toMatch(/R036-99/);
  });
  it("an intent that PREDATES the solve does NOT block — it existed without the cell", () => {
    // The live LV bag carried exactly this: a 16:45 hub2 intent armed by a
    // target row, an hour before the 17:20 mistaken solve. Deleting the seed
    // restores the state that intent already lived in.
    const b = solveUndoBlockers({
      cellsByPath: untouched,
      openByLoc: { hub2: { _: { createdAt: "2026-08-13T16:45:04.829Z", qty: 3 } } },
      solvedAtMs: SOLVED_AT,
    });
    expect(b).toEqual([]);
  });
  it("an intent with no parseable createdAt does not block (never guess history)", () => {
    const b = solveUndoBlockers({ cellsByPath: untouched, openByLoc: { hub2: { _: { qty: 1 } } }, solvedAtMs: SOLVED_AT });
    expect(b).toEqual([]);
  });
});

describe("undoUpdate — deletes exactly the recorded paths, nothing else", () => {
  it("null at each path", () => {
    expect(undoUpdate(["a/b", "c/d"])).toEqual({ "a/b": null, "c/d": null });
  });
  it("empty and falsy filtered", () => {
    expect(undoUpdate([])).toEqual({});
    expect(undoUpdate(null)).toEqual({});
    expect(undoUpdate(["x", null, ""])).toEqual({ x: null });
  });
});

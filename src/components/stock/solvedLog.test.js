import { describe, it, expect } from "vitest";
import { buildSolveLogEntry, buildConcreteLogEntry, normalizeSolvedEntry, mergeSolved, slimPriorOpen, newSolvedKey, undoneUpdate, standing, SOLVED_ROOT } from "./solvedLog";
import { undoablePaths } from "./solveSections";

const AT = 1795200000000;
const ENTRY = {
  key: "k1", pid: "p1", name: "Tee", store: "trophy", locs: ["hub2", "trophy"],
  paths: ["stock/hub2/p1/S", "stock/trophy/p1/S"],
  priorOpen: { hub2: { S: { refillId: "r9", runId: "run1", createdAt: "x", qty: 3, other: "big" } }, trophy: null },
  firstBatch: { solveId: "s1", requestIds: ["req1"], store: "trophy", units: 2 },
};

describe("solved log rows", () => {
  it("a solve row keeps exactly what Undo needs; lock identities only", () => {
    const r = buildSolveLogEntry(ENTRY, { at: AT, by: "u1", byName: "Junid", msg: "2 units…", division: 2 });
    expect(r).toMatchObject({ kind: "solve", pid: "p1", store: "trophy", locs: ["hub2", "trophy"], paths: ENTRY.paths, at: AT, by: "u1", status: "done", division: 2 });
    expect(r.priorOpen).toEqual({ hub2: { S: { refillId: "r9", runId: "run1", createdAt: "x" } } });
    expect(r.firstBatch).toEqual({ solveId: "s1", requestIds: ["req1"], store: "trophy", units: 2 });
  });
  it("a concrete row", () => {
    expect(buildConcreteLogEntry({ pid: "p1", name: "Tee", at: AT, by: "u1" })).toMatchObject({ kind: "concrete", pid: "p1", status: "done" });
  });
  it("refuses a row without a server time", () => {
    expect(() => buildConcreteLogEntry({ pid: "p1", at: 0 })).toThrow();
  });
  it("read back from REAL RTDB (empty arrays and nulls dropped) it is whole again", () => {
    const raw = { kind: "solve", pid: "p1", name: "Tee", at: AT, by: "u1", status: "done", store: "trophy", firstBatch: { solveId: "s1", store: "trophy", units: 0 } };
    const e = normalizeSolvedEntry("k1", raw);
    expect(e.paths).toEqual([]);
    expect(e.locs).toEqual([]);
    expect(e.firstBatch.requestIds).toEqual([]);
    expect(e.priorOpen).toEqual({});
    expect(undoablePaths(e, [])).toEqual([]);
  });
  it("arrays stored as objects (RTDB's sparse-array shape) are restored too", () => {
    expect(normalizeSolvedEntry("k", { paths: { 0: "a", 1: "b" } }).paths).toEqual(["a", "b"]);
  });
  it("newest first; a session row never doubles a saved one", () => {
    const a = { key: "a", at: 1 }, b = { key: "b", at: 3 }, c = { key: "c", at: 2 };
    expect(mergeSolved([a, b], [b, c]).map((x) => x.key)).toEqual(["b", "c", "a"]);
  });
  it("keys sort by time", () => {
    const k1 = newSolvedKey(AT, () => 0.9), k2 = newSolvedKey(AT + 1, () => 0.1);
    expect(k1 < k2).toBe(true);
    expect(k1).toMatch(/^k\d{14}[a-z0-9]{6}$/);
  });
  it("undone + standing", () => {
    expect(undoneUpdate("k1", { at: AT, by: "u" })).toEqual({ [`${SOLVED_ROOT}/k1/status`]: "undone", [`${SOLVED_ROOT}/k1/undoneAt`]: AT, [`${SOLVED_ROOT}/k1/undoneBy`]: "u" });
    expect(standing([{ kind: "solve", status: "done" }, { kind: "solve", status: "undone" }, { kind: "concrete", status: "done" }])).toHaveLength(1);
  });
  it("slimPriorOpen drops empty locations", () => {
    expect(slimPriorOpen({ a: null, b: {}, c: { S: null } })).toEqual({});
  });
});

import { undoRecordProblem } from "./solvedLog";
describe("undoRecordProblem — a history row is checked before Undo uses it", () => {
  const known = ["hub2", "trophy", "marathon-pe", "central"];
  it("a real row passes", () => {
    expect(undoRecordProblem(ENTRY, known)).toBeNull();
  });
  it("a path outside the product, an unknown location or a bad request id is refused", () => {
    expect(undoRecordProblem({ ...ENTRY, paths: ["stock/hub2/OTHER/S"] }, known)).toMatch(/not this product/);
    expect(undoRecordProblem({ ...ENTRY, paths: ["refill_requests/x"] }, known)).toMatch(/not this product/);
    expect(undoRecordProblem({ ...ENTRY, paths: ["stock/central/p1/S"] }, known)).toMatch(/not this product/);   // not one of its locs
    expect(undoRecordProblem({ ...ENTRY, locs: ["mars"] }, known)).toMatch(/unknown location/);
    expect(undoRecordProblem({ ...ENTRY, firstBatch: { requestIds: ["../x"] } }, known)).toMatch(/request id/);
    expect(undoRecordProblem({ ...ENTRY, pid: "a/b" }, known)).toMatch(/product id/);
  });
});

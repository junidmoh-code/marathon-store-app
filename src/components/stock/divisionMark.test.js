// divisionMark.js — the pure parts (Junid, 23 Nov 2026).
import { describe, it, expect, vi } from "vitest";
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: null } }));
const { withDivisionMarks, listedForDivision, divisionMarkOf, buildMarathonUpdate, marksOf } = await import("./divisionMark.js");

describe("withDivisionMarks", () => {
  const A = { id: "pA", concreteProduct: true }, B = { id: "pB" }, C = { id: "pC", marathonProduct: true };
  it("before the indexes answer, the records are used as they are", () => {
    const list = [A, B, C];
    expect(withDivisionMarks(list, null, null, false)).toBe(list);
  });
  it("once answered, the indexes are the truth: marks added and stripped", () => {
    const out = withDivisionMarks([A, B, C], { pB: true }, null, true);
    expect(divisionMarkOf(out[0])).toBe(null);          // unmarked on another device
    expect(divisionMarkOf(out[1])).toBe("concrete");    // marked on another device
    expect(divisionMarkOf(out[2])).toBe(null);
  });
  it("unchanged records keep their identity, and the same array comes back when nothing changes", () => {
    const list = [A, B, C];
    expect(withDivisionMarks(list, { pA: true }, { pC: true }, true)).toBe(list);
  });
  it("Concrete wins if both indexes ever named a product", () => {
    const [p] = withDivisionMarks([B], { pB: true }, { pB: true }, true);
    expect(marksOf(p)).toEqual({ concrete: true, marathon: false });
  });
});

describe("listedForDivision", () => {
  it("a product marked for one division is never on the other's list", () => {
    expect(listedForDivision({ id: "x", concreteProduct: true }, "marathon")).toBe(false);
    expect(listedForDivision({ id: "x", concreteProduct: true }, "concrete")).toBe(true);
    expect(listedForDivision({ id: "x", marathonProduct: true }, "concrete")).toBe(false);
    expect(listedForDivision({ id: "x", marathonProduct: true }, "marathon")).toBe(true);
    expect(listedForDivision({ id: "x" }, "concrete")).toBe(true);
  });
});

describe("buildMarathonUpdate", () => {
  it("writes the mark and its index — nothing else", () => {
    expect(buildMarathonUpdate({ pid: "p1", on: true, uid: "u", nowMs: 5 })).toEqual({
      "products/p1/marathonProduct": true, "products/p1/marathonProductSetBy": "u", "products/p1/marathonProductSetAt": 5, "settings/marathonOnlyIndex/p1": true,
    });
    expect(buildMarathonUpdate({ pid: "p1", on: false, uid: "u", nowMs: 5 })["settings/marathonOnlyIndex/p1"]).toBe(null);
  });
  it("refuses an unsafe id or a missing clock", () => {
    expect(() => buildMarathonUpdate({ pid: "a/b", on: true, uid: "u", nowMs: 5 })).toThrow();
    expect(() => buildMarathonUpdate({ pid: "p1", on: true, uid: "u", nowMs: 0 })).toThrow();
  });
});

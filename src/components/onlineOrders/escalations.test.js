import { describe, it, expect } from "vitest";
import { escalationRows, overrideUpdates } from "./escalations.js";

const REG = {
  "9001_0": { orderId: "9001", lineIndex: 0, ref: "LEV", title: "Club Tee", size: "M", phase: "wait", round: 1, where: "round 1: sent to Marathon PE", next: "Back on the display list at Marathon PE", nextAt: 200 },
  "9002_1": { orderId: "9002", lineIndex: 1, ref: "KQZ", title: "Air Runner", size: "8", phase: "unavailable", where: "Unavailable", next: "Customer agent", agent: { state: "offering" } },
  "9003_0": { orderId: "9003", lineIndex: 0, ref: "ABC", phase: "await", nextAt: 100 },
  bad: { orderId: "a/b", lineIndex: 0 },
};

describe("escalationRows", () => {
  it("lists every line with where it is, what is next and when, and the agent's state; malformed rows dropped", () => {
    const rows = escalationRows(REG);
    expect(rows.map((r) => r.ref)).toEqual(["ABC", "LEV", "KQZ"]);
    expect(rows[1]).toMatchObject({ orderId: "9001", lineIndex: 0, size: "M", where: "round 1: sent to Marathon PE", nextAt: 200, canMarkUnavailable: true, agent: null });
    expect(rows[2]).toMatchObject({ agent: "Customer offered alternatives — waiting for a reply", canMarkUnavailable: false });
  });
});

describe("overrideUpdates — Junid's one write", () => {
  it("writes ONLY the line's escalationOverride", () => {
    expect(overrideUpdates({ orderId: "9001", lineIndex: 0 }, "unavailable", "u-junid", 5)).toEqual({
      "online_orders/9001/lines/0/escalationOverride": { kind: "unavailable", by: "u-junid", at: 5 },
    });
    expect(Object.keys(overrideUpdates({ orderId: "9001", lineIndex: 2 }, "resolved", "u", 1))).toEqual(["online_orders/9001/lines/2/escalationOverride"]);
  });
  it("refuses anything that could write the wrong place", () => {
    expect(() => overrideUpdates({ orderId: "9001", lineIndex: 0 }, "refund", "u", 1)).toThrow();
    expect(() => overrideUpdates({ orderId: "a/b", lineIndex: 0 }, "resolved", "u", 1)).toThrow();
    expect(() => overrideUpdates({ orderId: "9001", lineIndex: 0 }, "resolved", null, 1)).toThrow();
  });
});

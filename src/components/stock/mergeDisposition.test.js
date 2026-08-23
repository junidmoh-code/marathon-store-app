// ─── THE OUTCOME SENTENCES — every disposition is STATED, even when it nets to 0
import { describe, it, expect } from "vitest";
import { planMerge, outcomeLines } from "./mergeDisposition.js";

describe("outcomeLines", () => {
  it("states a removal whose cells cancel to zero — the merge still writes both off", () => {
    // +3 in a 9 and −3 in a 10, both counted under the survivor at hub1.
    const plan = planMerge({
      loserId: "L", survivorId: "S",
      loserCells: { hub1: { "9": { qty: 3 }, "10": { qty: -3 } } },
      countedByLoc: { hub1: new Set(["S::9", "S::10"]) },
    });
    const row = plan.find((r) => r.loc === "hub1");
    expect(row.remove.length).toBe(2);
    expect(row.removeQty).toBe(0);
    const lines = outcomeLines(row, "Hub 1");
    expect(lines.some((l) => l.kind === "remove")).toBe(true);
  });

  it("states a transfer whose cells cancel to zero, and says nothing about a disposition with no cells", () => {
    const plan = planMerge({
      loserId: "L", survivorId: "S",
      loserCells: { central: { "9": { qty: 2 }, "10": { qty: -2 } } },
      countedByLoc: { central: new Set() },
    });
    const row = plan.find((r) => r.loc === "central");
    const lines = outcomeLines(row, "Central");
    expect(lines.some((l) => l.kind === "transfer")).toBe(true);
    expect(lines.some((l) => l.kind === "remove")).toBe(false);
  });
});

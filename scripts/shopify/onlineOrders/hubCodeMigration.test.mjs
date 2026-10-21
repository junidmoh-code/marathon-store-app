import { describe, it, expect } from "vitest";
import { migrationPlan, nextPointer, oldStillMatches } from "./hubCodeMigration.mjs";

describe("hub code migration (LEV / QGZ / SLR)", () => {
  const order = { lines: [
    { qty: 2, routeGen: 1, source: { status: "pick", orderKeys: ["QGZ-1-1", "QGZ-1-2"], entryKey: "orders/QGZ-1-1" } },
    { qty: 1, source: { status: "display", entryKey: "displayChecks_active/marathon-pe/online__1__1" } },
  ] };
  it("plans every hub unit (with its routeGen) and every strip entry", () => {
    expect(migrationPlan(order)).toEqual({
      units: [{ i: 0, u: 0, gen: 1, oldKey: "QGZ-1-1" }, { i: 0, u: 1, gen: 1, oldKey: "QGZ-1-2" }],
      displays: ["displayChecks_active/marathon-pe/online__1__1"],
    });
  });
  it("a unit the migration skipped KEEPS its old key; entryKey is never orders/undefined", () => {
    expect(nextPointer(["QGZ-1-1", "QGZ-1-2"], [undefined, "MBT"])).toEqual({ orderKeys: ["QGZ-1-1", "MBT"], entryKey: "orders/QGZ-1-1" });
    expect(nextPointer(["QGZ"], ["HJK"])).toEqual({ orderKeys: ["HJK"], entryKey: "orders/HJK" });
  });
  it("the old record is removed only if it is still what was copied", () => {
    const rec = { channel: "online", onlineOrderId: "1", status: "incoming" };
    expect(oldStillMatches(rec, rec, "1")).toBe(true);
    expect(oldStillMatches({ ...rec, status: "ready" }, rec, "1")).toBe(false);
    expect(oldStillMatches({ ...rec, onlineOrderId: "2" }, rec, "1")).toBe(false);
    expect(oldStillMatches(null, rec, "1")).toBe(false);
  });
});

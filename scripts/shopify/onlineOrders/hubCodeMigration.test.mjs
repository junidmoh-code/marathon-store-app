import { describe, it, expect } from "vitest";
import { migrationPlan, nextPointer, oldStillMatches, migrateOrder } from "./hubCodeMigration.mjs";
import { fakeDb } from "./fakeDb.testutil.mjs";
import { candidateCode } from "./orderRefs.mjs";

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

describe("migrateOrder against the fake RTDB (cold-cache null first pass, like the Admin SDK)", () => {
  const QGZ = { ref: "QGZ", orderNumber: 1769, status: "picking", lines: [{ pid: "SNK", qty: 1, isFootwear: true, source: { locationId: "hub1", status: "pick", orderKeys: ["QGZ"], entryKey: "orders/QGZ" } }] };
  const LEV = { ref: "LEV", orderNumber: 1768, status: "picking", lines: [{ pid: "TEE", qty: 1, source: { locationId: "marathon-pe", status: "display", entryKey: "displayChecks_active/marathon-pe/online__2__0" } }] };
  const hubRec = { id: "QGZ", channel: "online", onlineOrderId: "1", onlineLineIndex: 0, status: "incoming", hub: "hub1", customerName: "Shopify" };

  it("--commit MOVES the hub order to its unit code (status kept), points the line at it, removes the old key", async () => {
    const f = fakeDb({ online_orders: { 1: QGZ }, orders: { QGZ: hubRec } });
    const out = await migrateOrder(f.db, "1", QGZ, { nowMs: 1, commit: true });
    const code = candidateCode("1:0:0:0", 0);
    expect(out.moved).toEqual([["QGZ", code]]);
    expect(f.read("orders/QGZ")).toBeNull();
    expect(f.read(`orders/${code}`)).toMatchObject({ id: code, status: "incoming", hub: "hub1", onlineOrderNumber: 1769, onlineUnit: 0, migratedFrom: "QGZ", customerName: "Shopify" });
    expect(f.read("online_orders/1/lines/0/source")).toMatchObject({ orderKeys: [code], entryKey: `orders/${code}` });
    // A re-run finds nothing left to do.
    const again = await migrateOrder(f.db, "1", f.read("online_orders/1"), { nowMs: 2, commit: true });
    expect(again.moved).toEqual([]);
  });

  it("a hub order SENT while being moved is kept as it is (never lost), the copy withdrawn", async () => {
    const f = fakeDb({ online_orders: { 1: QGZ }, orders: { QGZ: hubRec } });
    const realRef = f.db.ref;
    const db = { ref: (p) => {
      const r = realRef(p);
      if (p === "orders/QGZ") return { ...r, transaction: async (fn) => { await f.db.ref("orders/QGZ/status").set("ready"); return r.transaction(fn); } };
      return r;
    } };
    const out = await migrateOrder(db, "1", QGZ, { nowMs: 1, commit: true });
    expect(out.kept).toEqual(["QGZ"]);
    expect(f.read("orders/QGZ")).toMatchObject({ status: "ready" });
    expect(f.read(`orders/${candidateCode("1:0:0:0", 0)}`)).toBeNull();
    expect(f.read("online_orders/1/lines/0/source/orderKeys")).toEqual(["QGZ"]);
  });

  it("stamps the Shopify number on the order's strip entries", async () => {
    const f = fakeDb({ online_orders: { 2: LEV }, displayChecks_active: { "marathon-pe": { online__2__0: { kind: "online_pick", ref: "LEV", status: "open" } } } });
    await migrateOrder(f.db, "2", LEV, { nowMs: 1, commit: true });
    expect(f.read("displayChecks_active/marathon-pe/online__2__0")).toMatchObject({ orderNumber: 1768, ref: "#1768", status: "open" });
  });

  it("a dry run writes nothing", async () => {
    const f = fakeDb({ online_orders: { 1: QGZ }, orders: { QGZ: hubRec } });
    const n = f.writes.length;
    await migrateOrder(f.db, "1", QGZ, { nowMs: 1, commit: false });
    expect(f.writes.length).toBe(n);
  });
});

import { describe, test, expect, beforeEach } from "vitest";
import { freshMirrorDb } from "./helpers";
import { createFakeRtdb, pushKeyForMs } from "./fakeAdapter";
import { createSyncEngine } from "../sync";
import {
  readMirroredPath, legFor, MISS, readInsightsFromKey, readMovementsFromTs, readWholeLeg,
} from "../localReads";
import {
  notePendingUpdate, applyPending, confirmPending, pendingCount,
  _clearPendingForTests, PENDING_TTL_MS,
} from "../pendingWrites";

const T0 = 1_780_000_000_000;

async function mirroredWorld(extra = {}) {
  const db = await freshMirrorDb();
  const w = createFakeRtdb({
    locations: { hub1: { id: "hub1" }, "marathon-pe": { id: "marathon-pe" } },
    users: { u1: { name: "Zee" } },
    products: { p1: { id: "p1", name: "Nike Air", price: 1200 } },
    stock: {
      hub1: { p1: { 9: { qty: 3, v: 1 } }, p2: { M: { qty: 5, v: 0 } } },
      "marathon-pe": { p1: { 9: { qty: 1, v: 0 } } },
    },
    orders: { "001": { id: "001", destShop: "marathon-pe" } },
    customers: { c1: { name: "Ndu" } },
    refill_requests: { r1: { status: "open" } },
    ...extra,
  });
  await createSyncEngine({ db, adapter: w.adapter, now: () => T0, buildVersion: "b1" }).runSetup();
  return { db, w };
}

beforeEach(() => _clearPendingForTests());

describe("a local read answers exactly what the server would", () => {
  test("a whole node comes back in its RTDB shape", async () => {
    const { db } = await mirroredWorld();
    expect(await readMirroredPath(db, "stock")).toEqual({
      hub1: { p1: { 9: { qty: 3, v: 1 } }, p2: { M: { qty: 5, v: 0 } } },
      "marathon-pe": { p1: { 9: { qty: 1, v: 0 } } },
    });
  });

  test("the same tree, entered at every height", async () => {
    const { db } = await mirroredWorld();
    expect(await readMirroredPath(db, "stock/hub1")).toEqual({
      p1: { 9: { qty: 3, v: 1 } }, p2: { M: { qty: 5, v: 0 } },
    });
    expect(await readMirroredPath(db, "stock/hub1/p1")).toEqual({ 9: { qty: 3, v: 1 } });
    expect(await readMirroredPath(db, "stock/hub1/p1/9")).toEqual({ qty: 3, v: 1 });
    expect(await readMirroredPath(db, "stock/hub1/p1/9/qty")).toBe(3);
  });

  test("AN EMPTY NODE READS null, never {} — RTDB cannot store an empty object", async () => {
    const { db } = await mirroredWorld();
    // Every `if (!data) return []` in this app depends on it.
    expect(await readMirroredPath(db, "stock/hub3")).toBeNull();
    expect(await readMirroredPath(db, "products/nope")).toBeNull();
    expect(await readMirroredPath(db, "stock/hub1/p1/42")).toBeNull();
    expect(await readMirroredPath(db, "returns_log")).toBeNull();
  });

  test("a path NO leg covers is a MISS, not a null", async () => {
    const { db } = await mirroredWorld();
    // "nothing is there" and "this copy cannot say" are different answers, and
    // conflating them renders an empty list for a node that is merely live.
    expect(await readMirroredPath(db, "laybys")).toBe(MISS);
    expect(await readMirroredPath(db, "card_batches/b1")).toBe(MISS);
    expect(await readMirroredPath(db, "products")).not.toBe(MISS);
  });

  test("a docs leg answers at its node and at a child", async () => {
    const { db } = await mirroredWorld();
    expect(await readMirroredPath(db, "locations")).toEqual({
      hub1: { id: "hub1" }, "marathon-pe": { id: "marathon-pe" },
    });
    expect(await readMirroredPath(db, "locations/hub1")).toEqual({ id: "hub1" });
    expect(await readMirroredPath(db, "users/u1")).toEqual({ name: "Zee" });
    expect(await readMirroredPath(db, "users")).toEqual({ u1: { name: "Zee" } });
  });

  test("one docs leg does not leak into another", async () => {
    const { db } = await mirroredWorld({ "config": { transit: { enabled: false } } });
    expect(await readMirroredPath(db, "config/transit")).toEqual({ enabled: false });
    expect(await readMirroredPath(db, "locations/transit")).toBeNull();
  });

  test("the longest matching node wins", () => {
    // /settings has three legs under it and is not itself a leg.
    expect(legFor("settings/displayRows/marathon-pe").leg.name).toBe("displayRows");
    expect(legFor("settings/displaySlots").leg.name).toBe("displaySlots");
    expect(legFor("products/p1/price").leg.name).toBe("products");
    expect(legFor("laybys")).toBeNull();
  });

  test("a depth-3 node rebuilds three levels", async () => {
    const { db } = await mirroredWorld({
      settings: { displayRows: { "marathon-pe": { p1: { r1: { open: true }, r2: { open: false } } } } },
    });
    expect(await readMirroredPath(db, "settings/displayRows")).toEqual({
      "marathon-pe": { p1: { r1: { open: true }, r2: { open: false } } },
    });
    expect(await readMirroredPath(db, "settings/displayRows/marathon-pe/p1/r2")).toEqual({ open: false });
  });
});

describe("a person's own action is visible immediately", () => {
  test("a stock write shows through a read of the node above it", async () => {
    const { db } = await mirroredWorld();
    expect((await readMirroredPath(db, "stock/hub1")).p1["9"].qty).toBe(3);
    // Exactly the flat multi-path map applyMovement hands RTDB.
    notePendingUpdate({
      "stock/hub1/p1/9/qty": 1,
      "stock/hub1/p1/9/v": 2,
    }, { enabled: true, now: () => T0 });
    const after = await readMirroredPath(db, "stock/hub1", { now: () => T0 + 10 });
    expect(after.p1["9"]).toEqual({ qty: 1, v: 2 });
    // …and at every other height the same fact is true.
    expect((await readMirroredPath(db, "stock", { now: () => T0 + 10 })).hub1.p1["9"].qty).toBe(1);
    expect(await readMirroredPath(db, "stock/hub1/p1/9/qty", { now: () => T0 + 10 })).toBe(1);
  });

  test("the mirrored copy is NOT mutated by the overlay", async () => {
    const { db } = await mirroredWorld();
    notePendingUpdate({ "stock/hub1/p1/9/qty": 99 }, { enabled: true, now: () => T0 });
    await readMirroredPath(db, "stock/hub1", { now: () => T0 + 10 });
    expect(await db.get("stock", "hub1|p1")).toEqual({ 9: { qty: 3, v: 1 } });
  });

  test("a DELETE echoes as a delete", async () => {
    const { db } = await mirroredWorld();
    notePendingUpdate({ "stock/hub1/p2": null }, { enabled: true, now: () => T0 });
    const after = await readMirroredPath(db, "stock/hub1", { now: () => T0 + 10 });
    expect(after.p2).toBeUndefined();
    expect(after.p1).toBeDefined();
  });

  test("a write that empties a node leaves it reading null, as RTDB would", async () => {
    const { db } = await mirroredWorld();
    notePendingUpdate({ "stock/marathon-pe/p1": null }, { enabled: true, now: () => T0 });
    expect(await readMirroredPath(db, "stock/marathon-pe", { now: () => T0 + 10 })).toBeNull();
  });

  test("the echo EXPIRES, so it can never hide someone else's later change", async () => {
    const { db } = await mirroredWorld();
    notePendingUpdate({ "stock/hub1/p1/9/qty": 99 }, { enabled: true, now: () => T0 });
    expect((await readMirroredPath(db, "stock/hub1", { now: () => T0 + 1000 })).p1["9"].qty).toBe(99);
    const late = await readMirroredPath(db, "stock/hub1", { now: () => T0 + PENDING_TTL_MS + 1 });
    expect(late.p1["9"].qty).toBe(3);
  });

  test("a confirmed path is dropped at once, not left to expire", async () => {
    notePendingUpdate({ "stock/hub1/p1/9/qty": 99 }, { enabled: true, now: () => T0 });
    expect(pendingCount({ now: () => T0 })).toBe(1);
    expect(confirmPending(["stock/hub1/p1/9/qty"])).toBe(1);
    expect(pendingCount({ now: () => T0 })).toBe(0);
  });

  test("with the mirror flag OFF nothing is recorded at all", async () => {
    expect(notePendingUpdate({ "stock/hub1/p1/9/qty": 99 }, { enabled: false })).toBe(0);
    expect(pendingCount()).toBe(0);
  });

  test("nothing pending returns the very same object — no wasted re-render", async () => {
    const value = { a: 1 };
    expect(applyPending("stock/hub1", value)).toBe(value);
  });

  test("a write AT a path is refined by a deeper write from the same update", () => {
    // update() takes both in one call and RTDB applies both; so must the echo.
    notePendingUpdate({ "stock/hub1/p9": { M: { qty: 1 } }, "stock/hub1/p9/M/qty": 4 },
      { enabled: true, now: () => T0 });
    const out = applyPending("stock/hub1", { p1: {} }, { now: () => T0 });
    expect(out.p9).toEqual({ M: { qty: 4 } });
  });
});

describe("the two windowed reads", () => {
  test("/insights_log answers a key range, not the whole node", async () => {
    const db = await freshMirrorDb();
    const rows = Array.from({ length: 5 }, (_, i) => ({
      key: pushKeyForMs(T0 + i * 86400_000, String(i).padStart(12, "A")),
      value: { timestamp: T0 + i * 86400_000 },
    }));
    await db.replaceAll("insights", rows);
    const got = await readInsightsFromKey(db, rows[3].key);
    expect(Object.keys(got)).toEqual([rows[3].key, rows[4].key]);
  });

  test("an empty window reads null, exactly as the live query does", async () => {
    const db = await freshMirrorDb();
    await db.replaceAll("insights", []);
    expect(await readInsightsFromKey(db, "-Z")).toBeNull();
  });

  test("/stock_movements answers a ts range through the index", async () => {
    const db = await freshMirrorDb();
    await db.replaceAll("movements", [
      { key: "a", value: { ts: "2026-06-01T00:00:00.000Z" } },
      { key: "b", value: { ts: "2026-09-01T00:00:00.000Z" } },
    ]);
    expect(Object.keys(await readMovementsFromTs(db, "2026-08-01T00:00:00.000Z"))).toEqual(["b"]);
  });

  test("the whole of a leg is available for the three all-time consumers", async () => {
    const { db } = await mirroredWorld();
    expect(await readWholeLeg(db, "products")).toEqual({
      p1: { id: "p1", name: "Nike Air", price: 1200 },
    });
    expect(await readWholeLeg(db, "nosuchleg")).toBe(MISS);
  });
});

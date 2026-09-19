import { describe, test, expect } from "vitest";
import { freshMirrorDb, rec } from "./helpers";
import { MIRROR_STORES } from "../nodes";
import { DATA_STORES } from "../db";

describe("the mirror database", () => {
  test("creates an object store for every leg in the registry", async () => {
    const db = await freshMirrorDb();
    // count() throws on a store that does not exist, so this asserts existence
    // rather than merely restating the list it came from.
    for (const name of MIRROR_STORES) {
      await expect(db.count(name)).resolves.toBe(0);
    }
    expect(DATA_STORES).toEqual([...MIRROR_STORES]);
  });

  test("movements carries the ts index the 90-day window reads", async () => {
    const db = await freshMirrorDb();
    await db.replaceAll("movements", [
      rec("a", { ts: "2026-01-01T00:00:00.000Z", qty: 1 }),
      rec("b", { ts: "2026-06-01T00:00:00.000Z", qty: 2 }),
      rec("c", { ts: "2026-09-01T00:00:00.000Z", qty: 3 }),
    ]);
    const got = await db.getEntriesInIndexRange("movements", "ts", "2026-05-01T00:00:00.000Z", null);
    expect(got.map((e) => e.key)).toEqual(["b", "c"]);
  });

  test("a key range on insights is a time range", async () => {
    const db = await freshMirrorDb();
    await db.replaceAll("insights", [rec("-A", {}), rec("-M", {}), rec("-Z", {})]);
    const got = await db.getEntriesInKeyRange("insights", "-B", null);
    expect(got.map((e) => e.key)).toEqual(["-M", "-Z"]);
  });

  test("replaceAll reports the count the store HOLDS, not the count it was handed", async () => {
    const db = await freshMirrorDb();
    // Two records under one key: the store holds one. A leg that trusted
    // records.length would vouch for a row that is not there.
    const held = await db.replaceAll("products", [rec("p1", { a: 1 }), rec("p1", { a: 2 })]);
    expect(held).toBe(1);
    expect(await db.count("products")).toBe(1);
  });

  test("a failed swap leaves the PREVIOUS snapshot, never an empty store", async () => {
    const db = await freshMirrorDb();
    await db.replaceAll("products", [rec("p1", { a: 1 }), rec("p2", { a: 2 })]);
    // A value IndexedDB cannot structured-clone aborts the transaction AFTER
    // the clear() has been issued — the exact shape of "interrupted mid-swap".
    await expect(
      db.replaceAll("products", [rec("p3", { fn() {} })]),
    ).rejects.toThrow();
    expect(await db.count("products")).toBe(2);
    expect(await db.getAllKeys("products")).toEqual(["p1", "p2"]);
  });

  test("putPage moves the cursor only when the page lands, and only forwards", async () => {
    const db = await freshMirrorDb();
    await db.putPage("orders", [rec("o1", { n: 1 })], { cursorKey: "cursor.orders", cursorValue: "k5" });
    expect(await db.getMeta("cursor.orders")).toBe("k5");
    // A slower tab finishing an OLDER page must not rewind the cursor.
    await db.putPage("orders", [rec("o0", { n: 0 })], { cursorKey: "cursor.orders", cursorValue: "k2" });
    expect(await db.getMeta("cursor.orders")).toBe("k5");
    expect(await db.count("orders")).toBe(2);
  });

  test("progress meta rides the cursor's own guard, so it cannot disagree with it", async () => {
    const db = await freshMirrorDb();
    await db.putPage("orders", [], {
      cursorKey: "cursor.orders", cursorValue: "k5", metaEntries: { "lastSyncAt.orders": 500 },
    });
    await db.putPage("orders", [], {
      cursorKey: "cursor.orders", cursorValue: "k2", metaEntries: { "lastSyncAt.orders": 200 },
    });
    expect(await db.getMeta("cursor.orders")).toBe("k5");
    expect(await db.getMeta("lastSyncAt.orders")).toBe(500);
  });

  test("putPage deletes in the same transaction as it writes", async () => {
    const db = await freshMirrorDb();
    await db.replaceAll("products", [rec("p1", { a: 1 }), rec("p2", { a: 2 })]);
    await db.putPage("products", [rec("p3", { a: 3 })], { deleteKeys: ["p1"] });
    expect(await db.getAllKeys("products")).toEqual(["p2", "p3"]);
  });

  test("the docs store is cleared BY PREFIX, so one leg cannot drop another's rows", async () => {
    const db = await freshMirrorDb();
    await db.replacePrefixed("docs", "settings/productTaxonomy", [
      rec("settings/productTaxonomy", { top: "footwear" }),
    ]);
    await db.replacePrefixed("docs", "locations", [rec("locations", { hub1: {} })]);
    // Re-syncing locations must not take the taxonomy with it.
    const held = await db.replacePrefixed("docs", "locations", [rec("locations", { hub1: {}, hub2: {} })]);
    expect(held).toBe(1);
    expect(await db.get("docs", "settings/productTaxonomy")).toEqual({ top: "footwear" });
  });

  test("a docs prefix does not swallow a longer node name that starts with it", async () => {
    const db = await freshMirrorDb();
    await db.replacePrefixed("docs", "settings/stockHold", [rec("settings/stockHold", { on: true })]);
    await db.replacePrefixed("docs", "settings/stockHoldExtra", [rec("settings/stockHoldExtra", { x: 1 })]);
    // "settings/stockHold" is a prefix of "settings/stockHoldExtra" as a
    // STRING. If the bound range is used naively both are cleared together.
    await db.replacePrefixed("docs", "settings/stockHold", [rec("settings/stockHold", { on: false })]);
    expect(await db.get("docs", "settings/stockHoldExtra")).toEqual({ x: 1 });
    expect(await db.get("docs", "settings/stockHold")).toEqual({ on: false });
  });

  test("countPrefixed counts a node's own key and its children, and nothing else", async () => {
    const db = await freshMirrorDb();
    await db.replacePrefixed("docs", "users", [
      rec("users/u1", { name: "a" }), rec("users/u2", { name: "b" }),
    ]);
    await db.replacePrefixed("docs", "locations", [rec("locations", {})]);
    expect(await db.countPrefixed("docs", "users")).toBe(2);
    expect(await db.countPrefixed("docs", "locations")).toBe(1);
  });

  test("a schema bump purges the rows AND the cursors that describe them", async () => {
    const db = await freshMirrorDb();
    await db.replaceAll("products", [rec("p1", { a: 1 })], {
      "cursor.products": "k1",
      "lastSyncAt.products": 1,
      "mirror.health.products": { ok: true, rows: 1 },
      "setup.done": true,
    });
    await db.ensureSchema({ schemaVersion: 99 });
    expect(await db.count("products")).toBe(0);
    expect(await db.getMeta("cursor.products")).toBeUndefined();
    expect(await db.getMeta("mirror.health.products")).toBeUndefined();
    expect(await db.getMeta("setup.done")).toBeUndefined();
    expect(await db.getMeta("schemaVersion")).toBe(99);
  });

  test("purgeEverything keeps the shape version, so the next open does not purge again", async () => {
    const db = await freshMirrorDb();
    await db.replaceAll("products", [rec("p1", {})], { "cursor.products": "k1" });
    const removed = await db.purgeEverything();
    expect(removed.products).toBe(1);
    expect(await db.count("products")).toBe(0);
    expect(await db.getMeta("cursor.products")).toBeUndefined();
    const again = await db.ensureSchema({ schemaVersion: 1 });
    expect(again.purged).toBe(false);
  });

  test("updateMeta is a read-modify-write inside ONE transaction", async () => {
    const db = await freshMirrorDb();
    await db.setMeta("n", 0);
    await Promise.all(Array.from({ length: 20 }, () => db.updateMeta("n", (v) => (v ?? 0) + 1)));
    expect(await db.getMeta("n")).toBe(20);
  });

  test("getAllEntries pairs each key with its own value in one pass", async () => {
    const db = await freshMirrorDb();
    await db.replaceAll("stock", [rec("hub1|p1", { 9: { qty: 2 } }), rec("hub2|p1", { 9: { qty: 5 } })]);
    const entries = await db.getAllEntries("stock");
    expect(entries).toEqual([
      { key: "hub1|p1", value: { 9: { qty: 2 } } },
      { key: "hub2|p1", value: { 9: { qty: 5 } } },
    ]);
  });
});

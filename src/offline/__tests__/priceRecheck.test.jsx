// ─── "No price set" on a device that missed the price ────────────────────────
//
// docs/ASSISTANT-NO-PRICE-SET.md. On 13 Nov 2026 SKUs 6080/6082 were priced
// through Missing Prices. The server's rows and its change records were right,
// yet an assistant view went on saying "No price set": a device serving
// /products from its mirror held the row from before the price. The daily
// census counts rows, and a price edit changes no count, so nothing healed it.
//
// These run the REAL sync engine against a fake RTDB, the REAL IndexedDB
// mirror (fake-indexeddb) and the REAL useMirroredPath, and look at what a
// card would print.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

let world;
const getCalls = [];
vi.mock("firebase/database", () => ({
  ref: (db, path) => ({ path }),
  onValue: vi.fn(() => () => {}),
  query: (r) => r, orderByKey: () => ({}), orderByChild: () => ({}), startAt: () => ({}),
  startAfter: () => ({}), endAt: () => ({}), limitToFirst: () => ({}), limitToLast: () => ({}),
  // The backstop's one-row read: answered from the same fake database.
  get: vi.fn(async (r) => {
    getCalls.push(r.path);
    const v = await world.adapter.readPath(r.path);
    return { exists: () => v !== null && v !== undefined, val: () => v };
  }),
  update: vi.fn(), push: vi.fn(), runTransaction: vi.fn(), equalTo: () => ({}), set: vi.fn(),
  remove: vi.fn(), serverTimestamp: () => ({}), child: vi.fn(),
}));
vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (auth, cb) => { cb({ uid: "u1", isAnonymous: false }); return () => {}; },
  getAuth: () => ({ currentUser: { uid: "u1", isAnonymous: false } }),
  GoogleAuthProvider: class {},
}));
vi.mock("../../firebase", () => ({
  database: {}, auth: { currentUser: { uid: "u1", isAnonymous: false } },
  storage: {}, app: {}, functions: {}, functionsUS: {}, googleProvider: {},
}));

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let testDb = null;
vi.mock("../mirrorDbHandle", async (orig) => {
  const real = await orig();
  return { ...real, getMirrorDbHandle: () => Promise.resolve(testDb) };
});

import { freshMirrorDb } from "./helpers";
import { createFakeRtdb, pushKeyForMs } from "./fakeAdapter";
import { createSyncEngine } from "../sync";
import { CHANGES_ROOT } from "../changeFeed";
import { setMirrorSwitchValue, _resetMirrorSwitchForTests } from "../killSwitch";
import { setServingLegs, _resetServingForTests } from "../serving";
import { bumpLegs, legVersion, _resetMirrorSignalForTests } from "../mirrorSignal";
import { _resetMirrorDbHandleForTests } from "../mirrorDbHandle";
import { MIRROR_LEGS } from "../nodes";
import { useMirroredPath } from "../useMirroredPath";
import { recheckMirroredRows } from "../rowRecheck";
import { usePriceRecheck, runPriceRecheck, idsToRecheck, _resetPriceRecheckForTests } from "../../components/assistant/usePriceRecheck";
import { retailPriceOf } from "../../utils/retailPrice";
import { echoPriceWrite } from "../../components/admin/priceStore";
import { _clearPendingForTests } from "../pendingWrites";

const T0 = 1_794_600_000_000;
const UNPRICED_6080 = { id: "p6080", sku: "6080", name: "Manchester city soccer jersey black", productType: "clothing", hubs: ["hub2", "hub3"] };
const OLD_1882 = { id: "p1882", sku: "1882", name: "Puma Manchester City Jersey Pink Purple", productType: "clothing", stockPrice: 200, retailPrice: 200 };
const LEGACY = { id: "pLegacy", sku: "0042", name: "Legacy tee", productType: "clothing", price: 150 };

let engine;
async function seed(products) {
  testDb = await freshMirrorDb();
  const initial = {
    locations: { hub1: { id: "hub1" } }, users: { u1: { name: "Zee" } },
    products, stock: { hub1: { p1: { 9: { qty: 3, v: 0 } } } }, orders: { "001": { id: "001" } }, customers: { c1: { name: "N" } },
    refill_requests: { r1: { status: "open" } },
  };
  world = createFakeRtdb(initial);
  engine = createSyncEngine({ db: testDb, adapter: world.adapter, now: () => T0, buildVersion: "b" });
  await engine.runSetup();
  setServingLegs(MIRROR_LEGS.map((l) => l.name));
}

// What the card prints: the assistant's own reader over the mirrored catalogue.
function mountCards({ withRecheck = true } = {}) {
  const shown = [];
  function Cards() {
    const s = useMirroredPath("products", true);
    const list = s.value ? Object.values(s.value) : [];
    if (withRecheck) usePriceRecheck(list.length ? list : null);   // eslint-disable-line react-hooks/rules-of-hooks
    const text = Object.fromEntries(list.map((p) => [p.sku, retailPriceOf(p) !== null ? `R${retailPriceOf(p)}` : "No price set"]));
    shown.push(text);
    return null;
  }
  let tree;
  act(() => { tree = TestRenderer.create(React.createElement(Cards)); });
  return { last: () => shown.at(-1) || {}, unmount: () => act(() => tree.unmount()) };
}
async function settle(n = 25) {
  for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 1)); });
}

beforeEach(() => {
  getCalls.length = 0;
  localStorage.removeItem("marathon-store.offlineMirror.downloadLedger");
  _resetServingForTests(); _resetMirrorSignalForTests(); _resetMirrorDbHandleForTests();
  _resetMirrorSwitchForTests(); setMirrorSwitchValue(true);
  _resetPriceRecheckForTests(); _clearPendingForTests();
});
afterEach(() => { _resetMirrorSwitchForTests(); _resetServingForTests(); });

describe("a Missing Prices price the device's mirror missed", () => {
  it("is fetched for that ONE row, patched into the mirror, and the card shows R300", async () => {
    await seed({ p6080: UNPRICED_6080, p1882: OLD_1882, pLegacy: LEGACY });
    // Missing Prices writes the price; THIS device never applies the change
    // record (a dropped invocation, a benched feed, a keys-only repair).
    world.write("products/p6080/retailPrice", 300);
    world.write("products/p6080/stockPrice", 250);

    const view = mountCards();
    await settle();
    expect(view.last()).toEqual({ 6080: "R300", 1882: "R200", "0042": "R150" });
    // One child read, of the unpriced row only. The priced rows (and the
    // legacy-priced one) are not read at all, and nothing is read whole.
    expect(getCalls).toEqual(["products/p6080"]);
    expect((await testDb.get("products", "p6080")).retailPrice).toBe(300);
    view.unmount();
  });

  it("without the backstop the same device says 'No price set' for good (the bug)", async () => {
    await seed({ p6080: UNPRICED_6080, p1882: OLD_1882 });
    world.write("products/p6080/retailPrice", 300);
    const view = mountCards({ withRecheck: false });
    await settle();
    await act(async () => { await engine.runPass(); });   // no change record → nothing to apply
    await settle();
    expect(view.last()).toEqual({ 6080: "No price set", 1882: "R200" });
    view.unmount();
  });

  it("a product that really has no price is read once per session, not on every render", async () => {
    await seed({ p6080: UNPRICED_6080 });
    const view = mountCards();
    await settle();
    bumpLegs(["products"]);     // feed passes re-render the screen
    await settle();
    bumpLegs(["products"]);
    await settle();
    expect(view.last()).toEqual({ 6080: "No price set" });
    expect(getCalls).toEqual(["products/p6080"]);
    view.unmount();
  });
});

describe("a price change while the assistant view is open", () => {
  it("arrives through the change feed and the open card goes from 'No price set' to R300", async () => {
    await seed({ p6080: UNPRICED_6080, p1882: OLD_1882 });
    const view = mountCards();
    await settle();
    expect(view.last()[6080]).toBe("No price set");

    world.write("products/p6080/retailPrice", 300);
    world.write(`${CHANGES_ROOT}/${pushKeyForMs(T0 + 1000, "K00000000001")}`, { n: "products", k: "p6080", t: T0 + 1000 });
    await act(async () => {
      const report = await engine.runPass();
      if ((report.feed?.applied ?? 0) > 0) bumpLegs(["products"]);
    });
    await settle();
    expect(view.last()).toEqual({ 6080: "R300", 1882: "R200" });
    view.unmount();
  });

  it("a later repricing (R300 → R350) reaches the open card too", async () => {
    await seed({ p6080: { ...UNPRICED_6080, retailPrice: 300, stockPrice: 250 } });
    const view = mountCards();
    await settle();
    expect(view.last()[6080]).toBe("R300");
    world.write("products/p6080/retailPrice", 350);
    world.write(`${CHANGES_ROOT}/${pushKeyForMs(T0 + 2000, "K00000000002")}`, { n: "products", k: "p6080", t: T0 + 2000 });
    await act(async () => {
      const report = await engine.runPass();
      if ((report.feed?.applied ?? 0) > 0) bumpLegs(["products"]);
    });
    await settle();
    expect(view.last()[6080]).toBe("R350");
    expect(getCalls).toEqual([]);   // a priced card never triggers the backstop
    view.unmount();
  });

  it("on the device that saved it, the echo shows the price before the feed carries it", async () => {
    await seed({ p6080: UNPRICED_6080 });
    const view = mountCards({ withRecheck: false });
    await settle();
    expect(view.last()[6080]).toBe("No price set");
    const before = legVersion("products");
    await act(async () => {
      echoPriceWrite({
        "products/p6080/retailPrice": 300, "products/p6080/stockPrice": 250,
        "price_history/pb_1/label": "Missing Prices: x",
      });
    });
    await settle();
    expect(legVersion("products")).toBe(before + 1);
    expect(view.last()[6080]).toBe("R300");
    view.unmount();
  });
});

describe("recheckMirroredRows", () => {
  const fakeDb = (rows) => ({
    rows: new Map(Object.entries(rows)),
    async get(store, k) { return this.rows.get(k); },
    async putPage(store, records) { for (const { key, value } of records) this.rows.set(key, value); },
    async putIfUnchanged(store, k, expected, value, same) {
      const cur = this.rows.get(k);
      if (cur === undefined || !same(cur, expected)) return false;
      this.rows.set(k, value);
      return true;
    },
  });

  it("never ADDS a row the device does not hold (membership is the feed's)", async () => {
    const db = fakeDb({});
    const read = vi.fn(async () => ({ id: "p9", retailPrice: 300 }));
    const res = await recheckMirroredRows({ node: "products", keys: ["p9"], db, read, bump: vi.fn() });
    expect(res.patched).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(db.rows.has("p9")).toBe(false);
  });

  it("never deletes: a row that reads back null is left for the feed", async () => {
    const db = fakeDb({ p1: { id: "p1" } });
    const bump = vi.fn();
    const res = await recheckMirroredRows({ node: "products", keys: ["p1"], db, read: async () => null, bump });
    expect(res.patched).toBe(0);
    expect(db.rows.get("p1")).toEqual({ id: "p1" });
    expect(bump).not.toHaveBeenCalled();
  });

  it("does not overwrite a row the feed changed while the read was in flight", async () => {
    const db = fakeDb({ p1: { id: "p1" } });
    const read = async () => { db.rows.set("p1", { id: "p1", retailPrice: 350 }); return { id: "p1", retailPrice: 300 }; };
    const res = await recheckMirroredRows({ node: "products", keys: ["p1"], db, read, bump: vi.fn() });
    expect(res.patched).toBe(0);
    expect(db.rows.get("p1").retailPrice).toBe(350);
  });

  it("refuses a node that is not a depth-1 mirrored node, and skips path-like keys", async () => {
    await expect(recheckMirroredRows({ node: "stock", keys: ["x"], db: fakeDb({}), read: async () => 1 })).rejects.toThrow();
    const read = vi.fn();
    await recheckMirroredRows({ node: "products", keys: ["a/b", "", 5], db: fakeDb({}), read, bump: vi.fn() });
    expect(read).not.toHaveBeenCalled();
  });
});

describe("the real mirror db: putIfUnchanged is one transaction", () => {
  it("puts when unchanged, refuses when the row moved or is absent", async () => {
    const db = await freshMirrorDb();
    await db.putPage("products", [{ key: "p1", value: { id: "p1" } }]);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    expect(await db.putIfUnchanged("products", "p1", { id: "p2" }, { id: "p1", retailPrice: 1 }, same)).toBe(false);
    expect(await db.putIfUnchanged("products", "p1", { id: "p1" }, { id: "p1", retailPrice: 300 }, same)).toBe(true);
    expect((await db.get("products", "p1")).retailPrice).toBe(300);
    expect(await db.putIfUnchanged("products", "nope", undefined, { id: "x" }, same)).toBe(false);
    expect(await db.get("products", "nope")).toBeUndefined();
  });
});

describe("the price save echoes on both write paths", () => {
  it("applyPriceBatch and restorePriceBatch each call echoPriceWrite after their update()", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../components/admin/priceStore.js", import.meta.url), "utf8");
    const hits = src.match(/await rtdbUpdate\(ref\(database\), built\.updates\);\n\s*echoPriceWrite\(built\.updates\);/g) || [];
    expect(hits).toHaveLength(2);
  });
});

describe("runPriceRecheck", () => {
  it("reads nothing when /products is not served from the mirror (a live onValue is the truth)", async () => {
    const read = vi.fn();
    const res = await runPriceRecheck([UNPRICED_6080], { serving: () => false, read, openDb: vi.fn() });
    expect(res.checked).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it("a failed read is asked again on the next pass, not given up on", async () => {
    const fail = vi.fn().mockRejectedValue(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runPriceRecheck([UNPRICED_6080], { serving: () => true, openDb: async () => ({}), recheck: fail });
    warn.mockRestore();
    expect(idsToRecheck([UNPRICED_6080])).toEqual(["p6080"]);
  });

  it("caps a pass, and skips priced and legacy-priced products", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, name: "x" }));
    expect(idsToRecheck(many)).toHaveLength(25);
    expect(idsToRecheck([OLD_1882, LEGACY, UNPRICED_6080])).toEqual(["p6080"]);
  });
});

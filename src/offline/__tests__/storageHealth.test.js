// ─── IS THE BROWSER THROWING THIS DEVICE'S COPY AWAY? ────────────────────────
//
// Driven through the REAL entry point, startOfflineMirror, against a test
// IndexedDB: a start on a database that has its schema stamp is not a wipe; a
// start on a brand-new database, on a device that has held one before, is —
// and the count reaches the device's own report at /mirror_devices.
import { describe, test, expect, beforeEach, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import "./helpers";                     // installs the IDBKeyRange global db.js needs
import { openMirrorDb } from "../db";
import { createFakeRtdb } from "./fakeAdapter";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (auth, cb) => { cb({ uid: "u1", isAnonymous: false }); return () => {}; },
}));
vi.mock("../../firebase", () => ({ database: {}, auth: {}, storage: {} }));
vi.mock("../../update/updateChecker", () => ({
  setForcedUpdateMode: () => {}, setUpdateBusy: () => {},
}));

import { startOfflineMirror } from "../bootstrap";
import { setMirrorSwitchValue, _resetMirrorSwitchForTests } from "../killSwitch";
import { _resetServingForTests } from "../serving";
import { _resetMirrorSignalForTests } from "../mirrorSignal";
import {
  noteMirrorOpened, wipeLedger, storageSnapshot, STORAGE_LEDGER_KEY, _resetStorageHealthForTests,
} from "../storageHealth";
import { deviceRecord, worthWriting } from "../deviceHealth";

// A database exactly as the browser hands one over after it has deleted the
// last: open, and with nothing in it — not even the schema stamp.
let n = 0;
const emptyDb = () => openMirrorDb({ indexedDBFactory: new IDBFactory(), dbName: `storage-health-${++n}` });

const T0 = Date.UTC(2026, 8, 23, 8, 0);        // 10:00 SAST
const DAY = 24 * 3600_000;

async function startOn(db, now = () => T0) {
  const w = createFakeRtdb({ locations: { hub1: { id: "hub1" } } });
  const rt = await startOfflineMirror({
    auth: { currentUser: { uid: "u1", isAnonymous: false } },
    storage: null, buildVersion: "test", now,
    setTimeoutFn: () => 0, clearTimeoutFn: () => {},
    openDb: async () => db,
    makeAdapter: () => w.adapter,
  });
  return { rt, w };
}

beforeEach(() => {
  store.clear();
  _resetMirrorSwitchForTests();
  _resetServingForTests();
  _resetMirrorSignalForTests();
  _resetStorageHealthForTests();
  setMirrorSwitchValue(true);
});

describe("the ledger", () => {
  test("a first-ever open is not a wipe", () => {
    expect(noteMirrorOpened({ hadSchema: false, now: () => T0 })).toMatchObject({ wipes: 0, hadCopy: true });
  });
  test("a copy that is still there is not a wipe", () => {
    noteMirrorOpened({ hadSchema: false, now: () => T0 });
    expect(noteMirrorOpened({ hadSchema: true, now: () => T0 }).wipes).toBe(0);
  });
  test("a copy that vanished IS, counted per SAST day", () => {
    noteMirrorOpened({ hadSchema: false, now: () => T0 });
    noteMirrorOpened({ hadSchema: false, now: () => T0 + 1 });
    noteMirrorOpened({ hadSchema: false, now: () => T0 + 2 });
    expect(wipeLedger({ now: () => T0 + 3 })).toEqual({ wipes: 2, wipesToday: 2, lastWipeAt: T0 + 2 });
    expect(wipeLedger({ now: () => T0 + DAY })).toMatchObject({ wipes: 2, wipesToday: 0 });
    noteMirrorOpened({ hadSchema: false, now: () => T0 + DAY });
    expect(wipeLedger({ now: () => T0 + DAY })).toMatchObject({ wipes: 3, wipesToday: 1 });
  });
  test("a corrupt ledger is a fresh one, never a throw", () => {
    store.set(STORAGE_LEDGER_KEY, "{nope");
    expect(noteMirrorOpened({ hadSchema: false, now: () => T0 }).wipes).toBe(0);
  });
});

describe("through the real start", () => {
  test("same database twice: no wipe. A new, empty one: one wipe, in the report", async () => {
    const db = await emptyDb();
    (await startOn(db)).rt.stop();
    (await startOn(db)).rt.stop();
    expect(wipeLedger({ now: () => T0 }).wipes).toBe(0);

    // The browser deleted the database: the next open finds a new, empty one.
    const evicted = await emptyDb();
    const { rt, w } = await startOn(evicted, () => T0 + 60_000);
    expect(wipeLedger({ now: () => T0 + 60_000 })).toMatchObject({ wipes: 1, wipesToday: 1, lastWipeAt: T0 + 60_000 });

    await rt.reportHealth();
    const written = w.calls.writePath.find((c) => c.path.startsWith("mirror_devices/"));
    expect(written?.value?.storage).toMatchObject({ wipes: 1, wipesToday: 1, lastWipeAt: T0 + 60_000 });
    rt.stop();
  });

  test("a deliberate delete (purgeEverything) is not counted as a wipe", async () => {
    const db = await emptyDb();
    (await startOn(db)).rt.stop();
    await db.purgeEverything();
    (await startOn(db)).rt.stop();
    expect(wipeLedger({ now: () => T0 }).wipes).toBe(0);
  });
});

describe("persisted, and the record", () => {
  test("persisted() is read at report time; absent API reports null, never a throw", async () => {
    const saved = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });
    expect((await storageSnapshot({ now: () => T0 })).persisted).toBeNull();
    Object.defineProperty(globalThis, "navigator", {
      value: { storage: { persisted: async () => false, estimate: async () => ({ usage: 12_345_678, quota: 50_000_000 }) } },
      configurable: true,
    });
    expect(await storageSnapshot({ now: () => T0 })).toMatchObject({ persisted: false, usageMB: 12.3, quotaMB: 50 });
    Object.defineProperty(globalThis, "navigator", { value: saved, configurable: true });
  });

  test("a new wipe is written at once, not after the 10-minute floor", () => {
    const base = { deviceId: "d1", label: "x", now: () => T0 };
    const a = deviceRecord({ ...base, storage: { persisted: false, wipes: 1, wipesToday: 1 } });
    const b = deviceRecord({ ...base, now: () => T0 + 1000, storage: { persisted: false, wipes: 2, wipesToday: 2 } });
    expect(worthWriting(a, b)).toBe(true);
    const c = deviceRecord({ ...base, now: () => T0 + 1000, storage: { persisted: true, wipes: 1, wipesToday: 1 } });
    expect(worthWriting(a, c)).toBe(true);
    const same = deviceRecord({ ...base, now: () => T0 + 1000, storage: { persisted: false, wipes: 1, wipesToday: 1 } });
    expect(worthWriting(a, same)).toBe(false);
  });
});

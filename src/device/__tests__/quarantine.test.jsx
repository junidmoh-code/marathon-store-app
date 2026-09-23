// ─── DEVICE QUARANTINE, PROVED ON THE THINGS THAT COULD GO WRONG ─────────────
//
// The quarantine exists to find ONE phone. The failure that matters is not
// "the message did not appear" — that costs the owner a walk round the shop.
// It is the message appearing on a device it was not meant for, on every
// device at once, or over a sale in progress. So most of this file is about
// NOT showing it:
//
//   · per device: a flag on another id, or on the parent node, shows nothing;
//   · fail open: a throw, a refused read, a malformed value, a stale or
//     foreign cache, no device id — every one of them shows nothing;
//   · never over a job: a busy device waits, and the moment it is idle the
//     message appears;
//   · the clear reaches the device live and takes the message down.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const THIS = "57070bab-8813-4164-9165-2f16fd7f9244";
const OTHER = "d6bb8389-7f13-481b-9437-2544117c9a9d";
let deviceIdImpl = () => THIS;
vi.mock("../deviceId", () => ({ getDeviceId: () => deviceIdImpl() }));
vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (auth, cb) => { cb(auth.user); return () => {}; },
}));
let busyNow = false;
vi.mock("../../update/updateChecker", () => ({ isUpdateBusy: () => busyNow }));

const {
  quarantineVerdict, quarantinePath, validDeviceId, watchQuarantine, shouldShowNow,
  readCachedQuarantine, writeCachedQuarantine, QUARANTINE_CACHE_KEY, CACHE_TRUST_MS, QUIET_MS,
  quarantineRecord,
} = await import("../quarantine");
const DeviceQuarantine = (await import("../DeviceQuarantine.jsx")).default;

// A fake database: a map of path → value, and the listeners on each path.
function fakeDb(initial = {}) {
  const values = new Map(Object.entries(initial));
  const listeners = new Map();
  const paths = [];
  return {
    paths,
    subscribe: vi.fn((path, onAnswer) => {
      paths.push(path);
      if (!listeners.has(path)) listeners.set(path, new Set());
      listeners.get(path).add(onAnswer);
      onAnswer(values.has(path) ? values.get(path) : null);
      return () => listeners.get(path).delete(onAnswer);
    }),
    write(path, v) {
      values.set(path, v);
      for (const l of listeners.get(path) ?? []) l(v);
    },
  };
}

const SIGNED_IN = { user: { uid: "vWfHqbLEPvRMItXhH0B9NvYW0LG3", isAnonymous: false } };
const flagPath = (id) => `mirror_switch/quarantine/${id}`;

// Loaded here so the component's own dynamic import resolves at once; a cold
// import under a busy multi-file run took longer than any fixed tick count.
await import("firebase/auth");

// Every tree is unmounted after its test: a live instance left behind keeps
// its interval and subscription running into the next test's fake timers.
const mounted = [];
async function mount(props) {
  let tree;
  await act(async () => { tree = TestRenderer.create(<DeviceQuarantine {...props} />); });
  mounted.push(tree);
  // The auth listener is behind a dynamic import: flush until it has run.
  for (let i = 0; i < 20; i++) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return tree;
}
const text = (tree) => JSON.stringify(tree.toJSON() ?? "");
const showing = (tree) => /Show this screen to Junid/.test(text(tree));

beforeEach(() => {
  store.clear();
  busyNow = false;
  deviceIdImpl = () => THIS;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-23T10:00:00Z"));
});
afterEach(() => {
  for (const t of mounted.splice(0)) { try { act(() => t.unmount()); } catch { /* already gone */ } }
  vi.useRealTimers();
});

describe("what the flag means", () => {
  it("only something written on purpose is ON", () => {
    expect(quarantineVerdict(true)).toBe(true);
    expect(quarantineVerdict({ on: true, at: 1 })).toBe(true);
    for (const v of [null, undefined, false, 0, 1, "true", "on", {}, { on: "true" }, { on: 1 }, [true], { on: false }]) {
      expect(quarantineVerdict(v), JSON.stringify(v)).toBe(false);
    }
  });

  it("the record the owner writes reads back as ON", () => {
    expect(quarantineVerdict(quarantineRecord({ by: "gunidmoh@gmail.com", now: () => 5 }))).toBe(true);
  });

  it("a path always names ONE device, and never the list", () => {
    expect(quarantinePath(THIS)).toBe(flagPath(THIS));
    for (const bad of [null, undefined, "", "a/b", "../x", "short", "   ", 42, "x".repeat(65), "a.b.c.d.e"]) {
      expect(quarantinePath(bad), String(bad)).toBeNull();
      expect(validDeviceId(bad)).toBe(false);
    }
  });
});

describe("per device, never account-wide or fleet-wide", () => {
  it("listens to its own flag and nothing else", async () => {
    const db = fakeDb();
    await mount({ auth: SIGNED_IN, subscribe: db.subscribe });
    expect(db.paths).toEqual([flagPath(THIS)]);
  });

  it("a flag on ANOTHER device shows nothing here", async () => {
    const db = fakeDb({ [flagPath(OTHER)]: { on: true } });
    const tree = await mount({ auth: SIGNED_IN, subscribe: db.subscribe });
    expect(showing(tree)).toBe(false);
  });

  it("a value on the PARENT node (a fleet-wide 'on') shows nothing", async () => {
    const db = fakeDb({ "mirror_switch/quarantine": { on: true }, mirror_switch: { on: true } });
    const tree = await mount({ auth: SIGNED_IN, subscribe: db.subscribe });
    expect(showing(tree)).toBe(false);
  });

  it("the flagged device shows the message, with its own id on it", async () => {
    const db = fakeDb({ [flagPath(THIS)]: { on: true, at: 1 } });
    const tree = await mount({ auth: SIGNED_IN, subscribe: db.subscribe });
    expect(showing(tree)).toBe(true);
    expect(text(tree)).toContain(THIS);
    // Not dismissible: there is nothing on it to press.
    expect(tree.root.findAll((n) => n.type === "button")).toHaveLength(0);
  });
});

describe("FAILS OPEN — every doubt is no message", () => {
  it("a subscription that throws shows nothing and does not break the app", async () => {
    const subscribe = vi.fn(() => { throw new Error("boom"); });
    const tree = await mount({ auth: SIGNED_IN, subscribe });
    expect(showing(tree)).toBe(false);
  });

  it("a refused read (PERMISSION_DENIED) shows nothing", async () => {
    const subscribe = vi.fn((_p, _ok, onError) => { onError(new Error("permission_denied")); return () => {}; });
    const tree = await mount({ auth: SIGNED_IN, subscribe });
    expect(showing(tree)).toBe(false);
  });

  it("a malformed value shows nothing", async () => {
    for (const v of ["true", 1, { on: "yes" }, [true]]) {
      store.clear();
      const db = fakeDb({ [flagPath(THIS)]: v });
      const tree = await mount({ auth: SIGNED_IN, subscribe: db.subscribe });
      expect(showing(tree), JSON.stringify(v)).toBe(false);
    }
  });

  it("a throw inside the component renders nothing (the error boundary)", async () => {
    deviceIdImpl = () => { throw new Error("storage exploded"); };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const tree = await mount({ auth: SIGNED_IN, subscribe: fakeDb().subscribe });
    expect(tree.toJSON()).toBeNull();
    warn.mockRestore(); err.mockRestore();
  });

  it("a device with no id (private mode) never subscribes and never shows", async () => {
    deviceIdImpl = () => null;
    const db = fakeDb();
    const tree = await mount({ auth: SIGNED_IN, subscribe: db.subscribe });
    expect(db.subscribe).not.toHaveBeenCalled();
    expect(showing(tree)).toBe(false);
  });

  it("a cache about ANOTHER device, a stale cache, or a corrupt cache is not trusted", () => {
    const now = () => Date.now();
    store.set(QUARANTINE_CACHE_KEY, JSON.stringify({ deviceId: OTHER, on: true, heardAt: now() }));
    expect(readCachedQuarantine(THIS)).toBe(false);
    store.set(QUARANTINE_CACHE_KEY, JSON.stringify({ deviceId: THIS, on: true, heardAt: now() - CACHE_TRUST_MS - 1 }));
    expect(readCachedQuarantine(THIS)).toBe(false);
    store.set(QUARANTINE_CACHE_KEY, "{not json");
    expect(readCachedQuarantine(THIS)).toBe(false);
    store.set(QUARANTINE_CACHE_KEY, JSON.stringify({ deviceId: THIS, on: true, heardAt: now() }));
    expect(readCachedQuarantine(THIS)).toBe(true);
  });

  it("never shows over a session that is not signed in — it could not hear the clear", async () => {
    writeCachedQuarantine(THIS, true);
    const tree = await mount({ auth: { user: null }, subscribe: fakeDb().subscribe });
    expect(showing(tree)).toBe(false);
  });

  it("an anonymous session (the TV shell) never subscribes", async () => {
    const db = fakeDb({ [flagPath(THIS)]: true });
    const tree = await mount({ auth: { user: { uid: "anon", isAnonymous: true } }, subscribe: db.subscribe });
    expect(db.subscribe).not.toHaveBeenCalled();
    expect(showing(tree)).toBe(false);
  });
});

describe("never over a job in progress", () => {
  it("the rule: busy waits; idle, or untouched since opening, shows", () => {
    expect(shouldShowNow({ quarantined: true, busy: true, msSinceActivity: 1e9, untouched: true })).toBe(false);
    expect(shouldShowNow({ quarantined: true, busy: false, msSinceActivity: 0, untouched: true })).toBe(true);
    expect(shouldShowNow({ quarantined: true, busy: false, msSinceActivity: QUIET_MS - 1, untouched: false })).toBe(false);
    expect(shouldShowNow({ quarantined: true, busy: false, msSinceActivity: QUIET_MS, untouched: false })).toBe(true);
    expect(shouldShowNow({ quarantined: false, busy: false, msSinceActivity: 1e9, untouched: true })).toBe(false);
  });

  it("a device with a cart open waits, and shows the moment the cart is done", async () => {
    busyNow = true;
    const db = fakeDb({ [flagPath(THIS)]: { on: true } });
    const tree = await mount({ auth: SIGNED_IN, subscribe: db.subscribe });
    expect(showing(tree)).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(showing(tree)).toBe(false);
    busyNow = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(showing(tree)).toBe(true);
  });

  it("cleared then flagged again while a cart is open still waits for the cart", async () => {
    const db = fakeDb({ [flagPath(THIS)]: { on: true } });
    const tree = await mount({ auth: SIGNED_IN, subscribe: db.subscribe });
    expect(showing(tree)).toBe(true);
    await act(async () => { db.write(flagPath(THIS), null); });
    busyNow = true;
    await act(async () => { db.write(flagPath(THIS), { on: true }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(showing(tree)).toBe(false);
    busyNow = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(showing(tree)).toBe(true);
  });

  it("the app underneath is never unmounted: the message is rendered BESIDE it", async () => {
    // main.jsx renders <DeviceQuarantine/> as a sibling of <MirrorGate><App/>,
    // never as a wrapper — so there are no children to take away.
    const fs = await import("node:fs");
    const main = fs.readFileSync(new URL("../../main.jsx", import.meta.url), "utf8");
    expect(main).toMatch(/<\/MirrorGate>\s*\{\/\*[^]*?\*\/\}\s*<DeviceQuarantine auth=\{auth\} \/>/);
  });
});

describe("the clear reaches the device live", () => {
  it("clearing the flag takes the message down with no reload, and forgets the cache", async () => {
    const db = fakeDb({ [flagPath(THIS)]: { on: true } });
    const tree = await mount({ auth: SIGNED_IN, subscribe: db.subscribe });
    expect(showing(tree)).toBe(true);
    expect(readCachedQuarantine(THIS)).toBe(true);
    await act(async () => { db.write(flagPath(THIS), null); });
    expect(showing(tree)).toBe(false);
    expect(store.has(QUARANTINE_CACHE_KEY)).toBe(false);
  });

  it("setting the flag on an open device shows it without a reload", async () => {
    const db = fakeDb();
    const tree = await mount({ auth: SIGNED_IN, subscribe: db.subscribe });
    expect(showing(tree)).toBe(false);
    await act(async () => { db.write(flagPath(THIS), { on: true }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(showing(tree)).toBe(true);
  });

  it("watchQuarantine's teardown stops listening", () => {
    const db = fakeDb();
    const onChange = vi.fn();
    const stop = watchQuarantine({ deviceId: THIS, subscribe: db.subscribe, onChange });
    stop();
    db.write(flagPath(THIS), true);
    expect(onChange).toHaveBeenCalledTimes(1);     // the first answer only
  });
});

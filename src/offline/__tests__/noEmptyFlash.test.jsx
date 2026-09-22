// ─── A LINE MUST NEVER VANISH WHILE IT STILL EXISTS ──────────────────────────
//
// 21 Sep 2026, the mirror back on: staff on the refill screens watched the
// whole list of refill requests go EMPTY, come back, and go empty again every
// few seconds, and could not fulfil a size because the line disappeared under
// their finger. Nothing was deleted; the rows were in the database the whole
// time.
//
// The cause was the hook, not the data. Every change-feed pass that applied
// anything bumped every change-fed leg's version, and useMirroredPath answered
// a version bump by resetting itself to "pending" — value null — before it
// started the local re-read. usePathState hands "pending" straight to the
// screen, so for the length of an IndexedDB rebuild of /refill_requests the
// screen was told there were none. The feed signals a pass ~400 ms after any
// /mirror_changes write — an order, a stock move, anybody's — so on a busy
// morning that was every few seconds.
//
// So these tests record EVERY render the real usePathState produces while the
// real sync engine applies real change-feed pages, while the kill switch
// flips, and while the serving hint flips, and assert the one property staff
// need: between two renders that showed rows, no render showed none.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// The live read, for the source-switch tests. Answers a moment later, as the
// real one does, so the gap between "opened" and "answered" is visible.
let liveTree = {};
const onValue = vi.fn((r, cb) => {
  const t = setTimeout(() => {
    let node = liveTree;
    for (const s of r.path.split("/")) node = node == null ? undefined : node[s];
    // RTDB holds no empty objects: an emptied node reads back null.
    const empty = node == null || (typeof node === "object" && Object.keys(node).length === 0);
    cb({ val: () => (empty ? null : structuredClone(node)) });
  }, 5);
  return () => clearTimeout(t);
});

vi.mock("firebase/database", () => ({
  ref: (db, path) => ({ path }),
  onValue: (...args) => onValue(...args),
  query: (r) => r,
  orderByKey: () => ({}),
  orderByChild: () => ({}),
  startAt: () => ({}),
  startAfter: () => ({}),
  endAt: () => ({}),
  limitToFirst: () => ({}),
  limitToLast: () => ({}),
  get: vi.fn(),
  update: vi.fn(),
  push: vi.fn(),
  runTransaction: vi.fn(),
  equalTo: () => ({}),
  set: vi.fn(),
  remove: vi.fn(),
  serverTimestamp: () => ({}),
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

import { freshMirrorDb } from "./helpers";
import { createFakeRtdb, pushKeyForMs } from "./fakeAdapter";
import { createSyncEngine } from "../sync";
import { CHANGES_ROOT } from "../changeFeed";
import { setMirrorSwitchValue, _resetMirrorSwitchForTests } from "../killSwitch";
import { setServingLegs, _resetServingForTests } from "../serving";
import { bumpLegs, _resetMirrorSignalForTests } from "../mirrorSignal";
import { _resetMirrorDbHandleForTests } from "../mirrorDbHandle";
import { MIRROR_LEGS } from "../nodes";

const T0 = 1_780_000_000_000;

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

const REFILLS = {
  r1: { status: "open", productId: "p1", size: "9", qty: 1, requestingLocation: "marathon-pe" },
  r2: { status: "open", productId: "p1", size: "10", qty: 2, requestingLocation: "marathon-pe" },
};

let world;
let engine;
async function seedMirror() {
  testDb = await freshMirrorDb();
  const initial = {
    locations: { hub1: { id: "hub1" } },
    users: { u1: { name: "Zee" } },
    products: { p1: { id: "p1", name: "Nike Air", price: 1200 } },
    stock: { hub1: { p1: { 9: { qty: 3, v: 0 } } } },
    orders: { "001": { id: "001" } },
    customers: { c1: { name: "Ndu" } },
    refill_requests: REFILLS,
  };
  liveTree = structuredClone(initial);
  world = createFakeRtdb(initial);
  engine = createSyncEngine({ db: testDb, adapter: world.adapter, now: () => T0, buildVersion: "b" });
  await engine.runSetup();
  setServingLegs(MIRROR_LEGS.map((l) => l.name));
}

// What bootstrap.js's runOnePass does after a pass: wake the screens.
const CHANGE_FED = MIRROR_LEGS.filter((l) => l.feed === "changes").map((l) => l.name);
let seq = 0;
async function feedTick(node, key, value) {
  seq += 1;
  const segs = [node, ...key.split("|")];
  world.write(segs.join("/"), value);
  // The live read sees the same database.
  let n = liveTree;
  for (const sg of segs.slice(0, -1)) n = (n[sg] ??= {});
  if (value === null) delete n[segs.at(-1)]; else n[segs.at(-1)] = structuredClone(value);
  const at = T0 + seq * 1000;
  world.write(`${CHANGES_ROOT}/${pushKeyForMs(at, `K${String(seq).padStart(11, "0")}`)}`, { n: node, k: key, t: at });
  const report = await engine.runPass();
  // A repair of a leg the test emptied on purpose may complain; the feed may not.
  expect(report.errors.filter((e) => e.where !== "repair")).toEqual([]);
  if ((report.feed?.applied ?? 0) + (report.feed?.deleted ?? 0) > 0) bumpLegs(CHANGE_FED);
}

// Every render, in order. The Probe pushes what the screen was handed.
function mount(hook) {
  const renders = [];
  function Probe() {
    const s = hook();
    renders.push(s);
    return null;
  }
  let tree;
  act(() => { tree = TestRenderer.create(React.createElement(Probe)); });
  return { renders, unmount: () => act(() => tree.unmount()) };
}

async function settle(n = 20) {
  for (let i = 0; i < n; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 1)); });
  }
}

const rowCount = (s) => (s && s.value && typeof s.value === "object" ? Object.keys(s.value).length : 0);

// THE PROPERTY. Once the screen has shown rows, it never shows none until the
// database really has none.
function expectNoEmptyFlash(renders) {
  const counts = renders.map(rowCount);
  const first = counts.findIndex((c) => c > 0);
  expect(first).toBeGreaterThanOrEqual(0);
  const flashes = [];
  for (let i = first + 1; i < counts.length; i += 1) if (counts[i] === 0) flashes.push(i);
  expect({ flashes, counts }).toEqual({ flashes: [], counts });
}

beforeEach(() => {
  onValue.mockClear();
  _resetServingForTests();
  _resetMirrorSignalForTests();
  _resetMirrorDbHandleForTests();
  _resetMirrorSwitchForTests();
  setMirrorSwitchValue(true);
});
afterEach(() => {
  _resetMirrorSwitchForTests();
  _resetServingForTests();
});

describe("the refill list never goes empty while its rows exist", () => {
  it("through change-feed ticks on OTHER nodes (an order, a stock move)", async () => {
    await seedMirror();
    const { usePathState } = await import("../../components/stock/useStock");
    const h = mount(() => usePathState("refill_requests"));
    await settle();
    expect(rowCount(h.renders.at(-1))).toBe(2);
    expect(onValue).not.toHaveBeenCalled();

    for (let i = 0; i < 6; i += 1) {
      await act(async () => { await feedTick("orders", `00${i + 2}`, { id: `00${i + 2}` }); });
      await act(async () => { await feedTick("stock", "hub1|p1", { 9: { qty: 3 - (i % 2), v: i + 1 } }); });
      await settle(5);
    }
    await settle();

    expectNoEmptyFlash(h.renders);
    expect(rowCount(h.renders.at(-1))).toBe(2);
    expect(onValue).not.toHaveBeenCalled();           // still no live read
    h.unmount();
  });

  it("through change-feed ticks on /refill_requests itself — and shows the change", async () => {
    await seedMirror();
    const { usePathState } = await import("../../components/stock/useStock");
    const h = mount(() => usePathState("refill_requests"));
    await settle();

    await act(async () => { await feedTick("refill_requests", "r3", { status: "open", productId: "p1", size: "11", qty: 1 }); });
    await settle(5);
    await act(async () => { await feedTick("refill_requests", "r1", { ...REFILLS.r1, status: "fulfilled" }); });
    await settle();

    expectNoEmptyFlash(h.renders);
    const last = h.renders.at(-1).value;
    expect(Object.keys(last).sort()).toEqual(["r1", "r2", "r3"]);
    expect(last.r1.status).toBe("fulfilled");
    h.unmount();
  });

  it("through a stock line's own ticks (the fulfil screen reads /stock/{loc})", async () => {
    await seedMirror();
    const { usePathState } = await import("../../components/stock/useStock");
    const h = mount(() => usePathState("stock/hub1"));
    await settle();
    for (let i = 0; i < 4; i += 1) {
      await act(async () => { await feedTick("stock", "hub1|p1", { 9: { qty: 2 + i, v: i + 1 } }); });
      await settle(3);
    }
    await settle();
    expectNoEmptyFlash(h.renders);
    expect(h.renders.at(-1).value.p1[9].qty).toBe(5);
    h.unmount();
  });

  it("through the kill switch going OFF and back ON (mirror → live → mirror)", async () => {
    await seedMirror();
    const { usePathState } = await import("../../components/stock/useStock");
    const h = mount(() => usePathState("refill_requests"));
    await settle();

    await act(async () => { setMirrorSwitchValue(false); });
    await settle();
    expect(onValue).toHaveBeenCalledTimes(1);
    await act(async () => { setMirrorSwitchValue(true); });
    await settle();
    await act(async () => { setMirrorSwitchValue(false); });
    await settle();

    expectNoEmptyFlash(h.renders);
    expect(rowCount(h.renders.at(-1))).toBe(2);
    h.unmount();
  });

  it("through the serving hint flipping (a leg going unusable and back)", async () => {
    await seedMirror();
    const { usePathState } = await import("../../components/stock/useStock");
    const h = mount(() => usePathState("refill_requests"));
    await settle();

    for (let i = 0; i < 3; i += 1) {
      await act(async () => { setServingLegs(MIRROR_LEGS.map((l) => l.name).filter((n) => n !== "refills")); });
      await settle();
      await act(async () => { setServingLegs(MIRROR_LEGS.map((l) => l.name)); });
      await settle();
    }
    expectNoEmptyFlash(h.renders);
    expect(rowCount(h.renders.at(-1))).toBe(2);
    h.unmount();
  });

  it("but DOES go empty when the database really is empty — the hold is not a lie", async () => {
    await seedMirror();
    const { usePathState } = await import("../../components/stock/useStock");
    const h = mount(() => usePathState("refill_requests"));
    await settle();
    await act(async () => { await feedTick("refill_requests", "r1", null); });
    await settle(5);
    await act(async () => { await feedTick("refill_requests", "r2", null); });
    await settle();
    const last = h.renders.at(-1);
    expect(last.settled).toBe(true);
    expect(last.value).toBe(null);
    h.unmount();
  });

  it("and a DIFFERENT path never shows the old path's rows while it loads", async () => {
    await seedMirror();
    const { usePathState } = await import("../../components/stock/useStock");
    let path = "stock/hub1";
    const h = mount(() => usePathState(path));
    await settle();
    expect(h.renders.at(-1).value.p1).toBeTruthy();
    path = "refill_requests";
    const before = h.renders.length;
    await act(async () => { bumpLegs(["stock"]); });     // re-render with the new path
    await settle();
    for (const s of h.renders.slice(before)) {
      if (s.value) expect(s.value.p1).toBeUndefined();   // never /stock/hub1's rows
    }
    expect(rowCount(h.renders.at(-1))).toBe(2);
    h.unmount();
  });
});

// ─── THE WHOLE POINT, PROVED AS A NUMBER ─────────────────────────────────────
//
// The saving is not "the screen renders from IndexedDB". The saving is that
// the live onValue is NEVER OPENED. Opening one costs the whole node — 4.7 MB
// for /products, 6.9 MB for /stock — and closing it a moment later when the
// local read resolves does not refund a byte.
//
// So these tests count onValue calls. A version of this work that read locally
// AND subscribed would pass every other test in this directory and save
// nothing at all, which is exactly the failure "test the number, not the
// title" names.
//
// Rendered through react-test-renderer, like every other component test here.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const onValue = vi.fn(() => () => {});

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
import { createFakeRtdb } from "./fakeAdapter";
import { createSyncEngine } from "../sync";
import { setOfflineMirrorEnabled } from "../mirrorFlag";
import { setMirrorSwitchValue, _resetMirrorSwitchForTests } from "../killSwitch";
import { setServingLegs, _resetServingForTests } from "../serving";
import { _resetMirrorSignalForTests } from "../mirrorSignal";
import { _resetMirrorDbHandleForTests } from "../mirrorDbHandle";
import { MIRROR_LEGS } from "../nodes";

const T0 = 1_780_000_000_000;

// vitest runs these in the `node` environment, which has no localStorage — and
// BOTH the mirror flag and the serving hint live there, because a hook has to
// know which source it is on synchronously, before its first render. Without
// this stub every test below would exercise the flag-off path and pass for the
// wrong reason.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

// The mirror's read-side handle is a module-level singleton; point it at the
// test's database rather than a real IndexedDB.
let testDb = null;
vi.mock("../mirrorDbHandle", async (orig) => {
  const real = await orig();
  return { ...real, getMirrorDbHandle: () => Promise.resolve(testDb) };
});

async function seedMirror() {
  testDb = await freshMirrorDb();
  const w = createFakeRtdb({
    locations: { hub1: { id: "hub1" } },
    users: { u1: { name: "Zee" } },
    products: { p1: { id: "p1", name: "Nike Air", price: 1200 } },
    stock: { hub1: { p1: { 9: { qty: 3, v: 0 } } } },
    orders: { "001": { id: "001" } },
    customers: { c1: { name: "Ndu" } },
    refill_requests: { r1: { status: "open" } },
  });
  await createSyncEngine({ db: testDb, adapter: w.adapter, now: () => T0, buildVersion: "b" }).runSetup();
  setServingLegs(MIRROR_LEGS.map((l) => l.name));
}

function Probe({ hook }) {
  const value = hook();
  return React.createElement("div", null, JSON.stringify(value ?? null));
}

// The local read chain is several IndexedDB transactions deep, so flushing two
// microtasks is not enough — a harness that under-flushes reads as "the mirror
// answered null", which is the one answer this file must never confuse with a
// real one. Flush real macrotasks until the value settles.
async function renderHook(hook) {
  let tree;
  await act(async () => {
    tree = TestRenderer.create(React.createElement(Probe, { hook }));
  });
  for (let i = 0; i < 20; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const json = tree.toJSON();
    const parsed = JSON.parse(json.children[0]);
    if (parsed && parsed.settled) break;
  }
  return tree;
}

beforeEach(() => {
  onValue.mockClear();
  _resetServingForTests();
  _resetMirrorSignalForTests();
  _resetMirrorDbHandleForTests();
  _resetMirrorSwitchForTests();
  setOfflineMirrorEnabled(true);
  // A device mirrors only if it is in the rollout AND the fleet switch is on.
  setMirrorSwitchValue(true);
});
afterEach(() => {
  setOfflineMirrorEnabled(false);
  _resetServingForTests();
});

describe("a device serving from its local copy", () => {
  it("NEVER opens the live subscription for a mirrored path", async () => {
    await seedMirror();
    const { usePathState } = await import("../../components/stock/useStock");
    const tree = await renderHook(() => usePathState("stock/hub1"));
    expect(onValue).not.toHaveBeenCalled();
    const rendered = JSON.parse(tree.toJSON().children[0]);
    expect(rendered.value).toEqual({ p1: { 9: { qty: 3, v: 0 } } });
    expect(rendered.settled).toBe(true);
    tree.unmount();
  });

  it("does not open one on the FIRST render either — the decision is synchronous", async () => {
    // An asynchronous decision would open the subscription, pay the node, and
    // close it. This is the test that catches that, because every other one
    // would pass.
    await seedMirror();
    const { usePathState } = await import("../../components/stock/useStock");
    let tree;
    act(() => { tree = TestRenderer.create(React.createElement(Probe, { hook: () => usePathState("products") })); });
    expect(onValue).not.toHaveBeenCalled();
    await act(async () => { await Promise.resolve(); });
    expect(onValue).not.toHaveBeenCalled();
    tree.unmount();
  });
});

describe("a device NOT serving from its local copy", () => {
  it("opens the live subscription exactly as it always did", async () => {
    await seedMirror();
    setServingLegs([]);                      // the mirror is not serving
    const { usePathState } = await import("../../components/stock/useStock");
    const tree = await renderHook(() => usePathState("stock/hub1"));
    expect(onValue).toHaveBeenCalledTimes(1);
    expect(onValue.mock.calls[0][0]).toEqual({ path: "stock/hub1" });
    tree.unmount();
  });

  it("opens one with the FLAG OFF, however healthy the local copy is", async () => {
    await seedMirror();
    setOfflineMirrorEnabled(false);
    const { usePathState } = await import("../../components/stock/useStock");
    const tree = await renderHook(() => usePathState("stock/hub1"));
    expect(onValue).toHaveBeenCalledTimes(1);
    tree.unmount();
  });

  it("opens one for a path NO leg covers, even while serving everything else", async () => {
    await seedMirror();
    const { usePathState } = await import("../../components/stock/useStock");
    const tree = await renderHook(() => usePathState("laybys"));
    expect(onValue).toHaveBeenCalledTimes(1);
    expect(onValue.mock.calls[0][0]).toEqual({ path: "laybys" });
    tree.unmount();
  });

  it("FALLS BACK when the hint is stale — a wrong hint costs a check, not a blank screen", async () => {
    // The hint lives in localStorage and the rows live in IndexedDB. They can
    // disagree: a purge, another tab, a half-cleared profile.
    testDb = await freshMirrorDb();               // no rows, no health records
    setServingLegs(["stock"]);
    const { usePathState } = await import("../../components/stock/useStock");
    const tree = await renderHook(() => usePathState("stock/hub1"));
    expect(onValue).toHaveBeenCalledTimes(1);
    tree.unmount();
  });
});

// ─── THE KILL SWITCH, AT THE ONE PLACE IT HAS TO WORK ───────────────────────
//
// Not "the boolean changed" — that is killSwitch.test.js. This is the claim
// the rollout rests on: a tablet that is ALREADY rendering from its local copy,
// left open on one screen, with nobody touching it, opens its live
// subscription the moment the switch goes false. No reload, no navigation, no
// remount. If this test is deleted the switch still passes every other test in
// the suite and is a note in a runbook rather than a control.
describe("the fleet kill switch", () => {
  it("puts a screen that is ALREADY serving locally back on the live read, with no reload", async () => {
    await seedMirror();
    const { usePathState } = await import("../../components/stock/useStock");
    const tree = await renderHook(() => usePathState("stock/hub1"));
    expect(onValue).not.toHaveBeenCalled();          // serving locally…

    await act(async () => { setMirrorSwitchValue(false); });   // …and killed
    for (let i = 0; i < 5; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }

    expect(onValue).toHaveBeenCalledTimes(1);
    expect(onValue.mock.calls[0][0]).toEqual({ path: "stock/hub1" });
    tree.unmount();
  });

  it("a device with the switch OFF never reads locally, however healthy its copy", async () => {
    await seedMirror();
    setMirrorSwitchValue(false);
    const { usePathState } = await import("../../components/stock/useStock");
    const tree = await renderHook(() => usePathState("products"));
    expect(onValue).toHaveBeenCalledTimes(1);
    tree.unmount();
  });

  it("and comes back onto the local copy when the switch goes back on", async () => {
    await seedMirror();
    setMirrorSwitchValue(false);
    const { usePathState } = await import("../../components/stock/useStock");
    const tree = await renderHook(() => usePathState("stock/hub1"));
    expect(onValue).toHaveBeenCalledTimes(1);

    await act(async () => { setMirrorSwitchValue(true); });
    for (let i = 0; i < 20; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      const parsed = JSON.parse(tree.toJSON().children[0]);
      if (parsed && parsed.settled) break;
    }
    const rendered = JSON.parse(tree.toJSON().children[0]);
    expect(rendered.value).toEqual({ p1: { 9: { qty: 3, v: 0 } } });
    tree.unmount();
  });
});

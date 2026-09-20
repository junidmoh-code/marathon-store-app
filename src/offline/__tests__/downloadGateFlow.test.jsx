// ─── THE DOWNLOAD MUST NEVER STAND BETWEEN STAFF AND THE APP ─────────────────
//
// PR #618 held the whole app behind a progress bar until 104 MB had landed.
// On a shop floor that is a member of staff standing in front of a customer
// waiting for a bar. These tests are the claim that replaced it, stated as
// behaviour rather than as intent:
//
//   · the app renders underneath the gate, always — including while it is up
//   · one tap opens it, IMMEDIATELY, without awaiting a single byte
//   · a device that has already tapped is never asked again; it resumes
//   · nothing serves locally until the copy is complete and verified
//
// The gate is rendered through react-test-renderer, like every other component
// test here, against a fake runtime with the same surface bootstrap.js returns.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let authUser = { uid: "u1", isAnonymous: false };
vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (auth, cb) => { cb(authUser); return () => {}; },
}));
vi.mock("firebase/database", () => ({
  ref: (db, path) => ({ path }),
  onValue: () => () => {},
}));
vi.mock("../../firebase", () => ({ database: {}, auth: {}, storage: {} }));

// The gate imports bootstrap dynamically. This is the runtime it gets.
//
// `startCalls` and `deferStart` exist for the orphan tests at the bottom: a
// start is not a pure constructor — by the time it resolves it has opened
// IndexedDB, started the connection tracker and registered an auth listener
// that schedules passes by itself — so building two is building two engines.
let runtime = null;
let startCalls = 0;
let deferred = null;
vi.mock("../bootstrap", () => ({
  startOfflineMirror: async () => {
    startCalls += 1;
    if (deferred) await deferred.promise;
    return runtime;
  },
}));
function deferStart() {
  let release;
  deferred = { promise: new Promise((r) => { release = r; }) };
  return () => { const d = deferred; deferred = null; release(); return d; };
}

import { MirrorGate } from "../MirrorGate";
import { MirrorDownloadGate, downloadLine } from "../MirrorDownloadGate";
import { setMirrorSwitchValue, _resetMirrorSwitchForTests } from "../killSwitch";
import { _resetServingForTests, isLegServing, setServingLegs } from "../serving";
import { _resetOfflineMirrorRuntimeForTests } from "../mirrorRuntime";

// A faithful stand-in for what startOfflineMirror returns — faithful in the
// ways that matter here: `resume()` makes the same three-way decision the real
// one makes (run the loop / resume the download / nobody has been asked), and
// a tap flips `consented` exactly as the real one does. A fake that answered
// "downloading" to everything would let a gate that never asks anybody pass.
function fakeRuntime({ setupDone = false, consented = false } = {}) {
  const calls = { setup: 0, background: 0, start: 0, stop: 0, consent: 0, resume: 0 };
  let downloadResolve = null;
  const rt = {
    calls,
    state: { downloading: false, setupDone: [], setupProgress: null, setupError: null },
    setupState: async () => ({ done: setupDone, ready: setupDone, legs: [] }),
    hasConsented: async () => consented,
    async resume() {
      calls.resume += 1;
      if (!consented) return "needs-consent";
      if (setupDone) { rt.start(); return "running"; }
      rt.downloadInBackground();
      return "downloading";
    },
    consentAndDownload: async () => {
      calls.consent += 1;
      consented = true;
      // A download that NEVER settles: the whole point is that the tap does not
      // wait for it. If the gate awaited this, the test would hang.
      return new Promise((r) => { downloadResolve = r; calls.background += 1; });
    },
    downloadInBackground: () => { calls.background += 1; return new Promise(() => {}); },
    downloadProgress: async () => ({ downloading: false, legsDone: [], current: null, error: null }),
    setup: async () => { calls.setup += 1; },
    start: () => { calls.start += 1; },
    stop: () => { calls.stop += 1; },
    finishDownload: () => downloadResolve?.(),
  };
  return rt;
}

const APP_TEXT = "the app, working";
// The gate's own heading, and NOT the word on its button. An earlier version of
// these tests asserted the absence of "Download", which a gate that had merely
// swapped its button to "Starting…" satisfied while still covering the app —
// so a gate that awaited the whole 104 MB passed. Assert the CARD is gone.
const GATE_TEXT = "Keep the shop on this device";
function App() { return React.createElement("div", null, APP_TEXT); }

async function mount() {
  let tree;
  await act(async () => {
    tree = TestRenderer.create(
      React.createElement(MirrorGate, { auth: {}, storage: {} }, React.createElement(App)),
    );
  });
  for (let i = 0; i < 8; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  return tree;
}

const text = (tree) => JSON.stringify(tree.toJSON());

// Flush macrotasks until the start is actually under way. The auth listener is
// behind a dynamic import, so the number of ticks that takes is not a constant
// a test may assume.
async function untilStarted(max = 40) {
  for (let i = 0; i < max && startCalls === 0; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  expect(startCalls).toBe(1);
}
const findButton = (tree) => tree.root.findAllByType("button")[0];

beforeEach(() => {
  store.clear();
  startCalls = 0;
  deferred = null;
  authUser = { uid: "u1", isAnonymous: false };
  _resetMirrorSwitchForTests();
  _resetServingForTests();
  _resetOfflineMirrorRuntimeForTests();
  setMirrorSwitchValue(true);
});
afterEach(() => { _resetMirrorSwitchForTests(); _resetServingForTests(); });

describe("a device nobody has asked yet", () => {
  it("shows the gate — and the app is rendered underneath it the whole time", async () => {
    runtime = fakeRuntime({ setupDone: false, consented: false });
    const tree = await mount();
    expect(text(tree)).toContain(GATE_TEXT);
    // THE POINT. Not "instead of the app" — over it. The sign-in screen lives
    // inside <App>, so a gate that replaced its children would deadlock a
    // fresh device: no sign-in, no permission, no download. (PR #618.)
    expect(text(tree)).toContain(APP_TEXT);
    tree.unmount();
  });

  it("one tap opens the app IMMEDIATELY — it does not await a single byte", async () => {
    runtime = fakeRuntime({ setupDone: false, consented: false });
    const tree = await mount();
    await act(async () => { findButton(tree).props.onClick(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // The gate is gone while the download it started is still running — and
    // the download in this fake NEVER settles, so a gate that waited for it
    // would still be on screen here.
    expect(text(tree)).not.toContain(GATE_TEXT);
    expect(text(tree)).toContain(APP_TEXT);
    expect(runtime.calls.consent).toBe(1);
    expect(runtime.calls.background).toBe(1);
    tree.unmount();
  });

  it("offers ONE button and no way to say no", async () => {
    runtime = fakeRuntime({ setupDone: false, consented: false });
    const tree = await mount();
    expect(tree.root.findAllByType("button")).toHaveLength(1);
    tree.unmount();
  });

  it("is not asked before there is a signed-in, non-anonymous user", async () => {
    // Every mirrored node is rules-gated on one. Asking the TV shell, or
    // somebody still on the PIN screen, is asking a device that cannot
    // download and is covering the screen that would let it.
    authUser = null;
    runtime = fakeRuntime({ setupDone: false, consented: false });
    const tree = await mount();
    expect(text(tree)).not.toContain(GATE_TEXT);
    expect(text(tree)).toContain(APP_TEXT);
    tree.unmount();
  });
});

describe("a device that has already tapped", () => {
  it("is never asked again — an incomplete copy resumes in the background", async () => {
    runtime = fakeRuntime({ setupDone: false, consented: true });
    const tree = await mount();
    expect(text(tree)).not.toContain(GATE_TEXT);
    expect(text(tree)).toContain(APP_TEXT);
    expect(runtime.calls.background).toBe(1);
    expect(runtime.calls.start).toBe(0);   // the loop starts when the copy is complete
    tree.unmount();
  });

  it("with a COMPLETE copy, goes straight into the steady-state loop", async () => {
    runtime = fakeRuntime({ setupDone: true, consented: true });
    const tree = await mount();
    expect(text(tree)).not.toContain(GATE_TEXT);
    expect(runtime.calls.start).toBe(1);
    expect(runtime.calls.background).toBe(0);
    tree.unmount();
  });
});

describe("the fleet switch still governs all of it", () => {
  it("a device with the switch OFF is never asked, and nothing starts", async () => {
    setMirrorSwitchValue(false);
    runtime = fakeRuntime({ setupDone: false, consented: false });
    const tree = await mount();
    expect(text(tree)).not.toContain(GATE_TEXT);
    expect(runtime.calls.background).toBe(0);
    expect(runtime.calls.start).toBe(0);
    tree.unmount();
  });

  it("a kill mid-download stops the engine, and the app carries on", async () => {
    runtime = fakeRuntime({ setupDone: false, consented: true });
    const tree = await mount();
    expect(runtime.calls.background).toBe(1);
    await act(async () => { setMirrorSwitchValue(false); });
    expect(runtime.calls.stop).toBe(1);
    expect(text(tree)).toContain(APP_TEXT);
    tree.unmount();
  });
});

describe("nothing is served locally until the copy is complete", () => {
  it("a half-downloaded device reads live, exactly as it does today", async () => {
    // The serving hint is what every hook consults on its first render, and
    // the engine only writes it at the END of a setup run (refreshServing).
    // So during a download it is empty and every screen opens its live read.
    runtime = fakeRuntime({ setupDone: false, consented: true });
    const tree = await mount();
    expect(isLegServing("products")).toBe(false);
    expect(isLegServing("stock")).toBe(false);
    tree.unmount();
  });

  it("and serves once it is — the hint is the only thing that changes", async () => {
    setServingLegs(["products"]);
    expect(isLegServing("products")).toBe(true);
  });
});

describe("what the gate and the dot say", () => {
  it("the gate names the size, so a tap is an informed one", async () => {
    runtime = fakeRuntime();
    let tree;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(MirrorDownloadGate, { runtime, onStart: () => {} }),
      );
    });
    expect(text(tree)).toContain("104 MB");
    expect(text(tree)).toContain("read live");
    tree.unmount();
  });

  it("the dot's line is weighted by BYTES and names what is downloading", () => {
    expect(downloadLine({ legsDone: [], current: "products" })).toContain("0%");
    expect(downloadLine({ legsDone: ["insights"], current: "movements" }))
      .toMatch(/34%|35%|Stock movements/);
    expect(downloadLine({ error: new Error("PERMISSION_DENIED") }))
      .toMatch(/paused/);
  });
});

// ─── ONE ENGINE, EVER ───────────────────────────────────────────────────────
//
// startOfflineMirror() takes a while — it opens IndexedDB — and it has side
// effects the moment it resolves, including an auth listener that schedules a
// pass by itself. A runtime that is built and then dropped is therefore not
// garbage; it is a second engine on the same device, reading and reporting,
// owned by nobody and stoppable by nobody. Two flips of the fleet switch
// inside that window used to be all it took.
// (Sonnet architect review, PR #624.)
describe("a switch flip while the mirror is still starting", () => {
  it("builds ONE engine, however many times the switch is flipped", async () => {
    runtime = fakeRuntime({ setupDone: true, consented: true });
    const release = deferStart();

    let tree;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(MirrorGate, { auth: {}, storage: {} }, React.createElement(App)),
      );
    });
    await untilStarted();
    await act(async () => { setMirrorSwitchValue(false); });
    await act(async () => { setMirrorSwitchValue(true); });
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
    for (let i = 0; i < 5; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }

    expect(startCalls).toBe(1);
    tree.unmount();
  });

  it("and an engine that resolves into a switch that is now OFF is STOPPED, not orphaned", async () => {
    runtime = fakeRuntime({ setupDone: true, consented: true });
    const release = deferStart();

    let tree;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(MirrorGate, { auth: {}, storage: {} }, React.createElement(App)),
      );
    });
    // Let sign-in land and the start actually get under way — nothing starts
    // before there is a user, so a flip before that would prove nothing. A
    // FIXED number of ticks made this flaky: the auth listener is behind a
    // dynamic import, so how many macrotasks it takes is not ours to decide.
    await untilStarted();
    await act(async () => { setMirrorSwitchValue(false); });
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
    for (let i = 0; i < 5; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }

    // It was adopted and stopped. Never started, and never left running with
    // nothing holding a reference to it.
    expect(startCalls).toBe(1);
    expect(runtime.calls.stop).toBeGreaterThanOrEqual(1);
    expect(runtime.calls.start).toBe(0);
    tree.unmount();
  });
});

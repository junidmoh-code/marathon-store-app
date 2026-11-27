// ─── SOURCE: LEAVE THE APP AND COME BACK (Junid, 27 Nov 2026) ────────────────
//
// Proves, through the production code paths, the three things that made Source
// load again from nothing on return — and counts the bytes.
//
//   1. The update checker never reloads the page while the shops trade, even
//      with a new build waiting, the tab hidden and shown again, a mirrored
//      ("forced") device, and half an hour passing.
//   2. Source's non-mirrored live reads survive a hide→show and a re-entry to
//      the screen: zero listeners reopened. The OLD wiring released idle
//      listeners on hide (releaseIdleLiveReads, still the production function)
//      and the re-entry cost every byte again.
//   3. Byte figures: measured 27 Nov 2026 with single bounded REST reads
//      (docs/resume-reload-investigation.md).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// Source's live (non-mirror-leg) reads on a mirrored device, measured bytes.
const MEASURED = {
  "refill_engine/open": 390_292,
  "config/refillEngine": 6_911,
  network: 4,
};

const opens = [];
const handlers = new Map();
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path ?? "" }),
  onValue: (r, cb, errCb) => {
    opens.push(r.path);
    handlers.set(r.path, { cb, errCb });
    return () => { handlers.delete(r.path); };
  },
  query: (r) => r,
  orderByKey: () => ({}), orderByChild: () => ({}), limitToLast: () => ({}), equalTo: () => ({}),
  update: vi.fn(), get: vi.fn(async () => ({ val: () => null })), runTransaction: vi.fn(),
}));
vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; },
}));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));

const {
  _setHoldingForTests, _resetSharedLiveReadsForTests, releaseIdleLiveReads, _hideGraceForTests, holdsInMode,
} = await import("../../utils/sharedLiveRead.js");
const stock = await import("../../components/stock/useStock.js");
const { useNetwork } = await import("../../utils/useNetwork.js");

const bytesOf = (paths) => paths.reduce((n, p) => n + (MEASURED[p] ?? 0), 0);

function mountSourceReads() {
  function SourceReads() { stock.useEngineOpen(); stock.useEngineConfig(); useNetwork(); return null; }
  let tree;
  act(() => { tree = TestRenderer.create(<SourceReads />); });
  for (const p of Object.keys(MEASURED)) {
    const h = handlers.get(p);
    if (h) act(() => { h.cb({ val: () => ({}) }); });
  }
  return { unmount: () => act(() => { tree.unmount(); }) };
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetSharedLiveReadsForTests();
  _setHoldingForTests(true);
  opens.length = 0;
  const conn = handlers.get(".info/connected");
  handlers.clear();
  if (conn) handlers.set(".info/connected", conn);
});
afterEach(() => {
  _resetSharedLiveReadsForTests();
  _setHoldingForTests(holdsInMode("test"));
  vi.useRealTimers();
});

describe("Source — the live reads on a return", () => {
  it("first open costs what it always cost", () => {
    const s = mountSourceReads();
    expect(bytesOf(opens.filter((p) => p in MEASURED))).toBe(397_207);
    s.unmount();
  });

  it("AFTER: leave Source, switch app for a minute, come back, open Source — 0 bytes", () => {
    const grace = _hideGraceForTests();
    const s = mountSourceReads();
    const first = opens.length;
    s.unmount();                                  // Source → Home
    act(() => { grace.hidden(); });               // → another app
    vi.advanceTimersByTime(60_000);
    act(() => { grace.visible(); });              // back
    const again = mountSourceReads();
    expect(opens.slice(first).filter((p) => p !== ".info/connected")).toEqual([]);   // nothing at all, measured or not
    const reopened = opens.slice(first).filter((p) => p in MEASURED);
    expect(reopened).toEqual([]);
    expect(bytesOf(reopened)).toBe(0);
    again.unmount();
  });

  it("AFTER: staying ON Source through the hide — 0 bytes (listeners in use are never dropped)", () => {
    const grace = _hideGraceForTests();
    const s = mountSourceReads();
    const first = opens.length;
    act(() => { grace.hidden(); });
    vi.advanceTimersByTime(30 * 60_000);
    act(() => { grace.visible(); });
    expect(opens.length).toBe(first);
    s.unmount();
  });

  it("BEFORE: the old hide handler (releaseIdle at once) made the same return cost 397,207 B", () => {
    const s = mountSourceReads();
    const first = opens.length;
    s.unmount();
    releaseIdleLiveReads();                       // what visibilitychange→hidden used to call
    const again = mountSourceReads();
    expect(bytesOf(opens.slice(first).filter((p) => p in MEASURED))).toBe(397_207);
    again.unmount();
  });
});

describe("the update checker — a new build waiting never reloads Source under anybody", () => {
  it("hidden, shown, focused, half an hour, forced mode, 11:00 SAST: no reload; a tap still reloads", async () => {
    const listeners = {};
    const on = (t, fn) => { (listeners[t] ||= []).push(fn); };
    vi.stubGlobal("window", { location: { hash: "" }, addEventListener: on, setInterval: (fn, ms) => setInterval(fn, ms) });
    const doc = { visibilityState: "visible", addEventListener: on };
    vi.stubGlobal("document", doc);
    const ss = new Map();
    vi.stubGlobal("sessionStorage", { getItem: (k) => ss.get(k) ?? null, setItem: (k, v) => ss.set(k, String(v)) });
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ version: "a-newer-build" }) }));
    vi.setSystemTime(Date.UTC(2026, 10, 27, 9, 0));          // 11:00 SAST
    vi.resetModules();
    const uc = await import("../../update/updateChecker.js");
    // A bundle with a real version, as in production.
    Object.defineProperty(uc, "CURRENT_VERSION", { value: "this-build" });
    const reload = vi.spyOn(uc.reloadIo, "reload").mockImplementation(() => {});
    uc.setForcedUpdateMode(true);
    uc.startUpdateChecker();
    const fire = async (t) => { for (const fn of listeners[t] || []) fn(); await vi.advanceTimersByTimeAsync(10); };
    await fire("focus");
    doc.visibilityState = "hidden"; await fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    doc.visibilityState = "visible"; await fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(reload).not.toHaveBeenCalled();
    uc.applyUpdate();                                         // the "Update ready" pill
    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("a phone asleep since a deploy a day ago: the build found on return is taken on that same long return", async () => {
    const listeners = {};
    const on = (t, fn) => { (listeners[t] ||= []).push(fn); };
    vi.stubGlobal("window", { location: { hash: "" }, addEventListener: on, setInterval: (fn, ms) => setInterval(fn, ms) });
    const doc = { visibilityState: "visible", addEventListener: on };
    vi.stubGlobal("document", doc);
    const ss = new Map();
    vi.stubGlobal("sessionStorage", { getItem: (k) => ss.get(k) ?? null, setItem: (k, v) => ss.set(k, String(v)) });
    let served = { version: "this-build" };
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => served }));
    vi.setSystemTime(Date.UTC(2026, 10, 27, 9, 0));          // 11:00 SAST
    vi.resetModules();
    const uc = await import("../../update/updateChecker.js");
    served = { version: uc.CURRENT_VERSION };              // up to date when it went to sleep
    const reload = vi.spyOn(uc.reloadIo, "reload").mockImplementation(() => {});
    uc.startUpdateChecker();
    await vi.advanceTimersByTimeAsync(10);
    expect(uc.isUpdateAvailable()).toBe(false);
    const fire = async (t) => { for (const fn of listeners[t] || []) fn(); await vi.advanceTimersByTimeAsync(10); };
    doc.visibilityState = "hidden"; await fire("visibilitychange");
    // Asleep: no timers ran. Meanwhile a build went out 2 days ago.
    vi.setSystemTime(Date.UTC(2026, 10, 27, 10, 0));
    served = { version: "a-newer-build", builtAt: new Date(Date.UTC(2026, 10, 25, 9, 0)).toISOString() };
    doc.visibilityState = "visible"; await fire("visibilitychange");
    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
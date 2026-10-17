// Junid, 17 Oct 2026: "when you open the card on their phone it takes forever".
// Measured on a phone-like line: the ~6 MB mirror download started at sign-in
// sat in front of the 1 KB /users/{uid} read the home screen waits for (50 s).
// The mirror now starts only once that record has answered.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };

const h = vi.hoisted(() => ({ authUser: { uid: "u1", isAnonymous: false }, profile: [], starts: 0 }));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (auth, cb) => { cb(h.authUser); return () => {}; } }));
vi.mock("firebase/database", () => ({
  ref: (db, path) => ({ path }),
  // The person's record answers only when the test says so.
  onValue: (r, ok, err) => { if (String(r.path).startsWith("users/")) h.profile.push({ path: r.path, ok, err }); return () => {}; },
}));
vi.mock("../../firebase", () => ({ database: {}, auth: {}, storage: {} }));
const runtime = {
  state: {}, setupState: async () => ({ done: false, ready: false, legs: [] }), hasConsented: async () => false,
  resume: async () => "needs-consent", consentAndDownload: () => new Promise(() => {}),
  downloadInBackground: () => new Promise(() => {}), downloadProgress: async () => ({}), setup: async () => {}, start: () => {}, stop: () => {},
};
vi.mock("../bootstrap", () => ({ startOfflineMirror: async () => { h.starts += 1; return runtime; } }));

const { MirrorGate, PROFILE_WAIT_MS } = await import("../MirrorGate");
const { setMirrorSwitchValue, _resetMirrorSwitchForTests } = await import("../killSwitch");
const { _resetOfflineMirrorRuntimeForTests } = await import("../mirrorRuntime");
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); }); };
const mount = async () => { let t; await act(async () => { t = TestRenderer.create(React.createElement(MirrorGate, { auth: {}, storage: {} }, React.createElement("div", null, "app"))); }); return t; };

beforeEach(() => { h.authUser = { uid: "u1", isAnonymous: false }; h.profile.length = 0; h.starts = 0; store.clear(); _resetMirrorSwitchForTests(); _resetOfflineMirrorRuntimeForTests(); setMirrorSwitchValue(true); });
afterEach(() => { vi.useRealTimers(); _resetMirrorSwitchForTests(); });

describe("the mirror waits for the person's own record", () => {
  it("signed in, record not answered yet: the app is on screen and NO download has started", async () => {
    const t = await mount();
    await flush();
    expect(h.profile.map((p) => p.path)).toEqual(["users/u1"]);
    expect(h.starts).toBe(0);
    expect(JSON.stringify(t.toJSON())).toContain("app");
    t.unmount();
  });

  it("the record answers: the download starts", async () => {
    const t = await mount();
    await flush();
    await act(async () => { h.profile[0].ok({ val: () => ({}) }); });
    await flush();
    expect(h.starts).toBe(1);
    t.unmount();
  });

  it("a refused record read still lets the mirror start (never held for good)", async () => {
    const t = await mount();
    await flush();
    await act(async () => { h.profile[0].err(new Error("permission_denied")); });
    await flush();
    expect(h.starts).toBe(1);
    t.unmount();
  });

  it("a record that never answers: the mirror starts anyway after PROFILE_WAIT_MS", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = await mount();
    for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(0); });
    expect(h.starts).toBe(0);
    await act(async () => { vi.advanceTimersByTime(PROFILE_WAIT_MS + 10); });
    for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(0); });
    expect(h.starts).toBe(1);
    t.unmount();
  });

  it("an anonymous session never asks for a record and never downloads", async () => {
    h.authUser = { uid: "anon", isAnonymous: true };
    const t = await mount();
    await flush();
    expect(h.profile).toHaveLength(0);
    expect(h.starts).toBe(0);
    t.unmount();
  });
});

// ─── A COLD START OPENS ON THE SAVED RECORD, NOT "Loading…" (27 Nov 2026) ────
// The real AuthGate, the real resume copies on the real mirror database
// (fake-indexeddb). Page 1 hears its /users record live and saves it; the page
// is thrown away; page 2 renders the app from the saved record while the live
// read is still in flight, with the Updating marker's flag up — and the live
// answer replaces it.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { IDBFactory } from "fake-indexeddb";

globalThis.indexedDB = new IDBFactory();
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.window ||= globalThis;
window.location ||= { hash: "" };
window.addEventListener ||= () => {};
window.removeEventListener ||= () => {};

const fb = { user: null, answer: true, userCbs: new Set(), permRecord: null };
vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (_a, cb) => { cb(fb.user); return () => {}; },
  onIdTokenChanged: (_a, cb) => { cb(fb.user); return () => {}; },
  signInAnonymously: vi.fn(async () => {}), signOut: vi.fn(async () => {}), signInWithCustomToken: vi.fn(async () => {}),
}));
vi.mock("firebase/database", () => ({
  ref: (_d, path) => ({ path }),
  set: vi.fn(async () => {}), push: vi.fn(async () => {}), increment: (n) => ({ increment: n }),
  get: vi.fn(async () => ({ val: () => null })),
  onValue: (_r, cb) => {
    const l = () => cb({ val: () => fb.permRecord });
    fb.userCbs.add(l);
    if (fb.answer) l();
    return () => fb.userCbs.delete(l);
  },
}));
vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: {} }) }));
vi.mock("../firebase", () => ({ auth: { currentUser: { uid: "u1" } }, database: {}, functions: {} }));
vi.mock("../push/registerPush", () => ({ revokeBeforeSignOut: async () => {} }));
vi.mock("./Login", () => ({ default: () => React.createElement("div", { "data-login": "" }) }));
vi.mock("../update/updateChecker", () => ({ isUpdateBusy: () => false }));
const binds = [];
vi.mock("../utils/activeStore", async (orig) => ({ ...(await orig()), bindActiveStore: (a) => { binds.push(a); } }));

const AuthGate = (await import("./AuthGate.jsx")).default;
const { usePermissions } = await import("./PermissionsContext.jsx");
const { _setResumeCopiesForTests } = await import("../offline/resumeCopy.js");
const { isSavedShowing } = await import("../offline/resumeFreshness.js");
const { setMirrorSwitchValue } = await import("../offline/killSwitch.js");
setMirrorSwitchValue(true);   // saved copies exist only on a device that runs the mirror

const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); };
const user = { uid: "u1", email: "staff@example.com", isAnonymous: false, getIdTokenResult: async () => ({ claims: {} }) };

function mount() {
  const seen = { ctx: null, app: false };
  const Probe = () => { seen.ctx = usePermissions(); seen.app = true; return null; };
  let r;
  act(() => { r = TestRenderer.create(React.createElement(AuthGate, null, React.createElement(Probe))); });
  return { seen, r };
}

describe("AuthGate after the page was thrown away", () => {
  it("paints the app from the saved record at once, then takes the live answer", async () => {
    fb.user = user;
    fb.permRecord = { username: "pat", permissions: ["source"], destShop: "marathon-pe" };
    fb.answer = true;
    const page1 = mount();
    await settle();
    expect(page1.seen.ctx.hasPermission("source")).toBe(true);
    act(() => page1.r.unmount());

    // Discarded: a fresh page, nothing in memory, the socket not answering yet.
    _setResumeCopiesForTests(null);
    fb.answer = false;
    binds.length = 0;
    const page2 = mount();
    await settle();
    const text = JSON.stringify(page2.r.toJSON());
    expect(text).not.toContain("Loading");
    expect(page2.seen.app).toBe(true);
    expect(page2.seen.ctx.hasPermission("source")).toBe(true);
    expect(isSavedShowing()).toBe(true);                    // "Updating…" is up
    expect(binds.length).toBe(0);                           // the saved record binds no shop
    const bindsBeforeLive = binds.length;

    // The live record lands — and it wins.
    fb.permRecord = { username: "pat", permissions: ["source", "returns"], destShop: "marathon-pe" };
    act(() => { for (const l of fb.userCbs) l(); });
    expect(page2.seen.ctx.hasPermission("returns")).toBe(true);
    expect(isSavedShowing()).toBe(false);
    expect(binds.length).toBe(bindsBeforeLive + 1);         // …the live one does
    act(() => page2.r.unmount());
  });

  it("another person on the same device never opens on the first person's record", async () => {
    _setResumeCopiesForTests(null);
    fb.user = { ...user, uid: "u2", email: "other@example.com" };
    fb.answer = false;
    const p = mount();
    await settle();
    // Honest Loading until their own record answers.
    expect(JSON.stringify(p.r.toJSON())).toContain("Loading");
    expect(isSavedShowing()).toBe(false);
    act(() => p.r.unmount());
  });
});

describe("AuthGate's saved record is display-only", () => {
  it("a device whose mirror is off never opens on a saved record", async () => {
    setMirrorSwitchValue(false);
    _setResumeCopiesForTests(null);
    fb.user = user; fb.answer = false;
    const p = mount();
    await settle();
    expect(JSON.stringify(p.r.toJSON())).toContain("Loading");
    act(() => p.r.unmount());
    setMirrorSwitchValue(true);
  });
});

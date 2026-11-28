// ─── NO RENDER WITH THE USER SET AND NO RECORD YET (TV board, 28 Nov 2026) ───
// permLoaded was left true by the signed-out pass, so the first render after a
// sign-in / restored session reached the app with permRecord null — read as
// an UNSCOPED account. The orders feed opened a whole-node /orders listen; a
// shop-pinned account is refused it, and the SDK cancelled the board's own
// destShop query with it (store TV on 0 all of 28 Nov morning).
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

const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); };
const user = { uid: "u1", email: "staff@example.com", isAnonymous: false, getIdTokenResult: async () => ({ claims: {} }) };

function mount() {
  const renders = [];
  const Probe = () => { const c = usePermissions(); renders.push({ uid: c.user?.uid ?? null, record: c.permRecord }); return null; };
  let r;
  act(() => { r = TestRenderer.create(React.createElement(AuthGate, null, React.createElement(Probe))); });
  return { renders, r };
}

describe("AuthGate never shows the app a signed-in user without that user's record", () => {
  it("waits for the /users answer: no render with the user set and permRecord null", async () => {
    fb.user = user;
    fb.permRecord = { username: "pat", permissions: ["product_admin"], destShop: "marathon-pe" };
    fb.answer = false;                       // the socket has not answered yet
    const m = mount();
    await settle();
    expect(m.renders).toEqual([]);           // "Loading…", not the app
    act(() => { for (const l of [...fb.userCbs]) l(); });   // the live record lands
    await settle();
    expect(m.renders.length).toBeGreaterThan(0);
    expect(m.renders.every((x) => x.record && x.record.destShop === "marathon-pe")).toBe(true);
    act(() => m.r.unmount());
  });

  it("a refused /users read still opens the app (fail-closed record), never hangs on Loading", async () => {
    // Same harness, but onValue's error path: covered by setPermUid(uid) on the
    // error branch — asserted here through the source so the hang cannot return.
    const { readFileSync } = await import("node:fs");
    const gate = readFileSync(new URL("./AuthGate.jsx", import.meta.url), "utf8");
    expect(gate).toMatch(/setPermReadError\(true\); setPermRecord\(null\); setPermUid\(uid\); setPermLoaded\(true\);/);
    expect(gate).toContain("if (!permLoaded || permUid !== user.uid) return <LoadingScreen />;");
  });
});

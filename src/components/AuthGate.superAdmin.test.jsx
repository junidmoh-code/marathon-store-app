// Jafer and Junid both get the super-admin context from the real AuthGate; staff do not.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

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

const DEV = "aaaaaaaa-1111-4111-8111-111111111111";

// ── firebase, faked at the module boundary (as EnrolmentGate.test.jsx) ──────
const fb = { user: null, authCbs: new Set(), tokenCbs: new Set(), userCbs: new Set(), permRecord: null, enrolCalls: [], reads: [] };
vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (_a, cb) => { fb.authCbs.add(cb); cb(fb.user); return () => fb.authCbs.delete(cb); },
  onIdTokenChanged: (_a, cb) => { fb.tokenCbs.add(cb); cb(fb.user); return () => fb.tokenCbs.delete(cb); },
  signInAnonymously: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
  signInWithCustomToken: vi.fn(async () => {}),
}));
vi.mock("firebase/database", () => ({
  ref: (_d, path) => ({ path }),
  set: vi.fn(async () => {}),
  push: vi.fn(async () => {}),
  increment: (n) => ({ increment: n }),
  get: vi.fn(async (r) => { fb.reads.push(r.path); return { val: () => ({ on: true }) }; }),
  onValue: (_r, cb) => { const l = () => cb({ val: () => fb.permRecord }); fb.userCbs.add(l); l(); return () => fb.userCbs.delete(l); },
}));
vi.mock("firebase/functions", () => ({
  httpsCallable: () => async (data) => { fb.enrolCalls.push(data); return { data: { ok: false } }; },
}));
vi.mock("../firebase", () => ({ auth: { currentUser: { uid: "mc" } }, database: {}, functions: {} }));
vi.mock("../push/registerPush", () => ({ revokeBeforeSignOut: async () => {} }));
vi.mock("./Login", () => ({ default: () => React.createElement("div", { "data-login": "" }) }));
vi.mock("../update/updateChecker", () => ({ isUpdateBusy: () => false }));

const AuthGate = (await import("./AuthGate.jsx")).default;
const { usePermissions } = await import("./PermissionsContext.jsx");

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const userOf = (email) => ({ uid: `uid-${email}`, email, isAnonymous: false, getIdTokenResult: async () => ({ claims: {} }) });

// AuthGate is where isSuperAdmin becomes the context's isSuperAdmin, the
// hasPermission short-circuit and the all-stores bypass. Render the real gate
// with a /users record that grants NOTHING and read what the app would see.
async function contextFor(email) {
  fb.user = userOf(email);
  fb.permRecord = { username: "x", permissions: [], storeIds: [] };
  let seen = null;
  const Probe = () => { seen = usePermissions(); return null; };
  let r;
  act(() => { r = TestRenderer.create(React.createElement(AuthGate, null, React.createElement(Probe))); });
  await flush();
  act(() => r.unmount());
  return seen;
}

describe("AuthGate — the super-admin short-circuit", () => {
  beforeEach(() => { store.clear(); fb.authCbs.clear(); fb.tokenCbs.clear(); fb.userCbs.clear(); });

  for (const [who, email] of [["Jafer", "jafermohammed340@gmail.com"], ["Junid", "gunidmoh@gmail.com"]]) {
    it(`${who}: isSuperAdmin, every permission, every store — with a /users record that grants nothing`, async () => {
      const ctx = await contextFor(email);
      expect(ctx).not.toBeNull();
      expect(ctx.isSuperAdmin).toBe(true);
      expect(ctx.hasPermission("user_admin")).toBe(true);
      expect(ctx.hasPermission("anything_at_all")).toBe(true);
      expect(ctx.storeIds.length).toBeGreaterThan(0);
    });
  }

  it("staff: not a super admin, no permission it was not given, no stores", async () => {
    const ctx = await contextFor("rashid@marathon.internal");
    expect(ctx).not.toBeNull();
    expect(ctx.isSuperAdmin).toBe(false);
    expect(ctx.hasPermission("user_admin")).toBe(false);
    expect(ctx.storeIds).toEqual([]);
  });
});

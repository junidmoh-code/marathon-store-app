// The code screen, and AuthGate — the real entry point every signed-in session
// passes through — deciding between it and the app. The failure that matters
// is the app opening (children mounted) for a device that has no live
// enrolment, so those cases assert the children were NEVER rendered, not just
// that the screen is on top.
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
const winListeners = new Map();
window.addEventListener = (t, fn) => { if (!winListeners.has(t)) winListeners.set(t, new Set()); winListeners.get(t).add(fn); };
window.removeEventListener = (t, fn) => winListeners.get(t)?.delete(fn);

const DEV = "aaaaaaaa-1111-4111-8111-111111111111";

// ── firebase, faked at the module boundary ───────────────────────────────────
const fb = { writes: [], user: null, authCbs: new Set(), tokenCbs: new Set(), userCbs: new Set(), permRecord: null, enrolCalls: [], enrolResult: null, customTokens: [] };
function signInAs(user) {
  fb.user = user;
  for (const cb of fb.authCbs) cb(user);
  for (const cb of fb.tokenCbs) cb(user);
}
vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (_a, cb) => { fb.authCbs.add(cb); cb(fb.user); return () => fb.authCbs.delete(cb); },
  onIdTokenChanged: (_a, cb) => { fb.tokenCbs.add(cb); cb(fb.user); return () => fb.tokenCbs.delete(cb); },
  signInAnonymously: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
  signInWithCustomToken: vi.fn(async (_a, token) => {
    fb.customTokens.push(token);
    // Same uid, NEW token with the device's claims — onIdTokenChanged only.
    const next = { ...fb.user, getIdTokenResult: async () => ({ claims: { deviceId: DEV, eid: "e-new", personName: "Sipho" } }) };
    fb.user = next;
    for (const cb of fb.tokenCbs) cb(next);
  }),
}));
vi.mock("firebase/database", () => ({
  ref: (_d, path) => ({ path }),
  set: vi.fn(async (r, v) => { fb.writes.push([r.path, v]); }),
  onValue: (_r, cb) => { const snap = () => ({ val: () => fb.permRecord }); const l = () => cb(snap()); fb.userCbs.add(l); l(); return () => fb.userCbs.delete(l); },
}));
vi.mock("firebase/functions", () => ({
  httpsCallable: () => async (data) => { fb.enrolCalls.push(data); return { data: fb.enrolResult }; },
}));
vi.mock("../../firebase", () => ({ auth: {}, database: {}, functions: {} }));
vi.mock("../../push/registerPush", () => ({ revokeBeforeSignOut: async () => {} }));
vi.mock("../../components/Login", () => ({ default: () => React.createElement("div", { "data-login": "" }) }));

const AuthGate = (await import("../../components/AuthGate.jsx")).default;
const EnrolmentGate = (await import("../EnrolmentGate.jsx")).default;
const { GATE_TITLE, messageFor } = await import("../EnrolmentGate.jsx");
const { getDeviceIdentity } = await import("../enrolment.js");

const setPerm = (p) => { fb.permRecord = p; for (const l of fb.userCbs) l(); };
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const pwUser = { uid: "mc", email: "mc@marathon.internal", isAnonymous: false, getIdTokenResult: async () => ({ claims: {} }) };
const devUser = (eid = "e1") => ({ ...pwUser, getIdTokenResult: async () => ({ claims: { deviceId: DEV, eid, personName: "Sipho", personId: "p1" } }) });
const text = (r) => JSON.stringify(r.toJSON());

function mount() {
  let r;
  act(() => { r = TestRenderer.create(React.createElement(AuthGate, null, React.createElement("div", { "data-app": "" }, "THE APP"))); });
  return r;
}
const appMounted = (r) => r.root.findAll((n) => n.props && n.props["data-app"] === "").length > 0;
const gateShown = (r) => r.root.findAll((n) => n.props && n.props["data-enrolment-gate"] === "").length > 0;
async function type(r, digits) {
  for (const d of digits) {
    const btn = r.root.findAll((n) => n.type === "button" && n.props["aria-label"] === d)[0];
    await act(async () => { btn.props.onClick(); });
  }
  await flush();
}

beforeEach(() => {
  store.clear();
  Object.assign(fb, { user: null, permRecord: null, enrolCalls: [], enrolResult: null, customTokens: [], writes: [] });
  fb.authCbs.clear(); fb.tokenCbs.clear(); fb.userCbs.clear();
});

describe("AuthGate + the code screen", () => {
  it("MC's login on a phone already signed in today: the code screen, and the app is never mounted", async () => {
    fb.user = pwUser;
    fb.permRecord = { username: "mc", deviceCodeRequired: true };
    const r = mount();
    await flush();
    expect(gateShown(r)).toBe(true);
    expect(text(r)).toContain(GATE_TITLE);
    expect(appMounted(r)).toBe(false);
  });

  it("the right code enrols, signs in with the token, and the app opens — no reload", async () => {
    fb.user = pwUser;
    fb.permRecord = { username: "mc", deviceCodeRequired: true };
    fb.enrolResult = { ok: true, token: "custom-token-1", personName: "Sipho" };
    const r = mount();
    await flush();
    await type(r, "4821");
    expect(fb.enrolCalls).toHaveLength(1);
    expect(fb.enrolCalls[0]).toMatchObject({ code: "4821" });
    expect(typeof fb.enrolCalls[0].deviceId).toBe("string");
    expect(fb.customTokens).toEqual(["custom-token-1"]);
    expect(appMounted(r)).toBe(false);          // the gate entry has not landed yet
    await act(async () => setPerm({ username: "mc", deviceCodeRequired: true, deviceGate: { [DEV]: "e-new" } }));
    await flush();
    expect(gateShown(r)).toBe(false);
    expect(appMounted(r)).toBe(true);
    expect(getDeviceIdentity()).toMatchObject({ deviceId: DEV, personName: "Sipho", enrolled: true });
    expect(localStorage.getItem("marathon.deviceId")).toBe(DEV);
  });

  it("a wrong code says so, clears the boxes, and never signs in", async () => {
    fb.user = pwUser;
    fb.permRecord = { username: "mc", deviceCodeRequired: true };
    fb.enrolResult = { ok: false, reason: "wrong", attemptsLeft: 3 };
    const r = mount();
    await flush();
    await type(r, "1111");
    expect(text(r)).toContain("That code is not right. 3 tries left.");
    expect(fb.customTokens).toEqual([]);
    expect(appMounted(r)).toBe(false);
  });

  it("an enrolled device opens straight into the app", async () => {
    fb.user = devUser();
    fb.permRecord = { username: "mc", deviceCodeRequired: true, deviceGate: { [DEV]: "e1" } };
    const r = mount();
    await flush();
    expect(appMounted(r)).toBe(true);
    expect(gateShown(r)).toBe(false);
  });

  it("revoked while open: the app is taken down live, no reload", async () => {
    fb.user = devUser();
    fb.permRecord = { username: "mc", deviceCodeRequired: true, deviceGate: { [DEV]: "e1" } };
    const r = mount();
    await flush();
    expect(appMounted(r)).toBe(true);
    await act(async () => setPerm({ username: "mc", deviceCodeRequired: true }));
    await flush();
    expect(appMounted(r)).toBe(false);
    expect(gateShown(r)).toBe(true);
  });

  it("other logins and Junid are never shown the code screen", async () => {
    fb.user = { uid: "mike", email: "mike@marathon.internal", isAnonymous: false, getIdTokenResult: async () => ({ claims: {} }) };
    fb.permRecord = { username: "mike", stockRole: "admin" };
    let r = mount();
    await flush();
    expect(appMounted(r)).toBe(true);
    act(() => r.unmount());
    fb.authCbs.clear(); fb.tokenCbs.clear(); fb.userCbs.clear();
    fb.user = { uid: "owner", email: "gunidmoh@gmail.com", isAnonymous: false, getIdTokenResult: async () => ({ claims: {} }) };
    fb.permRecord = { deviceCodeRequired: true };
    r = mount();
    await flush();
    expect(appMounted(r)).toBe(true);
  });
});

describe("the code screen on its own", () => {
  it("takes digits from a physical keyboard too, and the delete key", async () => {
    const enrol = vi.fn(async () => ({ ok: false, reason: "wrong", attemptsLeft: 4 }));
    const r = TestRenderer.create(React.createElement(EnrolmentGate, { enrol, signIn: vi.fn() }));
    await flush();
    const key = (k) => act(async () => { for (const fn of winListeners.get("keydown") || []) fn({ key: k }); });
    await key("4"); await key("9"); await key("Backspace"); await key("8"); await key("2"); await key("1");
    await flush();
    expect(enrol).toHaveBeenCalledTimes(1);
    expect(enrol).toHaveBeenCalledWith("4821");
  });

  it("messages for every refusal", () => {
    expect(messageFor({ ok: false, reason: "locked", retryAfterMs: 14 * 60e3 + 1 })).toBe("Too many wrong codes. Try again in 15 minutes.");
    expect(messageFor({ ok: false, reason: "full", max: 2 })).toBe("That code is already in use on 2 devices. Ask MC.");
    expect(messageFor({ ok: false, reason: "wrong", attemptsLeft: 1 })).toBe("That code is not right. 1 try left.");
    expect(messageFor({ ok: false, reason: "wrong", attemptsLeft: 0 })).toBe("That code is not right.");
  });
});

// DEVICE GATES PAUSED (2026-10-13) — the shipped default, through the real
// entry points. The code screen was stopping MC from working, so every device
// must behave as it did before #647: AuthGate opens the app for an unenrolled,
// an enrolled and a quarantined phone on MC's flagged login, the code screen
// never renders, the quarantine overlay never mounts (and never listens), and
// thisDevicePaused() — asked before every reject, fulfil and send — answers
// false without a read. The gated behaviour itself stays pinned, with the
// gates ON, in EnrolmentGate.test.jsx, quarantine.test.jsx and
// thisDevicePaused.test.js. The reject/fulfil/cancel presses are rendered for
// real in RefillQueue.render.test.jsx ("device gates PAUSED").
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

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
vi.mock("../../firebase", () => ({ auth: { currentUser: { uid: "mc" } }, database: {}, functions: {} }));
vi.mock("../../push/registerPush", () => ({ revokeBeforeSignOut: async () => {} }));
vi.mock("../../components/Login", () => ({ default: () => React.createElement("div", { "data-login": "" }) }));
vi.mock("../../update/updateChecker", () => ({ isUpdateBusy: () => false }));

const AuthGate = (await import("../../components/AuthGate.jsx")).default;
const DeviceQuarantine = (await import("../DeviceQuarantine.jsx")).default;
const { GATE_TITLE } = await import("../EnrolmentGate.jsx");
const { DEVICE_GATES_ENABLED, deviceGatesOn } = await import("../deviceGatesSwitch.js");
const { deviceGateVerdict, identityFrom, getDeviceIdentity } = await import("../enrolment.js");
const { thisDevicePaused } = await import("../rejectCount.js");
const { writeCachedQuarantine } = await import("../quarantine.js");

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const mcUser = (claims = {}) => ({ uid: "mc", email: "mc@marathon.internal", isAnonymous: false, getIdTokenResult: async () => ({ claims }) });
const text = (r) => JSON.stringify(r.toJSON());
function mountAuthGate() {
  let r;
  act(() => { r = TestRenderer.create(React.createElement(AuthGate, null, React.createElement("div", { "data-app": "" }, "THE APP"))); });
  return r;
}
const appMounted = (r) => r.root.findAll((n) => n.props && n.props["data-app"] === "").length > 0;
const gateShown = (r) => r.root.findAll((n) => n.props && n.props["data-enrolment-gate"] === "").length > 0;

// The three phones on MC's flagged login.
const PHONES = {
  unenrolled: () => ({ user: mcUser(), perm: { username: "mc", deviceCodeRequired: true } }),
  enrolled: () => ({
    user: mcUser({ deviceId: DEV, eid: "e1", personName: "Sipho", personId: "p1", section: 1 }),
    perm: { username: "mc", deviceCodeRequired: true, deviceGate: { [DEV]: "e1" } },
  }),
  // Revoked AND quarantined AND seen flagged before: every reason the gates
  // ever had to shut a phone, all at once.
  quarantined: () => {
    store.set("marathon.deviceCodeRequired.mc", "1");
    writeCachedQuarantine(DEV, true);
    return {
      user: mcUser({ deviceId: DEV, eid: "e-old", personName: "Ayob" }),
      perm: { username: "mc", deviceCodeRequired: true, deviceGate: {} },
    };
  },
};

beforeEach(() => {
  store.clear();
  store.set("marathon.deviceId", DEV);
  Object.assign(fb, { user: null, permRecord: null, enrolCalls: [], reads: [] });
  fb.authCbs.clear(); fb.tokenCbs.clear(); fb.userCbs.clear();
});

describe("the switch", () => {
  it("ships OFF", () => {
    expect(DEVICE_GATES_ENABLED).toBe(false);
    expect(deviceGatesOn()).toBe(false);
  });

  it("the server copy (functions/lib/device-gates-switch.cjs) says the same", () => {
    const require = createRequire(import.meta.url);
    const server = require("../../../functions/lib/device-gates-switch.cjs");
    expect(server.DEVICE_GATES_ENABLED).toBe(DEVICE_GATES_ENABLED);
    expect(server.deviceGatesOn()).toBe(false);
    // …and it is a literal in both files, not something read at run time.
    const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
    expect(src("../deviceGatesSwitch.js")).toMatch(/export const DEVICE_GATES_ENABLED = false;/);
    expect(src("../../../functions/lib/device-gates-switch.cjs")).toMatch(/const DEVICE_GATES_ENABLED = false;/);
  });
});

describe("paused: every phone on MC's login logs straight in — no code screen", () => {
  for (const [kind, setUp] of Object.entries(PHONES)) {
    it(`${kind} phone: the app mounts and the code screen never renders`, async () => {
      const { user, perm } = setUp();
      fb.user = user;
      fb.permRecord = perm;
      const r = mountAuthGate();
      await flush();
      expect(appMounted(r)).toBe(true);
      expect(gateShown(r)).toBe(false);
      expect(text(r)).not.toContain(GATE_TITLE);
      expect(fb.enrolCalls).toHaveLength(0);
    });
  }

  it("the verdict is 'app' for every shape that used to mean 'code' or 'loading'", () => {
    const flagged = { deviceCodeRequired: true };
    expect(deviceGateVerdict({ permRecord: flagged, claims: {}, isSuperAdmin: false })).toBe("app");
    expect(deviceGateVerdict({ permRecord: flagged, claims: undefined, isSuperAdmin: false })).toBe("app");
    expect(deviceGateVerdict({ permRecord: null, claims: null, isSuperAdmin: false, readError: true, knownRequired: true })).toBe("app");
    expect(deviceGateVerdict({ permRecord: { ...flagged, deviceGate: { [DEV]: "e2" } }, claims: { deviceId: DEV, eid: "e1" }, isSuperAdmin: false })).toBe("app");
  });

  it("an enrolled phone keeps naming itself in the stamps, but its section narrows nothing", async () => {
    const { user, perm } = PHONES.enrolled();
    fb.user = user;
    fb.permRecord = perm;
    const r = mountAuthGate();
    await flush();
    expect(appMounted(r)).toBe(true);
    expect(getDeviceIdentity()).toMatchObject({ deviceId: DEV, personName: "Sipho", enrolled: true, section: null });
    expect(identityFrom({ claims: { deviceId: DEV, eid: "e1", section: 2 }, permRecord: perm }).section).toBe(null);
  });
});

describe("paused: quarantine is released, its flags are kept", () => {
  it("a phone with a live flag AND a cached flag sees no overlay, and nothing listens", async () => {
    // Signed in, non-anonymous — the only session the overlay would ever cover.
    fb.user = mcUser();
    writeCachedQuarantine(DEV, true);
    const subscribe = vi.fn((_p, onAnswer) => { onAnswer({ on: true }); return () => {}; });
    const auth = {};
    let r;
    await act(async () => { r = TestRenderer.create(React.createElement(DeviceQuarantine, { auth, subscribe, busy: () => false })); });
    await flush();
    expect(r.toJSON()).toBe(null);
    expect(subscribe).not.toHaveBeenCalled();
    // The cached flag is not wiped — it is kept for if the feature is revived.
    expect(store.get("marathon.deviceQuarantine")).toContain(DEV);
  });

  it("thisDevicePaused() — asked before every reject, fulfil and send — is false with no read", async () => {
    writeCachedQuarantine(DEV, true);
    expect(await thisDevicePaused()).toBe(false);
    expect(fb.reads).toHaveLength(0);
  });
});

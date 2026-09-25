// The device-enrolment verdict and the claims it reads. The failure that
// matters here is an app that opens for a device it should not — so every
// shape of "not quite enrolled" is pinned as "code".
import { describe, it, expect, beforeEach } from "vitest";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const {
  deviceGateVerdict, isLiveEnrolment, pickDeviceClaims, decodeJwtClaims, readSessionClaims,
  setDeviceIdentity, getDeviceIdentity, deviceTypeHint,
} = await import("../enrolment.js");
const { adoptDeviceId, getDeviceId } = await import("../deviceId.js");

const DEV = "aaaaaaaa-1111-4111-8111-111111111111";
const flagged = (gate) => ({ username: "mc", deviceCodeRequired: true, ...(gate ? { deviceGate: gate } : {}) });
const claims = (o = {}) => pickDeviceClaims({ deviceId: DEV, eid: "e1", personId: "p1", personName: "Sipho", ...o });

describe("deviceGateVerdict", () => {
  it("a flagged login with a live enrolment opens the app", () => {
    expect(deviceGateVerdict({ permRecord: flagged({ [DEV]: "e1" }), claims: claims(), isSuperAdmin: false })).toBe("app");
  });
  it("a flagged login on a password session (no device claims) gets the code screen", () => {
    expect(deviceGateVerdict({ permRecord: flagged({ [DEV]: "e1" }), claims: pickDeviceClaims({}), isSuperAdmin: false })).toBe("code");
  });
  it("revoked (entry gone), an old enrolment id, or another device's entry → code", () => {
    expect(deviceGateVerdict({ permRecord: flagged(null), claims: claims(), isSuperAdmin: false })).toBe("code");
    expect(deviceGateVerdict({ permRecord: flagged({ [DEV]: "e2" }), claims: claims(), isSuperAdmin: false })).toBe("code");
    expect(deviceGateVerdict({ permRecord: flagged({ other: "e1" }), claims: claims(), isSuperAdmin: false })).toBe("code");
    expect(deviceGateVerdict({ permRecord: flagged({ [DEV]: "e1" }), claims: claims({ eid: null }), isSuperAdmin: false })).toBe("code");
    expect(deviceGateVerdict({ permRecord: flagged({ [DEV]: "e1" }), claims: null, isSuperAdmin: false })).toBe("code");
  });
  it("while the claims are still being read it waits rather than flash the code screen", () => {
    expect(deviceGateVerdict({ permRecord: flagged({ [DEV]: "e1" }), claims: undefined, isSuperAdmin: false })).toBe("loading");
  });
  it("a login without the flag, a flag that is not exactly true, and Junid are never gated", () => {
    expect(deviceGateVerdict({ permRecord: { username: "mike" }, claims: pickDeviceClaims({}), isSuperAdmin: false })).toBe("app");
    expect(deviceGateVerdict({ permRecord: { deviceCodeRequired: "yes" }, claims: pickDeviceClaims({}), isSuperAdmin: false })).toBe("app");
    expect(deviceGateVerdict({ permRecord: null, claims: undefined, isSuperAdmin: false })).toBe("app");
    expect(deviceGateVerdict({ permRecord: flagged(null), claims: pickDeviceClaims({}), isSuperAdmin: true })).toBe("app");
  });
  it("isLiveEnrolment never matches on a missing id", () => {
    expect(isLiveEnrolment({ deviceGate: { undefined: undefined } }, {})).toBe(false);
    expect(isLiveEnrolment({ deviceGate: { null: "null" } }, { deviceId: "null", eid: null })).toBe(false);
  });
});

describe("the claims", () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const token = (o) => `${b64({ alg: "RS256" })}.${b64(o)}.sig`;

  it("decodes a token payload (url-safe base64, unicode names)", () => {
    expect(decodeJwtClaims(token({ deviceId: DEV, personName: "Thandi Ngcobo – Hub 2" }))).toMatchObject({ personName: "Thandi Ngcobo – Hub 2" });
    expect(decodeJwtClaims("nonsense")).toBe(null);
    expect(decodeJwtClaims(null)).toBe(null);
  });
  it("reads the cached token, and falls back to decoding it when that throws (offline, expired)", async () => {
    const ok = { getIdTokenResult: async () => ({ claims: { deviceId: DEV, eid: "e1", personName: "Sipho", dkind: "shared" } }) };
    expect(await readSessionClaims(ok)).toEqual({ deviceId: DEV, eid: "e1", personId: null, personName: "Sipho", kind: "shared", canManageCodes: false });
    const offline = { getIdTokenResult: async () => { throw new Error("auth/network-request-failed"); }, accessToken: token({ deviceId: DEV, eid: "e9" }) };
    expect(await readSessionClaims(offline)).toMatchObject({ deviceId: DEV, eid: "e9" });
    expect(await readSessionClaims(null)).toMatchObject({ deviceId: null, eid: null });
  });
});

describe("who is holding the device", () => {
  beforeEach(() => store.clear());
  it("an enrolled device is its person, under the id its token names", () => {
    const id = setDeviceIdentity({ claims: claims(), permRecord: flagged(), user: { email: "mc@marathon.internal" } });
    expect(id).toEqual({ deviceId: DEV, personName: "Sipho", personId: "p1", enrolled: true, canManageCodes: false });
    expect(getDeviceIdentity()).toBe(id);
  });
  it("the Device codes tile shows only for a LIVE enrolment whose token says code-maker", () => {
    const mgr = pickDeviceClaims({ deviceId: DEV, eid: "e1", personName: "MC", dmgr: true });
    expect(setDeviceIdentity({ claims: mgr, permRecord: flagged({ [DEV]: "e1" }) }).canManageCodes).toBe(true);
    expect(setDeviceIdentity({ claims: mgr, permRecord: flagged(null) }).canManageCodes).toBe(false);
    expect(setDeviceIdentity({ claims: pickDeviceClaims({ deviceId: DEV, eid: "e1", dmgr: "true" }), permRecord: flagged({ [DEV]: "e1" }) }).canManageCodes).toBe(false);
  });
  it("a login without codes is the account's own name, on the browser's own id", () => {
    const id = setDeviceIdentity({ claims: pickDeviceClaims({}), permRecord: { displayName: "Mike" }, user: { email: "mike@marathon.internal" } });
    expect(id.personName).toBe("Mike");
    expect(id.enrolled).toBe(false);
    expect(id.deviceId).toBe(getDeviceId());
    expect(setDeviceIdentity({ claims: null, permRecord: null, user: { email: "amanda@marathon.internal" } }).personName).toBe("amanda");
  });
  it("adoptDeviceId brings the browser's id into line with the token", () => {
    const before = getDeviceId();
    adoptDeviceId(DEV);
    expect(getDeviceId()).toBe(DEV);
    expect(before).not.toBe(DEV);
    adoptDeviceId(null);
    expect(getDeviceId()).toBe(DEV);
  });
});

describe("deviceTypeHint", () => {
  it("names the common devices", () => {
    expect(deviceTypeHint({ userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit Chrome/152 Mobile Safari/537.36" })).toBe("Android phone · Chrome");
    expect(deviceTypeHint({ userAgent: "Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit Chrome/140 Safari/537.36" })).toBe("Android tablet · Chrome");
    expect(deviceTypeHint({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1" })).toBe("iPhone · Safari");
    expect(deviceTypeHint({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17 Safari/605", maxTouchPoints: 5 })).toBe("iPad · Safari");
    expect(deviceTypeHint({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140 Safari/537.36 Edg/140" })).toBe("Windows PC · Edge");
    expect(deviceTypeHint(undefined)).toBe("Unknown device");
  });
});

describe("last seen", () => {
  it("writes the device's own leaf with the given (server) time, at most every ten minutes, and never throws", async () => {
    const { writeLastSeen, LAST_SEEN_EVERY_MS } = await import("../enrolment.js");
    const mem = new Map();
    const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
    const writes = [];
    const write = async (p, v) => { writes.push([p, v]); };
    const T = 1790000000000;
    expect(await writeLastSeen({ deviceId: DEV, write, nowMs: T, storage })).toBe(true);
    expect(await writeLastSeen({ deviceId: DEV, write, nowMs: T + 60e3, storage })).toBe(false);
    expect(await writeLastSeen({ deviceId: DEV, write, nowMs: T + LAST_SEEN_EVERY_MS, storage })).toBe(true);
    expect(writes).toEqual([[`device_enrolment/devices/${DEV}/lastSeenAtMs`, T], [`device_enrolment/devices/${DEV}/lastSeenAtMs`, T + LAST_SEEN_EVERY_MS]]);
    const refused = async () => { throw new Error("PERMISSION_DENIED"); };
    expect(await writeLastSeen({ deviceId: DEV, write: refused, nowMs: T + 99 * LAST_SEEN_EVERY_MS, storage })).toBe(false);
    expect(await writeLastSeen({ deviceId: null, write, nowMs: T, storage })).toBe(false);
  });
});

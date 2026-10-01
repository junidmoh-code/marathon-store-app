// thisDevicePaused (src/device/rejectCount.js): the question every send and
// reject asks first. A phone that has ALREADY heard it is quarantined (the
// flag is cached by src/device/quarantine.js) is paused even when the live
// read cannot answer — offline is exactly when a quarantined phone would
// otherwise slip a reject through.
import { describe, it, expect, beforeEach, vi } from "vitest";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k), clear: () => mem.clear(),
};
const getMock = vi.fn();
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }), get: (...a) => getMock(...a), push: vi.fn(), set: vi.fn(), increment: (n) => n,
}));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("../enrolment", () => ({ getDeviceIdentity: () => null }));

const { thisDevicePaused } = await import("../rejectCount");
const { writeCachedQuarantine } = await import("../quarantine");
const PHONE = "2964c145-ecad-4f61-9f7a-304231af0e01";

describe("thisDevicePaused", () => {
  beforeEach(() => { mem.clear(); mem.set("marathon.deviceId", PHONE); getMock.mockReset(); });

  it("a cached quarantine answers at once, without waiting for a read that never comes", async () => {
    writeCachedQuarantine(PHONE, true);
    getMock.mockImplementation(() => new Promise(() => {}));     // offline: no answer, ever
    expect(await thisDevicePaused()).toBe(true);
  });

  it("no cache → the live flag decides", async () => {
    getMock.mockResolvedValue({ val: () => ({ on: true }) });
    expect(await thisDevicePaused()).toBe(true);
    expect(getMock.mock.calls[0][0].path).toBe(`mirror_switch/quarantine/${PHONE}`);
    getMock.mockResolvedValue({ val: () => null });
    expect(await thisDevicePaused()).toBe(false);
  });

  it("no cache and no answer within 1.5 s → goes ahead (fails open)", async () => {
    vi.useFakeTimers();
    getMock.mockImplementation(() => new Promise(() => {}));
    const p = thisDevicePaused();
    await vi.advanceTimersByTimeAsync(1501);
    expect(await p).toBe(false);
    vi.useRealTimers();
  });
});

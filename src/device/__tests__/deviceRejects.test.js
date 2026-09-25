// The per-device reject log and the quarantine check before a press
// (src/device/deviceRejects.js). Pure — the read is injected.
import { describe, it, expect, vi } from "vitest";
import {
  deviceRejectsPath, deviceRejectRecord, tallyDeviceRejects, isThisDeviceQuarantined, saDayOf, DEVICE_REJECTS_NODE,
} from "../deviceRejects";

const PHONE = "2964c145-ecad-4f61-9f7a-304231af0e01";

describe("where a reject is logged", () => {
  it("keys by SA day FIRST, then the phone — so a week is one bounded key range", () => {
    // 23:30 UTC on the 24th is 01:30 SA on the 25th
    expect(deviceRejectsPath(PHONE, Date.parse("2026-09-24T23:30:00Z"))).toBe(`${DEVICE_REJECTS_NODE}/2026-09-25/${PHONE}`);
    expect(deviceRejectsPath(PHONE, Date.parse("2026-09-25T12:22:45.065Z"))).toBe(`device_rejects/2026-09-25/${PHONE}`);
  });
  it("refuses anything that is not a device id — never a path that addresses a parent", () => {
    for (const bad of [null, undefined, "", "short", "../x/yyyyyyyy", "a/b/cdefghij", "has.dot.inside", 42]) {
      expect(deviceRejectsPath(bad, Date.now()), String(bad)).toBeNull();
    }
    expect(deviceRejectsPath(PHONE, NaN)).toBeNull();
  });
  it("saDayOf is the same formula as the rule's day key", () => {
    expect(saDayOf(Date.parse("2026-09-25T21:59:59.999Z"))).toBe("2026-09-25");
    expect(saDayOf(Date.parse("2026-09-25T22:00:00.000Z"))).toBe("2026-09-26");
  });
});

describe("the record", () => {
  it("is small and has no undefined (RTDB would refuse it)", () => {
    const r = deviceRejectRecord({ kind: "order", ref: 197, hub: "hub2", productId: "p1783245119000", size: 6, uid: "u1", atMs: 5 });
    expect(r).toEqual({ at: 5, uid: "u1", kind: "order", ref: "197", hub: "hub2", pid: "p1783245119000", size: "6" });
    const bare = deviceRejectRecord({ atMs: 5 });
    expect(Object.values(bare).includes(undefined)).toBe(false);
    expect(bare).toEqual({ at: 5, uid: null, kind: "order", ref: null, hub: null, pid: null, size: null });
  });
});

describe("the tally", () => {
  const TODAY = "2026-09-25";
  const log = {
    "2026-09-23": { [PHONE]: { a: { at: 100, uid: "ayob", kind: "order" } } },
    [TODAY]: {
      [PHONE]: { b: { at: 300, uid: "ayob" }, c: { at: 200, uid: "mc" }, junk: "x", nulls: null, noAt: { uid: "z" } },
      other: { d: { at: 50, uid: "mike" } },
    },
    "2026-09-24": "garbage",
  };
  it("counts today and the range per phone, and names the latest", () => {
    const t = tallyDeviceRejects(log, { today: TODAY });
    expect(t[PHONE]).toEqual({ today: 2, total: 3, lastAt: 300, lastUid: "ayob" });
    expect(t.other).toEqual({ today: 1, total: 1, lastAt: 50, lastUid: "mike" });
  });
  it("an empty or missing log is no rejects, never a throw", () => {
    expect(tallyDeviceRejects(null)).toEqual({});
    expect(tallyDeviceRejects("x")).toEqual({});
  });
});

describe("is THIS phone quarantined? — asked before a press, fails open", () => {
  it("only a flag set on purpose is ON (#640's verdict)", async () => {
    for (const [raw, want] of [[{ on: true }, true], [true, true], [{ on: false }, false], [null, false], ["true", false], [1, false], [{ on: "yes" }, false]]) {
      expect(await isThisDeviceQuarantined({ deviceId: PHONE, read: async () => raw }), JSON.stringify(raw)).toBe(want);
    }
  });
  it("reads ONE path: this phone's own flag", async () => {
    const read = vi.fn(async () => null);
    await isThisDeviceQuarantined({ deviceId: PHONE, read });
    expect(read).toHaveBeenCalledWith(`mirror_switch/quarantine/${PHONE}`);
  });
  it("no device id → not quarantined, and nothing is read", async () => {
    const read = vi.fn();
    expect(await isThisDeviceQuarantined({ deviceId: null, read })).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
  it("a refused read, a throw, or no answer in time → not quarantined (the rule is the backstop)", async () => {
    expect(await isThisDeviceQuarantined({ deviceId: PHONE, read: async () => { throw new Error("PERMISSION_DENIED"); } })).toBe(false);
    expect(await isThisDeviceQuarantined({ deviceId: PHONE, read: () => { throw new Error("sync"); } })).toBe(false);
    vi.useFakeTimers();
    const p = isThisDeviceQuarantined({ deviceId: PHONE, read: () => new Promise(() => {}), timeoutMs: 3000 });
    await vi.advanceTimersByTimeAsync(3001);
    expect(await p).toBe(false);
    vi.useRealTimers();
  });
});

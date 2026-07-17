import { describe, it, expect } from "vitest";
import { shouldWarn, describeSkew, clockWarningText, CLOCK_WARN_THRESHOLD_MS } from "./ClockWarningBanner.jsx";
import { setServerTimeOffsetMs, onServerTimeOffsetChange, getServerTimeOffsetMs } from "../utils/serverTime";

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

describe("shouldWarn", () => {
  it("stays quiet for ordinary drift — this must not cry wolf", () => {
    for (const ms of [0, 1, -1, 5000, -5000, 60_000, -60_000, 4 * MIN, -4 * MIN]) {
      expect(shouldWarn(ms)).toBe(false);
    }
  });

  it("fires at or past the 5-minute threshold, in BOTH directions", () => {
    expect(shouldWarn(CLOCK_WARN_THRESHOLD_MS)).toBe(true);
    expect(shouldWarn(-CLOCK_WARN_THRESHOLD_MS)).toBe(true);
    expect(shouldWarn(CLOCK_WARN_THRESHOLD_MS - 1)).toBe(false);
    expect(shouldWarn(-(CLOCK_WARN_THRESHOLD_MS - 1))).toBe(false);
  });

  it("fires on the real incident (device 24h behind)", () => {
    expect(shouldWarn(24 * HOUR)).toBe(true);
  });

  it("never fires on junk — an unknown offset is not a wrong clock", () => {
    for (const junk of [null, undefined, NaN, Infinity, -Infinity, "300000", {}]) {
      expect(shouldWarn(junk)).toBe(false);
    }
  });
});

describe("describeSkew — plain words, no decimals", () => {
  it("reads in minutes under an hour", () => {
    expect(describeSkew(5 * MIN)).toBe("about 5 minutes");
    expect(describeSkew(1 * MIN)).toBe("about 1 minute");
  });
  it("reads in hours under two days", () => {
    expect(describeSkew(HOUR)).toBe("about 1 hour");
    expect(describeSkew(24 * HOUR)).toBe("about 24 hours");
  });
  it("reads in days beyond that", () => {
    expect(describeSkew(3 * DAY)).toBe("about 3 days");
  });
});

describe("clockWarningText — the words staff actually read", () => {
  it("names the problem AND the fix in plain English", () => {
    const t = clockWarningText(24 * HOUR);
    expect(t).toContain("date/time is wrong");
    expect(t).toContain("set it to automatic");
    expect(t).not.toMatch(/offset|serverTimeOffset|ms\b|NaN|undefined/i);
  });

  it("says BEHIND when the device lags the server (the incident)", () => {
    // offset = server - device, so positive => device is behind.
    expect(clockWarningText(24 * HOUR)).toContain("about 24 hours behind");
  });

  it("says AHEAD when the device runs fast", () => {
    expect(clockWarningText(-2 * HOUR)).toContain("about 2 hours ahead");
  });
});

describe("subscription wiring", () => {
  it("fires immediately with the current value, then on change, and unsubscribes", () => {
    setServerTimeOffsetMs(0);
    const seen = [];
    const off = onServerTimeOffsetChange(v => seen.push(v));
    expect(seen).toEqual([0]);          // immediate

    setServerTimeOffsetMs(24 * HOUR);
    expect(seen).toEqual([0, 24 * HOUR]); // on change

    setServerTimeOffsetMs(24 * HOUR);     // identical -> no re-notify
    expect(seen).toEqual([0, 24 * HOUR]);

    off();
    setServerTimeOffsetMs(0);
    expect(seen).toEqual([0, 24 * HOUR]); // unsubscribed
    expect(getServerTimeOffsetMs()).toBe(0);
  });

  it("a throwing subscriber cannot break the offset update — never block a sale", () => {
    setServerTimeOffsetMs(0);
    const off1 = onServerTimeOffsetChange(() => { throw new Error("boom"); });
    const seen = [];
    const off2 = onServerTimeOffsetChange(v => seen.push(v));
    expect(() => setServerTimeOffsetMs(9 * MIN)).not.toThrow();
    expect(getServerTimeOffsetMs()).toBe(9 * MIN);
    expect(seen).toContain(9 * MIN);
    off1(); off2(); setServerTimeOffsetMs(0);
  });
});

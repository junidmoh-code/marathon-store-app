import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  setServerTimeOffsetMs, getServerTimeOffsetMs,
  serverNowMs, serverNowIso, saDateString, saHour, saTodayKey,
} from "./serverTime";

// The device clock in these tests is deliberately WRONG — exactly the 2026-07-17
// incident: a till whose date was 24h behind (time-of-day correct). Every
// assertion is that the device clock does not matter.
const REAL_NOW = Date.parse("2026-07-17T10:17:00.000Z");
const DEVICE_NOW = Date.parse("2026-07-16T10:17:00.000Z"); // 24h slow
const SKEW = REAL_NOW - DEVICE_NOW;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(DEVICE_NOW);
  setServerTimeOffsetMs(0);
});
afterEach(() => vi.useRealTimers());

describe("offset plumbing", () => {
  it("defaults to 0 — degrades to the device clock rather than blocking a sale", () => {
    expect(getServerTimeOffsetMs()).toBe(0);
    expect(serverNowMs()).toBe(DEVICE_NOW);
  });

  it("ignores junk values rather than poisoning every timestamp", () => {
    setServerTimeOffsetMs(SKEW);
    for (const junk of [null, undefined, NaN, Infinity, "5000", {}]) {
      setServerTimeOffsetMs(junk);
      expect(getServerTimeOffsetMs()).toBe(SKEW); // unchanged
    }
  });
});

describe("a 24h-slow device (the real incident)", () => {
  beforeEach(() => setServerTimeOffsetMs(SKEW));

  it("stamps the CORRECT instant despite the wrong clock", () => {
    expect(serverNowMs()).toBe(REAL_NOW);
    expect(serverNowIso()).toBe("2026-07-17T10:17:00.000Z");
  });

  it("stamps TODAY's date, not yesterday — the warehouse-queue bug", () => {
    expect(saDateString()).toBe("2026-07-17");
  });

  it("computes the counter day key as today, so it cannot reset the counter", () => {
    // 0-based month: 6 === July. Live /orderCounter held day "2026-6-17".
    expect(saTodayKey()).toBe("2026-6-17");
  });

  it("without correction the same device produces yesterday (the bug)", () => {
    setServerTimeOffsetMs(0);
    expect(saDateString()).toBe("2026-07-16");
    expect(saTodayKey()).toBe("2026-6-16"); // != stored "2026-6-17" -> reset to 001
  });
});

describe("SA offset (+2, no DST)", () => {
  it("saHour shifts UTC by +2", () => {
    setServerTimeOffsetMs(SKEW);
    expect(saHour()).toBe(12); // 10:17Z -> 12:17 SAST
  });

  it("rolls the day at SA midnight, not UTC midnight", () => {
    vi.setSystemTime(Date.parse("2026-07-17T21:59:00Z"));
    setServerTimeOffsetMs(0);
    expect(saDateString()).toBe("2026-07-17"); // 23:59 SAST
    expect(saTodayKey()).toBe("2026-6-17");

    vi.setSystemTime(Date.parse("2026-07-17T22:00:00Z"));
    expect(saDateString()).toBe("2026-07-18"); // 00:00 SAST
    expect(saTodayKey()).toBe("2026-6-18");
  });

  it("a device in a far-off timezone still gets the SA day", () => {
    // Formula reads UTC parts, so the host timezone can never leak in.
    vi.setSystemTime(Date.parse("2026-07-17T10:17:00Z"));
    setServerTimeOffsetMs(0);
    expect(saTodayKey()).toBe("2026-6-17");
  });
});

describe("saTodayKey matches the refill engine", () => {
  // Byte-identical to saTodayKey() in functions/lib/refill-engine.cjs. The
  // engine draws from the SAME /refillCounter; if these disagree they reset
  // each other — the bug that destroyed 47 orders.
  const engineSaTodayKey = (nowMs) => {
    const d = new Date(nowMs + 2 * 60 * 60 * 1000);
    return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
  };

  it("agrees with the engine across a year of days and both midnight edges", () => {
    setServerTimeOffsetMs(0);
    for (let i = 0; i < 365 * 24; i++) {
      const ms = Date.parse("2026-01-01T00:00:00Z") + i * 3600_000;
      vi.setSystemTime(ms);
      expect(saTodayKey()).toBe(engineSaTodayKey(ms));
    }
  });
});

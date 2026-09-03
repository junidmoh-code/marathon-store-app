// ── Reconcile scope tests: the watermark contract and its backstops ──────────
// Pure-function tests (no RTDB): every rule that decides WHICH nodes a tick
// looks at. These are the tests that stand between "cheap" and "a product that
// silently never publishes", so they are written as the failure they prevent.
import { describe, it, expect } from "vitest";
import {
  sastHour, isOvernight, fullScanIntervalMs, planScan, nextRetrySet,
  WATERMARK_OVERLAP_MS, FULL_SCAN_DAY_MS, FULL_SCAN_NIGHT_MS, MAX_RETRY_PIDS,
} from "./reconcileScope.mjs";

// SAST is UTC+2, no DST. 2026-09-03T10:00:00Z is 12:00 in Johannesburg.
const at = (iso) => Date.parse(iso);

describe("the clock", () => {
  it("reads UTC+2 with no daylight saving, in January and in July", () => {
    expect(sastHour(at("2026-01-15T10:00:00Z"))).toBe(12);
    expect(sastHour(at("2026-07-15T10:00:00Z"))).toBe(12);
    expect(sastHour(at("2026-09-03T23:30:00Z"))).toBe(1); // wraps past midnight
  });

  it("calls 23:00–07:00 SAST overnight and nothing else", () => {
    expect(isOvernight(at("2026-09-03T21:30:00Z"))).toBe(true);  // 23:30 SAST
    expect(isOvernight(at("2026-09-03T03:00:00Z"))).toBe(true);  // 05:00 SAST
    expect(isOvernight(at("2026-09-03T05:30:00Z"))).toBe(false); // 07:30 SAST
    expect(isOvernight(at("2026-09-03T18:00:00Z"))).toBe(false); // 20:00 SAST
  });

  it("backs the full scan off overnight and not by day", () => {
    expect(fullScanIntervalMs(at("2026-09-03T12:00:00Z"))).toBe(FULL_SCAN_DAY_MS);
    expect(fullScanIntervalMs(at("2026-09-03T02:00:00Z"))).toBe(FULL_SCAN_NIGHT_MS);
  });
});

describe("planScan — an incremental tick may never be the reason work is missed", () => {
  const now = at("2026-09-03T12:00:00Z");

  it("scans everything when there is no state at all (first run, wiped node)", () => {
    expect(planScan({ state: null, nowMs: now }).mode).toBe("full");
    expect(planScan({ state: { watermark: 0 }, nowMs: now }).mode).toBe("full");
    expect(planScan({ state: { watermark: "nonsense" }, nowMs: now }).mode).toBe("full");
  });

  it("scans everything when --full is asked for, whatever the state says", () => {
    const state = { watermark: now - 1000, lastFullScanAt: now - 1000 };
    expect(planScan({ state, nowMs: now, force: true }).mode).toBe("full");
  });

  it("scans everything once the cadence is due, and reads the window otherwise", () => {
    const fresh = { watermark: now - 60_000, lastFullScanAt: now - 60_000 };
    expect(planScan({ state: fresh, nowMs: now }).mode).toBe("incremental");
    const stale = { watermark: now - 60_000, lastFullScanAt: now - FULL_SCAN_DAY_MS - 1 };
    expect(planScan({ state: stale, nowMs: now }).mode).toBe("full");
  });

  it("holds the overnight cadence past the daytime one", () => {
    const night = at("2026-09-03T02:00:00Z");
    const state = { watermark: night - 1000, lastFullScanAt: night - FULL_SCAN_DAY_MS - 1 };
    expect(planScan({ state, nowMs: night }).mode).toBe("incremental");
    const older = { watermark: night - 1000, lastFullScanAt: night - FULL_SCAN_NIGHT_MS - 1 };
    expect(planScan({ state: older, nowMs: night }).mode).toBe("full");
  });

  it("starts the window BEFORE the watermark, so a write racing the last run is not stepped over", () => {
    const state = { watermark: now - 60_000, lastFullScanAt: now - 60_000 };
    expect(planScan({ state, nowMs: now }).since).toBe(now - 60_000 - WATERMARK_OVERLAP_MS);
  });

  it("falls back to a full scan when the watermark is ahead of the clock", () => {
    const skewed = { watermark: now + 60 * 60 * 1000, lastFullScanAt: now - 1000 };
    expect(planScan({ state: skewed, nowMs: now }).mode).toBe("full");
  });
});

describe("nextRetrySet — unfinished work outlives the window that cannot see it", () => {
  const now = 1_000_000;

  it("remembers a failure, because a failed apply does not move the node's updatedAt", () => {
    expect(nextRetrySet({ previous: {}, attempted: ["a"], failedPids: ["a"], nowMs: now })).toEqual({ a: now });
  });

  it("forgets a product once a later run applies it", () => {
    const carried = nextRetrySet({ previous: { a: 1 }, attempted: ["a"], failedPids: [], nowMs: now });
    expect(carried).toEqual({});
  });

  it("keeps a product that was remembered but NOT attempted this run (per-run cap)", () => {
    expect(nextRetrySet({ previous: { a: 1 }, attempted: ["b"], failedPids: [], nowMs: now })).toEqual({ a: 1 });
  });

  it("keeps the ORIGINAL failure time, so age is real", () => {
    expect(nextRetrySet({ previous: { a: 5 }, attempted: ["a"], failedPids: ["a"], nowMs: now })).toEqual({ a: 5 });
  });

  it("caps the set and drops the OLDEST, so today's failures are never crowded out", () => {
    const previous = {};
    for (let i = 0; i < MAX_RETRY_PIDS; i++) previous[`old${i}`] = i + 1; // oldest = old0
    const next = nextRetrySet({ previous, attempted: [], failedPids: ["new"], nowMs: now });
    expect(Object.keys(next)).toHaveLength(MAX_RETRY_PIDS);
    expect(next.new).toBe(now);
    expect(next.old0).toBeUndefined();
    expect(next[`old${MAX_RETRY_PIDS - 1}`]).toBeDefined();
  });
});

// ─── BATCHED RELEASE WINDOWS — the whole gate, pinned ────────────────────────
// Run: npx vitest run src/components/stock/releaseWindows.test.js
//
// The gate is a pure function of (createdAt, now, config): a request is
// pickable iff it was created at or before the most recent release instant,
// or an admin released it early. These tests pin the owner's spec cases
// verbatim (raised 13:55 → pickable at 14:00; raised 14:05 → created
// immediately but pickable only at the 06:00 release), the config fallback,
// the carry-over across windows, and the SA-not-UTC day arithmetic that has
// bitten this project before.
import { describe, it, expect } from "vitest";
import {
  DEFAULT_RELEASE_TIMES, parseTimeOfDay, parseReleaseTimes,
  lastReleaseMs, nextReleaseMs, isReleased, partitionReleased,
  saTimeLabel, releaseEarlyPatch,
} from "./releaseWindows";

// SA is UTC+2: "14:00 SA" on D = D-1? no — same date, 12:00Z.
const saInstant = (date, hhmm) => Date.parse(`${date}T${hhmm}:00.000+02:00`);
const DFLT = parseReleaseTimes(undefined);

describe("parseReleaseTimes — config-driven, defaults when absent, off switch", () => {
  it("absent / null / empty → the default 06:00 & 14:00 windows", () => {
    for (const raw of [undefined, null, [], {}]) {
      const w = parseReleaseTimes(raw);
      expect(w.disabled).toBe(false);
      expect(w.labels).toEqual(DEFAULT_RELEASE_TIMES);
      expect(w.minutes).toEqual([6 * 60, 14 * 60]);
    }
  });

  it("explicit false disables batching entirely — the emergency escape hatch", () => {
    expect(parseReleaseTimes(false).disabled).toBe(true);
    // and a disabled gate releases everything, even a request from the future
    expect(isReleased({ createdAt: "2099-01-01T00:00:00.000Z" }, 0, parseReleaseTimes(false))).toBe(true);
  });

  it("a console-edited array of HH:MM strings is honoured, sorted, deduped", () => {
    const w = parseReleaseTimes(["18:30", "09:15", "18:30"]);
    expect(w.minutes).toEqual([9 * 60 + 15, 18 * 60 + 30]);
    expect(w.labels).toEqual(["09:15", "18:30"]);
  });

  it("RTDB numeric-keyed object form (a sparse console edit) is accepted too", () => {
    const w = parseReleaseTimes({ 0: "06:00", 2: "14:00" });
    expect(w.labels).toEqual(["06:00", "14:00"]);
  });

  it("invalid entries are dropped; ALL-invalid falls back to the defaults, never half-applies", () => {
    expect(parseReleaseTimes(["06:00", "25:00", "junk", "9:75"]).labels).toEqual(["06:00"]);
    expect(parseReleaseTimes(["25:00", "nope", 1400]).labels).toEqual(DEFAULT_RELEASE_TIMES);
  });

  it("parseTimeOfDay is strict about wall-clock validity", () => {
    expect(parseTimeOfDay("06:00")).toBe(360);
    expect(parseTimeOfDay("23:59")).toBe(23 * 60 + 59);
    expect(parseTimeOfDay("24:00")).toBe(null);
    expect(parseTimeOfDay("06:60")).toBe(null);
    expect(parseTimeOfDay("0600")).toBe(null);
    expect(parseTimeOfDay(600)).toBe(null);
  });
});

describe("the owner's spec cases, verbatim", () => {
  it("raised 13:55 SA → pickable in the 14:00 release", () => {
    const r = { createdAt: new Date(saInstant("2026-08-10", "13:55")).toISOString() };
    expect(isReleased(r, saInstant("2026-08-10", "13:59"), DFLT)).toBe(false); // not before the window
    expect(isReleased(r, saInstant("2026-08-10", "14:00"), DFLT)).toBe(true);  // released ON the window
  });

  it("raised 14:05 SA → created immediately, but NOT pickable until the 06:00 release next day", () => {
    const r = { createdAt: new Date(saInstant("2026-08-10", "14:05")).toISOString() };
    expect(isReleased(r, saInstant("2026-08-10", "14:06"), DFLT)).toBe(false);
    expect(isReleased(r, saInstant("2026-08-10", "23:59"), DFLT)).toBe(false);
    expect(isReleased(r, saInstant("2026-08-11", "05:59"), DFLT)).toBe(false);
    expect(isReleased(r, saInstant("2026-08-11", "06:00"), DFLT)).toBe(true);
  });

  it("a released-but-unpicked request STAYS pickable across every later window", () => {
    const r = { createdAt: new Date(saInstant("2026-08-10", "13:55")).toISOString() };
    for (const [d, t] of [["2026-08-10", "14:00"], ["2026-08-10", "22:00"], ["2026-08-11", "06:01"],
                          ["2026-08-11", "13:59"], ["2026-08-12", "09:00"], ["2026-09-01", "03:00"]]) {
      expect(isReleased(r, saInstant(d, t), DFLT), `${d} ${t}`).toBe(true);
    }
  });

  it("everything that predates the feature is already released", () => {
    const r = { createdAt: "2026-07-01T09:00:00.000Z" };
    expect(isReleased(r, saInstant("2026-08-10", "04:00"), DFLT)).toBe(true);
  });
});

describe("SA wall clock, not UTC — the day boundary that has bitten before", () => {
  it("at 01:00 SA (23:00Z the PREVIOUS UTC day) the last release is yesterday 14:00 SA", () => {
    const now = saInstant("2026-08-11", "01:00"); // = 2026-08-10T23:00Z
    expect(lastReleaseMs(now, DFLT)).toBe(saInstant("2026-08-10", "14:00"));
    expect(nextReleaseMs(now, DFLT)).toBe(saInstant("2026-08-11", "06:00"));
  });

  it("at 23:00 SA the next release is tomorrow 06:00 SA", () => {
    const now = saInstant("2026-08-10", "23:00");
    expect(lastReleaseMs(now, DFLT)).toBe(saInstant("2026-08-10", "14:00"));
    expect(nextReleaseMs(now, DFLT)).toBe(saInstant("2026-08-11", "06:00"));
  });

  it("between 06:00 and 14:00 SA the last release is 06:00 today", () => {
    const now = saInstant("2026-08-10", "09:30");
    expect(lastReleaseMs(now, DFLT)).toBe(saInstant("2026-08-10", "06:00"));
    expect(nextReleaseMs(now, DFLT)).toBe(saInstant("2026-08-10", "14:00"));
  });

  it("saTimeLabel renders the SA wall clock of a UTC instant", () => {
    expect(saTimeLabel(Date.parse("2026-08-10T12:00:00.000Z"))).toBe("14:00");
    expect(saTimeLabel(Date.parse("2026-08-10T04:00:00.000Z"))).toBe("06:00");
  });

  it("custom single window: config times drive the maths, not the hardcoded defaults", () => {
    const w = parseReleaseTimes(["09:30"]);
    const r = { createdAt: new Date(saInstant("2026-08-10", "09:00")).toISOString() };
    expect(isReleased(r, saInstant("2026-08-10", "09:29"), w)).toBe(false);
    expect(isReleased(r, saInstant("2026-08-10", "09:30"), w)).toBe(true);
    // and a request raised after 09:30 waits a FULL day
    const late = { createdAt: new Date(saInstant("2026-08-10", "10:00")).toISOString() };
    expect(isReleased(late, saInstant("2026-08-11", "09:29"), w)).toBe(false);
    expect(isReleased(late, saInstant("2026-08-11", "09:30"), w)).toBe(true);
  });
});

describe("urgent override + fail-open edges", () => {
  it("an earlyRelease stamp releases the row between windows", () => {
    const r = { createdAt: new Date(saInstant("2026-08-10", "14:05")).toISOString(),
                earlyRelease: { at: "2026-08-10T13:00:00.000Z", by: "u1", reason: "customer waiting at counter" } };
    expect(isReleased(r, saInstant("2026-08-10", "15:00"), DFLT)).toBe(true);
  });

  it("releaseEarlyPatch records WHO and WHY — and refuses an empty reason", () => {
    const p = releaseEarlyPatch({ nowIso: "2026-08-10T13:00:00.000Z", uid: "u9", reason: "  customer at till  " });
    expect(p).toEqual({ earlyRelease: { at: "2026-08-10T13:00:00.000Z", by: "u9", reason: "customer at till" } });
    expect(releaseEarlyPatch({ nowIso: "x", uid: "u9", reason: "" })).toBe(null);
    expect(releaseEarlyPatch({ nowIso: "x", uid: "u9", reason: "   " })).toBe(null);
    expect(releaseEarlyPatch({ nowIso: "x", uid: null, reason: "why" }).earlyRelease.by).toBe(null);
  });

  it("an unparseable createdAt fails OPEN — bad data must never hide real work", () => {
    expect(isReleased({ createdAt: "not-a-date" }, saInstant("2026-08-10", "15:00"), DFLT)).toBe(true);
    expect(isReleased({}, saInstant("2026-08-10", "15:00"), DFLT)).toBe(true);
  });

  it("partitionReleased splits by the same rule the queue renders with", () => {
    const before = { id: "a", createdAt: new Date(saInstant("2026-08-10", "13:55")).toISOString() };
    const after = { id: "b", createdAt: new Date(saInstant("2026-08-10", "14:05")).toISOString() };
    const { released, waiting } = partitionReleased([before, after], saInstant("2026-08-10", "15:00"), DFLT);
    expect(released.map((r) => r.id)).toEqual(["a"]);
    expect(waiting.map((r) => r.id)).toEqual(["b"]);
  });
});

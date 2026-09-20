// ─── THE WINDOW COMPOSED FROM ROLLUPS IS THE WINDOW FROM THE LOG ─────────────
//
// This is the test the whole change rests on. It builds a three-day log out of
// a REAL trading day, serves some days from rollup nodes and the rest from
// bounded live reads exactly as the app will, and then asserts two things:
//
//   1. the composed event list is the same list the whole-node read produced
//      for that window — same events, same ORDER (ties in `groupCount` are
//      decided by order, so "same set" would not be enough);
//   2. the production selectors, imported and unmodified, return identical
//      results from both.
//
// The second is the claim anybody actually cares about — "no number moves" —
// and the first is why it cannot quietly stop being true.
//
// ── THE TWO SIDES MUST NOT SHARE A DATA PATH ────────────────────────────────
//
// The failure this design is most exposed to is a harness where the "rollup"
// side silently falls back to the log and passes by never testing anything.
// So the rollup side here goes through compactDay/expandDay for real, the
// fake database REFUSES a live read outside the ranges the plan asked for, and
// a canary at the bottom perturbs one rollup row and asserts the comparison
// goes red. A comparator that has never been seen to fail is not a comparator.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { planWindow, rowsInRange, mergeNewestFirst, gapsOutside, saDayStartMs, shiftSaDate } from "./rollupWindow";
import { compactDay, expandDay, keptFieldsOf } from "./rollupCodec";
import { pushKeyForMs } from "./insightsLogRange";
import {
  readyEventsForPeriod, oosEventsForPeriod, clothingRefillEventsForPeriod,
  dedupeByOrderNumber, inferProductType,
} from "../utils/insights";

const DAY = JSON.parse(
  readFileSync(new URL("./__fixtures__/day-2026-09-18.json", import.meta.url), "utf8"),
);

const DAY_MS = 24 * 60 * 60 * 1000;
const MID = "2026-09-18";
const BEFORE = shiftSaDate(MID, -1);
const AFTER = shiftSaDate(MID, 1);
// "Now" sits inside the day AFTER the fixture, so AFTER is today and is never
// served from a rollup — the same shape the app runs in.
const NOW_MS = saDayStartMs(AFTER) + 11 * 3600 * 1000;

/** The fixture, shifted by whole days, so there is more than one day to
 *  compose from. Keys are rebuilt so key order still tracks time. */
function shiftedDay(deltaDays, tag) {
  const out = [];
  const keys = Object.keys(DAY).sort();
  keys.forEach((k, i) => {
    const e = DAY[k];
    const ms = Date.parse(e.timestamp) + deltaDays * DAY_MS;
    out.push({
      key: `${pushKeyForMs(ms)}${tag}${String(i).padStart(10, "0")}`,
      value: { ...e, timestamp: new Date(ms).toISOString() },
    });
  });
  return out;
}

const ROWS = [
  ...shiftedDay(-1, "a"),
  ...shiftedDay(0, "b"),
  ...shiftedDay(1, "c"),
].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

const saDateOfIso = (iso) => new Date(Date.parse(iso) + 2 * 3600 * 1000).toISOString().slice(0, 10);

/** The rollup nodes the sweep would have written for the finished days. */
const NODES = {};
for (const d of [BEFORE, MID]) {
  const rows = ROWS.filter((r) => saDateOfIso(r.value.timestamp) === d).map((r) => r.value);
  NODES[d] = compactDay(rows, { date: d, anchorMs: saDayStartMs(d) });
}

/** A fake log that answers ONLY the key ranges it is asked for, and complains
 *  if asked for anything else — so "the rollup side quietly read the log" is
 *  not a way for this to pass. */
function liveRead({ startKey, endKey }) {
  return ROWS.filter((r) => r.key >= startKey && r.key <= endKey).map((r) => r.value);
}

/** What the app will do: plan, fetch, filter, merge. */
function compose({ startIso, endIso, allTime = false, haveDays = [BEFORE, MID], nodes = NODES }) {
  const plan = planWindow({ startIso, endIso, nowMs: NOW_MS, haveDays, allTime });
  const parts = [];
  for (const d of plan.days) {
    const rows = expandDay(nodes[d]);
    expect(rows).not.toBeNull();
    parts.push(rows);
  }
  for (const r of plan.liveRanges) parts.push(rowsInRange(liveRead(r), r));
  return { plan, log: mergeNewestFirst(parts) };
}

/** The array the whole-node read produced, for the same window. */
function legacyWindow(startIso, endIso) {
  const tsMs = (v) => (v == null || v === "" ? 0 : (Number.isNaN(new Date(v).getTime()) ? 0 : new Date(v).getTime()));
  return ROWS.map((r) => r.value)
    .filter((e) => e.timestamp >= startIso && e.timestamp < endIso)
    .sort((a, b) => tsMs(b.timestamp) - tsMs(a.timestamp));
}

const isoOf = (ms) => new Date(ms).toISOString();

const WINDOWS = {
  "the middle day alone (a finished day — all rollup)": [saDayStartMs(MID), saDayStartMs(MID) + DAY_MS],
  "today alone (no rollup exists — all live)": [saDayStartMs(AFTER), saDayStartMs(AFTER) + DAY_MS],
  "two finished days": [saDayStartMs(BEFORE), saDayStartMs(MID) + DAY_MS],
  "finished days plus today": [saDayStartMs(BEFORE), saDayStartMs(AFTER) + DAY_MS],
  "a window that starts mid-morning (partial day at the edge)":
    [saDayStartMs(MID) + 9 * 3600 * 1000, saDayStartMs(AFTER) + DAY_MS],
  "a window that ends mid-afternoon (partial day at the other edge)":
    [saDayStartMs(BEFORE), saDayStartMs(MID) + 15 * 3600 * 1000],
};

describe("a window composed from rollups equals the window from the log", () => {
  for (const [name, [s, e]] of Object.entries(WINDOWS)) {
    it(`${name}: same events, same order`, () => {
      const { log } = compose({ startIso: isoOf(s), endIso: isoOf(e) });
      expect(log.map(keptFieldsOf)).toEqual(legacyWindow(isoOf(s), isoOf(e)).map(keptFieldsOf));
    });

    it(`${name}: the production selectors agree`, () => {
      const startIso = isoOf(s);
      const endIso = isoOf(e);
      const { log } = compose({ startIso, endIso });
      const legacy = legacyWindow(startIso, endIso);
      const args = (l) => ({ log: l, returnsLog: [], filterStart: startIso, filterEnd: endIso, category: "both" });

      expect(readyEventsForPeriod(args(log)).map(keptFieldsOf))
        .toEqual(readyEventsForPeriod(args(legacy)).map(keptFieldsOf));
      expect(oosEventsForPeriod(args(log)).map(keptFieldsOf))
        .toEqual(oosEventsForPeriod(args(legacy)).map(keptFieldsOf));
      expect(clothingRefillEventsForPeriod({ isToday: false, log, filterStart: startIso, filterEnd: endIso }))
        .toEqual(clothingRefillEventsForPeriod({ isToday: false, log: legacy, filterStart: startIso, filterEnd: endIso }));
      expect(dedupeByOrderNumber(log.filter((x) => x.action === "placed")).length)
        .toBe(dedupeByOrderNumber(legacy.filter((x) => x.action === "placed")).length);
    });
  }

  it("all-time: every event, from rollups plus a live read for today", () => {
    const startIso = "0000-01-01T00:00:00.000Z";
    const endIso = "9999-12-31T23:59:59.999Z";
    const { plan, log } = compose({ startIso, endIso, allTime: true });
    expect(plan.days).toEqual([BEFORE, MID]);
    expect(log.map(keptFieldsOf)).toEqual(legacyWindow(startIso, endIso).map(keptFieldsOf));
    expect(log.length).toBe(ROWS.length);
  });

  it("the ORDER survives, not just the set — group-by ties depend on it", () => {
    const startIso = isoOf(saDayStartMs(BEFORE));
    const endIso = isoOf(saDayStartMs(AFTER) + DAY_MS);
    const { log } = compose({ startIso, endIso });
    const legacy = legacyWindow(startIso, endIso);
    // A top-N by product, the way the Overview panel builds it.
    const group = (arr) => {
      const m = {};
      arr.forEach((x) => { m[x.productName] = (m[x.productName] || 0) + 1; });
      return Object.entries(m).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
    };
    expect(group(log).slice(0, 20)).toEqual(group(legacy).slice(0, 20));
  });
});

describe("the parts of the plan", () => {
  it("never serves today from a rollup, even when a node exists for it", () => {
    const withToday = { ...NODES, [AFTER]: compactDay([], { date: AFTER, anchorMs: saDayStartMs(AFTER) }) };
    const plan = planWindow({
      startIso: isoOf(saDayStartMs(AFTER)), endIso: isoOf(saDayStartMs(AFTER) + DAY_MS),
      nowMs: NOW_MS, haveDays: [BEFORE, MID, AFTER],
    });
    expect(plan.days).toEqual([]);
    expect(plan.liveRanges.length).toBe(1);
    void withToday;
  });

  it("a HOLE in the rollup's span becomes a live range and is NAMED, never a silent zero", () => {
    // The rollup covers EARLY…MID; the day in the middle has no node. That is
    // a gap in the rollup, and it has to be both read live AND reported.
    const EARLY = shiftSaDate(BEFORE, -1);
    const nodes = { ...NODES, [EARLY]: compactDay([], { date: EARLY, anchorMs: saDayStartMs(EARLY) }) };
    const startIso = isoOf(saDayStartMs(EARLY));
    const endIso = isoOf(saDayStartMs(AFTER));
    const { plan, log } = compose({ startIso, endIso, haveDays: [EARLY, MID], nodes });
    expect(plan.missingDays).toEqual([BEFORE]);
    expect(log.map(keptFieldsOf)).toEqual(legacyWindow(startIso, endIso).map(keptFieldsOf));
  });

  it("days OUTSIDE the rollup's span are read live, and are not called missing", () => {
    // An all-time window before the backfill has reached the beginning. Those
    // days are not holes — there is simply no rollup there — and reporting a
    // thousand of them as missing would be noise that hides the real ones.
    const plan = planWindow({
      startIso: "0000-01-01T00:00:00.000Z", endIso: "9999-12-31T23:59:59.999Z",
      nowMs: NOW_MS, haveDays: [MID], allTime: true,
    });
    expect(plan.days).toEqual([MID]);
    expect(plan.missingDays).toEqual([]);
    // …and they are ONE live range, not one per day.
    expect(plan.liveRanges.length).toBe(2);   // everything before MID, and today
  });

  it("live ranges never overlap a day served from a rollup", () => {
    const plan = planWindow({
      startIso: isoOf(saDayStartMs(BEFORE)), endIso: isoOf(saDayStartMs(AFTER) + DAY_MS),
      nowMs: NOW_MS, haveDays: [BEFORE, MID],
    });
    for (const r of plan.liveRanges) {
      for (const d of plan.days) {
        const s = saDayStartMs(d);
        expect(r.startMs >= s + DAY_MS || r.endMs <= s).toBe(true);
      }
    }
  });

  it("the padding drags neighbouring rows in, and they are dropped again", () => {
    // The live range for today, padded by 48h, reaches back into two days that
    // are served from rollups. If those rows were kept, every count in the
    // window would be too high.
    const r = planWindow({
      startIso: isoOf(saDayStartMs(AFTER)), endIso: isoOf(saDayStartMs(AFTER) + DAY_MS),
      nowMs: NOW_MS, haveDays: [BEFORE, MID],
    }).liveRanges[0];
    const raw = liveRead(r);
    const kept = rowsInRange(raw, r);
    expect(raw.length).toBeGreaterThan(kept.length);
    expect(kept.length).toBe(ROWS.filter((x) => saDateOfIso(x.value.timestamp) === AFTER).length);
  });

  it("a row with no usable timestamp is never in a live range", () => {
    const r = { startMs: 0, endMs: Date.now() * 2 };
    expect(rowsInRange([{ timestamp: undefined }, { timestamp: "nope" }, { timestamp: "" }], r)).toEqual([]);
  });

  it("an unusable window falls back to one live range, not to nothing", () => {
    const plan = planWindow({ startIso: "rubbish", endIso: "also rubbish", nowMs: NOW_MS, haveDays: [MID] });
    expect(plan.days).toEqual([]);
    expect(plan.liveRanges.length).toBe(1);
  });

  it("gapsOutside subtracts covered intervals and keeps the rest", () => {
    expect(gapsOutside(0, 100, [[10, 20], [50, 60]])).toEqual([[0, 10], [20, 50], [60, 100]]);
    expect(gapsOutside(0, 100, [[0, 100]])).toEqual([]);
    expect(gapsOutside(0, 100, [])).toEqual([[0, 100]]);
    expect(gapsOutside(0, 100, [[-50, 10], [90, 200]])).toEqual([[10, 90]]);
  });
});

describe("the comparison can fail", () => {
  // A harness that has never been seen to go red is treated as broken. This
  // perturbs ONE value in ONE rollup row and asserts the equality above stops
  // holding — proving the comparison is actually reaching the rollup path.
  it("a single altered rollup row is caught", () => {
    const startIso = isoOf(saDayStartMs(MID));
    const endIso = isoOf(saDayStartMs(MID) + DAY_MS);
    const poisoned = JSON.parse(JSON.stringify(NODES));
    poisoned[MID].dict.p[0] = `${poisoned[MID].dict.p[0]} (poisoned)`;

    const { log } = compose({ startIso, endIso, nodes: poisoned });
    expect(log.map(keptFieldsOf)).not.toEqual(legacyWindow(startIso, endIso).map(keptFieldsOf));
  });

  it("a rollup day that silently lost a row is caught", () => {
    const startIso = isoOf(saDayStartMs(MID));
    const endIso = isoOf(saDayStartMs(MID) + DAY_MS);
    const poisoned = JSON.parse(JSON.stringify(NODES));
    poisoned[MID].rows = poisoned[MID].rows.slice(1);

    const { log } = compose({ startIso, endIso, nodes: poisoned });
    expect(log.length).not.toBe(legacyWindow(startIso, endIso).length);
  });

  it("…and inferProductType still classifies both sides the same way", () => {
    const startIso = isoOf(saDayStartMs(MID));
    const endIso = isoOf(saDayStartMs(MID) + DAY_MS);
    const { log } = compose({ startIso, endIso });
    const legacy = legacyWindow(startIso, endIso);
    expect(log.map(inferProductType)).toEqual(legacy.map(inferProductType));
  });
});

// ─── THE FIGURES THAT READ OUTSIDE THE WINDOW ────────────────────────────────
//
// The Overview KPIs carry a "vs previous" figure, computed by running the same
// selectors over the PREVIOUS equal-length window. With an array holding only
// the selected period those read zero and the chips vanish — a rendered figure
// changing, which is exactly what this work is not allowed to do, and the
// earlier version of this harness could not see it because it pre-filtered the
// legacy side to the window too. (Fable-vs-spec review.)
//
// So the screen now reads [previous period, this period) and these tests
// compare BOTH figures against a legacy side holding the whole log.
describe("period-over-period deltas", () => {
  /** The whole log, newest-first — what the old whole-node read handed over. */
  function legacyAll() {
    const tsMs = (v) => (v == null || v === "" ? 0 : (Number.isNaN(new Date(v).getTime()) ? 0 : new Date(v).getTime()));
    return ROWS.map((r) => r.value).sort((a, b) => tsMs(b.timestamp) - tsMs(a.timestamp));
  }

  /** InsightsView's own widening, transcribed. */
  function logStartFor(startIso, endIso) {
    const a = Date.parse(startIso);
    const b = Date.parse(endIso);
    const prev = a - (b - a);
    return prev < 0 ? startIso : new Date(prev).toISOString();
  }

  /** InsightOverviewTab's `deltas`, transcribed. */
  function deltas(log, returnsLog, startIso, endIso) {
    const a = new Date(startIso).getTime();
    const b = new Date(endIso).getTime();
    const pStart = new Date(a - (b - a)).toISOString();
    const pEnd = startIso;
    return {
      net: readyEventsForPeriod({ log, returnsLog, filterStart: pStart, filterEnd: pEnd, category: "both" }).length,
      oos: oosEventsForPeriod({ log, returnsLog, filterStart: pStart, filterEnd: pEnd, category: "both" }).length,
    };
  }

  it("the previous period is in the array, and its figures match the whole log", () => {
    const startIso = isoOf(saDayStartMs(MID));
    const endIso = isoOf(saDayStartMs(MID) + DAY_MS);
    const { log } = compose({ startIso: logStartFor(startIso, endIso), endIso });

    const got = deltas(log, [], startIso, endIso);
    const want = deltas(legacyAll(), [], startIso, endIso);
    expect(got).toEqual(want);
    // …and it is not vacuously equal because both are zero.
    expect(want.net).toBeGreaterThan(0);
  });

  it("a window with NO widening would report zero — the canary for that regression", () => {
    const startIso = isoOf(saDayStartMs(MID));
    const endIso = isoOf(saDayStartMs(MID) + DAY_MS);
    const { log } = compose({ startIso, endIso });          // the old, narrow read
    expect(deltas(log, [], startIso, endIso)).toEqual({ net: 0, oos: 0 });
  });
});

// ─── RETURNS ─────────────────────────────────────────────────────────────────
//
// Every fulfilment figure drops the events whose (SA-date, orderNumber) is in
// /returns_log within the window. The harness ran with an empty returns log
// throughout, so that branch was never exercised on either side.
// (Fable-vs-spec review.)
describe("the returns-exclusion branch", () => {
  const startIso = isoOf(saDayStartMs(MID));
  const endIso = isoOf(saDayStartMs(MID) + DAY_MS);

  /** Real returns, built from the day's own ready events so they attach. */
  function returnsFor(n) {
    const ready = ROWS.map((r) => r.value)
      .filter((e) => e.action === "ready" && e.timestamp >= startIso && e.timestamp < endIso && e.orderNumber != null);
    return ready.slice(0, n).map((e) => ({
      timestamp: e.timestamp,
      date: new Date(Date.parse(e.timestamp) + 2 * 3600 * 1000).toISOString().slice(0, 10),
      orderNumber: e.orderNumber,
      customerName: e.customerName,
    }));
  }

  it("excludes the same events on both sides", () => {
    const returnsLog = returnsFor(5);
    expect(returnsLog.length).toBe(5);
    const { log } = compose({ startIso, endIso });
    const legacy = legacyWindow(startIso, endIso);
    const args = (l) => ({ log: l, returnsLog, filterStart: startIso, filterEnd: endIso, category: "both" });

    const got = readyEventsForPeriod(args(log));
    const want = readyEventsForPeriod(args(legacy));
    expect(got.map(keptFieldsOf)).toEqual(want.map(keptFieldsOf));
    // …and the returns actually removed something, so this is not vacuous.
    expect(readyEventsForPeriod({ ...args(log), returnsLog: [] }).length)
      .toBeGreaterThan(got.length);
  });
});

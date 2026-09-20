// ─── THE FETCHER ─────────────────────────────────────────────────────────────
//
// planWindow decides what a window needs; readWindow gets it. What matters
// here is the behaviour around the edges of that, because the happy path is
// already proven against a real trading day in rollupWindow.test.js:
//
//   · a finished day is read once and then cached — that is what makes
//     changing the period cheap;
//   · the last two days are NEVER cached, because the sweep may rebuild them;
//   · a node that will not expand is read live, and named — never rendered as
//     an empty day, which on screen is indistinguishable from a quiet Tuesday;
//   · the undated bucket is read for an all-time window and for nothing else.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readWindow, _clearRollupCacheForTests } from "./rollupStore";
import { compactDay } from "./rollupCodec";
import { saDayStartMs, shiftSaDate } from "./rollupWindow";

const DAY_MS = 24 * 60 * 60 * 1000;
const TODAY = "2026-09-20";
const NOW_MS = saDayStartMs(TODAY) + 11 * 3600 * 1000;
const isoOf = (ms) => new Date(ms).toISOString();

const evt = (dateStr, hour, name) => ({
  action: "ready", productName: name,
  timestamp: new Date(saDayStartMs(dateStr) + hour * 3600 * 1000).toISOString(),
});

/** A fake with its own cache, so "was this re-read?" is observable. */
function makeIo({ days = {}, log = [], late = {}, undated = [] } = {}) {
  const cache = new Map();
  const calls = { index: 0, nodes: [], ranges: [], undated: 0, late: 0 };
  return {
    calls,
    cache,
    async readDayIndex() {
      calls.index += 1;
      // The real index is a map of date -> counts, not a list of dates.
      return Object.fromEntries(Object.keys(days).map((d) => [d, { n: 1 }]));
    },
    async readDayNodes(dates) {
      calls.nodes.push([...dates]);
      for (const d of dates) if (days[d]) cache.set(d, days[d]);
    },
    getCached: (d) => cache.get(d),
    async readLogRange(r) {
      calls.ranges.push(r);
      // {key, value} pairs, like the real one — the keys are what a caller's
      // live tail de-duplicates on.
      return log
        .filter((e) => {
          const ms = Date.parse(e.timestamp);
          return ms >= r.startMs - 48 * 3600 * 1000 && ms <= r.endMs + 48 * 3600 * 1000;
        })
        .map((e, i) => ({ key: `k${e.productName}${i}`, value: e }));
    },
    async readUndated() { calls.undated += 1; return undated; },
    async readLate(dates) { calls.late += 1; return dates.flatMap((d) => late[d] || []); },
  };
}

const nodeFor = (d, events) => compactDay(events, { date: d, anchorMs: saDayStartMs(d) });

beforeEach(() => _clearRollupCacheForTests());

describe("readWindow", () => {
  const d1 = shiftSaDate(TODAY, -3);
  const d2 = shiftSaDate(TODAY, -2);
  const d3 = shiftSaDate(TODAY, -1);

  it("serves finished days from nodes and today from the log", async () => {
    const io = makeIo({
      days: {
        [d1]: nodeFor(d1, [evt(d1, 9, "A")]),
        [d2]: nodeFor(d2, [evt(d2, 9, "B")]),
        [d3]: nodeFor(d3, [evt(d3, 9, "C")]),
      },
      log: [evt(TODAY, 9, "TODAY")],
    });
    const r = await readWindow({
      startIso: isoOf(saDayStartMs(d1)),
      endIso: isoOf(saDayStartMs(TODAY) + DAY_MS),
      nowMs: NOW_MS, io,
    });
    expect(r.log.map((e) => e.productName)).toEqual(["TODAY", "C", "B", "A"]);
    expect(r.fromRollup).toBe(3);
    expect(r.fromLive).toBe(1);
  });

  it("caches a settled day, and re-reads the two the sweep may still rebuild", async () => {
    const days = {
      [d1]: nodeFor(d1, [evt(d1, 9, "A")]),
      [d2]: nodeFor(d2, [evt(d2, 9, "B")]),
      [d3]: nodeFor(d3, [evt(d3, 9, "C")]),
    };
    const io = makeIo({ days });
    const args = {
      startIso: isoOf(saDayStartMs(d1)),
      endIso: isoOf(saDayStartMs(TODAY)),
      nowMs: NOW_MS, io,
    };
    await readWindow(args);
    expect(io.calls.nodes[0].sort()).toEqual([d1, d2, d3]);

    await readWindow(args);
    // d1 has settled; d2 and d3 are inside the sweep's rebuild window.
    expect(io.calls.nodes[1].sort()).toEqual([d2, d3]);
  });

  it("a node that will not expand is read LIVE and NAMED, never shown as empty", async () => {
    const broken = nodeFor(d1, [evt(d1, 9, "A")]);
    broken.v = 999;                                   // a shape this reader does not know
    const io = makeIo({
      days: { [d1]: broken },
      log: [evt(d1, 9, "A")],
    });
    const r = await readWindow({
      startIso: isoOf(saDayStartMs(d1)),
      endIso: isoOf(saDayStartMs(d1) + DAY_MS),
      nowMs: NOW_MS, io,
    });
    expect(r.corruptDays).toEqual([d1]);
    expect(r.log.map((e) => e.productName)).toEqual(["A"]);   // the day is still there
    expect(r.fromRollup).toBe(0);
    expect(r.fromLive).toBe(1);
  });

  it("reads the undated bucket for all-time, and NOT for a narrow window", async () => {
    const io = makeIo({
      days: { [d1]: nodeFor(d1, [evt(d1, 9, "A")]) },
      undated: [{ action: "placed", productName: "NoTimestamp" }],
    });
    const narrow = await readWindow({
      startIso: isoOf(saDayStartMs(d1)), endIso: isoOf(saDayStartMs(d1) + DAY_MS),
      nowMs: NOW_MS, io,
    });
    expect(io.calls.undated).toBe(0);
    expect(narrow.log.map((e) => e.productName)).toEqual(["A"]);

    const all = await readWindow({
      startIso: "0000-01-01T00:00:00.000Z", endIso: "9999-12-31T23:59:59.999Z",
      nowMs: NOW_MS, allTime: true, io,
    });
    expect(io.calls.undated).toBe(1);
    // A row with no timestamp sorts last, exactly as it did from the whole-node
    // read — and it IS there, because the sidebar count and the customer list
    // both still count it.
    expect(all.log.at(-1).productName).toBe("NoTimestamp");
  });

  it("drops the rows the 48-hour padding drags in", async () => {
    // The live range for today reaches back two days. Those rows belong to a
    // rollup day and must not arrive twice.
    const io = makeIo({
      days: { [d3]: nodeFor(d3, [evt(d3, 9, "YESTERDAY")]) },
      log: [evt(d3, 9, "YESTERDAY"), evt(TODAY, 9, "TODAY")],
    });
    const r = await readWindow({
      startIso: isoOf(saDayStartMs(d3)),
      endIso: isoOf(saDayStartMs(TODAY) + DAY_MS),
      nowMs: NOW_MS, io,
    });
    expect(r.log.map((e) => e.productName)).toEqual(["TODAY", "YESTERDAY"]);
  });

  it("asks for the day index exactly once per window", async () => {
    const io = makeIo({ days: {} });
    await readWindow({
      startIso: isoOf(saDayStartMs(d1)), endIso: isoOf(saDayStartMs(TODAY)),
      nowMs: NOW_MS, io,
    });
    expect(io.calls.index).toBe(1);
  });

  it("every live read it issues carries a key range", async () => {
    const io = makeIo({ days: {}, log: [] });
    await readWindow({
      startIso: isoOf(saDayStartMs(d1)), endIso: isoOf(saDayStartMs(TODAY) + DAY_MS),
      nowMs: NOW_MS, io,
    });
    expect(io.calls.ranges.length).toBeGreaterThan(0);
    for (const r of io.calls.ranges) {
      expect(typeof r.startKey).toBe("string");
      expect(typeof r.endKey).toBe("string");
      expect(r.startKey.length).toBeGreaterThan(0);
    }
  });

  it("a late row for a served day is merged in", async () => {
    const io = makeIo({
      days: { [d1]: nodeFor(d1, [evt(d1, 9, "A")]) },
      late: { [d1]: [evt(d1, 10, "LATE")] },
    });
    const r = await readWindow({
      startIso: isoOf(saDayStartMs(d1)), endIso: isoOf(saDayStartMs(d1) + DAY_MS),
      nowMs: NOW_MS, io,
    });
    expect(r.log.map((e) => e.productName)).toEqual(["LATE", "A"]);
  });

  it("a failing read rejects — it does not return a short log", async () => {
    const io = makeIo({ days: {} });
    io.readLogRange = vi.fn(async () => { throw new Error("PERMISSION_DENIED"); });
    await expect(readWindow({
      startIso: isoOf(saDayStartMs(d1)), endIso: isoOf(saDayStartMs(TODAY) + DAY_MS),
      nowMs: NOW_MS, io,
    })).rejects.toThrow("PERMISSION_DENIED");
  });
});

// ─── THE ALL-TIME TOTAL ──────────────────────────────────────────────────────
//
// "N events in view" is every event the store has ever logged, not the
// window's count. It comes from the day index plus today, and it has to be the
// same number whichever period the screen is showing — otherwise the sidebar
// quietly starts reporting the window instead.
describe("totals", () => {
  const d1 = shiftSaDate(TODAY, -3);
  const d3 = shiftSaDate(TODAY, -1);

  function ioWithIndex(index, log) {
    const io = makeIo({ days: {}, log });
    io.readDayIndex = async () => index;
    return io;
  }

  it("is the index plus today, and does not change with the window", async () => {
    const index = {
      [d1]: { n: 10, pe: 6, trophy: 3, pine: 1, other: 0 },
      [d3]: { n: 5, pe: 5, trophy: 0, pine: 0, other: 0 },
    };
    const today = [
      { ...evt(TODAY, 9, "T1"), destShop: "marathon-pe" },
      { ...evt(TODAY, 10, "T2"), destShop: "trophy" },
    ];

    const wide = await readWindow({
      startIso: isoOf(saDayStartMs(d1)), endIso: isoOf(saDayStartMs(TODAY) + DAY_MS),
      nowMs: NOW_MS, io: ioWithIndex(index, today),
    });
    const narrow = await readWindow({
      startIso: isoOf(saDayStartMs(d1)), endIso: isoOf(saDayStartMs(d1) + DAY_MS),
      nowMs: NOW_MS, io: ioWithIndex(index, today),
    });

    expect(wide.totals).toEqual({ n: 17, pe: 12, trophy: 4, pine: 1, other: 0 });
    expect(narrow.totals).toEqual(wide.totals);
  });

  it("counts today ONCE when the window already covers it", async () => {
    const index = { [d3]: { n: 1, pe: 1, trophy: 0, pine: 0, other: 0 } };
    const today = [{ ...evt(TODAY, 9, "T1"), destShop: "marathon-pe" }];
    const r = await readWindow({
      startIso: isoOf(saDayStartMs(TODAY)), endIso: isoOf(saDayStartMs(TODAY) + DAY_MS),
      nowMs: NOW_MS, io: ioWithIndex(index, today),
    });
    expect(r.totals.n).toBe(2);
  });

  it("an index entry with a missing store key does not produce NaN", async () => {
    const r = await readWindow({
      startIso: isoOf(saDayStartMs(d1)), endIso: isoOf(saDayStartMs(d1) + DAY_MS),
      nowMs: NOW_MS, io: ioWithIndex({ [d1]: { n: 4 } }, []),
    });
    expect(r.totals).toEqual({ n: 4, pe: 0, trophy: 0, pine: 0, other: 0 });
  });
});

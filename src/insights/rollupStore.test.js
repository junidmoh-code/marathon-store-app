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
function makeIo({ days = {}, log = [], late = {}, undated = [], logTotals = null } = {}) {
  const cache = new Map();
  const calls = { index: 0, nodes: [], ranges: [], undated: 0, late: 0, totals: 0 };
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
    async readUndated() {
      calls.undated += 1;
      return undated.map((e, i) => ({ key: `u${i}`, value: e }));
    },
    async readLate({ from, to }) {
      calls.late += 1;
      return Object.keys(late)
        .filter((d) => d >= from && d <= to)
        .flatMap((d) => late[d].map((e, i) => ({ key: `l${d}${i}`, value: e })));
    },
    async readLogTotals() { calls.totals += 1; return logTotals; },
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
      // Real push-key bounds in the right order — not merely non-empty
      // strings, which "" and "x" would also have satisfied.
      expect(r.startKey).toMatch(/^[-0-9A-Z_a-z]{8}$/);
      expect(r.endKey).toMatch(/^[-0-9A-Z_a-z]{8}$/);
      expect(r.startKey < r.endKey).toBe(true);
      expect(r.endMs).toBeGreaterThan(r.startMs);
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

  it("a late row for a day read LIVE is merged in too", async () => {
    // The day the late bucket most needs to be consulted for is the one with
    // no node — its rows are fetched by a padded key range, and a late row is
    // precisely the row that range cannot reach. Asking only about the rollup
    // days rescued the rows that least needed it. (Sonnet architect review.)
    const io = makeIo({
      days: {},                                   // no node for d1 at all
      log: [evt(d1, 9, "A")],
      late: { [d1]: [evt(d1, 10, "LATE")] },
    });
    const r = await readWindow({
      startIso: isoOf(saDayStartMs(d1)), endIso: isoOf(saDayStartMs(d1) + DAY_MS),
      nowMs: NOW_MS, io,
    });
    expect(r.log.map((e) => e.productName)).toEqual(["LATE", "A"]);
  });

  it("a late row for TODAY is merged in", async () => {
    const io = makeIo({
      days: {},
      log: [evt(TODAY, 9, "A")],
      late: { [TODAY]: [evt(TODAY, 10, "LATE")] },
    });
    const r = await readWindow({
      startIso: isoOf(saDayStartMs(TODAY)), endIso: isoOf(saDayStartMs(TODAY) + DAY_MS),
      nowMs: NOW_MS, io,
    });
    expect(r.log.map((e) => e.productName)).toEqual(["LATE", "A"]);
  });

  it("late and undated rows carry their KEYS into the de-duplication set", async () => {
    // Their push keys are recent by definition — that is why they are late —
    // so they can still be inside the live tail's window. Without the key they
    // would arrive once from the bucket and once from the tail, and be counted
    // twice. (Sonnet architect review.)
    const io = makeIo({
      days: {},
      late: { [d1]: [evt(d1, 10, "LATE")] },
      undated: [{ action: "placed", productName: "NoTimestamp" }],
    });
    const r = await readWindow({
      startIso: "0000-01-01T00:00:00.000Z", endIso: "9999-12-31T23:59:59.999Z",
      nowMs: NOW_MS, allTime: true, io,
    });
    expect([...r.liveKeys].some((k) => k.startsWith("l"))).toBe(true);
    expect(r.liveKeys.has("u0")).toBe(true);
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
// window's count, and it has to be the same number whichever period is on
// screen. It comes from the counter the sweep keeps over its own walk —
// exact as far as its cursor — plus one bounded read of everything after it.
//
// It deliberately does NOT come from summing the day index: a day the backfill
// has not reached is simply absent from that index, and would be silently
// absent from the total.
describe("totals", () => {
  const d1 = shiftSaDate(TODAY, -3);

  const COUNTER = { n: 100, pe: 60, trophy: 30, pine: 9, other: 1, cursor: "kSINCE" };

  function ioWithCounter(sinceRows) {
    const io = makeIo({ days: {}, logTotals: COUNTER });
    io.readLogRange = async (r) => {
      // The "everything since the cursor" read, and the window's own reads.
      if (r.startKey === COUNTER.cursor) return sinceRows;
      return [];
    };
    return io;
  }

  it("is the sweep's counter plus what has landed since its cursor", async () => {
    const io = ioWithCounter([
      { key: COUNTER.cursor, value: { destShop: "marathon-pe" } },   // the cursor's own row
      { key: "kA", value: { destShop: "marathon-pe" } },
      { key: "kB", value: { destShop: "trophy" } },
      { key: "kC", value: { placedAtHub: "hub3" } },
    ]);
    const r = await readWindow({
      startIso: isoOf(saDayStartMs(d1)), endIso: isoOf(saDayStartMs(TODAY) + DAY_MS),
      nowMs: NOW_MS, io,
    });
    // The cursor's own row is already inside the counter and is not counted twice.
    expect(r.totals).toEqual({ n: 103, pe: 61, trophy: 31, pine: 10, other: 1 });
  });

  it("does not change with the window", async () => {
    const rows = [{ key: "kA", value: { destShop: "trophy" } }];
    const wide = await readWindow({
      startIso: isoOf(saDayStartMs(d1)), endIso: isoOf(saDayStartMs(TODAY) + DAY_MS),
      nowMs: NOW_MS, io: ioWithCounter(rows),
    });
    const narrow = await readWindow({
      startIso: isoOf(saDayStartMs(TODAY)), endIso: isoOf(saDayStartMs(TODAY) + DAY_MS),
      nowMs: NOW_MS, io: ioWithCounter(rows),
    });
    expect(narrow.totals).toEqual(wide.totals);
  });

  it("is null, not wrong, when the counter has never been written", async () => {
    const io = makeIo({ days: {}, logTotals: null });
    const r = await readWindow({
      startIso: isoOf(saDayStartMs(d1)), endIso: isoOf(saDayStartMs(TODAY) + DAY_MS),
      nowMs: NOW_MS, io,
    });
    expect(r.totals).toBeNull();
  });

  it("the rows it counted are in the de-duplication set the tail uses", async () => {
    const io = ioWithCounter([{ key: "kA", value: { destShop: "trophy" } }]);
    const r = await readWindow({
      startIso: isoOf(saDayStartMs(TODAY)), endIso: isoOf(saDayStartMs(TODAY) + DAY_MS),
      nowMs: NOW_MS, io,
    });
    expect(r.liveKeys.has("kA")).toBe(true);
  });
});

// ─── BEFORE THE RULE IS PASTED ───────────────────────────────────────────────
//
// /insights_rollup needs its own read rule, pasted by hand. Between a hosting
// deploy and that paste, every read of it is PERMISSION_DENIED. A screen
// showing an error for that window would be worse than the bill this change
// exists to fix, so the reader degrades to the log — which is what the screens
// did before — and says that it did.
describe("an unreadable rollup", () => {
  const d1 = shiftSaDate(TODAY, -2);

  it("falls back to the log for the whole window, and says so", async () => {
    const io = makeIo({ days: {}, log: [evt(d1, 9, "A"), evt(TODAY, 9, "B")] });
    io.readDayIndex = async () => { throw new Error("PERMISSION_DENIED"); };

    const r = await readWindow({
      startIso: isoOf(saDayStartMs(d1)),
      endIso: isoOf(saDayStartMs(TODAY) + DAY_MS),
      nowMs: NOW_MS, io,
    });
    expect(r.degraded).toBe("index");
    expect(r.log.map((e) => e.productName)).toEqual(["B", "A"]);
    // No index means no all-time total; the caller counts what it loaded,
    // which is exactly what the old expression did.
    expect(r.totals).toBeNull();
  });

  it("degrades when the day NODES are refused but the index is not", async () => {
    const io = makeIo({
      days: { [d1]: nodeFor(d1, [evt(d1, 9, "A")]) },
      log: [evt(d1, 9, "A")],
    });
    io.readDayNodes = async () => { throw new Error("PERMISSION_DENIED"); };

    const r = await readWindow({
      startIso: isoOf(saDayStartMs(d1)), endIso: isoOf(saDayStartMs(d1) + DAY_MS),
      nowMs: NOW_MS, io,
    });
    expect(r.degraded).toBe("days");
    expect(r.corruptDays).toEqual([d1]);
    expect(r.log.map((e) => e.productName)).toEqual(["A"]);
  });
});

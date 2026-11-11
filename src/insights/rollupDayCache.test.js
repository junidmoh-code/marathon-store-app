// ─── A RELOAD DOES NOT DOWNLOAD THE FINISHED DAYS AGAIN ──────────────────────
//
// Profiler, 11 Nov 2026: one phone on the all-time Insights view reloaded five
// times in seventy-five minutes and fetched the same 22 MB of finished day
// nodes each time. The session cache in rollupStore.js is module state and
// dies with the page; these tests are about what survives it.
//
// "A reload" is simulated the only honest way available here: the session
// cache is cleared and the IndexedDB connection is closed and reopened. What
// is counted is the days handed to readDayNodes — the network read.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { readWindow, contiguousRuns, _clearRollupCacheForTests } from "./rollupStore";
import {
  loadKeptDays, keepDays, daySignature, _clearKeptDaysForTests, _closeKeptDaysDbForTests,
} from "./rollupDayCache";
import { compactDay } from "./rollupCodec";
import { saDayStartMs, shiftSaDate } from "./rollupWindow";

const TODAY = "2026-09-20";
const NOW_MS = saDayStartMs(TODAY) + 11 * 3600 * 1000;
const evt = (dateStr, hour, name) => ({
  action: "ready", productName: name,
  timestamp: new Date(saDayStartMs(dateStr) + hour * 3600 * 1000).toISOString(),
});
const dayNode = (d, n = 1) => compactDay(
  Array.from({ length: n }, (_, i) => evt(d, 9 + i, `${d}#${i}`)),
  { date: d, anchorMs: saDayStartMs(d) },
);

/** The server: day nodes and their index. Counts every day asked of it. */
function makeServer(days, counts = {}) {
  const server = { days, counts, asked: [] };
  server.index = () => Object.fromEntries(Object.keys(server.days).map((d) => [d, { n: server.counts[d] ?? 1 }]));
  return server;
}

/** One PAGE: its own session cache, the device's kept days shared underneath. */
function makePage(server) {
  const session = new Map();
  return {
    session,
    io: {
      readDayIndex: async () => server.index(),
      readDayNodes: async (dates) => {
        server.asked.push([...dates]);
        for (const d of dates) if (server.days[d]) session.set(d, server.days[d]);
      },
      getCached: (d) => session.get(d),
      setCached: (d, node) => { session.set(d, node); },
      loadKept: loadKeptDays,
      keep: keepDays,
      readLogRange: async () => [],
      readUndated: async () => [],
      readLate: async () => [],
      readLogTotals: async () => null,
    },
  };
}

const windowOf = (fromDate) => ({
  startIso: new Date(saDayStartMs(fromDate)).toISOString(),
  endIso: new Date(saDayStartMs(TODAY) + 24 * 3600 * 1000).toISOString(),
  nowMs: NOW_MS,
});
// keepDays is deliberately not awaited by readWindow; let it land.
const settle = () => new Promise((r) => setTimeout(r, 30));
const reload = async () => { _clearRollupCacheForTests(); await _closeKeptDaysDbForTests(); };

const FROM = shiftSaDate(TODAY, -10);
const tenDays = () => {
  const days = {};
  for (let i = 10; i >= 1; i -= 1) { const d = shiftSaDate(TODAY, -i); days[d] = dayNode(d); }
  return days;
};
const VOLATILE = [shiftSaDate(TODAY, -2), shiftSaDate(TODAY, -1)];
const FINISHED = Object.keys(tenDays()).filter((d) => !VOLATILE.includes(d)).sort();

beforeEach(async () => {
  _clearRollupCacheForTests();
  await _clearKeptDaysForTests();
});

describe("finished rollup days are kept on the device", () => {
  it("the first load fetches every day; the load after a reload fetches only the volatile ones", async () => {
    const server = makeServer(tenDays());

    const first = await readWindow({ ...windowOf(FROM), io: makePage(server).io });
    expect(server.asked.flat().sort()).toEqual([...FINISHED, ...VOLATILE].sort());
    await settle();

    await reload();
    server.asked.length = 0;
    const second = await readWindow({ ...windowOf(FROM), io: makePage(server).io });

    // THE NUMBER: eight finished days were not asked for again.
    expect(server.asked.flat().sort()).toEqual(VOLATILE);
    // …and the screen holds exactly what it held the first time.
    expect(second.log).toEqual(first.log);
    expect(second.fromRollup).toBe(first.fromRollup);
    expect(second.fromRollup).toBe(10);
  });

  it("a day the sweep REBUILT (its index entry changed) is fetched again, not served from the device", async () => {
    const server = makeServer(tenDays());
    await readWindow({ ...windowOf(FROM), io: makePage(server).io });
    await settle();

    // A late row landed in an old day: the sweep rebuilt it — new node, new counts.
    const rebuilt = FINISHED[2];
    server.days[rebuilt] = dayNode(rebuilt, 2);
    server.counts[rebuilt] = 2;

    await reload();
    server.asked.length = 0;
    const res = await readWindow({ ...windowOf(FROM), io: makePage(server).io });

    expect(server.asked.flat().sort()).toEqual([rebuilt, ...VOLATILE].sort());
    // The rebuilt day's two rows are on screen, not the one row kept earlier.
    expect(res.fromRollup).toBe(11);
    expect(res.log.filter((e) => e.productName.startsWith(rebuilt))).toHaveLength(2);
  });

  it("the volatile days are never kept, whatever was fetched", async () => {
    const server = makeServer(tenDays());
    await readWindow({ ...windowOf(FROM), io: makePage(server).io });
    await settle();
    const kept = await loadKeptDays([...FINISHED, ...VOLATILE], server.index());
    expect([...kept.keys()].sort()).toEqual(FINISHED);
  });

  it("a device that cannot keep anything fetches every day, exactly as before", async () => {
    const server = makeServer(tenDays());
    const broken = () => {
      const page = makePage(server);
      page.io.loadKept = async () => { throw new Error("QuotaExceededError"); };
      page.io.keep = async () => { throw new Error("QuotaExceededError"); };
      return page.io;
    };
    const first = await readWindow({ ...windowOf(FROM), io: broken() });
    await settle();
    await reload();
    server.asked.length = 0;
    const second = await readWindow({ ...windowOf(FROM), io: broken() });
    expect(server.asked.flat().sort()).toEqual([...FINISHED, ...VOLATILE].sort());
    expect(second.log).toEqual(first.log);
  });

  it("with the index unreadable nothing is served from the device", async () => {
    const server = makeServer(tenDays());
    await readWindow({ ...windowOf(FROM), io: makePage(server).io });
    await settle();
    await reload();
    const page = makePage(server);
    page.io.readDayIndex = async () => { throw new Error("PERMISSION_DENIED"); };
    const res = await readWindow({ ...windowOf(FROM), io: page.io });
    expect(res.fromRollup).toBe(0);
    expect(page.session.size).toBe(0);
  });
});

describe("the kept-day store itself", () => {
  it("serves a day only under the exact index entry it was saved under", async () => {
    const index = { "2026-09-01": { n: 3, pe: 3 }, "2026-09-02": { n: 1 } };
    await keepDays([["2026-09-01", { a: 1 }], ["2026-09-02", { b: 2 }]], index);
    expect([...(await loadKeptDays(["2026-09-01", "2026-09-02"], index)).keys()]).toEqual(["2026-09-01", "2026-09-02"]);
    const moved = { ...index, "2026-09-01": { n: 4, pe: 4 } };
    expect([...(await loadKeptDays(["2026-09-01", "2026-09-02"], moved)).keys()]).toEqual(["2026-09-02"]);
    // A day the index no longer lists has nothing to be validated against.
    expect((await loadKeptDays(["2026-09-02"], {})).size).toBe(0);
  });

  it("does not keep a day the index does not list, and only returns the days asked for", async () => {
    const index = { "2026-09-01": { n: 1 }, "2026-09-03": { n: 1 } };
    expect(await keepDays([["2026-09-01", { a: 1 }], ["2026-09-02", { x: 1 }], ["2026-09-03", { c: 1 }]], index)).toBe(2);
    const got = await loadKeptDays(["2026-09-01", "2026-09-03"], index);
    expect([...got.keys()]).toEqual(["2026-09-01", "2026-09-03"]);
    expect((await loadKeptDays(["2026-09-03"], index)).size).toBe(1);
  });

  it("prunes days older than the bound in the same write", async () => {
    const index = { "2024-01-01": { n: 1 }, "2026-09-01": { n: 1 } };
    await keepDays([["2024-01-01", { old: 1 }], ["2026-09-01", { a: 1 }]], index);
    await keepDays([["2026-09-01", { a: 1 }]], index, { pruneBefore: "2025-01-01" });
    expect([...(await loadKeptDays(["2024-01-01", "2026-09-01"], index)).keys()]).toEqual(["2026-09-01"]);
  });

  it("daySignature is null for an absent entry — absent is never a match", () => {
    expect(daySignature(undefined)).toBe(null);
    expect(daySignature(null)).toBe(null);
    expect(daySignature({ n: 1 })).toBe('{"n":1}');
  });
});

describe("day nodes are fetched one adjacent run at a time", () => {
  it("splits at every gap", () => {
    expect(contiguousRuns(["2026-09-19", "2026-05-04", "2026-09-18", "2026-09-20", "2026-05-05"]))
      .toEqual([["2026-05-04", "2026-05-05"], ["2026-09-18", "2026-09-19", "2026-09-20"]]);
    expect(contiguousRuns([])).toEqual([]);
    expect(contiguousRuns(["2026-02-28", "2026-03-01"])).toEqual([["2026-02-28", "2026-03-01"]]);
    expect(contiguousRuns(["2026-09-01", "2026-09-01"])).toEqual([["2026-09-01"]]);
  });
});

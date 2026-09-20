// ─── THE LIVE-RANGE READER'S QUERY SHAPE ─────────────────────────────────────
//
// `readLogRange` is the one path that still touches /insights_log at read time:
// today, a partial day at a window edge, a day with no node, and the "what has
// landed since the counter's cursor" read the all-time total depends on.
//
// It shipped with the same defect as #626 — `startAfter(cursor) +
// limitToFirst(n)` returns n-1 children, so a walk that ends on a short page
// ends on its second request — and it was the last place that defect was still
// live, having been fixed three times elsewhere. These assertions are what make
// a fourth return a red build.
import { describe, it, expect, vi, beforeEach } from "vitest";

const getMock = vi.fn();
const calls = [];
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ __ref: path }),
  query: (base, ...mods) => { const q = { __ref: base.__ref, __mods: mods }; calls.push(q); return q; },
  orderByKey: () => ({ __mod: "orderByKey" }),
  startAt: (v) => ({ __mod: "startAt", value: v }),
  startAfter: (v) => ({ __mod: "startAfter", value: v }),
  endAt: (v) => ({ __mod: "endAt", value: v }),
  limitToFirst: (n) => ({ __mod: "limitToFirst", value: n }),
  get: (...a) => getMock(...a),
}));
vi.mock("../firebase", () => ({ database: { __db: true } }));

const { readWindow, readLogRange, LOG_PAGE } = await import("./rollupStore");
const { saDayStartMs, shiftSaDate } = await import("./rollupWindow");
const { pushKeyForMs } = await import("./insightsLogRange");

/** Keys inside the range the plan will actually ask for — real push-key
 *  prefixes around today, so the fake server's endAt bound does not silently
 *  filter every row out and make these assertions vacuous. */
const keyAt = (i) => `${pushKeyForMs(saDayStartMs(TODAY) + i * 1000)}${String(i).padStart(12, "0")}`;

const TODAY = "2026-09-20";
const NOW_MS = saDayStartMs(TODAY) + 11 * 3600 * 1000;
const isoOf = (ms) => new Date(ms).toISOString();
const mods = (q) => q.__mods.map((m) => m.__mod);

/** A server that applies the limit and, under startAfter, drops the bound's
 *  own row afterwards — which is what the real one does. */
function serve(keys) {
  getMock.mockImplementation(async (q) => {
    const from = q.__mods.find((m) => m.__mod === "startAt");
    const after = q.__mods.find((m) => m.__mod === "startAfter");
    const to = q.__mods.find((m) => m.__mod === "endAt");
    const limit = q.__mods.find((m) => m.__mod === "limitToFirst");
    if (q.__ref === "insights_log" && !limit) throw new Error("unbounded read reached the server");
    let ks = keys.filter((k) => (from ? k >= from.value : true) && (after ? k >= after.value : true));
    if (to) ks = ks.filter((k) => k <= to.value);
    if (limit) ks = ks.slice(0, limit.value);
    if (after) ks = ks.filter((k) => k > after.value);      // the SDK's own drop
    return { forEach: (cb) => { for (const k of ks) cb({ key: k, val: () => ({ timestamp: isoOf(NOW_MS), k }) }); return false; } };
  });
}

const io = {
  readDayIndex: async () => ({}),
  readDayNodes: async () => {},
  getCached: () => undefined,
  readUndated: async () => [],
  readLate: async () => [],
  readLogTotals: async () => null,
};

beforeEach(() => { calls.length = 0; getMock.mockReset(); });

describe("readLogRange", () => {
  it("reads a node many pages long WHOLE", async () => {
    const keys = Array.from({ length: LOG_PAGE * 2 + 7 }, (_, i) => keyAt(i));
    serve(keys);
    const r = await readWindow({
      startIso: isoOf(saDayStartMs(TODAY)),
      endIso: isoOf(saDayStartMs(TODAY) + 86400000),
      nowMs: NOW_MS,
      io: { ...io, readLogRange },
    });
    // Every key, once — not the 10,000 a short-page walk would have stopped at.
    expect(r.liveKeys.size).toBe(keys.length);
  });

  it("bounds every request, and never with startAfter", async () => {
    const keys = Array.from({ length: LOG_PAGE + 5 }, (_, i) => keyAt(i));
    serve(keys);
    await readWindow({
      startIso: isoOf(saDayStartMs(TODAY)),
      endIso: isoOf(saDayStartMs(TODAY) + 86400000),
      nowMs: NOW_MS,
      io: { ...io, readLogRange },
    });
    const logQueries = calls.filter((q) => q.__ref === "insights_log");
    expect(logQueries.length).toBeGreaterThan(1);
    for (const q of logQueries) {
      expect(mods(q)).toContain("orderByKey");
      expect(mods(q)).toContain("limitToFirst");
      expect(mods(q)).toContain("startAt");
      expect(mods(q)).not.toContain("startAfter");
      expect(mods(q)).not.toContain("orderByChild");
    }
  });

  it("asks for no more per request than the read rule allows", async () => {
    serve([keyAt(1)]);
    await readWindow({
      startIso: isoOf(saDayStartMs(TODAY)),
      endIso: isoOf(saDayStartMs(TODAY) + 86400000),
      nowMs: NOW_MS,
      io: { ...io, readLogRange },
    });
    for (const q of calls.filter((x) => x.__ref === "insights_log")) {
      const lim = q.__mods.find((m) => m.__mod === "limitToFirst");
      expect(lim.value).toBeLessThanOrEqual(10000);
    }
  });

  it("stops rather than looping when the server stops advancing", async () => {
    // A node that answers every bound with the same page. Without a
    // forward-progress check this never returns.
    getMock.mockImplementation(async () => ({
      forEach: (cb) => { for (const k of [keyAt(1), keyAt(2)]) cb({ key: k, val: () => ({ timestamp: isoOf(NOW_MS) }) }); return false; },
    }));
    const r = await readWindow({
      startIso: isoOf(saDayStartMs(TODAY)),
      endIso: isoOf(saDayStartMs(TODAY) + 86400000),
      nowMs: NOW_MS,
      io: { ...io, readLogRange },
    });
    expect(r.liveKeys.size).toBeLessThanOrEqual(2);
  });

  it("never reads /insights_rollup/days without a key range", async () => {
    serve([]);
    await readWindow({
      startIso: isoOf(saDayStartMs(shiftSaDate(TODAY, -5))),
      endIso: isoOf(saDayStartMs(TODAY) + 86400000),
      nowMs: NOW_MS,
      io: { ...io, readLogRange, readDayIndex: async () => ({ [shiftSaDate(TODAY, -1)]: { n: 1 } }) },
    });
    for (const q of calls.filter((x) => String(x.__ref).startsWith("insights_rollup"))) {
      expect(mods(q).length).toBeGreaterThan(0);
    }
  });
});

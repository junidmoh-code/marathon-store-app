// ─── THE ALL-TIME READ IS BOUNDED, AND STILL RETURNS EVERYTHING ──────────────
//
// Two claims, and they pull in opposite directions, so both are asserted here:
//
//   1. no read this module issues is a bare whole-node read — that is what the
//      /insights_log read rule keys on, and a revert to `onValue(ref(...))`
//      must fail a test rather than a bill;
//   2. what the three all-time screens receive is byte-identical to what the
//      old unbounded read handed them — the same rows, newest-first.
//
// The second is the one that could fail silently, so it is checked against a
// fake node by comparing with the old expression itself rather than against a
// hand-written expectation.
import { describe, it, expect, vi } from "vitest";
import { readWholeLogBounded, insertNewestFirst, shapeRows } from "./insightsLogWholeRead";
import { pushKeyForMs } from "./insightsLogRange";

// Real push keys, so the tail's lower bound (which is computed from a clock)
// lives in the same key space the walk does. A node keyed "-K000001" would
// make every bound comparison meaningless.
const BASE_MS = 1_780_000_000_000;
const keyAt = (ms, n) => `${pushKeyForMs(ms)}${String(n).padStart(12, "x")}`;
// "now" for the tests that care about the tail's clock-derived lower bound:
// a little after the newest row any makeNode() produces.
const NOW_MS = BASE_MS + 60 * 60 * 1000;

// The array the retired `onValue(ref(db,"insights_log"))` produced, verbatim
// from the provider: Object.values → filter → sort by timestamp desc.
function legacyShape(data) {
  const tsMs = (v) => {
    if (v == null || v === "") return 0;
    const n = typeof v === "number" ? v : new Date(v).getTime();
    return Number.isNaN(n) ? 0 : n;
  };
  return Object.values(data).filter(Boolean).sort((a, b) => tsMs(b.timestamp) - tsMs(a.timestamp));
}

// A fake node: push-like keys in ascending order, each with a timestamp that
// deliberately does NOT agree with key order for a few rows (the measured skew
// is real — see insightsLogRange.js).
function makeNode(n) {
  const data = {};
  for (let i = 0; i < n; i++) {
    const key = keyAt(BASE_MS + i * 60_000, i);
    const skew = i % 37 === 0 ? -90_000 : 0;   // a few rows written late
    data[key] = { timestamp: new Date(1_780_000_000_000 + i * 60_000 + skew).toISOString(), action: "placed", i };
  }
  return data;
}

// Stands in for readByKeyPages: key order, a last key, a completeness flag.
function pagerFor(data, { complete = true } = {}) {
  const keys = Object.keys(data).sort();
  return {
    readAll: async () => ({
      data: Object.fromEntries(keys.map((k) => [k, data[k]])),
      complete,
      lastKey: keys.length ? keys[keys.length - 1] : null,
    }),
  };
}

describe("readWholeLogBounded", () => {
  it("delivers exactly what the old unbounded read delivered", async () => {
    const data = makeNode(12_003);
    const { readAll } = pagerFor(data);
    const onData = vi.fn();
    readWholeLogBounded(onData, { readAll, openTail: () => () => {} });
    await vi.waitFor(() => expect(onData).toHaveBeenCalled());

    const got = onData.mock.calls.at(-1)[0];
    expect(got).toEqual(legacyShape(data));
  });

  it("emits ONCE for the history, not once per page — no climbing totals", async () => {
    const data = makeNode(12_003);
    const { readAll } = pagerFor(data);
    const onData = vi.fn();
    readWholeLogBounded(onData, { readAll, openTail: () => () => {} });
    await vi.waitFor(() => expect(onData).toHaveBeenCalled());
    expect(onData).toHaveBeenCalledTimes(1);
  });

  it("a TRUNCATED walk is a failure, not a quieter month", async () => {
    const { readAll } = pagerFor(makeNode(50), { complete: false });
    const onData = vi.fn();
    const onError = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readWholeLogBounded(onData, {
      readAll, openTail: () => () => {}, onError, setTimeoutFn: () => 1,
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onData).not.toHaveBeenCalled();
    expect(onError.mock.calls[0][0].name).toBe("InsightsLogTruncatedError");
    warn.mockRestore();
  });

  it("tails from BELOW the last key it read, by the backdating pad", async () => {
    const data = makeNode(10);
    const pager = pagerFor(data);
    let tailArgs = null;
    readWholeLogBounded(vi.fn(), {
      readAll: pager.readAll,
      nowFn: () => NOW_MS,
      openTail: (args) => { tailArgs = args; return () => {}; },
    });
    await vi.waitFor(() => expect(tailArgs).not.toBeNull());
    // Below where the walk ended, never at it — a backdated row written during
    // the walk has to be inside the tail's range. (Sonnet architect review.)
    expect(tailArgs.after < keyAt(BASE_MS + 9 * 60_000, 9)).toBe(true);
    // …and not below the whole node either: the overlap is bounded by the pad.
    expect(tailArgs.after).toBe(pushKeyForMs(NOW_MS - 2 * 60 * 60 * 1000));
  });

  it("an EMPTY node still tails from a real lower bound, never a bare node read", async () => {
    const pager = pagerFor({});
    let tailArgs = null;
    readWholeLogBounded(vi.fn(), {
      readAll: pager.readAll,
      openTail: (args) => { tailArgs = args; return () => {}; },
    });
    await vi.waitFor(() => expect(tailArgs).not.toBeNull());
    expect(tailArgs).toEqual({ after: "-" });
  });

  it("a row arriving on the tail lands in the right place, newest-first", async () => {
    const data = makeNode(5);
    const pager = pagerFor(data);
    const onData = vi.fn();
    let emitRow = null;
    readWholeLogBounded(onData, {
      readAll: pager.readAll,
      openTail: (_args, cb) => { emitRow = cb; return () => {}; },
    });
    await vi.waitFor(() => expect(emitRow).not.toBeNull());

    const fresh = { timestamp: new Date(1_790_000_000_000).toISOString(), action: "ready" };
    emitRow("-K000099", fresh);
    await vi.waitFor(() => expect(onData).toHaveBeenCalledTimes(2));
    const got = onData.mock.calls.at(-1)[0];
    expect(got[0]).toBe(fresh);
    expect(got.length).toBe(6);
    // …and the rest is still exactly the legacy ordering.
    expect(got.slice(1)).toEqual(legacyShape(data));
  });

  it("the overlap the tail re-offers is dropped BY KEY, never counted twice", async () => {
    const data = makeNode(5);
    const pager = pagerFor(data);
    const onData = vi.fn();
    let emitRow = null;
    readWholeLogBounded(onData, {
      readAll: pager.readAll,
      openTail: (_args, cb) => { emitRow = cb; return () => {}; },
    });
    await vi.waitFor(() => expect(emitRow).not.toBeNull());

    // Every row the walk already delivered, re-offered by the inclusive bound.
    for (const k of Object.keys(data)) emitRow(k, data[k]);
    await new Promise((r) => setTimeout(r, 10));
    expect(onData).toHaveBeenCalledTimes(1);          // nothing changed
    expect(onData.mock.calls[0][0].length).toBe(5);
  });

  it("a row BACKDATED below the walk's last key is still picked up", async () => {
    // The defect this design exists to prevent: a till whose push-key clock
    // runs behind writes a row that sorts below the cursor the walk passed.
    const data = makeNode(5);
    const pager = pagerFor(data);
    const onData = vi.fn();
    let emitRow = null;
    readWholeLogBounded(onData, {
      readAll: pager.readAll,
      openTail: (_args, cb) => { emitRow = cb; return () => {}; },
    });
    await vi.waitFor(() => expect(emitRow).not.toBeNull());

    const backdated = { timestamp: new Date(BASE_MS).toISOString(), action: "collected" };
    emitRow(keyAt(BASE_MS + 2 * 60_000, 99), backdated);   // sorts BELOW the walk's last key
    await vi.waitFor(() => expect(onData).toHaveBeenCalledTimes(2));
    expect(onData.mock.calls.at(-1)[0]).toContain(backdated);
  });

  it("a failed walk RETRIES rather than leaving every all-time figure empty", async () => {
    const data = makeNode(4);
    const pager = pagerFor(data);
    let fails = 2;
    const onData = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const timers = [];
    readWholeLogBounded(onData, {
      readAll: async () => {
        if (fails-- > 0) throw new Error("client is offline");
        return pager.readAll();
      },
      openTail: () => () => {},
      setTimeoutFn: (fn) => { timers.push(fn); return timers.length; },
    });
    await vi.waitFor(() => expect(timers.length).toBe(1));
    timers.shift()();                                  // first backoff fires
    await vi.waitFor(() => expect(timers.length).toBe(1));
    timers.shift()();                                  // second
    await vi.waitFor(() => expect(onData).toHaveBeenCalled());
    expect(onData.mock.calls.at(-1)[0].length).toBe(4);
    warn.mockRestore();
  });

  it("unsubscribing cancels a pending retry", async () => {
    const cleared = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = readWholeLogBounded(vi.fn(), {
      readAll: async () => { throw new Error("offline"); },
      openTail: () => () => {},
      setTimeoutFn: () => 77,
      clearTimeoutFn: (id) => cleared.push(id),
    });
    await new Promise((r) => setTimeout(r, 5));
    stop();
    expect(cleared).toContain(77);
    warn.mockRestore();
  });

  it("a failed read does NOT report an empty log — every all-time figure would read zero", async () => {
    const onData = vi.fn();
    const onError = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readWholeLogBounded(onData, {
      readAll: async () => { throw new Error("PERMISSION_DENIED"); },
      openTail: () => () => {},
      onError,
      setTimeoutFn: () => 1,          // swallow the retry; this asserts the emit
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onData).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("unsubscribing before the walk finishes emits nothing and opens no tail", async () => {
    let openedTail = false;
    const onData = vi.fn();
    const stop = readWholeLogBounded(onData, {
      readAll: () => new Promise((r) => setTimeout(() => r({ data: {}, complete: true, lastKey: null }), 5)),
      openTail: () => { openedTail = true; return () => {}; },
    });
    stop();
    await new Promise((r) => setTimeout(r, 20));
    expect(onData).not.toHaveBeenCalled();
    expect(openedTail).toBe(false);
  });
});

describe("insertNewestFirst", () => {
  const at = (iso) => ({ timestamp: iso });
  it("matches a stable sort of the same rows", () => {
    const base = shapeRows([at("2026-01-03T00:00:00.000Z"), at("2026-01-02T00:00:00.000Z"), at("2026-01-01T00:00:00.000Z")]);
    const row = at("2026-01-02T00:00:00.000Z");
    expect(insertNewestFirst(base, row).map((r) => r.timestamp))
      .toEqual(shapeRows([...base, row]).map((r) => r.timestamp));
  });
  it("puts a row with no timestamp last, like the sort does", () => {
    const base = shapeRows([at("2026-01-02T00:00:00.000Z"), at("2026-01-01T00:00:00.000Z")]);
    const row = { action: "ready" };
    expect(insertNewestFirst(base, row).at(-1)).toBe(row);
  });
});

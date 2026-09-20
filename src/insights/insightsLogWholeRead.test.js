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
    const key = `-K${String(i).padStart(6, "0")}`;
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
    readWholeLogBounded(onData, { readAll, openTail: () => () => {}, onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onData).not.toHaveBeenCalled();
    expect(onError.mock.calls[0][0].name).toBe("InsightsLogTruncatedError");
    warn.mockRestore();
  });

  it("follows the tail from the LAST key it read, exclusively", async () => {
    const data = makeNode(10);
    const pager = pagerFor(data);
    let tailArgs = null;
    readWholeLogBounded(vi.fn(), {
      readAll: pager.readAll,
      openTail: (args) => { tailArgs = args; return () => {}; },
    });
    await vi.waitFor(() => expect(tailArgs).not.toBeNull());
    expect(tailArgs).toEqual({ after: "-K000009", skipKey: "-K000009" });
  });

  it("an EMPTY node still tails from a real lower bound, never a bare node read", async () => {
    const pager = pagerFor({});
    let tailArgs = null;
    readWholeLogBounded(vi.fn(), {
      readAll: pager.readAll,
      openTail: (args) => { tailArgs = args; return () => {}; },
    });
    await vi.waitFor(() => expect(tailArgs).not.toBeNull());
    expect(tailArgs).toEqual({ after: "-", skipKey: null });
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
    emitRow(fresh);
    const got = onData.mock.calls.at(-1)[0];
    expect(got[0]).toBe(fresh);
    expect(got.length).toBe(6);
    // …and the rest is still exactly the legacy ordering.
    expect(got.slice(1)).toEqual(legacyShape(data));
  });

  it("a failed read does NOT report an empty log — every all-time figure would read zero", async () => {
    const onData = vi.fn();
    const onError = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readWholeLogBounded(onData, {
      readAll: async () => { throw new Error("PERMISSION_DENIED"); },
      openTail: () => () => {},
      onError,
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

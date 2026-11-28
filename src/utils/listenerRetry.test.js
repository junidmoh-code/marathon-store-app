import { describe, it, expect, vi } from "vitest";
import { LISTENER_RETRY_MS, listenerRetryDelay, subscribeRangesWithRetry } from "./listenerRetry";

describe("listenerRetryDelay", () => {
  it("backs off 3 s, 10 s, 30 s, then holds at 60 s", () => {
    expect([0, 1, 2, 3, 4, 50].map(listenerRetryDelay)).toEqual([3000, 10000, 30000, 60000, 60000, 60000]);
    expect(LISTENER_RETRY_MS[LISTENER_RETRY_MS.length - 1]).toBe(60000);
  });
});

// A fake listener registry: each open() is one listener the test can answer or cancel.
function harness(n) {
  const opens = [];
  const open = (range, i, onSnap, onErr) => {
    const l = { i, onSnap, onErr, closed: false };
    opens.push(l);
    return () => { l.closed = true; };
  };
  const rows = [];
  const live = (i) => opens.filter((l) => l.i === i && !l.closed).at(-1);
  return { opens, open, rows, live, ranges: Array.from({ length: n }, (_, i) => [`a${i}`, `b${i}`]) };
}

describe("subscribeRangesWithRetry", () => {
  it("a refused range backs off on its own; a healthy range is never re-opened", () => {
    vi.useFakeTimers();
    const h = harness(2);
    const stop = subscribeRangesWithRetry({ ranges: h.ranges, open: h.open, onRows: (p) => h.rows.push([...p]) });
    h.live(0).onSnap({ "001": 1 });
    const delays = [];
    for (let k = 0; k < 5; k += 1) {
      const before = h.opens.length;
      h.live(1).onErr(new Error("permission_denied"));
      h.live(0).onSnap({ "001": 1 });            // the healthy range keeps answering
      let waited = 0;
      while (h.opens.length === before) { vi.advanceTimersByTime(1000); waited += 1000; }
      delays.push(waited);
    }
    expect(delays).toEqual([3000, 10000, 30000, 60000, 60000]);
    expect(h.opens.filter((l) => l.i === 0)).toHaveLength(1);   // never torn down, never re-read
    stop();
    vi.useRealTimers();
  });

  it("keeps a range's last rows while another is retried, and resets a range's backoff on its own success", () => {
    vi.useFakeTimers();
    const h = harness(2);
    subscribeRangesWithRetry({ ranges: h.ranges, open: h.open, onRows: (p) => h.rows.push([...p]) });
    h.live(0).onSnap("A");
    h.live(1).onSnap("B");
    h.live(1).onErr(new Error("x"));
    vi.advanceTimersByTime(3000);
    h.live(1).onSnap("B2");
    expect(h.rows.at(-1)).toEqual(["A", "B2"]);
    h.live(1).onErr(new Error("x"));
    const before = h.opens.length;
    vi.advanceTimersByTime(3000);                   // back to the first step after a success
    expect(h.opens.length).toBe(before + 1);
    vi.useRealTimers();
  });

  it("stop() closes every listener and cancels pending retries", () => {
    vi.useFakeTimers();
    const h = harness(2);
    const stop = subscribeRangesWithRetry({ ranges: h.ranges, open: h.open, onRows: () => {} });
    h.live(1).onErr(new Error("x"));
    stop();
    const before = h.opens.length;
    vi.advanceTimersByTime(120000);
    expect(h.opens.length).toBe(before);
    expect(h.opens.every((l) => l.closed || l.i === 1)).toBe(true);
    vi.useRealTimers();
  });
});

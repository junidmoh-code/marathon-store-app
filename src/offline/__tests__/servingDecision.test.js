import { describe, test, expect } from "vitest";
import {
  decideServing, feedIsStale, FEED_STALE_MS, UNKNOWN_GRACE_MS,
} from "../servingDecision";

const T = 1_790_000_000_000;

describe("feedIsStale", () => {
  test("never while disconnected — the live read cannot answer either", () => {
    expect(feedIsStale({ connected: false, feedOkAt: null, startedAt: T - 10 * FEED_STALE_MS, now: T })).toBe(false);
  });
  test("a session that has just started is not stale because of last night", () => {
    expect(feedIsStale({ connected: true, feedOkAt: T - 12 * 3600e3, startedAt: T - 60_000, now: T })).toBe(false);
  });
  test("connected, and no good feed read for longer than the window: stale", () => {
    expect(feedIsStale({ connected: true, feedOkAt: T - FEED_STALE_MS - 1, startedAt: T - 3600e3, now: T })).toBe(true);
    expect(feedIsStale({ connected: true, feedOkAt: T - FEED_STALE_MS + 1, startedAt: T - 3600e3, now: T })).toBe(false);
  });
});

describe("decideServing", () => {
  const was = (...legs) => (l) => legs.includes(l);

  test("yes is served, no is not", () => {
    const got = decideServing({
      verdicts: { products: "yes", orders: "no" }, wasServing: was("products", "orders"),
      unknownSince: new Map(), feedStale: false, now: T,
    });
    expect(got).toEqual(["products"]);
  });

  test("a stale feed serves nothing, however good the copy", () => {
    const got = decideServing({
      verdicts: { products: "yes", orders: "yes" }, wasServing: was("products", "orders"),
      unknownSince: new Map(), feedStale: true, now: T,
    });
    expect(got).toEqual([]);
  });

  test("unknown keeps a SERVED leg for the grace, then drops it", () => {
    const since = new Map();
    const at = (now) => decideServing({
      verdicts: { products: "unknown" }, wasServing: was("products"), unknownSince: since, feedStale: false, now,
    });
    expect(at(T)).toEqual(["products"]);
    expect(at(T + UNKNOWN_GRACE_MS - 1)).toEqual(["products"]);
    expect(at(T + UNKNOWN_GRACE_MS)).toEqual([]);
  });

  test("unknown never turns a live read into a local one", () => {
    const got = decideServing({
      verdicts: { products: "unknown" }, wasServing: was(), unknownSince: new Map(), feedStale: false, now: T,
    });
    expect(got).toEqual([]);
  });

  test("an answer resets the grace clock", () => {
    const since = new Map();
    const ask = (verdict, now) => decideServing({
      verdicts: { products: verdict }, wasServing: was("products"), unknownSince: since, feedStale: false, now,
    });
    ask("unknown", T);
    ask("yes", T + 60_000);
    expect(ask("unknown", T + UNKNOWN_GRACE_MS + 1)).toEqual(["products"]);
  });
});

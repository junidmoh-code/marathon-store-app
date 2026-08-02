// ─── ONE SUBSCRIPTION, PROVEN — not counted in production ────────────────────
// The regression this guards is SILENT: whether five consumers open one listener
// or five, the screens render identically. The only visible difference is the
// bill — 18.73 MB per extra listener. So the subscription count is asserted here
// against a mocked SDK.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createInsightsLogStore, EMPTY } from "./insightsLogStore";

// Stand-in for onValue: counts opens/closes and lets a test push a snapshot.
function mockSdk() {
  const sdk = { opens: 0, closes: 0, push: null };
  sdk.open = (onData) => {
    sdk.opens += 1;
    sdk.push = onData;
    return () => { sdk.closes += 1; sdk.push = null; };
  };
  return sdk;
}

const DELAY = 5 * 60 * 1000;
let sdk, store;
beforeEach(() => {
  vi.useFakeTimers();
  sdk = mockSdk();
  store = createInsightsLogStore({ open: sdk.open, releaseDelayMs: DELAY });
});
afterEach(() => vi.useRealTimers());

describe("lazy", () => {
  it("opens NOTHING until a consumer retains — a till session that never visits pays zero", () => {
    expect(sdk.opens).toBe(0);
    expect(store.getSnapshot()).toBe(EMPTY);
  });
});

describe("one subscription regardless of consumer count", () => {
  it("five consumers → ONE open", () => {
    for (let i = 0; i < 5; i++) store.retain();
    expect(sdk.opens).toBe(1);
    expect(store._state()).toMatchObject({ consumers: 5, isOpen: true });
  });

  it("releasing four of five keeps it open, with no re-open", () => {
    for (let i = 0; i < 5; i++) store.retain();
    for (let i = 0; i < 4; i++) store.release();
    vi.advanceTimersByTime(DELAY * 2);
    expect(sdk.opens).toBe(1);
    expect(sdk.closes).toBe(0);
    expect(store._state()).toMatchObject({ consumers: 1, isOpen: true });
  });

  it("shares one snapshot with every consumer", () => {
    const seen = [];
    store.subscribe(() => seen.push(store.getSnapshot()));
    store.retain(); store.retain();
    sdk.push([{ action: "placed" }]);
    expect(sdk.opens).toBe(1);
    expect(seen.at(-1)).toEqual([{ action: "placed" }]);
  });
});

describe("release after idle — heap comes back", () => {
  it("holds the subscription for the full delay", () => {
    store.retain(); store.release();
    vi.advanceTimersByTime(DELAY - 1000);
    expect(sdk.closes).toBe(0);
    expect(store._state().hasPendingRelease).toBe(true);
  });

  it("closes once the delay elapses, and DROPS the cached log", () => {
    store.retain();
    sdk.push([{ action: "placed" }]);
    expect(store.getSnapshot()).toHaveLength(1);
    store.release();
    vi.advanceTimersByTime(DELAY + 1000);
    expect(sdk.closes).toBe(1);
    expect(store.getSnapshot()).toBe(EMPTY);   // 18.73 MB released
  });

  it("a remount INSIDE the window reuses the open subscription — no re-download", () => {
    store.retain();
    store.release();
    vi.advanceTimersByTime(2 * 60 * 1000);     // 2 min later, staff come back
    store.retain();
    vi.advanceTimersByTime(DELAY * 2);
    expect(sdk.opens).toBe(1);
    expect(sdk.closes).toBe(0);
  });

  it("a return AFTER the window re-opens exactly once — the documented trade-off", () => {
    store.retain(); store.release();
    vi.advanceTimersByTime(DELAY + 1000);
    store.retain();
    expect(sdk.opens).toBe(2);
    expect(sdk.closes).toBe(1);
  });

  it("rapid churn cannot stack timers or double-close", () => {
    for (let i = 0; i < 20; i++) { store.retain(); store.release(); }
    vi.advanceTimersByTime(DELAY * 3);
    expect(sdk.opens).toBe(1);
    expect(sdk.closes).toBe(1);
  });

  it("never lets the consumer count go negative", () => {
    store.release(); store.release();
    expect(store._state().consumers).toBe(0);
  });
});

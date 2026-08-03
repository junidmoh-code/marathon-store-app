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

// Provider unmount must close NOW, not in five minutes: a subscription with no
// possible consumer is pure cost, and a provider remount inside the delay window
// would hold two live whole-node subscriptions at once.
describe("destroy — synchronous teardown on provider unmount", () => {
  it("closes immediately, without waiting for the delay", () => {
    store.retain(); store.retain();
    store.destroy();
    expect(sdk.closes).toBe(1);
    expect(store._state()).toMatchObject({ consumers: 0, isOpen: false, hasPendingRelease: false });
  });

  it("cancels a release already in flight, so the timer cannot fire later", () => {
    store.retain();
    store.release();                       // arms the 5-min timer
    store.destroy();
    expect(sdk.closes).toBe(1);
    vi.advanceTimersByTime(DELAY * 2);
    expect(sdk.closes).toBe(1);            // not closed twice
  });

  it("drops the cached log", () => {
    store.retain();
    sdk.push([{ action: "placed" }]);
    store.destroy();
    expect(store.getSnapshot()).toBe(EMPTY);
  });

  it("is safe to call with nothing open", () => {
    expect(() => store.destroy()).not.toThrow();
    expect(sdk.closes).toBe(0);
  });

  // SIGN-OUT. The provider calls destroy() the moment authReady goes false. After
  // that there must be no live /insights_log listener and no 18.73 MB retained —
  // gating retain/release alone would only stop FUTURE calls while the existing
  // listener kept streaming data the user is no longer entitled to read.
  it("sign-out with consumers still mounted: listener closed, cache dropped", () => {
    store.retain(); store.retain();          // two screens open
    sdk.push([{ action: "placed" }, { action: "ready" }]);
    expect(store._state().isOpen).toBe(true);

    store.destroy();                          // ← authReady flips false

    expect(sdk.closes).toBe(1);
    expect(store._state()).toMatchObject({ consumers: 0, isOpen: false, hasPendingRelease: false });
    expect(store.getSnapshot()).toBe(EMPTY);
    expect(sdk.push).toBeNull();              // the SDK handle is gone, not just ignored
  });

  it("sign-out while a delayed release is pending kills the timer too", () => {
    store.retain();
    store.release();                          // 5-min timer armed
    store.destroy();                          // sign-out mid-window
    expect(sdk.closes).toBe(1);
    vi.advanceTimersByTime(DELAY * 3);
    expect(sdk.closes).toBe(1);               // timer cannot fire a second close
    expect(store._state().isOpen).toBe(false);
  });

  it("nothing re-opens on its own after sign-out", () => {
    store.retain();
    store.destroy();
    vi.advanceTimersByTime(DELAY * 5);
    expect(sdk.opens).toBe(1);                // no resurrection without a retain
    expect(store._state().isOpen).toBe(false);
  });

  it("signing back IN re-opens exactly one subscription", () => {
    store.retain();
    store.destroy();                          // sign-out
    store.retain();                           // sign-in, screen mounts again
    expect(sdk.opens).toBe(2);
    expect(store._state().isOpen).toBe(true);
  });

  it("a fresh store after destroy opens exactly one subscription", () => {
    store.retain();
    store.destroy();
    const next = createInsightsLogStore({ open: sdk.open, releaseDelayMs: DELAY });
    next.retain();
    expect(sdk.opens).toBe(2);   // one per store, never two at once
    expect(sdk.closes).toBe(1);
  });
});

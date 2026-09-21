import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  withTimeout, isTimeout, OfflineTimeoutError, READ_TIMEOUT_MS, WAKE_GRACE_MS, HIDDEN_CEILING_MS,
} from "../bounded";
import { createConnectionTracker } from "../connection";

describe("nothing may hang", () => {
  test("a read that never settles fails honestly inside its budget", async () => {
    vi.useFakeTimers();
    const never = new Promise(() => {});
    const p = withTimeout(never, { ms: 50, label: "products" });
    const assertion = expect(p).rejects.toThrow(OfflineTimeoutError);
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
    vi.useRealTimers();
  });

  test("the failure names what was being read and how long we waited", async () => {
    try {
      await withTimeout(new Promise(() => {}), { ms: 1, label: "the customers leg" });
    } catch (err) {
      expect(isTimeout(err)).toBe(true);
      expect(err.label).toBe("the customers leg");
      expect(err.ms).toBe(1);
      expect(err.message).toContain("the customers leg");
    }
  });

  test("a value that arrives in time passes straight through", async () => {
    await expect(withTimeout(Promise.resolve(7), { ms: 1000 })).resolves.toBe(7);
  });

  test("the timer is cleared when the value wins, so a search loop leaks nothing", async () => {
    const clear = vi.spyOn(globalThis, "clearTimeout");
    await withTimeout(Promise.resolve(1), { ms: 1000 });
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  test("ms <= 0 means unbounded, deliberately", async () => {
    await expect(withTimeout(Promise.resolve(3), { ms: 0 })).resolves.toBe(3);
  });

  test("the default budget is what a person will stand at a screen for", () => {
    expect(READ_TIMEOUT_MS).toBe(8000);
  });
});

describe("connection state", () => {
  test("truth comes from the injected .info/connected, never navigator.onLine", () => {
    let emit;
    const t = createConnectionTracker({ subscribeConnected: (cb) => { emit = cb; return () => {}; } });
    t.start();
    expect(t.isConnected()).toBe(false);
    emit(true);
    expect(t.isConnected()).toBe(true);
    emit(false);
    expect(t.isConnected()).toBe(false);
  });

  test("subscribers are notified only when the state actually changes", () => {
    let emit;
    const t = createConnectionTracker({ subscribeConnected: (cb) => { emit = cb; return () => {}; } });
    t.start();
    let n = 0;
    t.subscribe(() => { n += 1; });
    emit(true); emit(true); emit(true);
    expect(n).toBe(1);
  });

  test("stop() unsubscribes", () => {
    const unsub = vi.fn();
    const t = createConnectionTracker({ subscribeConnected: () => unsub });
    t.start();
    t.stop();
    expect(unsub).toHaveBeenCalled();
  });
});

// ── A SLEEPING TABLET IS NOT A SLOW LINE ─────────────────────────────────────
describe("sleepAware: only time the page was awake counts", () => {
  let listeners;
  let hidden;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    listeners = new Set();
    hidden = false;
    globalThis.document = {
      get visibilityState() { return hidden ? "hidden" : "visible"; },
      addEventListener: (_t, fn) => listeners.add(fn),
      removeEventListener: (_t, fn) => listeners.delete(fn),
    };
  });
  afterEach(() => { vi.useRealTimers(); delete globalThis.document; });
  const setHidden = (h) => { hidden = h; for (const l of listeners) l(); };
  const never = () => new Promise(() => {});

  test("a genuinely slow read still times out, on time", async () => {
    const p = withTimeout(never(), { ms: 1000, label: "/x", sleepAware: true });
    const seen = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(1001);
    expect((await seen).name).toBe("OfflineTimeoutError");
    expect(listeners.size).toBe(0);                    // cleaned up
  });

  test("the clock stops while hidden, and waking gives the socket a grace", async () => {
    let failed = null;
    withTimeout(never(), { ms: 1000, label: "/x", sleepAware: true }).catch((e) => { failed = e; });
    await vi.advanceTimersByTimeAsync(500);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);     // five minutes hidden (under the ceiling)
    expect(failed).toBe(null);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS - 10);
    expect(failed).toBe(null);
    await vi.advanceTimersByTimeAsync(20);
    expect(failed?.name).toBe("OfflineTimeoutError");
  });

  test("a FROZEN page (timer fires late, no visibility event) re-arms instead of failing", async () => {
    let failed = null;
    let answer;
    const read = new Promise((r) => { answer = r; });
    const p = withTimeout(read, { ms: 1000, label: "/x", sleepAware: true });
    p.catch((e) => { failed = e; });
    // Frozen: the wall clock jumps a minute while no timer runs.
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(1000);           // the overdue timer fires late
    expect(failed).toBe(null);                          // …and re-armed, not failed
    await vi.advanceTimersByTimeAsync(3000);            // the socket comes back
    answer("answered");
    expect(await p).toBe("answered");
    expect(failed).toBe(null);
  });

  test("never waits for ever: re-arms are capped", async () => {
    let failed = null;
    withTimeout(never(), { ms: 1000, label: "/x", sleepAware: true }).catch((e) => { failed = e; });
    for (let i = 0; i < 10 && !failed; i += 1) {
      vi.setSystemTime(Date.now() + 60_000);            // frozen again, and again
      await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS + 1);
    }
    expect(failed?.name).toBe("OfflineTimeoutError");
  });

  test("a read started in a HIDDEN, running tab is still bounded (the ceiling)", async () => {
    setHidden(true);
    let failed = null;
    withTimeout(never(), { ms: 1000, label: "/x", sleepAware: true }).catch((e) => { failed = e; });
    await vi.advanceTimersByTimeAsync(HIDDEN_CEILING_MS - 10);
    expect(failed).toBe(null);
    await vi.advanceTimersByTimeAsync(20);
    expect(failed?.name).toBe("OfflineTimeoutError");
    expect(listeners.size).toBe(0);
  });

  test("hide/show cycling cannot extend a read without end", async () => {
    let failed = null;
    withTimeout(never(), { ms: 1000, label: "/x", sleepAware: true }).catch((e) => { failed = e; });
    for (let i = 0; i < 20 && !failed; i += 1) {
      await vi.advanceTimersByTimeAsync(500);
      setHidden(true);
      await vi.advanceTimersByTimeAsync(1000);
      setHidden(false);
    }
    expect(failed?.name).toBe("OfflineTimeoutError");
  });

  test("a read that answers clears everything", async () => {
    const p = withTimeout(Promise.resolve(7), { ms: 1000, sleepAware: true });
    expect(await p).toBe(7);
    expect(listeners.size).toBe(0);
  });
});

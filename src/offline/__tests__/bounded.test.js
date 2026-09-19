import { describe, test, expect, vi } from "vitest";
import { withTimeout, isTimeout, OfflineTimeoutError, READ_TIMEOUT_MS } from "../bounded";
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

import { describe, it, expect, vi } from "vitest";
import { onceAtATime } from "./onceAtATime.js";

const deferred = () => { let r, j; const p = new Promise((res, rej) => { r = res; j = rej; }); return { p, r, j }; };

describe("onceAtATime", () => {
  it("drops a call that arrives while the first is still running", async () => {
    const d = deferred();
    const inner = vi.fn(() => d.p);
    const g = onceAtATime(inner);
    const first = g();
    g(); g(); g();
    expect(inner).toHaveBeenCalledTimes(1);
    d.r("done");
    expect(await first).toBe("done");
  });

  it("DROPS, never queues — the second tap is the same instruction, not another", async () => {
    const d = deferred();
    const inner = vi.fn(() => d.p);
    const g = onceAtATime(inner);
    g();
    const dropped = g();
    d.r("x");
    expect(await dropped).toBeUndefined();
    await Promise.resolve();
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("lets the next call through once the first has finished", async () => {
    const inner = vi.fn(async () => "ok");
    const g = onceAtATime(inner);
    expect(await g()).toBe("ok");
    expect(await g()).toBe("ok");
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("A THROW DOES NOT WEDGE THE BUTTON — the lock releases and the error still surfaces", async () => {
    const inner = vi.fn(async () => { throw new Error("save failed"); });
    const g = onceAtATime(inner);
    await expect(g()).rejects.toThrow("save failed");
    expect(g.busy()).toBe(false);
    await expect(g()).rejects.toThrow("save failed");
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("…and a synchronous throw releases it too", async () => {
    const g = onceAtATime(() => { throw new Error("boom"); });
    await expect(g()).rejects.toThrow("boom");
    expect(g.busy()).toBe(false);
  });

  it("passes arguments and reports the lock", async () => {
    const d = deferred();
    const g = onceAtATime(async (a, b) => { await d.p; return a + b; });
    expect(g.busy()).toBe(false);
    const p = g(2, 3);
    expect(g.busy()).toBe(true);
    d.r();
    expect(await p).toBe(5);
    expect(g.busy()).toBe(false);
  });
});

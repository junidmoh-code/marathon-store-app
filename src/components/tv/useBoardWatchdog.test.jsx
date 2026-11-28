import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

vi.mock("firebase/database", () => ({ goOffline: vi.fn(), goOnline: vi.fn() }));
vi.mock("../../firebase", () => ({ database: {} }));
const store = new Map();
globalThis.window ||= globalThis;
window.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
window.location = { pathname: "/", search: "", hash: "" };

const { useBoardWatchdog, watchdogIo, WATCHDOG_CHECK_MS } = await import("./useBoardWatchdog.js");
const { WATCHDOG_MS, RELOAD_KEY } = await import("./boardHealth.js");

function Board({ healthy }) { useBoardWatchdog({ healthy }); return null; }

describe("useBoardWatchdog — the TV mends itself, and can never reload-loop", () => {
  let clock; let bounces; let reloads;
  beforeEach(() => {
    vi.useFakeTimers(); store.clear(); clock = 0; bounces = 0; reloads = [];
    watchdogIo.now = () => clock;
    watchdogIo.bounce = () => { bounces += 1; };
    watchdogIo.reload = (u) => { reloads.push(u); };
  });
  const tick = (ms) => { for (let t = 0; t < ms; t += WATCHDOG_CHECK_MS) { clock += WATCHDOG_CHECK_MS; act(() => { vi.advanceTimersByTime(WATCHDOG_CHECK_MS); }); } };

  it("unhealthy: reopens the socket at 3 min, reloads at 6 min, then not again within 5 min", () => {
    let r; act(() => { r = TestRenderer.create(React.createElement(Board, { healthy: false })); });
    tick(WATCHDOG_MS);
    expect(bounces).toBe(1); expect(reloads).toHaveLength(0);
    tick(WATCHDOG_MS);
    expect(reloads).toHaveLength(1);
    expect(reloads[0]).toMatch(/^\/\?_tvr=\d+$/);
    expect(Number(store.get(RELOAD_KEY))).toBeGreaterThan(0);
    // The reload did not happen (still the same page, as if the browser ignored it): never faster than 5 min.
    tick(4 * 60 * 1000);
    expect(reloads).toHaveLength(1);
    act(() => r.unmount());
  });

  it("a fresh page after a watchdog reload honours the stored floor", () => {
    store.set(RELOAD_KEY, String(0));
    clock = 0;
    let r; act(() => { r = TestRenderer.create(React.createElement(Board, { healthy: false })); });
    tick(2 * WATCHDOG_MS);              // 6 min since the stored reload: allowed again (floor is 5)
    expect(reloads).toHaveLength(1);
    act(() => r.unmount());
  });

  it("healthy boards are left alone, and recovering resets the clock", () => {
    let r; act(() => { r = TestRenderer.create(React.createElement(Board, { healthy: true })); });
    tick(30 * 60 * 1000);
    expect(bounces + reloads.length).toBe(0);
    act(() => r.update(React.createElement(Board, { healthy: false })));
    tick(WATCHDOG_MS - WATCHDOG_CHECK_MS);
    act(() => r.update(React.createElement(Board, { healthy: true })));
    tick(WATCHDOG_MS);
    expect(bounces).toBe(0);
    act(() => r.unmount());
  });
});

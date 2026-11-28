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
const { WATCHDOG_MS, FIRST_ANSWER_MS, RELOAD_KEY, RELOAD_COUNT_KEY, MAX_UNRECOVERED_RELOADS } = await import("./boardHealth.js");

function Board(props) { useBoardWatchdog(props); return null; }

describe("useBoardWatchdog — the TV mends itself, and can never reload-loop", () => {
  let clock; let bounces; let reloads; let reachable;
  beforeEach(() => {
    vi.useFakeTimers(); store.clear(); clock = 0; bounces = 0; reloads = []; reachable = true;
    watchdogIo.now = () => clock;
    watchdogIo.bounce = () => { bounces += 1; };
    watchdogIo.reload = (u) => { reloads.push(u); };
    watchdogIo.reachable = async () => reachable;
  });
  const tick = async (ms) => {
    for (let t = 0; t < ms; t += WATCHDOG_CHECK_MS) {
      clock += WATCHDOG_CHECK_MS;
      await act(async () => { vi.advanceTimersByTime(WATCHDOG_CHECK_MS); await Promise.resolve(); await Promise.resolve(); });
    }
  };
  const mount = (props) => { let r; act(() => { r = TestRenderer.create(React.createElement(Board, props)); }); return r; };

  it("refused after an answer: reopens the socket at 3 min, reloads at 6, then not again within 5 min", async () => {
    const r = mount({ healthy: false });
    await tick(WATCHDOG_MS);
    expect(bounces).toBe(1); expect(reloads).toHaveLength(0);
    await tick(WATCHDOG_MS);
    expect(reloads).toHaveLength(1);
    expect(reloads[0]).toMatch(/^\/\?_tvr=\d+$/);
    expect(Number(store.get(RELOAD_COUNT_KEY))).toBe(1);
    await tick(4 * 60 * 1000);                 // the page did not go: still never faster than 5 min
    expect(reloads).toHaveLength(1);
    act(() => r.unmount());
  });

  it("never reloads onto an error page: the site must answer first", async () => {
    reachable = false;
    const r = mount({ healthy: false });
    await tick(4 * WATCHDOG_MS);
    expect(reloads).toHaveLength(0);
    expect(store.has(RELOAD_KEY)).toBe(false);
    reachable = true;
    await tick(2 * WATCHDOG_MS);
    expect(reloads).toHaveLength(1);
    act(() => r.unmount());
  });

  it("a board still waiting for its FIRST answer gets 10 minutes before anything (a slow first download is not restarted)", async () => {
    const r = mount({ healthy: false, neverAnswered: true });
    await tick(FIRST_ANSWER_MS - WATCHDOG_CHECK_MS);
    expect(bounces + reloads.length).toBe(0);
    await tick(WATCHDOG_CHECK_MS);
    expect(bounces).toBe(1);
    act(() => r.unmount());
  });

  it(`stops reloading after ${MAX_UNRECOVERED_RELOADS} reloads that did not mend it; healthy resets the count`, async () => {
    store.set(RELOAD_COUNT_KEY, String(MAX_UNRECOVERED_RELOADS));
    const r = mount({ healthy: false });
    await tick(10 * WATCHDOG_MS);
    expect(reloads).toHaveLength(0);
    expect(bounces).toBeGreaterThan(1);       // it still reopens the socket
    act(() => r.update(React.createElement(Board, { healthy: true })));
    await tick(WATCHDOG_CHECK_MS);
    expect(store.has(RELOAD_COUNT_KEY)).toBe(false);
    act(() => r.unmount());
  });

  it("healthy boards are left alone, and recovering resets the clock", async () => {
    const r = mount({ healthy: true });
    await tick(30 * 60 * 1000);
    expect(bounces + reloads.length).toBe(0);
    act(() => r.update(React.createElement(Board, { healthy: false })));
    await tick(WATCHDOG_MS - WATCHDOG_CHECK_MS);
    act(() => r.update(React.createElement(Board, { healthy: true })));
    await tick(WATCHDOG_MS);
    expect(bounces).toBe(0);
    act(() => r.unmount());
  });
});

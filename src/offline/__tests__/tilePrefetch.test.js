// Prefetch of the order grid's photos (tilePrefetch.js): rows below the window
// first, at most four at a time, low priority, held while scrolling, nothing
// beyond the window on save-data / 2g.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const calls = [];
let resolvers = [];
let held = new Set();
let firstScreen = Promise.resolve();
vi.mock("../tilePhotoCache", () => ({
  getTile: (id, src, opts) => { calls.push({ id, opts }); return new Promise((r) => resolvers.push(r)); },
  isTileHeld: (id) => held.has(id),
  loadTileIndex: async () => ({}),
  tileCacheEnabled: () => true,
  tileFetchAllowed: () => true,
  whenFirstScreenLoaded: () => firstScreen,
}));

const P = await import("../tilePrefetch");
const items = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `p${from + i}`, src: `u${from + i}` }));
const settle = (ms = P.FIRST_SCREEN_GRACE_MS + 200) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  calls.length = 0; resolvers = []; held = new Set(); firstScreen = Promise.resolve();
  P._resetTilePrefetchForTests();
  globalThis.requestIdleCallback = (f) => setTimeout(f, 0);
  Object.defineProperty(globalThis, "navigator", { value: { connection: { effectiveType: "4g", saveData: false } }, configurable: true });
});
afterEach(() => { delete globalThis.requestIdleCallback; });

describe("tile prefetch", () => {
  it("ahead first, then the rest; four at a time, low priority; skips what is held", async () => {
    held.add("p1");
    P.setTilePrefetchPlan({ ahead: items(3), rest: items(5, 10) });
    await settle();
    expect(calls.map((c) => c.id)).toEqual(["p0", "p2", "p10", "p11"]);
    expect(calls.every((c) => c.opts.priority === "low")).toBe(true);
    resolvers.shift()(null);
    await settle(30);
    expect(calls).toHaveLength(5);
    expect(calls[4].id).toBe("p12");
  });

  it("waits for the first screen's photos before starting", async () => {
    let release;
    firstScreen = new Promise((r) => { release = r; });
    P.setTilePrefetchPlan({ ahead: items(2) });
    await settle();
    expect(calls).toHaveLength(0);
    release();
    await settle();
    expect(calls).toHaveLength(2);
  });

  it("holds while the list is scrolling", async () => {
    P.setTilePrefetchPlan({ ahead: items(2) });
    P.noteTileScroll();
    await settle(P.FIRST_SCREEN_GRACE_MS + 50);
    expect(P._tilePrefetchStateForTests().quietUntil).toBeGreaterThan(0);
    await settle(P.SCROLL_QUIET_MS + 200);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("save-data and 2g / slow-2g: nothing beyond the window", async () => {
    for (const c of [{ saveData: true, effectiveType: "4g" }, { effectiveType: "2g" }, { effectiveType: "slow-2g" }]) {
      expect(P.slowConnection({ connection: c })).toBe(true);
    }
    expect(P.slowConnection({ connection: { effectiveType: "3g" } })).toBe(false);
    expect(P.slowConnection({})).toBe(false);
    navigator.connection.effectiveType = "slow-2g";
    P.setTilePrefetchPlan({ ahead: items(3), rest: items(3, 10) });
    await settle();
    expect(calls).toHaveLength(0);
  });
});

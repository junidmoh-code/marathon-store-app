// ─── THE HOOKS, THROUGH THE APP'S ONE SHARED INSTANCE ────────────────────────
//
// sharedLiveReadCore.test.js proves the mechanism against a fake. This proves
// the WIRING: that the real hooks — the stock chokepoint every refill, health
// and transfer screen reads through, the layby hook, the Display Checks feed —
// actually go through it, so leaving a screen and opening the next one that
// reads the same node does not open a second listener.
//
// What is counted is onValue calls per path, because an onValue call is the
// download. A version that kept the per-hook onValue AND the shared one would
// pass every other test and save nothing.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const opens = [];            // every onValue call, by path
const closes = [];
const handlers = new Map();  // path -> { cb, errCb }
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path ?? "" }),
  onValue: (r, cb, errCb) => {
    opens.push(r.path);
    handlers.set(r.path, { cb, errCb });
    return () => { closes.push(r.path); handlers.delete(r.path); };
  },
  query: (r) => r,
  orderByKey: () => ({}), orderByChild: () => ({}), limitToLast: () => ({}), equalTo: () => ({}),
  update: vi.fn(), get: vi.fn(), runTransaction: vi.fn(),
}));
// Every auth listener the app registers — the hooks' own and the shared
// layer's — so a test can change who is signed in for all of them at once.
const authCbs = new Set();
const authCb = (user) => { for (const cb of [...authCbs]) cb(user); };
vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (_a, cb) => { authCbs.add(cb); cb({ uid: "u1" }); return () => { authCbs.delete(cb); }; },
}));
vi.mock("../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));

const {
  lingerMsForMode, _setLingerMsForTests, _resetSharedLiveReadsForTests,
  releaseIdleLiveReads,
} = await import("./sharedLiveRead.js");
const { LINGER_MS } = await import("./sharedLiveReadCore.js");
const stock = await import("../components/stock/useStock.js");
const layby = await import("../components/layby/useLayby.js");
const checks = await import("../pages/DisplayChecks/useDisplayChecks.js");

const push = (path, value) => act(() => { handlers.get(path).cb({ val: () => value }); });
const countOf = (path) => opens.filter((p) => p === path).length;

function mountHook(useIt) {
  const out = { value: undefined };
  function Probe() { out.value = useIt(); return null; }
  let tree;
  act(() => { tree = TestRenderer.create(<Probe />); });
  return { out, unmount: () => act(() => { tree.unmount(); }) };
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetSharedLiveReadsForTests();
  _setLingerMsForTests(LINGER_MS);     // the app's setting, not the test default
  opens.length = 0; closes.length = 0; handlers.clear();
});
afterEach(() => {
  _resetSharedLiveReadsForTests();
  _setLingerMsForTests(lingerMsForMode("test"));
  vi.useRealTimers();
});

describe("the linger setting", () => {
  it("is ten minutes in every mode the app ships or runs in, and off only under the test runner", () => {
    expect(lingerMsForMode("production")).toBe(LINGER_MS);
    expect(lingerMsForMode("development")).toBe(LINGER_MS);
    expect(lingerMsForMode(undefined)).toBe(LINGER_MS);
    expect(lingerMsForMode("test")).toBe(0);
  });
});

describe("the stock chokepoint (usePathState) — the Refill queue's read", () => {
  it("Refill screen → Health screen → Home badge: ONE listener on the request node, not three", () => {
    const refill = mountHook(() => stock.useRefillRequests());
    push("refill_requests", { a: { status: "open", productId: "p1" }, b: { status: "fulfilled" } });
    expect(refill.out.value.map((r) => r.id)).toEqual(["a", "b"]);
    refill.unmount();

    const health = mountHook(() => stock.useRefillRequests("open"));
    // Held value, at once — no empty list while a second download runs.
    expect(health.out.value.map((r) => r.id)).toEqual(["a"]);
    health.unmount();

    vi.advanceTimersByTime(3 * 60 * 1000);
    const home = mountHook(() => stock.useRefillRequests("open"));
    expect(home.out.value.map((r) => r.id)).toEqual(["a"]);

    expect(countOf("refill_requests")).toBe(1);
    expect(closes).toEqual([]);
  });

  it("the rows a screen is handed are exactly the rows the listener delivered, and they stay live", () => {
    const first = mountHook(() => stock.useRefillRequests());
    push("refill_requests", { a: { status: "open" } });
    first.unmount();
    // A change arrives while no screen is mounted…
    push("refill_requests", { a: { status: "open" }, c: { status: "open", qty: 2 } });
    const second = mountHook(() => stock.useRefillRequests());
    expect(second.out.value).toEqual([{ id: "a", status: "open" }, { id: "c", status: "open", qty: 2 }]);
    // …and another while one is.
    push("refill_requests", { c: { status: "open", qty: 1 } });
    expect(second.out.value).toEqual([{ id: "c", status: "open", qty: 1 }]);
  });

  it("two screens mounted together share the listener", () => {
    mountHook(() => stock.useStockTargets());
    mountHook(() => stock.useStockTargetsState());
    expect(countOf("stock_targets")).toBe(1);
  });

  it("after the linger the listener is closed — an abandoned node stops streaming", () => {
    const h = mountHook(() => stock.useEngineOpen());
    push("refill_engine/open", {});
    h.unmount();
    vi.advanceTimersByTime(LINGER_MS + 1);
    expect(closes).toEqual(["refill_engine/open"]);
    mountHook(() => stock.useEngineOpen());
    expect(countOf("refill_engine/open")).toBe(2);
  });

  it("a hidden page lets go of what no screen is using", () => {
    const h = mountHook(() => stock.useStockCells("hub2"));
    const kept = mountHook(() => stock.useDisplaySlots());
    h.unmount();
    releaseIdleLiveReads();
    expect(closes).toEqual(["stock/hub2"]);
    expect(kept.out.value).toBe(null);
  });

  it("a denied read is still settled-with-error, and the next mount tries again", () => {
    const h = mountHook(() => stock.useStockTargetsState("hub1"));
    act(() => { handlers.get("stock_targets/hub1").errCb(new Error("permission_denied")); });
    expect(h.out.value).toEqual({ value: null, settled: true, error: true });
    h.unmount();
    mountHook(() => stock.useStockTargetsState("hub1"));
    expect(countOf("stock_targets/hub1")).toBe(2);
  });

  it("signing out and another person signing in does not hand over the held rows", () => {
    const h = mountHook(() => stock.useRefillRequests());
    push("refill_requests", { a: { status: "open" } });
    h.unmount();
    act(() => { authCb({ uid: "someone-else" }); });
    expect(closes).toEqual(["refill_requests"]);
    const next = mountHook(() => stock.useRefillRequests());
    expect(next.out.value).toEqual([]);
    expect(countOf("refill_requests")).toBe(2);
    act(() => { authCb({ uid: "u1" }); });
  });
});

describe("laybys and layby pulls", () => {
  it("warehouse view → another view → warehouse view: each node is opened once", () => {
    const useBoth = () => ({ laybys: layby.useLaybys(), pulls: layby.useLaybyPulls() });
    const a = mountHook(useBoth);
    push("laybys", { L1: { status: "stored", invoiceNo: "100" } });
    push("laybyPulls", { P1: { status: "pending" } });
    expect(a.out.value.laybys).toEqual([{ key: "L1", status: "stored", invoiceNo: "100" }]);
    a.unmount();
    vi.advanceTimersByTime(2 * 60 * 1000);
    const b = mountHook(useBoth);
    expect(b.out.value.laybys).toEqual([{ key: "L1", status: "stored", invoiceNo: "100" }]);
    expect(b.out.value.pulls).toEqual([{ key: "P1", status: "pending" }]);
    expect(countOf("laybys")).toBe(1);
    expect(countOf("laybyPulls")).toBe(1);
  });

  it("the TV board and the warehouse view mounted together share the pulls listener", () => {
    mountHook(() => layby.useLaybyPulls());
    mountHook(() => layby.useLaybyPulls());
    expect(countOf("laybyPulls")).toBe(1);
  });

  it("a denied read still shows an empty list rather than crashing", () => {
    const h = mountHook(() => layby.useLaybys());
    act(() => { handlers.get("laybys").errCb({ code: "PERMISSION_DENIED" }); });
    expect(h.out.value).toEqual([]);
  });
});

describe("the Display Checks feed", () => {
  it("leaving the tab and coming back opens the active index once", () => {
    const useFeed = () => checks.useTodayFeedSources("marathon-pe", "2026-11-11");
    const a = mountHook(useFeed);
    push("displayChecks_active/marathon-pe", { k1: { state: "open" } });
    push("displayChecks/marathon-pe/2026-11-11", null);
    expect(a.out.value.ready).toBe(true);
    expect(a.out.value.activeItems).toEqual([{ key: "k1", state: "open" }]);
    a.unmount();
    const b = mountHook(useFeed);
    expect(b.out.value.ready).toBe(true);
    expect(b.out.value.activeItems).toEqual([{ key: "k1", state: "open" }]);
    expect(countOf("displayChecks_active/marathon-pe")).toBe(1);
  });

  it("a denied read is surfaced as an error, never as an empty feed", () => {
    const h = mountHook(() => checks.useTodayFeedSources("trophy", "2026-11-11"));
    act(() => { handlers.get("displayChecks_active/trophy").errCb({ code: "PERMISSION_DENIED" }); });
    push("displayChecks/trophy/2026-11-11", null);
    expect(h.out.value.error).toBe("PERMISSION_DENIED");
  });
});

// App.jsx cannot be mounted in a unit test (22,000 lines, the whole app), so
// its four fallback reads are pinned the way this repo pins App.jsx wiring
// elsewhere: by the source saying what it must say.
describe("App.jsx's own fallback reads go through the shared listener", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const app = readFileSync(resolve(here, "../App.jsx"), "utf8");
  it("products, customers and the returns log", () => {
    expect(app).toContain('subscribeLivePath("products", (snap) => {');
    expect(app).toContain('subscribeLivePath("customers", snap => {');
    expect(app).toContain('subscribeLivePath("returns_log", snap => {');
    expect(app).not.toMatch(/onValue\(\s*ref\(database, "(products|customers|returns_log)"\)/);
    expect(app).not.toContain("onValue(productsRef");
  });
  it("orders, keyed by its complete query so a shop's scoped read shares with nothing else", () => {
    expect(app).toContain('const readKey = scopeShop ? `orders?orderByChild=destShop&equalTo=${scopeShop}` : "orders";');
    expect(app).toContain("subscribeLiveQuery(readKey, () => readRef, (snap) => {");
    expect(app).not.toContain("onValue(readRef");
  });
});

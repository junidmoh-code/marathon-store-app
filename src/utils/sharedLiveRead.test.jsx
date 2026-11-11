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
  update: vi.fn(), get: (r) => { gets.push(r.path); return Promise.resolve({ val: () => null }); }, runTransaction: vi.fn(),
}));
// The mirror "takes a path over" when a test says its leg is serving.
const servingLegs = new Set();
const gets = [];
vi.mock("../offline/serving", async (original) => ({
  ...(await original()),
  isLegServing: (leg) => servingLegs.has(leg),
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
  holdsInMode, lingerPolicyFor, childQueryKey, isPlaceholderKey,
  _setHoldingForTests, _resetSharedLiveReadsForTests, releaseIdleLiveReads,
} = await import("./sharedLiveRead.js");
const { LINGER_MS, SHORT_LINGER_MS, MAX_IDLE_BYTES } = await import("./sharedLiveReadCore.js");
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
  _setHoldingForTests(true);           // the app's setting, not the test default
  // The one `.info/connected` listener is opened once per module, on first
  // use, and survives a reset — keep its handler across tests.
  const conn = handlers.get(".info/connected");
  opens.length = 0; closes.length = 0; handlers.clear();
  if (conn) handlers.set(".info/connected", conn);
  gets.length = 0; servingLegs.clear();
});
afterEach(() => {
  _resetSharedLiveReadsForTests();
  _setHoldingForTests(holdsInMode("test"));
  vi.useRealTimers();
});

describe("the hold setting", () => {
  it("is on in every mode the app ships or runs in, and off only under the test runner", () => {
    expect(holdsInMode("production")).toBe(true);
    expect(holdsInMode("development")).toBe(true);
    expect(holdsInMode(undefined)).toBe(true);
    expect(holdsInMode("test")).toBe(false);
  });
});

describe("the per-path policy table", () => {
  const MB = 1024 * 1024;
  const long = (k) => lingerPolicyFor(k).lingerMs === LINGER_MS;
  it("ten minutes for the big, slow-changing nodes", () => {
    for (const k of [
      "refill_requests", "products", "orders", childQueryKey("orders", "destShop", "marathon-pe"),
      "customers", "settings/displayRows", "settings/displaySlots", "stock_targets", "stock",
    ]) expect([k, long(k)]).toEqual([k, true]);
  });
  it("…and for their sub-paths: one location of stock or targets is the same slow data", () => {
    for (const k of [
      "stock/hub2", "stock/marathon-pe", "stock_targets/hub1", "stock_targets/hub2/p1",
      "stock/hub2/p1", "settings/displayRows/trophy", "settings/displaySlots/marathon-pe/p1",
      "refill_requests/abc", "products/p1", "customers/0821234567",
    ]) expect([k, long(k)]).toEqual([k, true]);
  });
  it("the short hold for small hot nodes, for look-alikes, and for anything not listed", () => {
    for (const k of [
      "laybys", "laybyPulls", "refill_engine/open", "displayChecks_active/marathon-pe",
      "displayChecks/marathon-pe/2026-11-11", "returns_log", "config/refillEngine",
      "settings/hubSneakerCount/register/hub1", "settings/stockHold/config",
      "productsX", "stock_movements", "stock_targets_decisions", "something/new",
    ]) expect([k, lingerPolicyFor(k).lingerMs]).toEqual([k, SHORT_LINGER_MS]);
    expect(SHORT_LINGER_MS).toBeGreaterThanOrEqual(20000);
    expect(SHORT_LINGER_MS).toBeLessThanOrEqual(30000);
  });
  it("a placeholder path is never held", () => {
    for (const k of ["stock/__off__", "stock/__no_source__", "stock_targets/__off__"]) {
      expect(isPlaceholderKey(k)).toBe(true);
      expect(lingerPolicyFor(k)).toEqual({ lingerMs: 0, bytes: 0 });
    }
    expect(isPlaceholderKey("stock/hub2")).toBe(false);
    expect(isPlaceholderKey("stock/hub2/p1/_")).toBe(false);
  });
  it("size hints: the request node is the biggest and fits the budget alone; a sub-path is smaller than its node", () => {
    expect(lingerPolicyFor("refill_requests").bytes).toBe(16 * MB);
    expect(lingerPolicyFor("refill_requests").bytes).toBeLessThanOrEqual(MAX_IDLE_BYTES);
    expect(lingerPolicyFor("stock").bytes).toBe(7 * MB);
    expect(lingerPolicyFor("stock/hub2").bytes).toBe(1.5 * MB);
    expect(lingerPolicyFor("stock_targets/hub1").bytes).toBe(0.5 * MB);
    expect(lingerPolicyFor("stock/hub2/p1").bytes).toBe(0.25 * MB);
    expect(lingerPolicyFor("refill_requests/abc").bytes).toBe(0.25 * MB);
    expect(lingerPolicyFor(childQueryKey("orders", "destShop", "x")).bytes).toBe(4 * MB);
  });
  it("a query key escapes its value, so no shop name can collide with another key", () => {
    expect(childQueryKey("orders", "destShop", "marathon-pe")).toBe("orders?orderByChild=destShop&equalTo=marathon-pe");
    expect(childQueryKey("orders", "destShop", "a&equalTo=b")).toBe("orders?orderByChild=destShop&equalTo=a%26equalTo%3Db");
    expect(childQueryKey("orders", "destShop", "x")).not.toBe(childQueryKey("orders", "destShop", "x?"));
  });
});

describe("the two commonest loops, through the real hooks and the real table", () => {
  // The shop view reads several stock locations, one of them the placeholder
  // it is handed when a second hub is not in play.
  const useShop = () => [
    stock.useStockCells("hub1"), stock.useStockCells("hub2"), stock.useStockCells("marathon-pe"),
    stock.useStockCells("hub3"), stock.useStockCells("__off__"),
  ];
  const useHome = () => stock.useRefillRequests("open");
  const useHealth = () => [stock.useStockCells(), stock.useRefillRequests("open"), stock.useStockTargets()];
  const useRefill = () => [stock.useRefillRequests(), stock.useStockCells("hub2"), stock.useEngineOpen()];
  const answer = () => { for (const p of [...handlers.keys()]) if (p !== ".info/connected") push(p, {}); };
  const switchTo = async (from, useNext) => {
    from.unmount();
    const next = mountHook(useNext);
    answer();
    await act(async () => { await Promise.resolve(); });   // the idle cap runs after the switch
    return next;
  };

  it("HOME → SHOP → HOME → SHOP → HOME: the request node is opened ONCE", async () => {
    let screen = mountHook(useHome); answer();
    screen = await switchTo(screen, useShop);
    screen = await switchTo(screen, useHome);
    screen = await switchTo(screen, useShop);
    screen = await switchTo(screen, useHome);
    expect(countOf("refill_requests")).toBe(1);
    expect(closes).not.toContain("refill_requests");
    screen.unmount();
  });

  it("the placeholder location is closed the moment the shop view is left, never held", async () => {
    let screen = mountHook(useShop); answer();
    screen = await switchTo(screen, useHome);
    expect(closes).toContain("stock/__off__");
    screen.unmount();
  });

  it("HEALTH → REFILL → HEALTH → REFILL → HEALTH: whole stock, the request node and the targets are each opened ONCE", async () => {
    let screen = mountHook(useHealth); answer();
    screen = await switchTo(screen, useRefill);
    screen = await switchTo(screen, useHealth);
    screen = await switchTo(screen, useRefill);
    screen = await switchTo(screen, useHealth);
    expect(countOf("stock")).toBe(1);
    expect(countOf("refill_requests")).toBe(1);
    expect(countOf("stock_targets")).toBe(1);
    screen.unmount();
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

  it("after its hold the listener is closed — a small hot node after seconds, a big one after ten minutes", () => {
    const small = mountHook(() => stock.useEngineOpen());
    const big = mountHook(() => stock.useStockTargets());
    push("refill_engine/open", {});
    push("stock_targets", {});
    small.unmount(); big.unmount();
    vi.advanceTimersByTime(SHORT_LINGER_MS - 1);
    expect(closes).toEqual([]);               // a tab toggle is covered
    vi.advanceTimersByTime(2);
    expect(closes).toEqual(["refill_engine/open"]);
    vi.advanceTimersByTime(LINGER_MS - SHORT_LINGER_MS - 2);
    expect(closes).toEqual(["refill_engine/open"]);
    vi.advanceTimersByTime(2);
    expect(closes).toEqual(["refill_engine/open", "stock_targets"]);
    mountHook(() => stock.useEngineOpen());
    expect(countOf("refill_engine/open")).toBe(2);
  });

  it("when the offline mirror takes the path over, the listener is closed at once — not held for nobody", () => {
    const h = mountHook(() => stock.useRefillRequests());
    push("refill_requests", { a: { status: "open" } });
    servingLegs.add("refills");               // the device's own copy now answers
    h.unmount();
    expect(closes).toEqual(["refill_requests"]);
  });

  it("the connection dropping: idle listeners go; a screen opening while offline is handed the held rows and nothing is reopened", () => {
    const idle = mountHook(() => stock.useStockTargets());
    push("stock_targets", { hub1: {} });
    idle.unmount();
    const home = mountHook(() => stock.useRefillRequests("open"));
    push("refill_requests", { a: { status: "open" } });
    act(() => { handlers.get(".info/connected").cb({ val: () => true }); });
    act(() => { handlers.get(".info/connected").cb({ val: () => false }); });
    expect(closes).toEqual(["stock_targets"]);
    // Exactly what a bare onValue does: the SDK's held value, at once.
    const refill = mountHook(() => stock.useRefillRequests());
    expect(refill.out.value.map((r) => r.id)).toEqual(["a"]);
    expect(countOf("refill_requests")).toBe(1);
    // The line returns: no probe read, no reopen — the SDK re-syncs the listener itself.
    act(() => { handlers.get(".info/connected").cb({ val: () => true }); });
    expect(gets).toEqual([]);
    expect(countOf("refill_requests")).toBe(1);
    push("refill_requests", { a: { status: "open" }, b: { status: "open" } });
    expect(refill.out.value.map((r) => r.id)).toEqual(["a", "b"]);
    expect(home.out.value.map((r) => r.id)).toEqual(["a", "b"]);
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

  it("a DIRECT switch from person A to person B with the screen still mounted: B's new screen is never handed A's rows", () => {
    // A's Home is mounted and holds the list. The identity changes with no
    // sign-out in between, so nothing unmounts.
    const homeA = mountHook(() => stock.useRefillRequests("open"));
    push("refill_requests", { a: { status: "open", who: "A" } });
    act(() => { authCb({ uid: "person-b" }); });
    expect(closes).toEqual([]);               // in use: not torn down under the screen
    const screenB = mountHook(() => stock.useRefillRequests());
    expect(screenB.out.value).toEqual([]);    // NOT A's rows
    expect(countOf("refill_requests")).toBe(2);   // a fresh listener, under B
    push("refill_requests", { b: { status: "open", who: "B" } });
    expect(screenB.out.value).toEqual([{ id: "b", status: "open", who: "B" }]);
    homeA.unmount(); screenB.unmount();
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
    vi.advanceTimersByTime(SHORT_LINGER_MS - 5000);   // a tab toggle, not a ten-minute hold
    const b = mountHook(useBoth);
    expect(b.out.value.laybys).toEqual([{ key: "L1", status: "stored", invoiceNo: "100" }]);
    expect(b.out.value.pulls).toEqual([{ key: "P1", status: "pending" }]);
    expect(countOf("laybys")).toBe(1);
    expect(countOf("laybyPulls")).toBe(1);
    b.unmount();
    vi.advanceTimersByTime(SHORT_LINGER_MS + 1);
    expect(closes.sort()).toEqual(["laybyPulls", "laybys"]);   // small hot nodes are not held for minutes
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
    expect(app).toContain('const readKey = scopeShop ? childQueryKey("orders", "destShop", scopeShop) : "orders";');
    expect(app).toContain("subscribeLiveQuery(readKey, () => readRef, (snap) => {");
    expect(app).not.toContain("onValue(readRef");
  });
});

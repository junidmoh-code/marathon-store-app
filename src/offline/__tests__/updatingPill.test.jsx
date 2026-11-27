// ─── THE "UPDATING…" PILL IS NEVER FOREVER (Junid, 27 Nov 2026) ─────────────
//
// Junid's iPhone kept "Updating…" up on the product page. The pill has three
// sources — an aged mirror copy, a held live value the socket has not
// re-confirmed, and the saved /users record AuthGate paints a cold start with
// — and all three render through ONE component in the App shell
// (ResumeUpdatingMarker, beside the mirror dot, on every page except the TV).
// These tests drive that production component and the production state module.
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import TestRenderer, { act } from "react-test-renderer";

const servingLegs = new Set();
vi.mock("../serving", async (original) => ({
  ...(await original()),
  isLegServing: (leg) => servingLegs.has(leg),
}));
vi.mock("../../update/updateChecker", async (original) => ({
  ...(await original()),
  isTvScreen: () => false,
}));

import { ResumeUpdatingMarker } from "../ResumeUpdatingMarker.jsx";
import {
  markerState, markMirrorFeedOk, markMirrorFeedFailed, setSavedShowing, setDatabaseConnected,
  setMirrorSuspended, registerUpdateRetry, UPDATE_TIMEOUT_MS, RESUME_SAFE_MS,
  _resetResumeFreshnessForTests,
} from "../resumeFreshness";
import { freshMirrorDb } from "./helpers";
import { createFakeRtdb, pushKeyForMs } from "./fakeAdapter";
import { createSyncEngine } from "../sync";
import { CHANGES_ROOT } from "../changeFeed";

const T0 = 1_790_000_000_000;
let onLine = true;

beforeEach(() => {
  _resetResumeFreshnessForTests();
  servingLegs.clear();
  onLine = true;
  Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, get: () => onLine });
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => { vi.useRealTimers(); });

let tree = null;
const render = (el) => { act(() => { tree = TestRenderer.create(el); }); };
afterEach(() => { if (tree) act(() => tree.unmount()); tree = null; });
const textOf = (n) => (typeof n === "string" ? n : (n.children || []).map(textOf).join(""));
// The pill as the user sees it: its face, its words, whether it is a button.
const pill = () => {
  const found = tree.root.findAll((n) => n.props && n.props["data-testid"] === "resume-updating" && typeof n.type === "string");
  if (!found.length) return null;
  const n = found[0];
  return { dataset: { state: n.props["data-state"] }, tagName: n.type.toUpperCase(), textContent: textOf(n), click: () => n.props.onClick() };
};
const tick = async (ms) => { await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); }); };

describe("which face the pill shows (pure)", () => {
  const base = { updating: true, since: T0, nowMs: T0 };
  test("hidden when nothing is catching up", () => {
    expect(markerState({ ...base, updating: false })).toBe("hidden");
  });
  test("updating inside the window, failed once it runs out", () => {
    expect(markerState({ ...base, nowMs: T0 + UPDATE_TIMEOUT_MS - 1 })).toBe("updating");
    expect(markerState({ ...base, nowMs: T0 + UPDATE_TIMEOUT_MS })).toBe("failed");
  });
  test("a feed failure during this attempt is failed at once; one from before it is not", () => {
    expect(markerState({ ...base, mirrorStale: true, failedAt: T0 + 5 })).toBe("failed");
    expect(markerState({ ...base, mirrorStale: true, failedAt: T0 - 5 })).toBe("updating");
  });
  test("offline beats both", () => {
    expect(markerState({ ...base, offline: true, nowMs: T0 + UPDATE_TIMEOUT_MS * 5 })).toBe("offline");
  });
  test("an idle-suspended mirror with nothing else to report shows nothing", () => {
    expect(markerState({ ...base, mirrorStale: true, idle: true })).toBe("hidden");
  });
});

describe("the pill on screen", () => {
  test("a page with nothing stale never shows it", async () => {
    // Not serving, nothing saved: a live device.
    render(<ResumeUpdatingMarker />);
    expect(pill()).toBeNull();
    await tick(UPDATE_TIMEOUT_MS * 3);
    expect(pill()).toBeNull();
    // Serving with a fresh feed read, kept fresh.
    servingLegs.add("products");
    act(() => markMirrorFeedOk(Date.now()));
    await tick(60_000);
    act(() => markMirrorFeedOk(Date.now()));
    await tick(60_000);
    expect(pill()).toBeNull();
  });

  test("an aged mirror copy: asks for a catch-up at once, and a successful read clears it", async () => {
    const asked = [];
    registerUpdateRetry((o) => asked.push(o));
    servingLegs.add("products");
    act(() => markMirrorFeedOk(T0 - RESUME_SAFE_MS - 1));
    render(<ResumeUpdatingMarker />);
    await tick(0);
    expect(pill().dataset.state).toBe("updating");
    expect(pill().textContent).toContain("Updating…");
    expect(asked).toEqual([{ manual: false }]);   // did not wait for the next scheduled pass
    act(() => markMirrorFeedOk(Date.now()));
    expect(pill()).toBeNull();
  });

  test("a catch-up that fails turns into a tappable retry; the tap retries and starts a fresh window", async () => {
    const asked = [];
    registerUpdateRetry((o) => asked.push(o));
    servingLegs.add("products");
    render(<ResumeUpdatingMarker />);
    await tick(0);
    expect(pill().dataset.state).toBe("updating");
    act(() => markMirrorFeedFailed(Date.now() + 1));
    expect(pill().dataset.state).toBe("failed");
    expect(pill().tagName).toBe("BUTTON");
    expect(pill().textContent).toBe("!Couldn't update. Tap to retry");
    act(() => { pill().click(); });
    expect(asked.at(-1)).toEqual({ manual: true });
    expect(pill().dataset.state).toBe("updating");
    act(() => markMirrorFeedOk(Date.now()));
    expect(pill()).toBeNull();
  });

  test("a catch-up that hangs reaches the retry state at the limit, never a spinner forever", async () => {
    servingLegs.add("products");
    render(<ResumeUpdatingMarker />);
    await tick(UPDATE_TIMEOUT_MS - 1000);
    expect(pill().dataset.state).toBe("updating");
    await tick(1000);
    expect(pill().dataset.state).toBe("failed");
    await tick(10 * 60_000);
    expect(pill().dataset.state).toBe("failed");
  });

  test("a held live value never re-confirmed (socket answers nothing) reaches retry too", async () => {
    render(<ResumeUpdatingMarker />);
    act(() => setSavedShowing("live|refill_engine/open", true));
    expect(pill().dataset.state).toBe("updating");
    await tick(UPDATE_TIMEOUT_MS);
    expect(pill().dataset.state).toBe("failed");
    act(() => setSavedShowing("live|refill_engine/open", false));
    expect(pill()).toBeNull();
  });

  test("the saved /users record that never hears back reaches retry; the live answer clears it", async () => {
    render(<ResumeUpdatingMarker />);
    act(() => setSavedShowing("users/u1", true));
    await tick(UPDATE_TIMEOUT_MS);
    expect(pill().dataset.state).toBe("failed");
    act(() => setSavedShowing("users/u1", false));
    expect(pill()).toBeNull();
  });

  test("offline shows Offline, not Updating…", async () => {
    servingLegs.add("products");
    onLine = false;
    render(<ResumeUpdatingMarker />);
    await tick(0);
    expect(pill().dataset.state).toBe("offline");
    expect(pill().textContent).toContain("Offline");
    onLine = true;
    await tick(1000);
    expect(pill().dataset.state).toBe("updating");
    act(() => setDatabaseConnected(true));
    act(() => setDatabaseConnected(false));      // a socket that WAS up and dropped
    expect(pill().dataset.state).toBe("offline");
  });

  test("an idle-suspended device (nobody using it) shows no pill for its aged copy", async () => {
    servingLegs.add("products");
    act(() => setMirrorSuspended(true));
    render(<ResumeUpdatingMarker />);
    await tick(UPDATE_TIMEOUT_MS * 2);
    expect(pill()).toBeNull();
  });
});

describe("review fixes (#1021)", () => {
  test("idle-suspended with an aged mirror is hidden even though the socket reads dropped", async () => {
    servingLegs.add("products");
    act(() => { setDatabaseConnected(true); setDatabaseConnected(false); setMirrorSuspended(true); });
    render(<ResumeUpdatingMarker />);
    await tick(UPDATE_TIMEOUT_MS * 2);
    expect(pill()).toBeNull();
  });
  test("time hidden or offline does not count: coming back starts a full fresh window", async () => {
    servingLegs.add("products");
    act(() => setMirrorSuspended(true));
    render(<ResumeUpdatingMarker />);
    await tick(UPDATE_TIMEOUT_MS * 3);
    act(() => setMirrorSuspended(false));
    await tick(0);
    expect(pill().dataset.state).toBe("updating");
    onLine = false;
    await tick(UPDATE_TIMEOUT_MS * 3);
    expect(pill().dataset.state).toBe("offline");
    onLine = true;
    await tick(1000);
    expect(pill().dataset.state).toBe("updating");
    await tick(UPDATE_TIMEOUT_MS - 2000);
    expect(pill().dataset.state).toBe("updating");
  });
  test("the automatic catch-up is asked only when the mirror is what is behind", async () => {
    const asked = [];
    registerUpdateRetry((o) => asked.push(o));
    render(<ResumeUpdatingMarker />);
    act(() => setSavedShowing("users/u1", true));
    await tick(0);
    expect(pill().dataset.state).toBe("updating");
    expect(asked).toEqual([]);
  });
});

describe("the mirror engine says how the feed went before the slow range walks", () => {
  function world() {
    return createFakeRtdb({
      locations: { hub1: { id: "hub1" }, "marathon-pe": { id: "marathon-pe" } },
      users: { u1: { name: "Zee" } },
      products: { p1: { id: "p1", name: "Nike Air", price: 1200 } },
      stock: { hub1: { p1: { 9: { qty: 3 } } }, "marathon-pe": { p1: { 9: { qty: 1 } } } },
      orders: { "001": { id: "001", destShop: "marathon-pe" } },
      customers: { c1: { name: "Ndu" } },
      refill_requests: { r1: { status: "open" } },
    });
  }

  test("onFeed fires with success as soon as the feed step ends — before any range walk reads", async () => {
    vi.useRealTimers();
    const db = await freshMirrorDb();
    const w = world();
    const events = [];
    // Record every page read the engine makes, in order (the range walks use
    // readKeyPage / readChildPage on their own nodes; the feed reads CHANGES_ROOT).
    const adapter = {
      ...w.adapter,
      readKeyPage: (path, o) => { events.push(String(path).startsWith(CHANGES_ROOT) ? "feed" : `range:${path}`); return w.adapter.readKeyPage(path, o); },
      readChildPage: (path, f, o) => { events.push(`range:${path}`); return w.adapter.readChildPage(path, f, o); },
    };
    const e = createSyncEngine({ db, adapter, now: () => T0, buildVersion: "b1" });
    await e.runSetup();
    w.write("products/p1/price", 999);
    w.write(`${CHANGES_ROOT}/${pushKeyForMs(T0 + 1000, "BBBBBBBBBBBB")}`, { n: "products", k: "p1", t: T0 + 1000 });
    events.length = 0;
    const seen = [];
    await e.runPass({ onFeed: (feed, failed) => { seen.push({ applied: feed.applied, failed }); events.push("onFeed"); } });
    expect(seen).toEqual([{ applied: 1, failed: false }]);
    const at = events.indexOf("onFeed");
    expect(events.slice(0, at).some((x) => x.startsWith("range:"))).toBe(false);
    expect(events.slice(at + 1).some((x) => x.startsWith("range:"))).toBe(true);   // the walks did run, after
  });

  test("onFeed fires with failure when the feed read times out", async () => {
    vi.useRealTimers();
    const db = await freshMirrorDb();
    const w = world();
    const e0 = createSyncEngine({ db, adapter: w.adapter, now: () => T0, buildVersion: "b1" });
    await e0.runSetup();
    const timeout = Object.assign(new Error("/mirror_changes (key page) did not answer within 8000 ms"), { name: "OfflineTimeoutError" });
    const adapter = {
      ...w.adapter,
      readKeyPage: (path, o) => (String(path).startsWith(CHANGES_ROOT) ? Promise.reject(timeout) : w.adapter.readKeyPage(path, o)),
    };
    const e = createSyncEngine({ db, adapter, now: () => T0, buildVersion: "b1" });
    const seen = [];
    const report = await e.runPass({ onFeed: (_feed, failed) => seen.push(failed) });
    expect(report.errors.some((x) => x.where === "feed")).toBe(true);
    expect(seen).toEqual([true]);
  });
});

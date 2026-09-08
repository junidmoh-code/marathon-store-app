// ─── STOCK AUDIT — THROUGH THE REAL COMPONENT ────────────────────────────────
// Mounts the whole screen over a faked snapshot: both tabs, both store chips,
// both Tab B views. The failure this exists to catch is the one a unit test
// cannot — a dangling identifier in the render path that kills the route on
// first open and that nothing MOUNTING the view would notice.
//
// It also pins the two promises the screen makes: it reads ONE path per store
// plus today's results node and nothing else, and an actioned row does not come
// back.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const SUBSCRIBED = [];

vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "u1" } } }));
vi.mock("firebase/database", () => ({ ref: () => ({}), onValue: () => () => {} }));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: () => () => {} }));
// A movable clock, so the midnight-rollover test can advance it.
const NOW_MS = { v: Date.parse("2026-09-07T09:00:00.000Z") };
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => NOW_MS.v }));

const SNAPSHOTS = {
  // ── hubs: sneaker lines a customer was turned away from ──
  "settings/stockAudit/hub/hub1/latest": {
    hub: "hub1", saDate: "2026-09-07",
    oos: {
      total: 2, truncated: false,
      rows: [
        // said sold out while its own cell reads 3 — the phantom
        { k: "a__9__hub1", p: "a", n: "Air Force 1 White", s: "9", sk: "9", w: "hub1", q: 3, r: "out_of_stock", c: 2 },
        { k: "b__7__hub1", p: "b", n: "Timberland Motion 6", s: "7", sk: "7", w: "hub1", q: 0, r: "coming_tomorrow", c: 1 },
      ],
    },
  },
  "settings/stockAudit/hub/hub2/latest": {
    hub: "hub2", saDate: "2026-09-07",
    oos: { total: 1, truncated: false, rows: [{ k: "z__11__hub2", p: "z", n: "Hub Two Shoe", s: "11", sk: "11", w: "hub2", q: 0, r: "out_of_stock", c: 1 }] },
  },
  "settings/stockAudit/hub/hub3/latest": {
    hub: "hub3", saDate: "2026-09-07", oos: { total: 0, truncated: false, rows: [] },
  },
  // one row already actioned today — it must not come back
  "settings/stockAudit/hub/hub1/results/2026-09-07": { "b__7__hub1": { outcome: "confirmed_empty" } },

  // ── shops: the clothing rotation ──
  "settings/stockAudit/marathon-pe/latest": {
    store: "marathon-pe", saDate: "2026-09-07",
    rotation: {
      batchDate: "2026-09-07", refreshed: true, universeSize: 641, cycleBatches: 22, walked: 0, batchSize: 2,
      rows: [
        { p: "a", n: "Nike Tee Black", slow: false, last: null,
          z: [{ s: "S", sk: "S", q: 4 }, { s: "M", sk: "M", q: 1 }] },
        { p: "c", n: "Puma Shorts", slow: true, last: 1, z: [{ s: "L", sk: "L", q: 2 }] },
      ],
    },
  },
  "settings/stockAudit/trophy/latest": {
    store: "trophy", saDate: "2026-09-04",
    rotation: { batchDate: "2026-09-02", refreshed: false, universeSize: 466, cycleBatches: 16, rows: [], walked: 30, batchSize: 30 },
  },
};

// usePathState reports THREE states RTDB's null conflates, so the fake must too
// — a fake that always answers "settled, no error" cannot witness the
// difference between "nothing is actioned" and "we could not find out".
const READ = { settled: true, error: false };
vi.mock("./useStock", () => ({
  usePathState: (path, enabled) => {
    if (enabled && path) SUBSCRIBED.push(path);
    const isResults = String(path).includes("/results/");
    return {
      value: SNAPSHOTS[path] ?? null,
      settled: isResults ? READ.settled : true,
      error: isResults ? READ.error : false,
    };
  },
}));

const { default: StockAuditView } = await import("./StockAuditView.jsx");

const instText = (inst) => {
  if (typeof inst === "string") return inst;
  return (inst?.children || []).map(instText).join("");
};
const buttonWith = (tree, needle) => tree.root.findAllByType("button").find((b) => instText(b).includes(needle));
const text = (tree) => JSON.stringify(tree.toJSON());

const mount = () => {
  let t;
  act(() => { t = TestRenderer.create(<StockAuditView onExit={() => {}} />); });
  return t;
};
const tap = (t, needle) => act(() => { buttonWith(t, needle).props.onClick(); });

describe("StockAuditView", () => {
  it("opens on the hub tab and names the answer, the shelf and what the hub believed", () => {
    SUBSCRIBED.length = 0;
    const t = mount();
    const s = text(t);
    expect(s).toContain("Air Force 1 White");
    expect(s).toContain("Hub 1");
    expect(s).toContain("Sold out");
    expect(s).toContain("system");
    expect(s).toContain("2 customers");
    // the row already actioned today is gone
    expect(s).not.toContain("Timberland");
  });

  it("reads only the selected hub's snapshot and today's results", () => {
    SUBSCRIBED.length = 0;
    mount();
    expect([...new Set(SUBSCRIBED)]).toEqual([
      "settings/stockAudit/hub/hub1/latest",
      "settings/stockAudit/hub/hub1/results/2026-09-07",
    ]);
    for (const forbidden of ["stock", "products", "stock_movements", "orders", "insights_log", "locations", "displayChecks_active"]) {
      expect(SUBSCRIBED.some((p) => p === forbidden || p.startsWith(`${forbidden}/`))).toBe(false);
    }
  });

  it("the chip row is HUBS on the hub tab and SHOPS on the rotation tab", () => {
    const t = mount();
    expect(buttonWith(t, "Hub 1")).toBeTruthy();
    expect(buttonWith(t, "Hub 3")).toBeTruthy();
    expect(buttonWith(t, "Marathon PE")).toBeUndefined();

    tap(t, "Not Selling");
    expect(buttonWith(t, "Marathon PE")).toBeTruthy();
    expect(buttonWith(t, "Trophy")).toBeTruthy();
    expect(buttonWith(t, "Hub 3")).toBeUndefined();
  });

  it("the hub chip switches which snapshot is read", () => {
    const t = mount();
    SUBSCRIBED.length = 0;
    tap(t, "Hub 2");
    expect(SUBSCRIBED).toContain("settings/stockAudit/hub/hub2/latest");
    expect(text(t)).toContain("Hub Two Shoe");
  });

  it("switching tabs switches the subscription, never holding both", () => {
    const t = mount();
    SUBSCRIBED.length = 0;
    tap(t, "Not Selling");
    expect(SUBSCRIBED).toContain("settings/stockAudit/marathon-pe/latest");
    expect(SUBSCRIBED.some((p) => p.includes("/hub/"))).toBe(false);
  });

  it("Not Selling lists the batch without a No-sale badge on every row", () => {
    // Every line here is already a line that has not sold in three weeks — that
    // is what put it in the batch — so the badge would say nothing.
    const t = mount();
    tap(t, "Not Selling");
    const s = text(t);
    expect(s).toContain("Nike Tee Black");
    expect(s).toContain("Puma Shorts");
    expect(s).not.toContain("No sale");
    expect(s).not.toContain("No display");
    expect(s).toContain("Slow");            // the settled slow mover, not re-raised

    tap(t, "Sizes");
    expect(text(t)).toContain("Nike Tee Black");
  });

  it("the SIZE view reads; only the product view acts", () => {
    const t = mount();
    tap(t, "Not Selling");
    expect(buttonWith(t, "Present but slow")).toBeTruthy();
    tap(t, "Sizes");
    expect(buttonWith(t, "Present but slow")).toBeUndefined();
    expect(buttonWith(t, "Not there")).toBeUndefined();
  });

  it("a walked batch says it is done, not that there was nothing to do", () => {
    const t = mount();
    tap(t, "Not Selling");
    tap(t, "Trophy");
    const s = text(t);
    expect(s).toContain("Batch done");
    expect(s).toContain("30 checked");
    expect(s).not.toContain("Nothing to check");
  });

  it("a list that is not today's says which day it was built", () => {
    const t = mount();
    expect(text(t)).not.toContain("Built ");     // hub1's list is today's
    tap(t, "Not Selling");
    tap(t, "Trophy");                            // Trophy's is three days old
    expect(text(t)).toContain("Built 2026-09-04");
  });

  it("Out of Stock offers the three outcomes, and the quantity box only on Adjust", () => {
    const t = mount();
    expect(buttonWith(t, "Confirmed empty")).toBeTruthy();
    expect(buttonWith(t, "Flag")).toBeTruthy();
    expect(t.root.findAllByType("input")).toHaveLength(0);
    tap(t, "Adjust");
    expect(t.root.findAllByType("input")).toHaveLength(1);
  });

  it("waits for the results read before offering a list", () => {
    READ.settled = false;
    try {
      const t = mount();
      expect(text(t)).toContain("Loading");
      expect(text(t)).not.toContain("Air Force 1 White");
    } finally { READ.settled = true; }
  });

  it("an unreadable results node shows the rows but refuses to act on them", () => {
    READ.error = true;
    try {
      const t = mount();
      const s = text(t);
      expect(s).toContain("may show work already done");
      expect(s).toContain("Air Force 1 White");
      expect(buttonWith(t, "Confirmed empty").props.disabled).toBe(true);
      expect(buttonWith(t, "Adjust").props.disabled).toBe(true);
    } finally { READ.error = false; }
  });

  it("a hub with nothing to check says so plainly, rather than spinning", () => {
    const t = mount();
    tap(t, "Hub 3");
    expect(text(t)).toContain("Nothing to check");
  });

  it("the results day follows SA midnight instead of freezing at mount", () => {
    vi.useFakeTimers();
    try {
      SUBSCRIBED.length = 0;
      let t;
      act(() => { t = TestRenderer.create(<StockAuditView onExit={() => {}} />); });
      expect(SUBSCRIBED).toContain("settings/stockAudit/hub/hub1/results/2026-09-07");
      SUBSCRIBED.length = 0;
      NOW_MS.v = Date.parse("2026-09-08T01:00:00.000Z");
      act(() => { vi.advanceTimersByTime(14 * 3600e3); });
      expect(SUBSCRIBED).toContain("settings/stockAudit/hub/hub1/results/2026-09-08");
    } finally { vi.useRealTimers(); NOW_MS.v = Date.parse("2026-09-07T09:00:00.000Z"); }
  });
});

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
  "settings/stockAudit/marathon-pe/latest": {
    store: "marathon-pe", saDate: "2026-09-07", displaySignal: "ok",
    oos: {
      total: 2, truncated: false,
      rows: [
        { k: "a__L__hub2", p: "a", n: "Nike Tee Black", s: "L", sk: "L", w: "hub2", q: 7, r: "rejected" },
        { k: "b__M__marathon-pe", p: "b", n: "Adidas Hoodie", s: "M", sk: "M", w: "marathon-pe", q: -2, r: "negative_cell" },
      ],
    },
    rotation: {
      batchDate: "2026-09-07", refreshed: true, universeSize: 90, cycleBatches: 3,
      rows: [
        { p: "a", n: "Nike Tee Black", sold: false, disp: false, slow: false, last: null,
          z: [{ s: "S", sk: "S", q: 4, sold: false, disp: false }, { s: "M", sk: "M", q: 1, sold: true, disp: false }] },
        { p: "c", n: "Puma Shorts", sold: true, disp: true, slow: true, last: 1, z: [{ s: "L", sk: "L", q: 2, sold: true, disp: true }] },
      ],
    },
  },
  "settings/stockAudit/trophy/latest": {
    store: "trophy", saDate: "2026-09-04",
    oos: { total: 1, truncated: false, rows: [{ k: "z__S__central", p: "z", n: "Trophy Only Tee", s: "S", sk: "S", w: "central", q: 0, r: "unfillable" }] },
    rotation: { batchDate: "2026-09-07", refreshed: true, universeSize: 10, cycleBatches: 1, rows: [] },
  },
  // one row already actioned today — it must not come back
  "settings/stockAudit/marathon-pe/results/2026-09-07": { "b__M__marathon-pe": { outcome: "confirmed_empty" } },
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
  it("opens on Out of Stock for Marathon PE and names the place and the believed quantity", () => {
    SUBSCRIBED.length = 0;
    const t = mount();
    const s = text(t);
    expect(s).toContain("Nike Tee Black");
    expect(s).toContain("Hub 2");
    expect(s).toContain("system");
    expect(s).toContain("Rejected");
    // the row already actioned today is gone
    expect(s).not.toContain("Adidas Hoodie");
  });

  it("reads only the selected store's snapshot and today's results", () => {
    SUBSCRIBED.length = 0;
    mount();
    expect([...new Set(SUBSCRIBED)]).toEqual([
      "settings/stockAudit/marathon-pe/latest",
      "settings/stockAudit/marathon-pe/results/2026-09-07",
    ]);
    for (const forbidden of ["stock", "products", "stock_movements", "refill_requests", "insights_log", "locations"]) {
      expect(SUBSCRIBED.some((p) => p === forbidden || p.startsWith(`${forbidden}/`))).toBe(false);
    }
  });

  it("the store chip switches which snapshot is read", () => {
    const t = mount();
    SUBSCRIBED.length = 0;
    tap(t, "Trophy");
    expect(SUBSCRIBED).toContain("settings/stockAudit/trophy/latest");
    expect(text(t)).toContain("Trophy Only Tee");
    expect(text(t)).toContain("Central");
  });

  it("Not Selling shows the two signals as their absence, in both views", () => {
    const t = mount();
    tap(t, "Not Selling");
    let s = text(t);
    expect(s).toContain("Nike Tee Black");
    expect(s).toContain("No sale");
    expect(s).toContain("No display");
    expect(s).toContain("Slow");              // the settled slow mover, not re-raised as a problem
    expect(s).toContain("Puma Shorts");

    tap(t, "Sizes");
    s = text(t);
    expect(s).toContain("Nike Tee Black");
    expect(s).toContain("Puma Shorts");
  });

  it("the SIZE view reads; only the product view acts", () => {
    // A rotation stamp is per PRODUCT, so a per-size outcome would mark sizes
    // nobody looked at as freshly checked and starve them for a full cycle.
    const t = mount();
    tap(t, "Not Selling");
    expect(buttonWith(t, "Present but slow")).toBeTruthy();
    expect(buttonWith(t, "Not on display")).toBeTruthy();

    tap(t, "Sizes");
    expect(buttonWith(t, "Present but slow")).toBeUndefined();
    expect(buttonWith(t, "Not on display")).toBeUndefined();
    expect(buttonWith(t, "Not there")).toBeUndefined();
    // still a read of the same batch
    expect(text(t)).toContain("No sale");
  });

  it("a list that is not today's says which day it was built", () => {
    // The pass rides on refillHealthScan, which stands down entirely while the
    // engine is off or Central is receiving — so a list can be days old, and
    // silence about that is the lie.
    const t = mount();
    expect(text(t)).not.toContain("Built ");    // Marathon PE's list is today's
    tap(t, "Trophy");                          // Trophy's is three days old
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

  it("a DARK display signal is not drawn as 'No display' on every row", () => {
    // Trophy's snapshot has no displaySignal at all (an older write) — known.
    // Marathon PE's is flipped to unavailable here: the pass could not read the
    // registrations, so every `disp` is false and the pill would put a finding
    // on every row in the batch. Half of Tab B's purpose is telling
    // no-sale-with-a-display from no-sale-without one; inventing the answer is
    // worse than not showing it.
    const pe = SNAPSHOTS["settings/stockAudit/marathon-pe/latest"];
    const was = pe.displaySignal;
    pe.displaySignal = "unavailable";
    try {
      const t = mount();
      tap(t, "Not Selling");
      const s = text(t);
      expect(s).toContain("Display registrations could not be read.");
      expect(s).not.toContain("No display");
      expect(s).toContain("No sale");            // the signal that IS known still shows
    } finally { pe.displaySignal = was; }
  });

  it("waits for the results read before offering a list", () => {
    // "Not answered yet" is not "nothing has been done today". Showing the list
    // early would bring back rows staff already closed.
    READ.settled = false;
    try {
      const t = mount();
      expect(text(t)).toContain("Loading");
      expect(text(t)).not.toContain("Nike Tee Black");
    } finally { READ.settled = true; }
  });

  it("an unreadable results node shows the rows but refuses to act on them", () => {
    READ.error = true;
    try {
      const t = mount();
      const s = text(t);
      expect(s).toContain("may show work already done");
      expect(s).toContain("Nike Tee Black");                    // still informative
      expect(buttonWith(t, "Confirmed empty").props.disabled).toBe(true);
      expect(buttonWith(t, "Adjust").props.disabled).toBe(true);
      expect(buttonWith(t, "Flag").props.disabled).toBe(true);
    } finally { READ.error = false; }
  });

  it("the results day follows SA midnight instead of freezing at mount", () => {
    // A shop tablet left on the counter overnight would otherwise keep reading
    // AND WRITING yesterday's results node all morning.
    vi.useFakeTimers();
    try {
      SUBSCRIBED.length = 0;
      let t;
      act(() => { t = TestRenderer.create(<StockAuditView onExit={() => {}} />); });
      expect(SUBSCRIBED).toContain("settings/stockAudit/marathon-pe/results/2026-09-07");
      SUBSCRIBED.length = 0;
      // serverNowMs is mocked at 2026-09-07T09:00Z = 11:00 SAST; SA midnight is
      // 13 hours away.
      NOW_MS.v = Date.parse("2026-09-08T01:00:00.000Z");        // 03:00 SAST, next day
      act(() => { vi.advanceTimersByTime(14 * 3600e3); });
      expect(SUBSCRIBED).toContain("settings/stockAudit/marathon-pe/results/2026-09-08");
    } finally { vi.useRealTimers(); NOW_MS.v = Date.parse("2026-09-07T09:00:00.000Z"); }
  });

  it("says so plainly when there is nothing, rather than spinning", () => {
    const t = mount();
    tap(t, "Trophy");
    tap(t, "Not Selling");
    expect(text(t)).toContain("Nothing to check");
  });
});

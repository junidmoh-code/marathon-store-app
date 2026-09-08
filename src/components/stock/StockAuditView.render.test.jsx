// ─── STOCK AUDIT — THROUGH THE REAL COMPONENT ────────────────────────────────
// Mounts the whole screen over a faked snapshot: both tabs, both chip rows, the
// single action, the photos. The failure this exists to catch is the one a unit
// test cannot — a dangling identifier that kills the route on first open and
// that nothing MOUNTING the view would notice.
//
// It also pins the promises the screen makes: it reads ONE node per scope plus
// that day's results and nothing else, an actioned row does not come back, and
// there is exactly one button on a row.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const SUBSCRIBED = [];

vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "u1" } } }));
vi.mock("firebase/database", () => ({ ref: () => ({}), onValue: () => () => {} }));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: () => () => {} }));
const NOW_MS = { v: Date.parse("2026-09-07T09:00:00.000Z") };
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => NOW_MS.v }));
const WRITES = [];
vi.mock("./stockAuditStore", () => ({
  markHubRowFixed: async (a) => { WRITES.push(["hub", a.hub, a.row.k]); return { ok: true }; },
  markRotationRowFixed: async (a) => { WRITES.push(["shop", a.store, a.row.p]); return { ok: true }; },
}));

const SNAPSHOTS = {
  "settings/stockAudit/hub/hub1/latest": {
    hub: "hub1", saDate: "2026-09-07",
    oos: {
      total: 2, truncated: false,
      rows: [
        { k: "a__9__hub1", p: "a", n: "Air Force 1 White", s: "9", sk: "9", w: "hub1", q: 3, r: "out_of_stock", c: 2 },
        { k: "b__7__hub1", p: "b", n: "Timberland Motion 6", s: "7", sk: "7", w: "hub1", q: 0, r: "coming_tomorrow", c: 1 },
      ],
    },
  },
  "settings/stockAudit/hub/hub2/latest": {
    hub: "hub2", saDate: "2026-09-07",
    oos: { total: 1, truncated: false, rows: [{ k: "z__11__hub2", p: "z", n: "Hub Two Shoe", s: "11", sk: "11", w: "hub2", q: 0, r: "out_of_stock", c: 1 }] },
  },
  // one row already actioned today — it must not come back
  "settings/stockAudit/hub/hub1/results/2026-09-07": { "b__7__hub1": { outcome: "fixed" } },

  "settings/stockAudit/marathon-pe/latest": {
    store: "marathon-pe", saDate: "2026-09-07",
    rotation: {
      batchDate: "2026-09-07", refreshed: true, universeSize: 641, cycleBatches: 22, walked: 0, batchSize: 2,
      rows: [
        { p: "a", n: "Nike Tee Black", slow: false, last: null, z: [{ s: "S", sk: "S", q: 4 }, { s: "M", sk: "M", q: 1 }] },
        { p: "c", n: "Puma Shorts", slow: true, last: 1, z: [{ s: "L", sk: "L", q: 2 }] },
      ],
    },
  },
  "settings/stockAudit/trophy/latest": {
    store: "trophy", saDate: "2026-09-04",
    rotation: { batchDate: "2026-09-02", refreshed: false, universeSize: 466, cycleBatches: 16, rows: [], walked: 30, batchSize: 30 },
  },
};

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

const PRODUCTS = [
  { id: "a", name: "Air Force 1 White", photoUrl: "https://example.test/a.jpg" },
  { id: "c", name: "Puma Shorts", photo: "https://example.test/c.jpg" },
  // "z" deliberately absent — a merged or renamed product still has to render
];

const instText = (inst) => (typeof inst === "string" ? inst : (inst?.children || []).map(instText).join(""));
const buttonWith = (t, needle) => t.root.findAllByType("button").find((b) => instText(b).includes(needle));
const buttonsWith = (t, needle) => t.root.findAllByType("button").filter((b) => instText(b).includes(needle));
const text = (t) => JSON.stringify(t.toJSON());
const mount = () => { let t; act(() => { t = TestRenderer.create(<StockAuditView onExit={() => {}} products={PRODUCTS} />); }); return t; };
const tap = (t, needle) => act(() => { buttonWith(t, needle).props.onClick(); });

describe("StockAuditView", () => {
  it("opens on the hub tab: one line carrying the answer, the size, and what the hub believed", () => {
    const t = mount();
    const s = text(t);
    expect(s).toContain("Air Force 1 White");
    expect(s).toContain("Sold out");
    expect(s).toContain("Hub 1 says 3");
    expect(s).toContain("2 customers");
    expect(s).not.toContain("Timberland");      // already actioned today
  });

  it("shows the product photo, from the list App already streams", () => {
    const t = mount();
    const imgs = t.root.findAllByType("img");
    expect(imgs.map((i) => i.props.src)).toContain("https://example.test/a.jpg");
  });

  it("a product with no record still renders — it just has no picture", () => {
    const t = mount();
    tap(t, "Hub 2");
    expect(text(t)).toContain("Hub Two Shoe");
    expect(t.root.findAllByType("img")).toHaveLength(0);
  });

  it("HUB 3 IS NOT OFFERED", () => {
    const t = mount();
    expect(buttonWith(t, "Hub 1")).toBeTruthy();
    expect(buttonWith(t, "Hub 2")).toBeTruthy();
    expect(buttonWith(t, "Hub 3")).toBeUndefined();
  });

  it("the second tab is AUDIT, and its chips are the two shops", () => {
    const t = mount();
    expect(buttonWith(t, "Audit")).toBeTruthy();
    expect(buttonWith(t, "Not Selling")).toBeUndefined();
    tap(t, "Audit");
    expect(buttonWith(t, "Marathon PE")).toBeTruthy();
    expect(buttonWith(t, "Trophy")).toBeTruthy();
    expect(buttonWith(t, "Hub 1")).toBeUndefined();
  });

  it("ONE action per row, and it says Fixed", () => {
    const t = mount();
    expect(buttonsWith(t, "Fixed")).toHaveLength(1);      // one visible row
    for (const gone of ["Confirmed empty", "Adjust", "Flag", "Present", "Not there", "Not on display", "slow —"]) {
      expect(buttonWith(t, gone)).toBeUndefined();
    }
    expect(t.root.findAllByType("input")).toHaveLength(0);   // no quantity box anywhere
  });

  it("there is no product/size toggle — the size is on the line", () => {
    const t = mount();
    tap(t, "Audit");
    expect(buttonWith(t, "Sizes")).toBeUndefined();
    expect(buttonWith(t, "Products")).toBeUndefined();
    const s = text(t);
    expect(s).toContain("Nike Tee Black");
    // formatSize is the app's own clothing labelling ("S" -> "S-30"), so the
    // line reads the way every other screen reads.
    expect(s).toContain("S-30 4");
    expect(s).toContain("M-32 1");
    expect(s).toContain("slow");
  });

  it("Fixed writes for the row that was tapped, on the scope that is up", async () => {
    WRITES.length = 0;
    const t = mount();
    await act(async () => { buttonWith(t, "Fixed").props.onClick(); });
    expect(WRITES).toEqual([["hub", "hub1", "a__9__hub1"]]);

    tap(t, "Audit");
    WRITES.length = 0;
    await act(async () => { buttonsWith(t, "Fixed")[1].props.onClick(); });
    expect(WRITES).toEqual([["shop", "marathon-pe", "c"]]);
  });

  it("reads one node per scope plus that day's results, and nothing else", () => {
    SUBSCRIBED.length = 0;
    mount();
    expect([...new Set(SUBSCRIBED)]).toEqual([
      "settings/stockAudit/hub/hub1/latest",
      "settings/stockAudit/hub/hub1/results/2026-09-07",
    ]);
    for (const forbidden of ["stock", "products", "stock_movements", "orders", "insights_log", "locations"]) {
      expect(SUBSCRIBED.some((p) => p === forbidden || p.startsWith(`${forbidden}/`))).toBe(false);
    }
  });

  it("switching tabs switches the subscription, never holding both", () => {
    const t = mount();
    SUBSCRIBED.length = 0;
    tap(t, "Audit");
    expect(SUBSCRIBED).toContain("settings/stockAudit/marathon-pe/latest");
    expect(SUBSCRIBED.some((p) => p.includes("/hub/"))).toBe(false);
  });

  it("a walked batch says it is done, not that there was nothing to do", () => {
    const t = mount();
    tap(t, "Audit");
    tap(t, "Trophy");
    const s = text(t);
    expect(s).toContain("Batch done");
    expect(s).toContain("30 checked");
    expect(s).not.toContain("Nothing to check");
  });

  it("a list that is not today's says which day it was built", () => {
    const t = mount();
    expect(text(t)).not.toContain("Built ");
    tap(t, "Audit");
    tap(t, "Trophy");
    expect(text(t)).toContain("Built 2026-09-04");
  });

  it("waits for the results read, and will not act on one it could not make", () => {
    READ.settled = false;
    try {
      const t = mount();
      expect(text(t)).toContain("Loading");
      expect(text(t)).not.toContain("Air Force 1 White");
    } finally { READ.settled = true; }

    READ.error = true;
    try {
      const t = mount();
      expect(text(t)).toContain("may show work already done");
      expect(text(t)).toContain("Air Force 1 White");        // still informative
      expect(buttonWith(t, "Fixed").props.disabled).toBe(true);
    } finally { READ.error = false; }
  });

  it("the results day follows SA midnight instead of freezing at mount", () => {
    vi.useFakeTimers();
    try {
      SUBSCRIBED.length = 0;
      let t;
      act(() => { t = TestRenderer.create(<StockAuditView onExit={() => {}} products={PRODUCTS} />); });
      expect(SUBSCRIBED).toContain("settings/stockAudit/hub/hub1/results/2026-09-07");
      SUBSCRIBED.length = 0;
      NOW_MS.v = Date.parse("2026-09-08T01:00:00.000Z");
      act(() => { vi.advanceTimersByTime(14 * 3600e3); });
      expect(SUBSCRIBED).toContain("settings/stockAudit/hub/hub1/results/2026-09-08");
    } finally { vi.useRealTimers(); NOW_MS.v = Date.parse("2026-09-07T09:00:00.000Z"); }
  });

  it("NO ORANGE anywhere on the screen", () => {
    // Owner, 2026-09-08. Amber was the tone for "Tomorrow", the staleness note
    // and the slow badge; the palette is now white, one grey, one accent and a
    // single alert red.
    const t = mount();
    const painted = [text(t)];
    tap(t, "Audit");
    painted.push(text(t));
    for (const s of painted) {
      expect(s.toUpperCase()).not.toContain("FBBF24");
      expect(s).not.toMatch(/251\s*,\s*191\s*,\s*36/);
      expect(s.toLowerCase()).not.toContain("orange");
    }
  });
});

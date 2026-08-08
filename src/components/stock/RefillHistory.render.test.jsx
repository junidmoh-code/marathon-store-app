// ─── REFILL HISTORY — END TO END THROUGH THE REAL COMPONENT (redo 2026-08-08) ─
// refillHistoryCore.test.js pins the pure row-building and stepper maths. This
// renders the actual view against faked RTDB reads and proves the new controls
// all the way to the screen:
//
//   • the DAY STEPPER moves exactly one day per press and cannot pass today;
//   • the HUB STEPPER cycles All / Hub 1 / Hub 2 / Shops;
//   • every STATUS TAB opens its own rows (rejections carry reason + person,
//     Queued is the release-window split of the open set);
//   • every read stays INDEX-BOUNDED — never a whole-node read. On a project
//     already billed hundreds of dollars for one unindexed read, that is the
//     assertion worth having.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// SA 2026-08-07 12:00 = 10:00Z. Default windows 06:00/14:00 SA → the last
// release was 06:00 SA (04:00Z); an open request raised after it is QUEUED.
const NOW = Date.parse("2026-08-07T10:00:00.000Z");

// The mock keeps the QUERY, not just the path — a mock that drops
// orderByChild/startAt/endBefore cannot tell a bounded read from a whole-node
// one. It deliberately does NOT export `endAt` (an inclusive bound must fail
// to resolve, not slip in unnoticed).
const reads = {};
const readCalls = [];
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  query: (r, ...constraints) => ({ ...r, constraints }),
  orderByChild: (field) => ({ kind: "orderByChild", field }),
  startAt: (value) => ({ kind: "startAt", value }),
  endBefore: (value) => ({ kind: "endBefore", value }),
  equalTo: (value) => ({ kind: "equalTo", value }),
  get: (r) => { readCalls.push(r); return Promise.resolve({ val: () => reads[r.path] ?? null }); },
  onValue: (r, cb) => { cb({ val: () => reads[r.path] ?? null }); return () => {}; },
}));
const callsTo = (path) => readCalls.filter((r) => r.path === path);
const constraintsOf = (r) => Object.fromEntries((r.constraints || []).map((c) => [c.kind, c.kind === "orderByChild" ? c.field : c.value]));
const isBacklogQuery = (r) => (r.constraints || []).some((c) => c.kind === "equalTo");
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
// Mutable clock: the release-boundary test moves it forward and lets the
// component's own minute ticker pick the new instant up.
const clock = { now: NOW };
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => clock.now, serverNowIso: () => new Date(clock.now).toISOString() }));

const { default: RefillHistory } = await import("./RefillHistory.jsx");

const PRODUCTS = [
  { id: "boot", name: "Timberland Premium 6-Inch Wheat", photoUrl: null },
  { id: "tee", name: "Essentials tracksuit olive khaki", photoUrl: null },
  { id: "cap", name: "New Era 9Forty Navy", photoUrl: null },
];

const textOf = (n) => {
  if (n == null || n === false) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  return textOf(n.children);
};
async function mount() {
  let tree;
  await act(async () => { tree = TestRenderer.create(<RefillHistory products={PRODUCTS} />); });
  await act(async () => {});
  return tree;
}
const byAria = (tree, label) => tree.root.findAll((n) => n.type === "button" && n.props["aria-label"] === label)[0];
const clickAria = async (tree, label) => { await act(async () => { byAria(tree, label).props.onClick(); }); await act(async () => {}); };
const clickTab = async (tree, label) => {
  const btn = tree.root.findAll((n) => n.type === "button" && n.props.role === "tab" && textOf(n.props.children).startsWith(label))[0];
  await act(async () => { btn.props.onClick(); });
  await act(async () => {});
};

beforeEach(() => {
  for (const k of Object.keys(reads)) delete reads[k];
  readCalls.length = 0;
  clock.now = NOW;
  reads["config/refillEngine"] = null;   // default windows
  reads["refill_requests"] = {
    // OPEN, raised before today's 06:00 release → the Open tab.
    openA: {
      productId: "boot", size: "7", qty: 2, requestingLocation: "hub1", status: "open",
      createdAt: "2026-08-07T03:00:00.000Z", createdFrom: { source: "central", via: "missing_sneakers" },
    },
    // OPEN, raised AFTER the release → the Queued tab.
    queuedA: {
      productId: "cap", size: "M", qty: 1, requestingLocation: "hub1", status: "open",
      createdAt: "2026-08-07T05:00:00.000Z", createdFrom: { manual: true, source: "central" },
    },
    // REJECTED yesterday by a human — no cancelReason, role + uid.
    rej: {
      productId: "boot", size: "7", qty: 3, requestingLocation: "hub1", status: "cancelled",
      createdAt: "2026-08-06T08:00:00.000Z", resolvedAt: "2026-08-06T12:00:00.000Z",
      rejectedBy: "warehouse", resolvedBy: "vWfHqbLEPvRMItXhH0B9NvYW0LG3",
      createdFrom: { source: "central", via: "missing_sneakers" },
    },
    // Engine self-withdrawal yesterday, hub2.
    wdr: {
      productId: "tee", size: "M", qty: 2, requestingLocation: "hub2", status: "cancelled",
      cancelReason: "already_in_stock",
      createdAt: "2026-08-06T09:00:00.000Z", resolvedAt: "2026-08-06T10:00:00.000Z",
      createdFrom: { engine: true, source: "central" },
    },
  };
  reads["stock_movements"] = null;
});

describe("the DAY STEPPER — one day per press, never past today", () => {
  it("defaults to today; forward is disabled; back shows yesterday's rows", async () => {
    const tree = await mount();
    let out = textOf(tree.toJSON());
    expect(out).toContain("Today");
    expect(byAria(tree, "Next day").props.disabled).toBe(true);
    // yesterday's rejection is not on today's outcome tabs
    await clickTab(tree, "Rejected");
    expect(textOf(tree.toJSON())).toContain("Nothing under");

    await clickAria(tree, "Previous day");
    out = textOf(tree.toJSON());
    expect(out).toContain("Yesterday");
    expect(byAria(tree, "Next day").props.disabled).toBe(false);
    expect(textOf(tree.toJSON())).toContain("Timberland Premium 6-Inch Wheat");
    tree.unmount();
  });

  it("each press moves exactly ONE day, and forward re-disables at today", async () => {
    const tree = await mount();
    await clickAria(tree, "Previous day");
    await clickAria(tree, "Previous day");
    let out = textOf(tree.toJSON());
    expect(out).toContain("5 August");            // two presses = two days back
    await clickAria(tree, "Next day");
    out = textOf(tree.toJSON());
    expect(out).toContain("6 August");            // one forward = one day
    await clickAria(tree, "Next day");
    expect(byAria(tree, "Next day").props.disabled).toBe(true);   // back at today
    tree.unmount();
  });
});

describe("the STATUS TABS — each opens its own rows", () => {
  it("Open and Queued split the open set by the release windows", async () => {
    const tree = await mount();
    // Open tab (default): the pre-window request only
    let out = textOf(tree.toJSON());
    expect(out).toContain("Timberland Premium 6-Inch Wheat");
    expect(out).not.toContain("New Era 9Forty Navy");
    await clickTab(tree, "Queued");
    out = textOf(tree.toJSON());
    expect(out).toContain("New Era 9Forty Navy");
    expect(out).not.toContain("Timberland Premium 6-Inch Wheat");
    tree.unmount();
  });

  it("crossing a release instant re-buckets Queued → Open WITHOUT any user action", async () => {
    // 12:00 SA: queuedA (raised 07:00 SA) sits behind the 14:00 window. Leave
    // the screen alone, let the clock pass 14:00 SA, and the minute ticker
    // must move it to Open on its own (CodeRabbit, PR #337: a render-time
    // clock froze the buckets until the user changed day/hub/tab).
    vi.useFakeTimers();
    let tree;
    await act(async () => { tree = TestRenderer.create(<RefillHistory products={PRODUCTS} />); });
    await act(async () => {});
    await clickTab(tree, "Queued");
    expect(textOf(tree.toJSON())).toContain("New Era 9Forty Navy");

    clock.now = Date.parse("2026-08-07T12:01:00.000Z");   // 14:01 SA — past the release
    await act(async () => { vi.advanceTimersByTime(61_000); });
    expect(textOf(tree.toJSON())).not.toContain("New Era 9Forty Navy");   // left Queued…
    await clickTab(tree, "Open");
    expect(textOf(tree.toJSON())).toContain("New Era 9Forty Navy");       // …and landed in Open
    tree.unmount();
    vi.useRealTimers();
  });

  it("the Rejected tab shows product, size, qty, source→destination, time, actor AND the reason", async () => {
    const tree = await mount();
    await clickAria(tree, "Previous day");
    await clickTab(tree, "Rejected");
    const out = textOf(tree.toJSON());
    expect(out).toContain("Timberland Premium 6-Inch Wheat");
    expect(out).toContain("size 7");
    expect(out).toContain("×3");
    expect(out).toContain("Central");
    expect(out).toContain("Hub 1");
    expect(out).toContain("marked not available on the shelf");
    expect(out).toContain("warehouse");
    expect(out).toContain("vWfHqbL");
    // and ONLY its own rows — the engine withdrawal is not here
    expect(out).not.toContain("Essentials tracksuit olive khaki");
    tree.unmount();
  });

  it("the engine withdrawal lives under No longer needed, credited to the engine", async () => {
    const tree = await mount();
    await clickAria(tree, "Previous day");
    await clickTab(tree, "No longer needed");
    const out = textOf(tree.toJSON());
    expect(out).toContain("Essentials tracksuit olive khaki");
    expect(out).toContain("the destination already held enough");
    expect(out).toContain("Withdrawn by");
    expect(out).not.toContain("Timberland Premium 6-Inch Wheat");
    tree.unmount();
  });

  it("a person who fulfilled an engine-raised request is credited — never 'the engine'", async () => {
    reads["refill_requests"] = {
      staffPick: {
        productId: "tee", size: "M", qty: 2, requestingLocation: "hub2", status: "fulfilled",
        createdAt: "2026-08-06T08:00:00.000Z", resolvedAt: "2026-08-06T12:00:00.000Z",
        createdFrom: { engine: true, source: "central" },
        resolvedBy: "vWfHqbLEPvRMItXhH0B9NvYW0LG3",
      },
    };
    const tree = await mount();
    await clickAria(tree, "Previous day");
    await clickTab(tree, "Refilled");
    const out = textOf(tree.toJSON());
    expect(out).toContain("by staff");
    expect(out).toContain("vWfHqbL");
    expect(out).not.toContain("Withdrawn by");
    tree.unmount();
  });
});

describe("the HUB STEPPER — cycles All / Hub 1 / Hub 2 / Shops", () => {
  it("steps forward through the four stops and wraps back to All", async () => {
    const tree = await mount();
    const seq = [];
    for (let i = 0; i < 4; i++) {
      await clickAria(tree, "Next location");
      seq.push(textOf(tree.toJSON()).includes("Hub 1") ? null : null);
    }
    // after 4 presses we are back at All
    const out = textOf(tree.toJSON());
    expect(out).toContain("hubs and shops together");
    tree.unmount();
  });

  it("Hub 1 shows only Hub 1 rows; stepping BACK from All lands on Shops", async () => {
    const tree = await mount();
    await clickAria(tree, "Previous day");
    await clickTab(tree, "No longer needed");
    expect(textOf(tree.toJSON())).toContain("Essentials tracksuit olive khaki");  // hub2 row visible under All
    await clickAria(tree, "Next location");   // All → Hub 1
    const out = textOf(tree.toJSON());
    expect(out).not.toContain("Essentials tracksuit olive khaki");
    await clickAria(tree, "Previous location");   // Hub 1 → All
    await clickAria(tree, "Previous location");   // All → Shops (cyclic)
    expect(textOf(tree.toJSON())).toContain("Marathon PE · Trophy · Pine · Hub 3");
    tree.unmount();
  });
});

describe("BANDWIDTH — every read is index-bounded, never a whole node", () => {
  it("movements are read DATE-RANGED against the ts index", async () => {
    const tree = await mount(); tree.unmount();
    const mv = callsTo("stock_movements");
    expect(mv).toHaveLength(1);
    const c = constraintsOf(mv[0]);
    expect(c.orderByChild).toBe("ts");
    expect(c.startAt).toBe("2026-08-06T22:00:00.000Z");
    expect(c.endBefore).toBe("2026-08-07T22:00:00.000Z");
  });

  it("requests are read through THREE bounded index queries, NEVER as a whole node", async () => {
    const tree = await mount(); tree.unmount();
    const rr = callsTo("refill_requests");
    expect(rr).toHaveLength(3);
    const ranged = rr.filter((r) => !isBacklogQuery(r));
    expect(ranged.map((r) => constraintsOf(r).orderByChild).sort()).toEqual(["createdAt", "resolvedAt"]);
    for (const r of ranged) {
      const c = constraintsOf(r);
      expect(c.orderByChild, "an unordered read of this node is a full download").toBeTruthy();
      expect(c.startAt).toBe("2026-08-06T22:00:00.000Z");
      expect(c.endBefore).toBe("2026-08-07T22:00:00.000Z");
    }
    const backlog = rr.filter(isBacklogQuery);
    expect(backlog).toHaveLength(1);
    expect(constraintsOf(backlog[0]).orderByChild).toBe("resolvedAt");
    expect(constraintsOf(backlog[0]).equalTo).toBeNull();
    expect(rr.filter((r) => (r.constraints ?? []).length === 0)).toEqual([]);
  });

  it("stepping the day re-queries, and EVERY read across every day stays bounded", async () => {
    const tree = await mount();
    await clickAria(tree, "Previous day");
    await clickAria(tree, "Previous day");
    tree.unmount();
    expect(callsTo("refill_requests").length).toBeGreaterThan(3);
    expect(callsTo("stock_movements").length).toBeGreaterThan(1);
    for (const r of [...callsTo("refill_requests"), ...callsTo("stock_movements")]) {
      const c = constraintsOf(r);
      expect(c.orderByChild, `unbounded read of ${r.path}`).toBeTruthy();
      if (isBacklogQuery(r)) {
        expect(c.equalTo).toBeNull();
      } else {
        expect(typeof c.startAt).toBe("string");
        expect(typeof c.endBefore).toBe("string");
        const kinds = (r.constraints ?? []).map((x) => x.kind);
        expect(kinds, `${r.path} must not use an inclusive end bound`).not.toContain("endAt");
      }
    }
  });
});

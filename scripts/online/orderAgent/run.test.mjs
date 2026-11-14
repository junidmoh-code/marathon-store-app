// The order agent's run against the fake RTDB (nulls / empty arrays dropped, cold-cache txn pass) and an in-memory
// Jamie database. Nothing touches the network.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { fakeDb } from "../../shopify/onlineOrders/fakeDb.testutil.mjs";
import { runOrderAgent, summaryText, bundle } from "./run.mjs";
import { chaseQueueOver, CHASE_TABLE } from "./chaseQueue.mjs";

// vitest cannot resolve node:sqlite as an import (it strips the prefix); require reaches the built-in.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
let fetchGuard;
beforeEach(() => { fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("NETWORK IS FORBIDDEN IN TESTS"); }); });
afterEach(() => fetchGuard.mockRestore());

const T = (iso) => Date.parse(iso);
const NOW = T("2026-11-14T09:30:00Z"); // Sat 11:30 SAST
const handed = (pid) => ({ pid, size: "M", sizeKey: "M", qty: 1, title: pid, source: { status: "handed", locationId: "marathon-pe" } });

function world() {
  return {
    stock: { "marathon-pe": { GST: { XXL: { qty: 1, updatedAt: "2026-11-12T10:55:42Z", lastType: "transfer_out" } } }, hub2: { GST: { XXL: { qty: 2 } } } },
    online_reservations: { GST: { XXL: { 2085: { qty: 1, locs: { "marathon-pe": 1 } } } } },
    displayChecks_active: { trophy: { e1: { createdAt: T("2026-11-14T06:00:00Z") } }, concrete: { e2: { createdAt: T("2026-11-14T06:00:00Z") } } },
    online_orders: {
      2085: {
        shopifyName: "#2085", orderNumber: 2085, status: "needs_attention", attention: { kind: "walkin_override", at: T("2026-11-12T10:18:00Z") },
        lines: [handed("BEA"), { pid: "GST", size: "XXL", sizeKey: "XXL", qty: 1, title: "G star tee", routeGen: 2, source: { status: "needs_attention", locationId: "marathon-pe" } }],
      },
      2097: {
        shopifyName: "#2097", orderNumber: 2097, status: "picking",
        lines: [handed("A"), { pid: "CAP", size: "_", sizeKey: "_", qty: 1, title: "Cap", source: { status: "unavailable" } }],
        jimmyStatus: { 1: { pid: "CAP", state: "waiting_reply", offered: [{ name: "x" }], told: { at: NOW - 5 * 3600e3 } } },
      },
      2142: {
        shopifyName: "#2142", orderNumber: 2142, status: "picking",
        lines: [
          { pid: "D1", size: "L", sizeKey: "L", qty: 1, title: "Dress", source: { status: "display", locationId: "trophy", entryKey: "displayChecks_active/trophy/e1" } },
          { pid: "D2", size: "L", sizeKey: "L", qty: 1, title: "Top", source: { status: "display", locationId: "concrete", entryKey: "displayChecks_active/concrete/e2" } },
        ],
      },
      2150: { shopifyName: "#2150", orderNumber: 2150, status: "ready", lines: [handed("Z")] },
    },
  };
}
const rows = (q) => q._db.prepare(`SELECT id, kind, order_key, line_index, reason FROM ${CHASE_TABLE} ORDER BY id`).all();
const mkQueue = () => { const sqlite = new DatabaseSync(":memory:"); const q = chaseQueueOver(sqlite); q._db = sqlite; return q; };

describe("one committed run", () => {
  it("re-pick asked for #2085, Jamie asked to follow up #2097, both places nudged then Junid told once for #2142, every order stamped", async () => {
    const f = fakeDb(world());
    const q = mkQueue();
    const pushes = [];
    const push = async (p) => { pushes.push(p); return { sent: true, delivered: 1 }; };
    // 13:30 SAST: #2142's entries are 4.5 trading hours old → escalate (and no nudge: the 4 h step replaces it).
    const r = await runOrderAgent({ db: f.db, chase: q, push, now: T("2026-11-14T11:30:00Z"), commit: true });
    expect(r).toMatchObject({ checked: 4, green: 1, red: 3 });
    const rp = Object.values(f.read("online_orders/2085/agentRepicks"));
    expect(rp).toEqual([expect.objectContaining({ lineIndex: 1, expectStatus: "needs_attention", expectRouteGen: 2, state: "pending", by: "order-agent" })]);
    expect(rp[0].exclude).toBeUndefined(); // an empty list is dropped by RTDB; the poller reads it as none
    expect(rows(q).map((x) => x.kind).sort()).toEqual(["follow_up", "junid_escalation"]);
    const esc = rows(q).find((x) => x.kind === "junid_escalation");
    expect(esc.reason).toMatch(/^#2142: Dress size L has waited .* at Trophy .*; Top size L has waited .* at Concrete/);
    expect(f.read("online_orders/2150/agent")).toMatchObject({ group: "green", total: 1, here: 1 });
    expect(f.read("online_orders/2085/agent")).toMatchObject({ group: "red", reason: "Held item sold at the till — re-picking at Marathon PE", note: "re-pick at Marathon PE asked" });
    expect(f.read("online_order_agent/lastRun")).toMatchObject({ checked: 4, green: 1, red: 3 });
    expect(Object.values(f.read("online_order_agent/log/2026-11-14")).length).toBe(3);
    // Never a request, never stock.
    expect(f.writes.filter(([, p]) => /^(refill_requests|stock\/|orders\/)/.test(p))).toEqual([]);
  });

  it("a second run the same day repeats nothing", async () => {
    const f = fakeDb(world());
    const q = mkQueue();
    const at = T("2026-11-14T11:30:00Z");
    await runOrderAgent({ db: f.db, chase: q, now: at, commit: true });
    const n = rows(q).length;
    const r2 = await runOrderAgent({ db: f.db, chase: q, now: at + 15 * 60e3, commit: true });
    expect(rows(q).length).toBe(n);
    expect(r2.actions).toEqual([]);
    expect(Object.keys(f.read("online_orders/2085/agentRepicks")).length).toBe(1); // the pending one is not asked twice
  });

  it("a nudge at 2–4 trading hours goes once per place per order", async () => {
    const f = fakeDb(world());
    const pushes = [];
    await runOrderAgent({ db: f.db, chase: mkQueue(), push: async (p) => { pushes.push(p); return { sent: true }; }, now: T("2026-11-14T09:00:00Z"), commit: true });
    expect(pushes.map((p) => p.hub).sort()).toEqual(["concrete", "trophy"]);
    await runOrderAgent({ db: f.db, chase: mkQueue(), push: async (p) => { pushes.push(p); return { sent: true }; }, now: T("2026-11-14T09:15:00Z"), commit: true });
    expect(pushes.length).toBe(2);
  });

  it("a dry run writes nothing at all", async () => {
    const f = fakeDb(world());
    const q = mkQueue();
    const before = f.writes.length;
    const r = await runOrderAgent({ db: f.db, chase: q, now: T("2026-11-14T11:30:00Z"), commit: false });
    expect(r.actions.length).toBeGreaterThan(0);
    expect(f.writes.length).toBe(before);
    expect(rows(q)).toEqual([]);
  });

  it("from 18:00 the day's summary is queued for Junid once", async () => {
    const f = fakeDb(world());
    const q = mkQueue();
    const at = T("2026-11-14T16:05:00Z");
    const r = await runOrderAgent({ db: f.db, chase: q, now: at, commit: true });
    expect(r.summary).toMatch(/^Website orders, 2026-11-14 \(order agent\)\nTurned green: none\nShipped: none\nChased: /);
    expect(r.summary).toMatch(/Still red \(3\):\n- #2085: Held item sold at the till/);
    await runOrderAgent({ db: f.db, chase: q, now: at + 10 * 60e3, commit: true });
    expect(rows(q).filter((x) => x.kind === "daily_summary").length).toBe(1);
  });
});

describe("summary + bundling (pure)", () => {
  it("names green, shipped, chased and red", () => {
    const t = summaryText({ day: "2026-11-14", dayOrders: { a: { label: "#1", wasRed: true, group: "green", greenAt: 1 }, b: { label: "#2", endedAs: "shipped" } }, outcomes: [{ group: "red", label: "#3", reason: "Waiting for Hub 2" }], logToday: { repick: 2, nudge: 1 } });
    expect(t).toBe("Website orders, 2026-11-14 (order agent)\nTurned green: #1\nShipped: #2\nChased: 2 re-picks, 1 staff nudges\nStill red (1):\n- #3: Waiting for Hub 2");
  });
  it("one nudge per place, one escalation per order", () => {
    const order = { lines: [{ pid: "a" }, { pid: "b" }, { pid: "c" }] };
    const b = bundle([{ type: "nudge", i: 0, location: "hub2" }, { type: "nudge", i: 1, location: "hub2" }, { type: "escalate", i: 2 }, { type: "repick", i: 1 }], order);
    expect(b.map((a) => a.type)).toEqual(["nudge", "escalate", "repick"]);
    expect(b[0].items.map((x) => x.i)).toEqual([0, 1]);
  });
});

describe("architect review of #905 (run)", () => {
  it("a refund of 1 unit on a Shopify line split over two app lines closes only one of them", async () => {
    const { refundCoverage } = await import("./run.mjs");
    const order = { lines: [{ shopifyLineItemId: "gid://shopify/LineItem/9", qty: 1, source: { status: "display" } }, { shopifyLineItemId: "gid://shopify/LineItem/9", qty: 1, source: { status: "pick" } }] };
    expect(Object.keys(refundCoverage(order, { byLine: { 9: { at: 1, cents: 100, qty: 1 } } }))).toEqual(["0"]);
    expect(Object.keys(refundCoverage(order, { byLine: { 9: { at: 1, cents: 200, qty: 2 } } }))).toEqual(["0", "1"]);
  });
  it("without Jamie's database an escalation is not marked done (it is asked again next run)", async () => {
    const f = fakeDb(world());
    const none = { available: false, insert: () => false, exists: () => false, todayCounts: () => null };
    await runOrderAgent({ db: f.db, chase: none, now: T("2026-11-14T11:30:00Z"), commit: true });
    const marks = f.read("online_order_agent/marks/2142") || {};
    expect(Object.keys(marks).filter((k) => k.startsWith("escalate"))).toEqual([]);
  });
  it("per-run caps hold nudges to 5", async () => {
    const w = world();
    for (let n = 0; n < 8; n++) w.online_orders[`9${n}`] = { shopifyName: `#9${n}`, status: "picking", lines: [{ pid: `P${n}`, size: "L", sizeKey: "L", qty: 1, title: "x", source: { status: "pick", locationId: "hub2", entryKey: "displayChecks_active/trophy/e1" } }] };
    const f = fakeDb(w);
    const pushes = [];
    await runOrderAgent({ db: f.db, chase: mkQueue(), push: async (p) => { pushes.push(p); return { sent: true }; }, now: T("2026-11-14T09:00:00Z"), commit: true });
    expect(pushes.length).toBe(5);
  });
});

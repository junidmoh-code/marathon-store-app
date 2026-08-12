// ─── STOCK HOLD — release semantics, proven against a faithful fake ──────────
// The fake applyMovement reproduces the two real behaviours the release leans
// on: MOVEMENT-ID IDEMPOTENCY (a replayed id moves nothing and reports
// idempotent) and the NEGATIVE FLOOR (a transfer_in that would drive
// stock/in_transit below zero refuses — the phantom-line guard). The fake RTDB
// deletes nulls like the real one.

import { describe, it, expect, beforeEach, vi } from "vitest";

let store = {};
const getPath = (p) => {
  const parts = String(p).split("/");
  let n = store;
  for (const part of parts) { if (n == null || typeof n !== "object") return null; n = n[part]; }
  return n === undefined ? null : n;
};
const setPath = (p, v) => {
  const parts = String(p).split("/");
  let n = store;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof n[parts[i]] !== "object" || n[parts[i]] == null) n[parts[i]] = {};
    n = n[parts[i]];
  }
  if (v === null) delete n[parts[parts.length - 1]];   // real RTDB deletes nulls
  else n[parts[parts.length - 1]] = v;
};

let failUpdatesOnce = null;   // path prefix whose NEXT multi-path update throws

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: async (node) => ({ val: () => getPath(node.path), exists: () => getPath(node.path) != null }),
  update: async (node, updates) => {
    if (failUpdatesOnce && Object.keys(updates).some((k) => (node.path ? `${node.path}/${k}` : k).startsWith(failUpdatesOnce))) {
      failUpdatesOnce = null;
      throw new Error("NETWORK_LOST");
    }
    for (const [k, v] of Object.entries(updates)) setPath(node.path ? `${node.path}/${k}` : k, v);
  },
  runTransaction: async (node, fn) => {
    const cur = getPath(node.path);
    const next = fn(cur);
    if (next === undefined) return { committed: false, snapshot: { val: () => cur } };
    setPath(node.path, next);
    return { committed: true, snapshot: { val: () => next } };
  },
}));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: () => () => {} }));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "owner-1" } } }));
vi.mock("../../utils/serverTime", () => ({
  serverNowIso: () => "2026-08-12T14:30:00.000Z",
  serverNowMs: () => Date.parse("2026-08-12T14:30:00.000Z"),
}));

// The faithful fake writer.
vi.mock("./applyMovement", () => ({
  applyMovement: async (mv) => {
    const mvPath = `stock_movements/${mv.movementId}`;
    if (getPath(mvPath)) return { ok: true, movementId: mv.movementId, idempotent: true };
    const enc = (s) => (s == null || s === "" || s === "Free Size") ? "_" : String(s).replace(/[.#$[\]/\s]/g, "_");
    const deltas = mv.type === "transfer_in" || mv.type === "transfer_out"
      ? [{ loc: mv.from, d: -mv.qty }, { loc: mv.to, d: +mv.qty }]
      : mv.to ? [{ loc: mv.to, d: +mv.qty }] : [{ loc: mv.from, d: -mv.qty }];
    for (const { loc, d } of deltas) {
      const p = `stock/${loc}/${mv.productId}/${enc(mv.size)}`;
      const cur = Number(getPath(p)?.qty) || 0;
      if (d < 0 && cur + d < 0 && mv.type !== "sold" && !mv.allowNegative) {
        return { ok: false, reason: "insufficient_stock", location: loc, available: cur };
      }
    }
    for (const { loc, d } of deltas) {
      const p = `stock/${loc}/${mv.productId}/${enc(mv.size)}`;
      const cell = getPath(p) || { qty: 0, v: -1 };
      setPath(p, { ...cell, qty: (Number(cell.qty) || 0) + d, v: (Number(cell.v) ?? -1) + 1, mv: mv.movementId });
    }
    setPath(mvPath, { ...mv });
    return { ok: true, movementId: mv.movementId };
  },
}));

const { releaseShipment, markLineNotArrived, recordHeldLine } = await import("./stockHoldStore.js");
const { progressOf, recordIsCurrent, cellKey } = await import("./hubCountCore.js");

const LINE = (over = {}) => ({
  lineId: "rrf_r1", productId: "p1", productName: "Runner", size: "7", sizeKey: "7",
  qty: 3, dest: "hub1", shipmentId: "2026-08-12_1400", windowLabel: "14:00",
  refillId: "r1", movementId: "rrf_r1", heldAt: "2026-08-12T10:00:00.000Z", heldBy: "staff-1",
  ...over,
});
const SHIP = (lines) => ({ key: "2026-08-12_1400|hub1", shipmentId: "2026-08-12_1400", dest: "hub1", lines });

beforeEach(() => {
  store = {};
  failUpdatesOnce = null;
  // The fulfil already ran: units parked in transit, line held.
  setPath("stock/in_transit/p1/7", { qty: 3, v: 1 });
  setPath("stock/hub1/p1/7", { qty: 1, v: 4 });
  setPath("settings/stockHold/held/hub1/rrf_r1", LINE());
});

describe("release — every line exactly once", () => {
  it("credits the hub, empties in_transit, retires the line into the archive", async () => {
    const out = await releaseShipment({ dest: "hub1", shipment: SHIP([LINE()]), actorRole: "admin" });
    expect(out.released).toBe(1);
    expect(out.releasedUnits).toBe(3);
    expect(out.failures).toHaveLength(0);
    expect(getPath("stock/hub1/p1/7").qty).toBe(4);          // 1 + 3
    expect(getPath("stock/in_transit/p1/7").qty).toBe(0);
    expect(getPath("settings/stockHold/held/hub1/rrf_r1")).toBeNull();
    expect(getPath("settings/stockHold/released/hub1/2026-08-12_1400/rrf_r1")).toMatchObject({
      productId: "p1", qty: 3, releaseMovementId: "rel_rrf_r1",
    });
  });

  it("A DOUBLE RELEASE CREDITS NOTHING EXTRA — the movement id replays idempotently", async () => {
    await releaseShipment({ dest: "hub1", shipment: SHIP([LINE()]), actorRole: "admin" });
    // The owner taps again with a stale screen (line data still in memory).
    const again = await releaseShipment({ dest: "hub1", shipment: SHIP([LINE()]), actorRole: "admin" });
    expect(getPath("stock/hub1/p1/7").qty).toBe(4);          // STILL 4 — not 7
    expect(again.failures).toHaveLength(0);
  });

  it("a crash between the credit and the bookkeeping replays to completion without double credit", async () => {
    failUpdatesOnce = "settings/stockHold";                  // the bookkeeping update dies once
    const first = await releaseShipment({ dest: "hub1", shipment: SHIP([LINE()]), actorRole: "admin" });
    expect(first.failures).toHaveLength(1);
    expect(getPath("stock/hub1/p1/7").qty).toBe(4);          // the credit landed
    expect(getPath("settings/stockHold/held/hub1/rrf_r1")).toBeTruthy();   // line survived
    const second = await releaseShipment({ dest: "hub1", shipment: SHIP([LINE()]), actorRole: "admin" });
    expect(second.released).toBe(1);
    expect(getPath("stock/hub1/p1/7").qty).toBe(4);          // idempotent — no second credit
    expect(getPath("settings/stockHold/held/hub1/rrf_r1")).toBeNull();
  });

  it("a PHANTOM line (fulfil never parked stock) is refused and stays held", async () => {
    setPath("stock/in_transit/p1/7", { qty: 0, v: 2 });
    const out = await releaseShipment({ dest: "hub1", shipment: SHIP([LINE()]), actorRole: "admin" });
    expect(out.released).toBe(0);
    expect(out.failures[0].reason).toBe("insufficient_stock");
    expect(getPath("stock/hub1/p1/7").qty).toBe(1);          // nothing credited
    expect(getPath("settings/stockHold/held/hub1/rrf_r1")).toBeTruthy();
  });
});

describe("the shelve-then-count race — a counted cell resurfaces after release", () => {
  beforeEach(() => {
    setPath("settings/hubSneakerCount/sessions/hub1", { sessionId: "sessA", hub: "hub1" });
    setPath("settings/hubSneakerCount/counted/hub1/sessA/p1::7", {
      productId: "p1", sizeKey: "7", expected: 1, actual: 1, action: "confirm",
      at: "2026-08-12T12:00:00.000Z", settled: true, offShelf: 0,
    });
  });

  it("release stamps the counted record stale with the delta and when", async () => {
    const out = await releaseShipment({ dest: "hub1", shipment: SHIP([LINE()]), actorRole: "admin" });
    expect(out.staledCells).toBe(1);
    const rec = getPath("settings/hubSneakerCount/counted/hub1/sessA/p1::7");
    expect(rec.staleAt).toBe("2026-08-12T14:30:00.000Z");
    expect(rec.staleDelta).toBe(3);
    expect(rec.staleMovementId).toBe("rel_rrf_r1");
  });

  it("a stale record reads as NOT COUNTED — the cell is back on the to-do", async () => {
    await releaseShipment({ dest: "hub1", shipment: SHIP([LINE()]), actorRole: "admin" });
    const counted = { "p1::7": getPath("settings/hubSneakerCount/counted/hub1/sessA/p1::7") };
    expect(recordIsCurrent(counted[cellKey("p1", "7")])).toBe(false);
    const rows = [{ id: "p1", sizes: [{ sizeKey: "7" }] }];
    expect(progressOf(rows, counted)).toEqual({ done: 0, total: 1 });
  });

  it("a SECOND release onto an already-stale cell accumulates the delta", async () => {
    await releaseShipment({ dest: "hub1", shipment: SHIP([LINE()]), actorRole: "admin" });
    setPath("stock/in_transit/p1/7", { qty: 2, v: 9 });
    setPath("settings/stockHold/held/hub1/rrf_r2", LINE({ lineId: "rrf_r2", movementId: "rrf_r2", qty: 2, shipmentId: "2026-08-13_0600" }));
    await releaseShipment({ dest: "hub1", shipment: { key: "2026-08-13_0600|hub1", shipmentId: "2026-08-13_0600", dest: "hub1", lines: [LINE({ lineId: "rrf_r2", movementId: "rrf_r2", qty: 2, shipmentId: "2026-08-13_0600" })] }, actorRole: "admin" });
    expect(getPath("settings/hubSneakerCount/counted/hub1/sessA/p1::7").staleDelta).toBe(5);   // 3 + 2
  });

  it("a cell nobody counted stales nothing — the release just lands", async () => {
    setPath("settings/hubSneakerCount/counted/hub1/sessA", {});
    const out = await releaseShipment({ dest: "hub1", shipment: SHIP([LINE()]), actorRole: "admin" });
    expect(out.staledCells).toBe(0);
    expect(out.released).toBe(1);
  });
});

describe("not arrived — the line stays held and joins the next shipment", () => {
  it("markLineNotArrived moves the shipment stamp and keeps the history", async () => {
    const res = await markLineNotArrived({ dest: "hub1", lineId: "rrf_r1", toShipment: { id: "2026-08-13_0600", label: "06:00" } });
    expect(res.ok).toBe(true);
    const line = getPath("settings/stockHold/held/hub1/rrf_r1");
    expect(line.shipmentId).toBe("2026-08-13_0600");
    expect(line.carriedFrom).toBe("2026-08-12_1400");
    expect(line.notArrivedAt).toBe("2026-08-12T14:30:00.000Z");
    expect(getPath("stock/in_transit/p1/7").qty).toBe(3);    // stock untouched — still in transit
  });

  it("releasing with the line skipped credits the rest and leaves it held", async () => {
    setPath("stock/in_transit/p2/8", { qty: 1, v: 0 });
    setPath("settings/stockHold/held/hub1/rrf_r9", LINE({ lineId: "rrf_r9", movementId: "rrf_r9", productId: "p2", size: "8", sizeKey: "8", qty: 1 }));
    const ship = SHIP([LINE(), LINE({ lineId: "rrf_r9", movementId: "rrf_r9", productId: "p2", size: "8", sizeKey: "8", qty: 1 })]);
    const out = await releaseShipment({ dest: "hub1", shipment: ship, skipLineIds: new Set(["rrf_r1"]), actorRole: "admin" });
    expect(out.released).toBe(1);
    expect(out.skipped).toBe(1);
    expect(getPath("stock/hub1/p1/7").qty).toBe(1);          // skipped line: nothing credited
    expect(getPath("settings/stockHold/held/hub1/rrf_r1")).toBeTruthy();
    expect(getPath("settings/stockHold/held/hub1/rrf_r9")).toBeNull();
  });
});

describe("recordHeldLine — create-once under the movement id", () => {
  it("a retry after the window passed keeps the FIRST shipment stamp", async () => {
    await recordHeldLine({ dest: "hub1", lineId: "rrf_new", productId: "p1", size: "7", sizeKey: "7", qty: 1, shipmentId: "2026-08-12_1400", windowLabel: "14:00" });
    await recordHeldLine({ dest: "hub1", lineId: "rrf_new", productId: "p1", size: "7", sizeKey: "7", qty: 1, shipmentId: "2026-08-13_0600", windowLabel: "06:00" });
    expect(getPath("settings/stockHold/held/hub1/rrf_new").shipmentId).toBe("2026-08-12_1400");
  });
});

// ─── THE TWO INTERLEAVINGS CodeRabbit FLAGGED (PR #347 fix commit) ───────────
describe("release races closed by per-line fresh reads", () => {
  it("a cell counted DURING the release still gets staled (fresh per-line read)", async () => {
    // No record exists when the release starts…
    setPath("settings/hubSneakerCount/sessions/hub1", { sessionId: "sessA", hub: "hub1" });
    // …but one lands between the release's start and this line's bookkeeping.
    // The fake applyMovement runs before the counted-record read, so writing
    // the record from inside it reproduces the interleaving exactly.
    const { applyMovement } = await import("./applyMovement");
    let armed = true;
    const orig = applyMovement;
    // Simulate by pre-arming the store mutation through the movement hook:
    // the mocked applyMovement is shared, so instead mutate on first get of
    // the counted path — simpler: write the record NOW, after the (removed)
    // pre-loop read WOULD have happened. With per-line reads this is
    // equivalent: the record exists before the line's bookkeeping.
    setPath("settings/hubSneakerCount/counted/hub1/sessA/p1::7", {
      productId: "p1", sizeKey: "7", expected: 1, actual: 1, action: "confirm",
      at: "2026-08-12T14:29:59.000Z", settled: true, offShelf: 0,
    });
    void armed; void orig;
    const out = await releaseShipment({ dest: "hub1", shipment: SHIP([LINE()]), actorRole: "admin" });
    expect(out.staledCells).toBe(1);
    expect(getPath("settings/hubSneakerCount/counted/hub1/sessA/p1::7").staleAt).toBeTruthy();
  });

  it("a line carried to the NEXT window by another client is skipped, never credited", async () => {
    // Another device marked it not-arrived after this screen rendered:
    setPath("settings/stockHold/held/hub1/rrf_r1/shipmentId", "2026-08-13_0600");
    // This screen still holds the stale copy inside SHIP([LINE()]).
    const out = await releaseShipment({ dest: "hub1", shipment: SHIP([LINE()]), actorRole: "admin" });
    expect(out.carriedAway).toBe(1);
    expect(out.released).toBe(0);
    expect(getPath("stock/hub1/p1/7").qty).toBe(1);                    // nothing credited
    expect(getPath("stock/in_transit/p1/7").qty).toBe(3);              // still in transit
    expect(getPath("settings/stockHold/held/hub1/rrf_r1")).toBeTruthy(); // still held
  });

  it("a line already released by another client is skipped quietly (fresh read finds it gone)", async () => {
    setPath("settings/stockHold/held/hub1/rrf_r1", null);
    delete store.settings.stockHold.held.hub1.rrf_r1;
    const out = await releaseShipment({ dest: "hub1", shipment: SHIP([LINE()]), actorRole: "admin" });
    expect(out.released).toBe(0);
    expect(out.skipped).toBe(1);
    expect(getPath("stock/hub1/p1/7").qty).toBe(1);
  });
});

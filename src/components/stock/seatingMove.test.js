// ─── MOVE AND SWITCH OFF — THE GUARDS ────────────────────────────────────────
// Every stock write goes through applyMovement, negatives keep their sign, the
// destination is never written a seating fact, and the switch-off re-reads
// before it fires.

import { describe, it, expect, beforeEach, vi } from "vitest";

const moves = [];
const writes = [];
let LIVE = { stock: {}, targets: {} };

vi.mock("./applyMovement", () => ({
  applyMovement: async (m) => { moves.push(m); return { ok: true, movementId: `mv${moves.length}` }; },
}));
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  get: async (r) => {
    const [root, loc, pid] = String(r.path).split("/");
    const src = root === "stock" ? LIVE.stock : LIVE.targets;
    const v = src?.[loc]?.[pid];
    return { exists: () => v !== undefined, val: () => v };
  },
  update: async (_r, upd) => { writes.push(upd); },
}));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u-owner" } } }));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => 1756000000000 }));

const { moveAndSwitchOff, movePlan, moveBlockers } = await import("./seatingStore.js");
const { seatingAt } = await import("./seatingCore.js");

const P = { p1: { id: "p1", name: "Tee", sizes: ["S", "M", "L"], productType: "clothing" } };
const CONFIG = { ruleBasedTargets: true, defaultRunByStore: { trophy: { S: 1, M: 2, L: 2 } } };
const LOCS = ["trophy", "marathon-pe", "hub2", "central"];
const ctxOf = (stock, targets = {}) => ({ products: P, stock, targets, config: CONFIG });
const seatOf = (ctx, loc = "trophy") => seatingAt(ctx, loc, "p1");

beforeEach(() => { moves.length = 0; writes.length = 0; LIVE = { stock: {}, targets: {} }; });

// ── DESTINATIONS ─────────────────────────────────────────────────────────────
describe("where it may go", () => {
  it("refuses no destination and the same location", () => {
    expect(moveBlockers("trophy", "")).toMatch(/Pick where/);
    expect(moveBlockers("trophy", "trophy")).toMatch(/same location/);
  });

  it("declines a Transit lane rather than skipping the receive step", () => {
    // Central (building A) → any other building is the T1 two-step lane.
    expect(moveBlockers("central", "marathon-pine")).toMatch(/Transit/);
    expect(moveBlockers("central", "trophy")).toMatch(/Transit/);
    // Shop-to-shop inside a building is the instant flow, unchanged.
    expect(moveBlockers("trophy", "hub2")).toBe(null);
  });

  it("a blocked destination writes nothing at all", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 3 } } } });
    const res = await moveAndSwitchOff({ seat: seatOf(ctx), ctx, viewer: {}, dest: "trophy", locations: LOCS });
    expect(res.ok).toBe(false);
    expect(moves).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });
});

// ── EVERY WRITE THROUGH applyMovement ────────────────────────────────────────
describe("all stock writes go through applyMovement", () => {
  it("one line per size that holds something, resolved by pid", async () => {
    const ctx = ctxOf({ trophy: { p1: { S: { qty: 2 }, M: { qty: 4 }, L: { qty: 0 } } } });
    LIVE = { stock: {}, targets: {} };                       // everything moved out
    await moveAndSwitchOff({ seat: seatOf(ctx), ctx, viewer: {}, dest: "hub2", locations: LOCS });
    // Size-key order, stable: the lines the screen showed are the lines sent.
    expect(moves.map((m) => [m.size, m.qty, m.from, m.to]))
      .toEqual([["M", 4, "trophy", "hub2"], ["S", 2, "trophy", "hub2"]]);
    for (const m of moves) {
      expect(m.type).toBe("transfer_out");
      expect(m.productId).toBe("p1");
      expect(m.reason).toBe("seating_move");
    }
  });

  it("the movement id is deterministic, so a repeat is idempotent", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 4 } } } });
    await moveAndSwitchOff({ seat: seatOf(ctx), ctx, viewer: {}, dest: "hub2", locations: LOCS });
    // Derived from serverNowMs, NOT Date.now: the batch id is base-36 of the
    // server clock, so the same confirm retried collapses to one movement.
    const stamp = (1756000000000).toString(36);
    expect(moves[0].movementId).toBe(`seatmove_${stamp}_p1_M`);
    expect(moves[0].link.transferId).toBe(`seatmove_${stamp}`);
  });

  it("no /stock path is ever written directly", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 4 } } } });
    await moveAndSwitchOff({ seat: seatOf(ctx), ctx, viewer: {}, dest: "hub2", locations: LOCS });
    for (const upd of writes) {
      for (const path of Object.keys(upd)) expect(path.startsWith("stock_targets/")).toBe(true);
    }
  });
});

// ── NEGATIVES ────────────────────────────────────────────────────────────────
describe("a negative travels with its sign", () => {
  it("is sent the other way, so the source rises to 0 and the debt follows", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: -2 } } } });
    await moveAndSwitchOff({ seat: seatOf(ctx), ctx, viewer: {}, dest: "hub2", locations: LOCS });
    expect(moves).toHaveLength(1);
    // from the DESTINATION to the SOURCE: trophy -2 → 0, hub2 down by 2.
    expect(moves[0].from).toBe("hub2");
    expect(moves[0].to).toBe("trophy");
    expect(moves[0].qty).toBe(2);
    expect(moves[0].allowNegative).toBe(true);
  });

  it("a positive line never carries allowNegative", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 4 } } } });
    await moveAndSwitchOff({ seat: seatOf(ctx), ctx, viewer: {}, dest: "hub2", locations: LOCS });
    expect("allowNegative" in moves[0]).toBe(false);
  });

  it("mixed signs each go their own way in one action", async () => {
    const ctx = ctxOf({ trophy: { p1: { S: { qty: 3 }, M: { qty: -1 } } } });
    await moveAndSwitchOff({ seat: seatOf(ctx), ctx, viewer: {}, dest: "hub2", locations: LOCS });
    expect(moves.map((m) => [m.size, m.from, m.to, m.qty]))
      .toEqual([["M", "hub2", "trophy", 1], ["S", "trophy", "hub2", 3]]);
  });
});

// ── THE TICK ─────────────────────────────────────────────────────────────────
describe("switch off the source", () => {
  it("fires by default, over the RE-READ state and not the stale plan", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 4 } } } });
    LIVE = { stock: { trophy: { p1: { M: { qty: 0 } } } }, targets: {} };
    const res = await moveAndSwitchOff({ seat: seatOf(ctx), ctx, viewer: {}, dest: "hub2", locations: LOCS });
    expect(res.switchedOff).toBe(true);
    expect(Object.keys(writes[0]).sort()).toEqual([
      "stock_targets/trophy/p1/L", "stock_targets/trophy/p1/M", "stock_targets/trophy/p1/S",
    ]);
  });

  it("un-ticked, the stock moves and the seat stays on", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 4 } } } });
    const res = await moveAndSwitchOff({ seat: seatOf(ctx), ctx, viewer: {}, dest: "hub2", alsoSwitchOff: false, locations: LOCS });
    expect(res.ok).toBe(true);
    expect(res.switchedOff).toBe(false);
    expect(moves).toHaveLength(1);
    expect(writes).toHaveLength(0);
  });

  it("a sale landing mid-move leaves the seat ON rather than burying the units", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 4 } } } });
    LIVE = { stock: { trophy: { p1: { M: { qty: 2 } } } }, targets: {} };   // 2 arrived after
    const res = await moveAndSwitchOff({ seat: seatOf(ctx), ctx, viewer: {}, dest: "hub2", locations: LOCS });
    expect(res.ok).toBe(true);
    expect(res.switchedOff).toBe(false);
    expect(res.offReason).toBe("holds_units");
    expect(writes).toHaveLength(0);
  });

  it("a failed line parks the switch-off — stock left behind stays seated", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 4 } } } });
    const { applyMovement } = await import("./applyMovement");
    vi.mocked?.(applyMovement);
    moves.length = 0;
    // one failing leg
    const store = await import("./seatingStore.js");
    const spy = vi.spyOn(await import("./applyMovement"), "applyMovement")
      .mockResolvedValueOnce({ ok: false, reason: "insufficient_stock" });
    const res = await store.moveAndSwitchOff({ seat: seatOf(ctx), ctx, viewer: {}, dest: "hub2", locations: LOCS });
    expect(res.switchedOff).toBe(false);
    expect(res.offSkipped).toBe("lines_failed");
    expect(writes).toHaveLength(0);
    spy.mockRestore();
  });
});

// ── THE DESTINATION ──────────────────────────────────────────────────────────
describe("the destination establishes carriage by the movement alone", () => {
  it("is never written a target row or a seating fact", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 4 } } } });
    LIVE = { stock: { hub2: { p1: { M: { qty: 4 } } } }, targets: {} };
    await moveAndSwitchOff({ seat: seatOf(ctx), ctx, viewer: {}, dest: "hub2", locations: LOCS });
    for (const upd of writes) {
      for (const path of Object.keys(upd)) expect(path).not.toContain("/hub2/");
    }
  });

  it("and the shared carriage answer then reads it as seated", () => {
    const after = seatingAt(ctxOf({ hub2: { p1: { M: { qty: 4 } } } }), "hub2", "p1");
    expect(after.hasCell).toBe(true);
  });
});

describe("movePlan", () => {
  it("lists only cells that hold something, in size-key order", () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 4 }, L: { qty: 0 }, S: { qty: -1 } } } });
    expect(movePlan(ctx, "trophy", "p1")).toEqual([
      { sizeKey: "M", size: "M", qty: 4 },
      { sizeKey: "S", size: "S", qty: -1 },
    ]);
  });
});

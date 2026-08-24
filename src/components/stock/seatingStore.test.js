// ─── SWITCH OFF AND RE-SEAT — THE GUARDS ─────────────────────────────────────
// Each of these pins a property that, removed, loses stock or loses somebody's
// decision. Every one is mutation-proved in scripts/mutation-proof-seating.mjs.

import { describe, it, expect, beforeEach, vi } from "vitest";

const writes = [];
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  get: async () => ({ exists: () => false, val: () => null }),
  update: async (_r, upd) => { writes.push(upd); },
}));
let CURRENT = { uid: "u-owner", email: "gunidmoh@gmail.com" };
vi.mock("../../firebase", () => ({ database: {}, get auth() { return { currentUser: CURRENT }; } }));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => 1756000000000 }));

const { switchOff, switchOffBlockers, switchOffPlan, reseat, reseatPlan, offRow } =
  await import("./seatingStore.js");
const { seatingAt, SEATING_OFF_SOURCE } = await import("./seatingCore.js");

const P = { p1: { id: "p1", name: "Tee", sizes: ["S", "M", "L"], productType: "clothing" } };
const CONFIG = { ruleBasedTargets: true, defaultRunByStore: { trophy: { S: 1, M: 2, L: 2 } } };
const ctxOf = (stock, targets) => ({ products: P, stock, targets, config: CONFIG });
const seatOf = (ctx) => seatingAt(ctx, "trophy", "p1");

beforeEach(() => { writes.length = 0; CURRENT = { uid: "u-owner", email: "gunidmoh@gmail.com" }; });

// ── THE REFUSAL ──────────────────────────────────────────────────────────────
describe("switching off never makes stock disappear", () => {
  it("refuses while a cell holds units, and names them", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 3 } } } }, {});
    const res = await switchOff({ seat: seatOf(ctx), ctx, viewer: {} });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("holds_units");
    expect(res.blockers.units).toBe(3);
    expect(writes).toHaveLength(0);
  });

  it("refuses on a NEGATIVE cell too — a count error must not be stranded", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: -2 } } } }, {});
    const res = await switchOff({ seat: seatOf(ctx), ctx, viewer: {} });
    expect(res.ok).toBe(false);
    expect(res.blockers.negativeOnly).toBe(true);
    expect(writes).toHaveLength(0);
  });

  it("allows an empty seat — a zero cell is a real, correct seat", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, {});
    const res = await switchOff({ seat: seatOf(ctx), ctx, viewer: {} });
    expect(res.ok).toBe(true);
  });
});

// ── COVERAGE ─────────────────────────────────────────────────────────────────
describe("the switch-off covers every size the engine arms", () => {
  it("declared catalogue sizes, not only the stocked one", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, {});
    await switchOff({ seat: seatOf(ctx), ctx, viewer: {} });
    const paths = Object.keys(writes[0]).sort();
    expect(paths).toEqual([
      "stock_targets/trophy/p1/L",
      "stock_targets/trophy/p1/M",
      "stock_targets/trophy/p1/S",
    ]);
  });

  it("leaves the location unseated afterwards, by the shared carriage answer", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, {});
    await switchOff({ seat: seatOf(ctx), ctx, viewer: {} });
    const rows = {};
    for (const [path, row] of Object.entries(writes[0])) rows[path.split("/").pop()] = row;
    const after = seatingAt(ctxOf(ctx.stock, { trophy: { p1: rows } }), "trophy", "p1");
    expect(after.seated).toBe(false);
    expect(after.reason).toBe("switched_off");
  });

  it("every row is target 0 / minQty 0 — the shape the live rule validates", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, {});
    await switchOff({ seat: seatOf(ctx), ctx, viewer: {} });
    for (const row of Object.values(writes[0])) {
      expect(row.target).toBe(0);
      expect(typeof row.target).toBe("number");
      expect(typeof row.minQty).toBe("number");
    }
  });
});

// ── ATTRIBUTION ──────────────────────────────────────────────────────────────
describe("every row is attributed", () => {
  it("carries the actor uid and the SERVER clock", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, {});
    await switchOff({ seat: seatOf(ctx), ctx, viewer: { email: "gunidmoh@gmail.com" } });
    for (const row of Object.values(writes[0])) {
      expect(row.offBy).toBe("u-owner");
      expect(row.offAt).toBe(1756000000000);       // serverNowMs, never Date.now
      expect(row.source).toBe(SEATING_OFF_SOURCE);
      expect(row.batchId).toMatch(/^seating_/);
    }
  });

  it("refuses outright when nobody is signed in", async () => {
    CURRENT = null;
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, {});
    await expect(switchOff({ seat: seatOf(ctx), ctx, viewer: {} })).rejects.toThrow(/signed in/i);
    expect(writes).toHaveLength(0);
  });
});

// ── REVERSIBILITY ────────────────────────────────────────────────────────────
describe("re-seat removes the delist fact and nothing else", () => {
  const OFF = (prev) => offRow({ prev, actor: { uid: "u-owner" }, at: 1, batchId: "b" });

  it("deletes a row it created, restores a row it replaced", () => {
    const hand = { target: 5, minQty: 3, source: "hand" };
    const targets = { trophy: { p1: { S: OFF(null), M: OFF(hand) } } };
    const { restore } = reseatPlan(ctxOf({}, targets), "trophy", "p1");
    // Sorted by size key, so M precedes S — the order is stable on purpose:
    // a plan the screen shows must not reshuffle between renders.
    expect(restore).toEqual([
      { sizeKey: "M", to: hand },
      { sizeKey: "S", to: null },
    ]);
  });

  it("NEVER touches a row this screen did not write", () => {
    const targets = { trophy: { p1: {
      S: OFF(null),
      M: { target: 0, minQty: 0, source: "excluded" },     // the Decision Queue's
      L: { target: 4, minQty: 2 },                          // hand-made
    } } };
    const ctx = ctxOf({}, targets);
    const { restore, stuck } = reseatPlan(ctx, "trophy", "p1");
    expect(restore.map((r) => r.sizeKey)).toEqual(["S"]);
    // AND IT DOES NOT REPORT THEM EITHER. Landing a foreign row in `stuck`
    // would be a quieter version of the same mistake: the screen would tell the
    // owner that somebody else's deliberate exclusion is an undo it failed to
    // perform, and invite him to go and "fix" it. `stuck` means "a row I wrote
    // whose record I lost" and nothing else. (This is the assertion that makes
    // the source check load-bearing — without it, dropping the check merely
    // reshuffled foreign rows into `stuck` and every test still passed.)
    expect(stuck).toEqual([]);
  });

  it("writes exactly those paths and no others", async () => {
    const targets = { trophy: { p1: { S: OFF(null), L: { target: 4, minQty: 2 } } } };
    const ctx = ctxOf({}, targets);
    const res = await reseat({ seat: seatOf(ctx), ctx });
    expect(res.ok).toBe(true);
    expect(Object.keys(writes[0])).toEqual(["stock_targets/trophy/p1/S"]);
    expect(writes[0]["stock_targets/trophy/p1/S"]).toBe(null);
  });

  it("a stamped row with no provenance is reported, never guessed at", () => {
    const targets = { trophy: { p1: { S: { target: 0, minQty: 0, source: SEATING_OFF_SOURCE } } } };
    const { restore, stuck } = reseatPlan(ctxOf({}, targets), "trophy", "p1");
    expect(restore).toHaveLength(0);
    expect(stuck).toEqual(["S"]);
  });

  it("prevAbsent is a flag, not a null — RTDB cannot store the null", () => {
    expect(OFF(null).prevAbsent).toBe(true);
    expect("prevRow" in OFF(null)).toBe(false);
    expect(OFF({ target: 2, minQty: 1 }).prevRow).toEqual({ target: 2, minQty: 1 });
    expect("prevAbsent" in OFF({ target: 2, minQty: 1 })).toBe(false);
  });

  it("switch off then re-seat is a round trip back to the original rows", async () => {
    const before = { trophy: { p1: { M: { target: 3, minQty: 2, source: "hand" } } } };
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, before);
    await switchOff({ seat: seatOf(ctx), ctx, viewer: {} });
    const afterRows = {};
    for (const [path, row] of Object.entries(writes[0])) afterRows[path.split("/").pop()] = row;
    const ctx2 = ctxOf(ctx.stock, { trophy: { p1: afterRows } });
    writes.length = 0;
    await reseat({ seat: seatOf(ctx2), ctx: ctx2 });
    const restored = {};
    for (const [path, row] of Object.entries(writes[0])) restored[path.split("/").pop()] = row;
    expect(restored).toEqual({ S: null, L: null, M: { target: 3, minQty: 2, source: "hand" } });
  });
});

// ── NOTHING IS DELETED ───────────────────────────────────────────────────────
describe("no stock cell is ever removed", () => {
  it("no write this module makes touches /stock", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, {});
    await switchOff({ seat: seatOf(ctx), ctx, viewer: {} });
    for (const upd of writes) {
      for (const path of Object.keys(upd)) {
        expect(path.startsWith("stock_targets/")).toBe(true);
        expect(/^stock\//.test(path)).toBe(false);
      }
    }
  });

  it("the source itself contains no cell delete", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./seatingStore.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/\[`stock\/\$\{/);
    expect(src).not.toMatch(/remove\(/);
  });
});

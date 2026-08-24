// ─── SWITCH OFF AND RE-SEAT — THE GUARDS ─────────────────────────────────────
// Each of these pins a property that, removed, loses stock or loses somebody's
// decision. Every one is mutation-proved in scripts/mutation-proof-seating.mjs.

import { describe, it, expect, beforeEach, vi } from "vitest";

const writes = [];
// switchOff re-reads live before it decides, so the fixture has to serve that
// read. LIVE defaults to whatever the test's ctx says — the interesting cases
// are the ones that deliberately make it DISAGREE.
let LIVE = null;
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  get: async (r) => {
    const [root, loc, pid] = String(r.path).split("/");
    const src = root === "stock" ? LIVE?.stock : LIVE?.targets;
    const v = src?.[loc]?.[pid];
    return { exists: () => v !== undefined, val: () => v };
  },
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
const LOCS = ["trophy", "marathon-pe", "hub2", "central", "in_transit"];
const ctxOf = (stock, targets) => ({ products: P, stock, targets, config: CONFIG });
const seatOf = (ctx) => seatingAt(ctx, "trophy", "p1");
// The call under test, with the live snapshot defaulting to the ctx it was
// given (i.e. nothing changed between the render and the write).
const off = (ctx, extra = {}) => {
  if (LIVE === null) LIVE = { stock: ctx.stock, targets: ctx.targets };
  return switchOff({ seat: seatOf(ctx), ctx, viewer: {}, locations: LOCS, ...extra });
};

beforeEach(() => { writes.length = 0; LIVE = null; CURRENT = { uid: "u-owner", email: "gunidmoh@gmail.com" }; });

// ── THE REFUSAL ──────────────────────────────────────────────────────────────
describe("switching off never makes stock disappear", () => {
  it("refuses while a cell holds units, and names them", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 3 } } } }, {});
    const res = await off(ctx);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("holds_units");
    expect(res.blockers.units).toBe(3);
    expect(writes).toHaveLength(0);
  });

  it("refuses on a NEGATIVE cell too — a count error must not be stranded", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: -2 } } } }, {});
    const res = await off(ctx);
    expect(res.ok).toBe(false);
    expect(res.blockers.negativeOnly).toBe(true);
    expect(writes).toHaveLength(0);
  });

  it("allows an empty seat — a zero cell is a real, correct seat", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, {});
    const res = await off(ctx);
    expect(res.ok).toBe(true);
  });
});

// ── COVERAGE ─────────────────────────────────────────────────────────────────
describe("the switch-off covers every size the engine arms", () => {
  it("declared catalogue sizes, not only the stocked one", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, {});
    await off(ctx);
    const paths = Object.keys(writes[0]).sort();
    expect(paths).toEqual([
      "stock_targets/trophy/p1/L",
      "stock_targets/trophy/p1/M",
      "stock_targets/trophy/p1/S",
    ]);
  });

  it("leaves the location unseated afterwards, by the shared carriage answer", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, {});
    await off(ctx);
    const rows = {};
    for (const [path, row] of Object.entries(writes[0])) rows[path.split("/").pop()] = row;
    const after = seatingAt(ctxOf(ctx.stock, { trophy: { p1: rows } }), "trophy", "p1");
    expect(after.seated).toBe(false);
    expect(after.reason).toBe("switched_off");
  });

  it("every row is target 0 / minQty 0 — the shape the live rule validates", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, {});
    await off(ctx);
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
    await off(ctx);
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
    await expect(off(ctx)).rejects.toThrow(/signed in/i);
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
    await off(ctx);
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
    await off(ctx);
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

// ═════════════════════════════════════════════════════════════════════════════
// REVIEW FIXES — PR #429
// Each of these is a bug that shipped in the first five commits and was found
// in review. They stay as tests because the reasoning that produced each bug is
// reasonable-sounding, and nothing else would stop it coming back.
// ═════════════════════════════════════════════════════════════════════════════

describe("switching off twice still undoes to the ORIGINAL row", () => {
  it("does not nest its own off-row as the thing to restore", async () => {
    const hand = { target: 5, minQty: 3, source: "hand" };
    const ctx1 = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, { trophy: { p1: { M: hand } } });
    await off(ctx1);
    const rows1 = {};
    for (const [path, row] of Object.entries(writes[0])) rows1[path.split("/").pop()] = row;

    // A size is added to the catalogue, the location seats again, and the owner
    // switches it off a second time.
    writes.length = 0; LIVE = null;
    const ctx2 = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, { trophy: { p1: rows1 } });
    await off(ctx2);
    const rows2 = {};
    for (const [path, row] of Object.entries(writes[0])) rows2[path.split("/").pop()] = row;

    // NOT rows1.M — the hand-written row, undamaged.
    expect(rows2.M.prevRow).toEqual(hand);
    expect(rows2.M.prevRow.source).toBe("hand");
    expect(rows2.S.prevAbsent).toBe(true);

    const { restore } = reseatPlan(ctxOf({}, { trophy: { p1: rows2 } }), "trophy", "p1");
    expect(restore.find((r) => r.sizeKey === "M").to).toEqual(hand);
  });
});

describe("the units-held refusal is decided against LIVE data", () => {
  it("refuses when a sale landed after the screen rendered", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, {});   // screen says empty
    LIVE = { stock: { trophy: { p1: { M: { qty: 3 } } } }, targets: {} };  // reality does not
    const res = await off(ctx);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("holds_units");
    expect(writes).toHaveLength(0);
  });

  it("REFUSES rather than guessing when the location list cannot verify it", async () => {
    // An empty or wrong list makes readSeatingContext return no cells, which
    // reads exactly like an empty shelf — a failed check that looks like a
    // passed one, over live stock.
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 3 } } } }, {});
    for (const locations of [undefined, [], ["hub2"], null]) {
      LIVE = { stock: {}, targets: {} };
      const res = await switchOff({ seat: seatOf(ctx), ctx, viewer: {}, locations });
      expect(res.ok, JSON.stringify(locations)).toBe(false);
      expect(res.reason).toBe("unverified");
    }
    expect(writes).toHaveLength(0);
  });
});

// ── RE-SEAT SURVIVES A ROW THE RULE WOULD REFUSE ─────────────────────────────
// Admin-SDK scripts write /stock_targets directly and bypass the client rule,
// so a captured prevRow of { target: 0 } (no minQty) or { target: "4" } is a
// shape that exists on the live node. One of those used to make the whole
// multi-path restore fail with a bare PERMISSION_DENIED — nothing restored, no
// way forward. (Adversarial review, PR #429.)
describe("one unwritable prevRow does not block the rest of the undo", () => {
  const OFF2 = (prev) => offRow({ prev, actor: { uid: "u-owner" }, at: 1, batchId: "b" });

  it("restores every other size and reports the one it cannot", () => {
    const good = { target: 4, minQty: 2 };
    const targets = { trophy: { p1: {
      S: OFF2(good),
      M: OFF2({ target: 0 }),          // no minQty — the rule refuses it
      L: OFF2({ target: "4", minQty: 2 }),  // target is a string
    } } };
    const { restore, stuck } = reseatPlan(ctxOf({}, targets), "trophy", "p1");
    expect(restore).toEqual([{ sizeKey: "S", to: good }]);
    expect(stuck.sort()).toEqual(["L", "M"]);
  });

  it("a prevAbsent row is still a delete, not a shape check", () => {
    const targets = { trophy: { p1: { S: OFF2(null) } } };
    const { restore, stuck } = reseatPlan(ctxOf({}, targets), "trophy", "p1");
    expect(restore).toEqual([{ sizeKey: "S", to: null }]);
    expect(stuck).toEqual([]);
  });
});

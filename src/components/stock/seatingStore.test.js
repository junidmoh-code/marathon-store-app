// ─── SWITCH OFF AND RE-SEAT — THE GUARDS ─────────────────────────────────────
// Each of these pins a property that, removed, loses stock or loses somebody's
// decision. Every one is mutation-proved in scripts/mutation-proof-seating.mjs.
//
// ── WHAT CHANGED WHEN THE WRITE MOVED SERVER-SIDE ────────────────────────────
// These used to assert on the multi-path `update()` this module issued. It
// issues a CALLABLE now — one action for every explicit-row change the card
// makes, so a switch-off, an arming and a per-size override share a preview, a
// history entry and a drift check (see seatingStore.js "THE ONE WRITE"). The
// assertions therefore read the PAYLOAD, which carries exactly the same
// decisions: which sizes, which numbers, which rows are cleared, and which are
// left alone. The row's stored shape — the source stamp, the prevRow capture
// and its non-nesting — is the server's half and is pinned in
// functions/test/product-targets.test.cjs.

import { describe, it, expect, beforeEach, vi } from "vitest";

const calls = [];
// switchOff re-reads live before it decides, so the fixture has to serve that
// read. LIVE defaults to whatever the test's ctx says — the interesting cases
// are the ones that deliberately make it DISAGREE.
let LIVE = null;
let RESPONSE = { data: { ok: true, rowCount: 1 } };
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  get: async (r) => {
    const [root, loc, pid] = String(r.path).split("/");
    const src = root === "stock" ? LIVE?.stock : LIVE?.targets;
    const v = src?.[loc]?.[pid];
    return { exists: () => v !== undefined, val: () => v };
  },
}));
vi.mock("firebase/functions", () => ({
  httpsCallable: () => async (payload) => { calls.push(payload); if (RESPONSE instanceof Error) throw RESPONSE; return RESPONSE; },
}));
let CURRENT = { uid: "u-owner", email: "gunidmoh@gmail.com" };
vi.mock("../../firebase", () => ({ database: {}, functions: {}, get auth() { return { currentUser: CURRENT }; } }));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => 1756000000000 }));

const { switchOff, switchOffBlockers, switchOffPlan, reseat, reseatPlan, saveProductTargets } =
  await import("./seatingStore.js");
const { seatingAt, SEATING_OFF_SOURCE } = await import("./seatingCore.js");
const { OVERRIDE_SOURCE } = await import("./targetOverride.js");

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
// The rows a payload would write, keyed by size, and the sizes it clears.
const written = (i = 0) => Object.fromEntries(calls[i].rows.map((r) => [r.sizeKey, r]));
const cleared = (i = 0) => calls[i].remove.slice().sort();

beforeEach(() => {
  calls.length = 0; LIVE = null;
  RESPONSE = { data: { ok: true, rowCount: 3 } };
  CURRENT = { uid: "u-owner", email: "gunidmoh@gmail.com" };
});

// ── THE REFUSAL ──────────────────────────────────────────────────────────────
describe("switching off never makes stock disappear", () => {
  it("refuses while a cell holds units, and names them", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 3 } } } }, {});
    const res = await off(ctx);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("holds_units");
    expect(res.blockers.units).toBe(3);
    expect(calls).toHaveLength(0);
  });

  it("refuses on a NEGATIVE cell too — a count error must not be stranded", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: -2 } } } }, {});
    const res = await off(ctx);
    expect(res.ok).toBe(false);
    expect(res.blockers.negativeOnly).toBe(true);
    expect(calls).toHaveLength(0);
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
    expect(Object.keys(written()).sort()).toEqual(["L", "M", "S"]);
  });

  it("leaves the location unseated afterwards, by the shared carriage answer", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, {});
    await off(ctx);
    const after = seatingAt(ctxOf(ctx.stock, { trophy: { p1: written() } }), "trophy", "p1");
    expect(after.seated).toBe(false);
    expect(after.reason).toBe("switched_off");
  });

  it("every row is target 0 / minQty 0 — the shape the live rule validates", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, {});
    await off(ctx);
    for (const row of Object.values(written())) {
      expect(row.target).toBe(0);
      expect(typeof row.target).toBe("number");
      expect(typeof row.minQty).toBe("number");
      expect(row.minQty).toBe(0);
    }
  });

  it("writes ONE payload for the whole location — a half switch-off is not a state", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, {});
    await off(ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe("setProductTargets");
    expect(calls[0].loc).toBe("trophy");
    expect(calls[0].pid).toBe("p1");
  });
});

// ── ATTRIBUTION AND DRIFT ────────────────────────────────────────────────────
describe("every write is attributed and drift-checked", () => {
  it("carries the numbers the screen was opened on, per size", async () => {
    const hand = { target: 5, minQty: 3, source: "hand" };
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, { trophy: { p1: { M: hand } } });
    await off(ctx);
    // `expected` is what the server refuses the write against. A size with no
    // row is `null` — a real value, not an omission.
    expect(calls[0].expected.M).toEqual({ target: 5, minQty: 3, reorderPoint: null });
    expect(calls[0].expected.S).toBe(null);
  });

  it("refuses outright when nobody is signed in", async () => {
    CURRENT = null;
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, {});
    await expect(off(ctx)).rejects.toThrow(/signed in/i);
    expect(calls).toHaveLength(0);
  });

  it("a drift refusal from the server is reported, not swallowed", async () => {
    RESPONSE = Object.assign(new Error("M changed while this was open."), { details: { drift: true } });
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, {});
    const res = await off(ctx);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("drift");
  });
});

// ── REVERSIBILITY ────────────────────────────────────────────────────────────
// The off-row shape is the server's now, so these build one the way the server
// does: our source stamp, plus the row it replaced or the fact there was none.
const OFF = (prev) => (prev
  ? { target: 0, minQty: 0, source: OVERRIDE_SOURCE, prevRow: prev }
  : { target: 0, minQty: 0, source: OVERRIDE_SOURCE, prevAbsent: true });
// The older stamp, for rows written before this build. They must stay clearable.
const LEGACY_OFF = (prev) => ({ ...OFF(prev), source: SEATING_OFF_SOURCE });

describe("re-seat removes the delist fact and nothing else", () => {
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

  it("still recognises a row written under the OLD stamp", () => {
    const hand = { target: 5, minQty: 3, source: "hand" };
    const targets = { trophy: { p1: { M: LEGACY_OFF(hand) } } };
    expect(reseatPlan(ctxOf({}, targets), "trophy", "p1").restore).toEqual([{ sizeKey: "M", to: hand }]);
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
    // whose record I lost" and nothing else.
    expect(stuck).toEqual([]);
  });

  it("clears exactly those sizes and leaves the foreign row's number alone", async () => {
    const targets = { trophy: { p1: { S: OFF(null), L: { target: 4, minQty: 2 } } } };
    const ctx = ctxOf({}, targets);
    const res = await reseat({ seat: seatOf(ctx), ctx });
    expect(res.ok).toBe(true);
    expect(cleared()).toEqual(["S"]);
    // L is re-stated at its own number rather than cleared: re-seat undoes this
    // screen's decisions and nobody else's.
    expect(calls[0].rows.map((r) => r.sizeKey)).toEqual([]);
    expect(calls[0].allowRemoveForeign).toBeUndefined();
  });

  it("a stamped row with no provenance is reported, never guessed at", () => {
    const targets = { trophy: { p1: { S: { target: 0, minQty: 0, source: OVERRIDE_SOURCE } } } };
    const { restore, stuck } = reseatPlan(ctxOf({}, targets), "trophy", "p1");
    expect(restore).toHaveLength(0);
    expect(stuck).toEqual(["S"]);
  });

  it("switch off then re-seat is a round trip back to the original rows", async () => {
    const hand = { target: 3, minQty: 2, source: "hand" };
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, { trophy: { p1: { M: hand } } });
    await off(ctx);
    // The server stamps the row; the client's half is the numbers and the
    // sizes, so the round trip is modelled with the row the server would store.
    const afterRows = { S: OFF(null), M: OFF(hand), L: OFF(null) };
    const ctx2 = ctxOf(ctx.stock, { trophy: { p1: afterRows } });
    calls.length = 0;
    await reseat({ seat: seatOf(ctx2), ctx: ctx2 });
    expect(cleared()).toEqual(["L", "S"]);
    expect(written()).toEqual({ M: { sizeKey: "M", target: 3, minQty: 2 } });
  });
});

// ── NOTHING IS DELETED ───────────────────────────────────────────────────────
describe("no stock cell is ever removed", () => {
  it("nothing this module sends names a /stock path", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, {});
    await off(ctx);
    expect(JSON.stringify(calls)).not.toMatch(/"stock\//);
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
  it("the second switch-off sends the SAME numbers, so the server's capture is unchanged", async () => {
    const hand = { target: 5, minQty: 3, source: "hand" };
    const rows1 = { S: OFF(null), M: OFF(hand), L: OFF(null) };
    const ctx2 = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, { trophy: { p1: rows1 } });
    LIVE = { stock: ctx2.stock, targets: ctx2.targets };
    const res = await switchOff({ seat: seatOf(ctx2), ctx: ctx2, viewer: {}, locations: LOCS });
    // Already off on every size: nothing to write, and that is a success, not
    // an error — the button was pressed to reach a state it is already in.
    expect(res.ok).toBe(true);
    expect(res.noChange).toBe(true);
    expect(calls).toHaveLength(0);
    // And the original row is still the one an undo restores.
    expect(reseatPlan(ctx2, "trophy", "p1").restore.find((r) => r.sizeKey === "M").to).toEqual(hand);
  });
});

describe("the units-held refusal is decided against LIVE data", () => {
  it("refuses when a sale landed after the screen rendered", async () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, {});   // screen says empty
    LIVE = { stock: { trophy: { p1: { M: { qty: 3 } } } }, targets: {} };  // reality does not
    const res = await off(ctx);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("holds_units");
    expect(calls).toHaveLength(0);
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
    expect(calls).toHaveLength(0);
  });
});

// ── RE-SEAT SURVIVES A ROW THE RULE WOULD REFUSE ─────────────────────────────
// Admin-SDK scripts write /stock_targets directly and bypass the client rule,
// so a captured prevRow of { target: 0 } (no minQty) or { target: "4" } is a
// shape that exists on the live node. One of those used to make the whole
// multi-path restore fail with a bare PERMISSION_DENIED — nothing restored, no
// way forward. (Adversarial review, PR #429.)
describe("one unwritable prevRow does not block the rest of the undo", () => {
  it("restores every other size and reports the one it cannot", () => {
    const good = { target: 4, minQty: 2 };
    const targets = { trophy: { p1: {
      S: OFF(good),
      M: OFF({ target: 0 }),                 // no minQty — the rule refuses it
      L: OFF({ target: "4", minQty: 2 }),    // target is a string
    } } };
    const { restore, stuck } = reseatPlan(ctxOf({}, targets), "trophy", "p1");
    expect(restore).toEqual([{ sizeKey: "S", to: good }]);
    expect(stuck.sort()).toEqual(["L", "M"]);
  });

  it("a prevAbsent row is still a delete, not a shape check", () => {
    const targets = { trophy: { p1: { S: OFF(null) } } };
    const { restore, stuck } = reseatPlan(ctxOf({}, targets), "trophy", "p1");
    expect(restore).toEqual([{ sizeKey: "S", to: null }]);
    expect(stuck).toEqual([]);
  });

  it("and the payload leaves that size exactly as it is", async () => {
    const targets = { trophy: { p1: { S: OFF({ target: "4", minQty: 2 }) } } };
    const ctx = ctxOf({}, targets);
    const res = await saveProductTargets({ ctx, loc: "trophy", pid: "p1", draft: {
      sizes: { S: { target: "" }, M: { target: "" }, L: { target: "" } },
      reorderPoint: "",
    } });
    // Nothing to do: the one row that could change is one it refuses to guess
    // at, so the call is not made at all.
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no_change");
    expect(calls).toHaveLength(0);
  });
});

// ── THE PLAN THE SCREEN SHOWS IS THE PLAN THAT IS SENT ───────────────────────
describe("switchOffPlan still names every size the engine arms", () => {
  it("covers declared sizes with no cell", () => {
    const ctx = ctxOf({ trophy: { p1: { M: { qty: 0 } } } }, {});
    expect(switchOffPlan(ctx, "trophy", "p1").map((p) => p.sizeKey)).toEqual(["L", "M", "S"]);
  });
  it("and switchOffBlockers is unchanged", () => {
    expect(switchOffBlockers({ sizes: [{ size: "M", qty: 0 }] })).toBe(null);
    expect(switchOffBlockers({ sizes: [{ size: "M", qty: 2 }] }).units).toBe(2);
  });
});

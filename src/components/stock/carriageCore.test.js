// ─── CARRIAGE — the guards, pinned ────────────────────────────────────────────
// The claims here are the ones that make an irreversible delete safe to put
// behind a button. Every one of them is a way this could destroy real stock or
// leave the network half-relocated, so they are unit-pinned rather than left to
// the UI to remember.
import { describe, it, expect } from "vitest";
import {
  isCarriedOnly, cellSizes, unseatPlan, unseatCellTxn, seedCell, movePlan, carriageLogEntry, CARRIAGE_LOG,
} from "./carriageCore";

const cell = (size, qty, extra = {}) => ({ size, qty, hasCell: true, v: 0, mv: "seed", ...extra });
const pad  = (size) => ({ size, qty: 0, hasCell: false });

describe("carried-only classification", () => {
  it("a group whose every cell reads 0 is carried-only", () => {
    expect(isCarriedOnly([cell("M", 0), cell("L", 0)])).toBe(true);
  });

  it("one unit anywhere means it is stocked, not merely carried", () => {
    expect(isCarriedOnly([cell("M", 0), cell("L", 1)])).toBe(false);
  });

  // A negative cell is a BROKEN balance (an oversold POS line), not an empty
  // claim. Treating it as carried-only would offer to delete the evidence.
  it("a negative cell is never carried-only", () => {
    expect(isCarriedOnly([cell("M", -2)])).toBe(false);
  });

  it("a group with no cells at all is not carried-only", () => {
    expect(isCarriedOnly([pad("M"), pad("L")])).toBe(false);
    expect(isCarriedOnly([])).toBe(false);
  });

  // THE PAD DISTINCTION. The Counted grid shows a product's catalogue sizes at 0
  // so they stay tappable; those have no node. Only a real cell may be deleted.
  it("catalogue-size pads are not cells", () => {
    expect(cellSizes([cell("M", 0), pad("L"), pad("XL")]).map(s => s.size)).toEqual(["M"]);
  });
});

describe("unseatPlan", () => {
  it("names exactly the cells it would delete, and encodes the size key", () => {
    const p = unseatPlan({ loc: "marathon-pe", pid: "p1", name: "Tracksuit", sizes: [cell("M", 0), cell("5.5", 0), pad("L")] });
    expect(p.ok).toBe(true);
    expect(p.paths.map(x => x.path)).toEqual(["stock/marathon-pe/p1/M", "stock/marathon-pe/p1/5_5"]);
  });

  // THE HARD REFUSAL. Unseat removes a claim; a quantity is ledger history and
  // must leave through a movement (Move or Clear), never a cell delete.
  it("refuses outright while any size still holds stock", () => {
    const p = unseatPlan({ loc: "trophy", pid: "p1", name: "Tracksuit", sizes: [cell("M", 0), cell("L", 3)] });
    expect(p.ok).toBe(false);
    expect(p.blockers.join(" ")).toMatch(/still holds stock here \(L: 3\)/);
  });

  it("a negative cell blocks too — it is stock, wrongly signed", () => {
    const p = unseatPlan({ loc: "trophy", pid: "p1", sizes: [cell("M", -1)] });
    expect(p.ok).toBe(false);
  });

  it("refuses while the engine holds an open refill on a size being deleted", () => {
    const p = unseatPlan({
      loc: "marathon-pe", pid: "p1", name: "Tracksuit", sizes: [cell("M", 0)],
      openLocks: { M: { orderId: "ORD-7" } },
    });
    expect(p.ok).toBe(false);
    expect(p.blockers.join(" ")).toMatch(/open refill .*ORD-7.*reject it in the queue first/);
  });

  // Locks are keyed by the ENCODED size, so the lookup must encode too — a raw
  // "5.5" would silently miss the lock guarding cell "5_5".
  it("matches an open lock on a half size through the encoded key", () => {
    const p = unseatPlan({ loc: "trophy", pid: "p1", sizes: [cell("5.5", 0)], openLocks: { "5_5": { orderId: "ORD-9" } } });
    expect(p.ok).toBe(false);
  });

  it("a lock on a size we are NOT deleting does not block", () => {
    const p = unseatPlan({ loc: "trophy", pid: "p1", sizes: [cell("M", 0)], openLocks: { XL: { orderId: "ORD-3" } } });
    expect(p.ok).toBe(true);
  });

  it("refuses when there is no carriage to remove", () => {
    const p = unseatPlan({ loc: "trophy", pid: "p1", name: "Tracksuit", sizes: [pad("M")] });
    expect(p.ok).toBe(false);
    expect(p.blockers.join(" ")).toMatch(/not carried at this location/);
  });
});

describe("unseatCellTxn — the race guard", () => {
  const expect0 = { qty: 0, v: 0, mv: "seed" };

  it("commits the delete on the exact cell the plan saw", () => {
    expect(unseatCellTxn(expect0)({ qty: 0, v: 0, mv: "seed" })).toBe(null);
  });

  it("aborts when a sale landed between the plan and the tap", () => {
    expect(unseatCellTxn(expect0)({ qty: 2, v: 1, mv: "mv_1" })).toBe(undefined);
  });

  // A cell can be back at 0 and still have taken history — sold then returned.
  // qty alone is not enough; v and mv are what catch it.
  it("aborts on a cell that returned to 0 through real movements", () => {
    expect(unseatCellTxn(expect0)({ qty: 0, v: 4, mv: "mv_9" })).toBe(undefined);
    expect(unseatCellTxn(expect0)({ qty: 0, v: 0, mv: "mv_9" })).toBe(undefined);
  });

  // RTDB runs the decision against the local cache first, which is often null.
  // Aborting there would give up before the server's real value ever arrived.
  it("commits a no-op on null so the transaction re-runs against the server", () => {
    expect(unseatCellTxn(expect0)(null)).toBe(null);
    expect(unseatCellTxn(expect0)(undefined)).toBe(null);
  });

  // An absent v/mv means "don't compare", NOT "compare against 0" — the caller
  // that could not read them (a post-transfer re-read) must not have every
  // legitimately-bumped cell abort on it.
  it("with no expectation at all, qty 0 is the whole guard", () => {
    expect(unseatCellTxn(null)({ qty: 0, v: 6, mv: "mv_9" })).toBe(null);
    expect(unseatCellTxn(null)({ qty: 1, v: 6, mv: "mv_9" })).toBe(undefined);
  });

  // …and qty 0 is never optional. Whatever else is or is not compared, an
  // unseat cannot remove stock.
  it("never commits over a non-zero cell, whatever the expectation says", () => {
    for (const e of [null, undefined, expect0, { qty: 2, v: 0, mv: "seed" }]) {
      expect(unseatCellTxn(e)({ qty: 2, v: 0, mv: "seed" })).toBe(undefined);
      expect(unseatCellTxn(e)({ qty: -1, v: 0, mv: "seed" })).toBe(undefined);
    }
  });
});

describe("seedCell", () => {
  // The /stock SEED validate branch accepts EXACTLY this shape and nothing else
  // (!data.exists() && qty===0 && v===0 && lastType==='count' && mv==='seed').
  // Any drift is a rejected write, so the shape is pinned, not just built.
  it("matches the shape the SEED rule branch accepts", () => {
    expect(seedCell({ uid: "u1", now: "2026-08-24T10:00:00.000Z" }))
      .toEqual({ qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt: "2026-08-24T10:00:00.000Z", updatedBy: "u1" });
  });
});

describe("movePlan", () => {
  const sizes = [cell("M", 3), cell("L", 0), cell("XL", 2), pad("S")];

  it("moves every unit and takes the whole seating when no amounts are typed", () => {
    const p = movePlan({ loc: "marathon-pe", pid: "p1", sizes, to: "trophy" });
    expect(p.ok).toBe(true);
    expect(p.transfers).toEqual([{ size: "M", qty: 3 }, { size: "XL", qty: 2 }]);
    expect(p.seeding).toEqual(["L"]);                       // nothing to send → seed the claim
    expect(p.unseat.map(u => u.size).sort()).toEqual(["L", "M", "XL"]);
    expect(p.partial).toBe(false);
  });

  // THE POINT OF THE WHOLE FEATURE. Without part 3 the units land at Trophy and
  // Marathon PE keeps its claim — still carried, still refilled. That is a copy,
  // not a move.
  it("the source loses its claim — every moved size is unseated", () => {
    const p = movePlan({ loc: "marathon-pe", pid: "p1", sizes, to: "trophy" });
    expect(p.unseat.map(u => u.path)).toContain("stock/marathon-pe/p1/M");
  });

  it("a carried-only product moves its seating with no transfers at all", () => {
    const p = movePlan({ loc: "marathon-pe", pid: "p1", sizes: [cell("M", 0), cell("L", 0)], to: "trophy" });
    expect(p.ok).toBe(true);                                 // the old Move dead-ended here
    expect(p.transfers).toEqual([]);
    expect(p.seeding).toEqual(["M", "L"]);
    expect(p.unseat).toHaveLength(2);
  });

  it("manual amounts move exactly what was typed", () => {
    const p = movePlan({ loc: "marathon-pe", pid: "p1", sizes, to: "trophy", amounts: { M: 1 } });
    expect(p.transfers).toEqual([{ size: "M", qty: 1 }, { size: "XL", qty: 2 }]);
  });

  // A partial move leaves stock behind, so the source genuinely still stocks the
  // product and MUST keep its claim.
  it("a partly-moved size keeps its seating at the source", () => {
    const p = movePlan({ loc: "marathon-pe", pid: "p1", sizes, to: "trophy", amounts: { M: 1 } });
    expect(p.partial).toBe(true);
    expect(p.unseat.map(u => u.size)).not.toContain("M");
    expect(p.unseat.map(u => u.size).sort()).toEqual(["L", "XL"]);
    expect(p.seeding).toEqual(["L"]);                         // M is transferred, so no seed needed
  });

  it("refuses to move more than the location holds", () => {
    const p = movePlan({ loc: "marathon-pe", pid: "p1", sizes, to: "trophy", amounts: { M: 9 } });
    expect(p.ok).toBe(false);
    expect(p.blockers.join(" ")).toMatch(/only 3 here — you asked to move 9/);
  });

  it("refuses a fractional or negative amount", () => {
    expect(movePlan({ loc: "a", pid: "p1", sizes, to: "b", amounts: { M: 1.5 } }).ok).toBe(false);
    expect(movePlan({ loc: "a", pid: "p1", sizes, to: "b", amounts: { M: -1 } }).ok).toBe(false);
  });

  it("refuses a missing or self-referential destination", () => {
    expect(movePlan({ loc: "trophy", pid: "p1", sizes, to: "" }).ok).toBe(false);
    expect(movePlan({ loc: "trophy", pid: "p1", sizes, to: "trophy" }).blockers.join(" ")).toMatch(/same location/);
  });

  it("moveSeating:false is the old behaviour — units move, both stay seated", () => {
    const p = movePlan({ loc: "marathon-pe", pid: "p1", sizes, to: "trophy", moveSeating: false });
    expect(p.transfers).toHaveLength(2);
    expect(p.seeding).toEqual([]);
    expect(p.unseat).toEqual([]);
  });

  // A no-op must SAY so, and say what would help. Silently doing nothing is
  // exactly how a wrongly-seated product became unmovable in the first place.
  it("refuses a no-op move and points at the option that would work", () => {
    const p = movePlan({ loc: "marathon-pe", pid: "p1", name: "Tracksuit", sizes: [cell("M", 0)], to: "trophy", moveSeating: false });
    expect(p.ok).toBe(false);
    expect(p.blockers.join(" ")).toMatch(/holds no stock here.*Move the seating too/);
  });

  it("refuses a move of a product with neither stock nor seating here", () => {
    const p = movePlan({ loc: "marathon-pe", pid: "p1", name: "Tracksuit", sizes: [pad("M")], to: "trophy" });
    expect(p.ok).toBe(false);
  });

  // A transfer creates the destination cell itself; a seed racing it would be
  // rejected by the SEED branch (which only accepts !data.exists()).
  it("never seeds a size that a transfer will create", () => {
    const p = movePlan({ loc: "marathon-pe", pid: "p1", sizes, to: "trophy" });
    for (const t of p.transfers) expect(p.seeding).not.toContain(t.size);
  });

  it("a negative cell is never unseated by a move", () => {
    const p = movePlan({ loc: "marathon-pe", pid: "p1", sizes: [cell("M", -2), cell("L", 0)], to: "trophy" });
    expect(p.unseat.map(u => u.size)).toEqual(["L"]);
  });
});

describe("carriageLogEntry", () => {
  it("records the gesture — who, where, which sizes", () => {
    expect(carriageLogEntry({ action: "unseat", loc: "marathon-pe", pid: "p1", name: "Tracksuit", sizes: ["M", "L"], by: "u1", at: 1700000000000 }))
      .toEqual({ action: "unseat", loc: "marathon-pe", pid: "p1", sizes: ["M", "L"], at: 1700000000000, by: "u1", name: "Tracksuit" });
  });

  // RTDB rejects `undefined` inside a multi-path update and takes the whole
  // batch down with it — optional fields are OMITTED, never written as undefined.
  it("omits absent optional fields rather than writing undefined", () => {
    const e = carriageLogEntry({ action: "unseat", loc: "trophy", pid: "p1", sizes: [] });
    expect("to" in e).toBe(false);
    expect("note" in e).toBe(false);
    expect("name" in e).toBe(false);
    expect(Object.values(e).every(v => v !== undefined)).toBe(true);
  });

  it("an unknown action falls back to unseat, never through unlabelled", () => {
    expect(carriageLogEntry({ action: "nonsense", loc: "a", pid: "p" }).action).toBe("unseat");
    expect(carriageLogEntry({ action: "move", loc: "a", pid: "p", to: "b" }).action).toBe("move");
  });

  // /settings is the node whose LIVE rule already grants non-anonymous write, so
  // this feature needs no rules deploy. Pinning the path keeps that true.
  it("logs under /settings, which needs no rules change", () => {
    expect(CARRIAGE_LOG.startsWith("settings/")).toBe(true);
  });
});

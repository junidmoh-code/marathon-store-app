// Tests for the stale-display-record classification (displayRecordCleanup.js).
// Every export is a pure function of its arguments; fixtures are the STORED
// shapes of /settings/hubSneakerCount/register/{hub} and /settings/displaySlots.
//
// THE ASYMMETRY THESE TESTS EXIST FOR: retiring a row raises a cell's
// expected-on-shelf. Retiring a GHOST fixes a false discrepancy; retiring a
// REAL display makes the next count expect a pair that is genuinely out at a
// shop, not find it, and adjust a real unit away. So the bar for "actionable"
// is a LIVE RECORD THAT CONTRADICTS THE ROW — never age, never absence.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  classifyDisplayRecords, splitRegisterKey, retirePlan, retireKey,
  retireEffectLine, CLEANUP_CLASSES, ACTIONABLE_CLASSES,
  findUnregisteredDisplays, registerKey,
} from "./displayRecordCleanup";

const P = {
  p1: { id: "p1", name: "Air Force 1 White" },
  p2: { id: "p2", name: "Lacoste Gripshot" },
  p3: { id: "p3", name: "Nike Vomero" },
  p4: { id: "p4", name: "Merged Away", mergedInto: "p9" },
  p5: { id: "p5", name: "Finished Line", deactivated: { at: "2026-08-01T00:00:00.000Z" } },
};
const reg = (rows) => rows;
const row = (over = {}) => ({ qty: 1, at: "2026-08-07T10:00:00.000Z", ...over });
const liveSlot = (over = {}) => ({ size: "6", sizeKey: "6", bookedHub: "hub1", source: "registration", at: "2026-09-01T08:00:00.000Z", ...over });
const tomb = (over = {}) => ({ size: null, sizeKey: null, prevSize: "6", source: "display_sold", at: "2026-09-02T08:00:00.000Z", ...over });

const run = (register, slots, over = {}) =>
  classifyDisplayRecords({ register, slots, hub: "hub1", productsById: P, ...over });

describe("splitRegisterKey — the size key can contain an underscore", () => {
  it("splits on the LAST double underscore, like displayPairCore", () => {
    expect(splitRegisterKey("p1__6")).toEqual(["p1", "6"]);
    expect(splitRegisterKey("p1__5_5")).toEqual(["p1", "5_5"]);
  });
  it("refuses a one-size sentinel and anything malformed", () => {
    expect(splitRegisterKey("p1___")).toBeNull();      // sizeKey "_" — never a display
    expect(splitRegisterKey("__6")).toBeNull();
    expect(splitRegisterKey("p1")).toBeNull();
    expect(splitRegisterKey(null)).toBeNull();
  });
});

describe("classifyDisplayRecords — what the evidence says", () => {
  it("MATCHED: a live slot at the same size leaves the row alone", () => {
    const r = run(reg({ p1__6: row() }), { "marathon-pe": { p1: liveSlot() } });
    expect(r.counts.matched).toBe(1);
    expect(r.actionableCount).toBe(0);
  });

  it("REPLACED: a live slot at a DIFFERENT size makes the row the pair that went", () => {
    const r = run(reg({ p1__6: row() }), { "marathon-pe": { p1: liveSlot({ size: "8", sizeKey: "8", source: "display_refill" }) } });
    expect(r.counts.replaced).toBe(1);
    expect(r.byClass.replaced[0].why).toMatch(/now size 8/);
    expect(r.byClass.replaced[0].retireQty).toBe(1);
    expect(r.byClass.replaced[0].evidence).toEqual([
      { kind: "live", store: "marathon-pe", size: "8", sizeKey: "8", at: "2026-09-01T08:00:00.000Z", source: "display_refill" },
    ]);
  });

  it("SOLD: only a tombstone means the display left and nothing replaced it", () => {
    const r = run(reg({ p1__6: row() }), { "marathon-pe": { p1: tomb() } });
    expect(r.counts.sold).toBe(1);
    expect(r.byClass.sold[0].evidence[0]).toMatchObject({ kind: "tomb", store: "marathon-pe", size: "6" });
  });

  it("OVER is REPORTED, never actioned — the surplus is unexplained, not contradicted", () => {
    // A floor showing THIS size explains a unit; it contradicts none. The
    // surplus therefore stands on the same footing as a row with no slot at
    // all, which this module refuses to touch.
    const r = run(reg({ p1__6: row({ qty: 3 }) }), { "marathon-pe": { p1: liveSlot() } });
    expect(r.counts.over).toBe(1);
    expect(r.byClass.over[0].qty).toBe(3);
    expect(r.byClass.over[0].retireQty).toBe(0);
    expect(r.actionableCount).toBe(0);
    expect(ACTIONABLE_CLASSES.has("over")).toBe(false);
    expect(r.byClass.over[0].why).toMatch(/only 1 shop floor shows/);
    expect(r.byClass.over[0].why).toMatch(/not offered here/);
  });

  it("TWO FLOORS showing the same size is not over-registration", () => {
    const r = run(reg({ p1__6: row({ qty: 2 }) }), {
      "marathon-pe": { p1: liveSlot() },
      trophy: { p1: liveSlot() },
    });
    expect(r.counts.matched).toBe(1);
    expect(r.actionableCount).toBe(0);
  });

  // ── THE EVIDENCE BOUNDS THE QUANTITY ────────────────────────────────────
  // A register row is a QUANTITY and carries NO store, so a piece of evidence
  // can only ever speak for as many units as there are shop records behind it.
  // Retiring the whole row on one tombstone counts a second, untracked display
  // away — which is the failure this screen exists to avoid.
  it("SOLD: one tombstone retires ONE unit of a two-unit row, not both", () => {
    const r = run(reg({ p1__6: row({ qty: 2 }) }), { "marathon-pe": { p1: tomb() } });
    expect(r.counts.sold).toBe(1);
    expect(r.byClass.sold[0].qty).toBe(2);
    expect(r.byClass.sold[0].retireQty).toBe(1);          // the other may still be on a floor
    expect(r.byClass.sold[0].why).toMatch(/only 1 can be retired/);
  });

  it("SOLD: two tombstones for a two-unit row retire both", () => {
    const r = run(reg({ p1__6: row({ qty: 2 }) }), {
      "marathon-pe": { p1: tomb() },
      trophy: { p1: tomb() },
    });
    expect(r.byClass.sold[0].retireQty).toBe(2);
    expect(r.byClass.sold[0].why).not.toMatch(/can be retired/);
  });

  it("REPLACED: one moved floor retires ONE unit of a two-unit row", () => {
    const r = run(reg({ p1__6: row({ qty: 2 }) }), { "marathon-pe": { p1: liveSlot({ size: "8", sizeKey: "8" }) } });
    expect(r.byClass.replaced[0].retireQty).toBe(1);
    expect(r.byClass.replaced[0].why).toMatch(/only 1 can be retired/);
  });

  it("REPLACED: two moved floors for a two-unit row retire both", () => {
    const r = run(reg({ p1__6: row({ qty: 2 }) }), {
      "marathon-pe": { p1: liveSlot({ size: "8", sizeKey: "8" }) },
      trophy: { p1: liveSlot({ size: "9", sizeKey: "9" }) },
    });
    expect(r.byClass.replaced[0].retireQty).toBe(2);
  });

  // ── EVIDENCE IS SPENT ONCE ACTED ON ─────────────────────────────────────
  // The walk-to-zero this closes: qty 2 with ONE tombstone offers 1, that
  // lands, and the next load sees qty 1 with the SAME tombstone and offers 1
  // again — taking the unit that may be the real display at an untracked shop.
  it("SPENT EVIDENCE IS NOT RE-OFFERED — a partly retired row goes quiet", () => {
    // bumps 2, qty 1 → one unit has already been retired against this tombstone.
    const r = run(reg({ p1__6: row({ qty: 1, bumps: 2 }) }), { "marathon-pe": { p1: tomb() } });
    expect(r.counts.sold).toBe(0);
    expect(r.actionableCount).toBe(0);
    expect(r.byClass.unverified[0].why).toMatch(/already been accounted for/);
  });

  it("the same for a REPLACED row", () => {
    const r = run(reg({ p1__6: row({ qty: 1, bumps: 2 }) }), { "marathon-pe": { p1: liveSlot({ size: "8", sizeKey: "8" }) } });
    expect(r.counts.replaced).toBe(0);
    expect(r.actionableCount).toBe(0);
  });

  it("but evidence that has NOT been spent still counts", () => {
    // bumps 2, qty 2 → nothing retired yet; two tombstones cover both units.
    const r = run(reg({ p1__6: row({ qty: 2, bumps: 2 }) }), {
      "marathon-pe": { p1: tomb() }, trophy: { p1: tomb() },
    });
    expect(r.byClass.sold[0].retireQty).toBe(2);
  });

  it("two tombstones and one already retired leaves exactly one to go", () => {
    const r = run(reg({ p1__6: row({ qty: 1, bumps: 2 }) }), {
      "marathon-pe": { p1: tomb() }, trophy: { p1: tomb() },
    });
    expect(r.byClass.sold[0].retireQty).toBe(1);
  });

  it("a row written before `bumps` existed is treated as nothing-retired", () => {
    const r = run(reg({ p1__6: { qty: 1, at: "2026-08-07T10:00:00.000Z" } }), { "marathon-pe": { p1: tomb() } });
    expect(r.byClass.sold[0].retireQty).toBe(1);
  });

  it("THE FULL WALK: retiring never takes a row below what the evidence covers", () => {
    // Simulate the loop the screen drives: classify, retire, re-classify, until
    // it stops offering. One tombstone must only ever take ONE unit.
    let qty = 3, bumps = 3;
    const slots = { "marathon-pe": { p1: tomb() } };
    let guard = 0;
    for (;;) {
      if (++guard > 10) throw new Error("did not converge");
      const r = run(reg({ p1__6: { qty, bumps, at: "2026-08-07T10:00:00.000Z" } }), slots);
      if (!r.actionableCount) break;
      const take = r.byClass.sold[0].retireQty;
      qty -= take;                       // bumps never decreases
    }
    expect(qty).toBe(2);                 // 3 registered − 1 that left = 2 still claimed
  });

  it("a MIS-TAGGED shoe is not 'gone' — existence is existence", () => {
    // The screen must pass an UNFILTERED catalogue. A product whose category
    // was edited away from footwear still exists and its display may still be
    // standing; calling it deleted and offering it for retirement is how a real
    // display gets counted away.
    const clothing = { ...P, p6: { id: "p6", name: "Re-tagged Shoe", productType: "clothing" } };
    const r = classifyDisplayRecords({ register: reg({ p6__6: row() }), slots: {}, hub: "hub1", productsById: clothing });
    expect(r.counts.gone).toBe(0);
    expect(r.counts.unverified).toBe(1);
  });

  it("an ABSENT record says deleted OR merged, because the screen cannot tell them apart", () => {
    const r = run(reg({ pX__6: row() }), {});
    expect(r.byClass.gone[0].why).toMatch(/deleted, or merged into another record/);
  });

  it("GONE: a merged-away product, and a product record that is not there", () => {
    const r = run(reg({ p4__6: row(), pX__6: row() }), {});
    expect(r.counts.gone).toBe(2);
    expect(r.byClass.gone.map((x) => x.why).join(" ")).toMatch(/Merged into another product \(p9\)/);
  });

  it("UNVERIFIED: no slot record at all is reported and NEVER actionable", () => {
    const r = run(reg({ p1__6: row() }), {});
    expect(r.counts.unverified).toBe(1);
    expect(r.actionableCount).toBe(0);
    expect(ACTIONABLE_CLASSES.has("unverified")).toBe(false);
  });

  it("A HALF-LOADED CATALOGUE MAKES NOTHING ACTIONABLE — absence is not evidence", () => {
    // The dangerous failure: products have not answered yet, every pid looks
    // deleted, and a bulk retire wipes the whole register.
    const r = classifyDisplayRecords({
      register: reg({ p1__6: row(), p2__7: row() }),
      slots: { "marathon-pe": { p1: liveSlot() } },
      hub: "hub1", productsById: {}, catalogueComplete: false,
    });
    expect(r.counts.gone).toBe(0);
    expect(r.byClass.matched).toHaveLength(1);            // p1 still judged on its slot
    expect(r.byClass.unverified).toHaveLength(1);         // p2 has no slot — unverified, not gone
  });

  it("a DEACTIVATED product is a NOTE, never a reason to act", () => {
    // A finished line can still have its last pair on a wall. "We stopped
    // restocking it" says nothing about the floor.
    const r = run(reg({ p5__6: row() }), { "marathon-pe": { p5: liveSlot() } });
    expect(r.counts.matched).toBe(1);
    expect(r.byClass.matched[0].deactivated).toBe(true);
    expect(r.actionableCount).toBe(0);
  });

  it("HUB-SCOPED: another hub's live slot cannot vouch for this hub's row", () => {
    const r = run(reg({ p1__6: row() }), { "marathon-pe": { p1: liveSlot({ bookedHub: "hub2" }) } });
    expect(r.counts.matched).toBe(0);
    expect(r.counts.unverified).toBe(1);      // no hub1 evidence, and a tombstone is not implied
  });

  it("a retired row (qty 0) is not a record any more", () => {
    const r = run(reg({ p1__6: row({ qty: 0, retiredAt: "2026-09-01T00:00:00.000Z" }) }), {});
    expect(r.actionableCount).toBe(0);
    expect(Object.values(r.counts).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("one-size sentinels and malformed keys are skipped entirely", () => {
    const r = run(reg({ p1___: row(), garbage: row(), p1__6: row() }), {});
    expect(Object.values(r.counts).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("empty and absent inputs are safe", () => {
    expect(classifyDisplayRecords({ register: null, slots: null, hub: "hub1", productsById: null }).actionableCount).toBe(0);
    expect(classifyDisplayRecords({ register: {}, slots: {}, hub: "hub1", productsById: new Map() }).counts)
      .toEqual(Object.fromEntries(CLEANUP_CLASSES.map((c) => [c, 0])));
  });

  it("accepts a Map catalogue as well as a plain object", () => {
    const r = classifyDisplayRecords({
      register: reg({ p4__6: row() }), slots: {}, hub: "hub1",
      productsById: new Map(Object.entries(P)),
    });
    expect(r.counts.gone).toBe(1);
  });

  it("newest registration first inside a class", () => {
    const r = run(reg({
      p1__6: row({ at: "2026-08-01T00:00:00.000Z" }),
      p2__7: row({ at: "2026-09-01T00:00:00.000Z" }),
      p3__8: row({ at: "2026-08-15T00:00:00.000Z" }),
    }), {});
    expect(r.byClass.unverified.map((x) => x.productId)).toEqual(["p2", "p3", "p1"]);
  });
});

describe("retirePlan — a slot is NEVER cleared from this screen", () => {
  it("passes no slotStores, whatever the class", () => {
    const r = run(reg({ p1__6: row() }), { "marathon-pe": { p1: liveSlot({ size: "8", sizeKey: "8" }) } });
    const plan = retirePlan(r.byClass.replaced[0], "hub1");
    expect(plan.slotStores).toEqual([]);
    // Clearing the live slot here would erase the CURRENT display and re-create
    // the duplicate-marker bug PR #574 closed.
    expect(plan).toEqual({ hub: "hub1", product: { id: "p1", name: "Air Force 1 White" }, sizeKey: "6", slotStores: [], times: 1, expectQty: 1 });
  });
  it("a retire plan is guarded by the qty it decided against", () => {
    // Without expectQty two admins each looking at the same row would each
    // retire against a stale view and take it further down than the evidence.
    const r = run(reg({ p1__6: row({ qty: 2 }) }), { "marathon-pe": { p1: tomb() }, trophy: { p1: tomb() } });
    const plan = retirePlan(r.byClass.sold[0], "hub1");
    expect(plan.times).toBe(2);
    expect(plan.expectQty).toBe(2);
  });
  it("the module never CALLS a slot writer", () => {
    // Comments may name them (the header explains how the unregistered rows
    // come about); code may not touch them. So the check is on the code with
    // comments stripped, not on the source text.
    const src = readFileSync(new URL("./displayRecordCleanup.js", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/setDisplaySlot\s*\(|clearDisplaySlot\s*\(/);
    // The one thing it may import from displaySlots is the pure predicate.
    expect(src).toMatch(/import \{ slotIsLive \} from "\.\/displaySlots"/);
  });
});

describe("retireKey / retireEffectLine", () => {
  it("the key separates hub, row and how many are being retired", () => {
    const r = { key: "p1__6", retireQty: 1 };
    expect(retireKey("hub1", r)).not.toBe(retireKey("hub2", r));
    expect(retireKey("hub1", r)).not.toBe(retireKey("hub1", { ...r, retireQty: 2 }));
    expect(retireKey("hub1", r)).toBe(retireKey("hub1", { ...r }));
  });
  it("says plainly that no stock moves and what the count will do", () => {
    expect(retireEffectLine({ retireQty: 1 })).toBe(
      "Retires 1 display record. No stock moves — the hub simply stops expecting this pair to be out at a shop, so the next count looks for it on the shelf.");
    expect(retireEffectLine({ retireQty: 3 })).toMatch(/Retires 3 display records\..*these pairs.*looks for them/);
  });
});

// ─── THE OTHER DIRECTION: a floor the register has never heard of ────────────
// The consequence is different from a stale row and the tests say so: the COUNT
// is fine (offShelf reads live slots directly), the REGISTER is what has the
// hole. So the bar here is lower than for retiring — registering records a fact
// about a pair that is already booked, and moves nothing.
describe("findUnregisteredDisplays", () => {
  const REG = { hub1: { p1__6: { qty: 1 } }, hub2: {} };
  const slot = (over = {}) => ({ size: "6", sizeKey: "6", bookedHub: "hub1", source: "display_refill", at: "2026-09-01T08:00:00.000Z", ...over });
  const find = (slots, over = {}) =>
    findUnregisteredDisplays({ slots, registerByHub: REG, productsById: P, ...over });

  it("a registered floor is not reported", () => {
    expect(find({ "marathon-pe": { p1: slot() } })).toEqual([]);
  });

  it("a floor with NO register row for the product is reported and registerable", () => {
    const r = find({ "marathon-pe": { p2: slot() } });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ store: "marathon-pe", productId: "p2", size: "6", bookedHub: "hub1", registerable: true });
    expect(r[0].reason).toMatch(/never heard of it/);
  });

  it("a floor registered at ANOTHER size is reported but NOT registerable", () => {
    // That is the Double Displays tab's business — registering here would claim
    // a SECOND display for one physical pair, which is the bug this all began with.
    const r = find({ "marathon-pe": { p1: slot({ size: "8", sizeKey: "8" }) } });
    expect(r).toHaveLength(1);
    expect(r[0].registerable).toBe(false);
    expect(r[0].registeredSizes).toEqual(["6"]);
    expect(r[0].reason).toMatch(/Double Displays|Display Records tab/);
  });

  it("a tombstoned slot is not a floor", () => {
    expect(find({ "marathon-pe": { p2: { size: null, sizeKey: null, bookedHub: "hub1" } } })).toEqual([]);
  });

  it("HUB-AWARE: a hub2 floor is judged against hub2's register, not hub1's", () => {
    // Without this a hub2 display reads as unregistered purely because the
    // screen happened to be looking at hub1.
    const withHub2 = { hub1: {}, hub2: { p1__6: { qty: 1 } } };
    const r = findUnregisteredDisplays({
      slots: { "marathon-pe": { p1: slot({ bookedHub: "hub2" }) } },
      registerByHub: withHub2, productsById: P,
    });
    expect(r).toEqual([]);
  });

  it("a floor booked at a hub with NO register is reported, not silently dropped", () => {
    const r = find({ "marathon-pine": { p2: slot({ bookedHub: "hub3" }) } });
    expect(r).toHaveLength(1);
    expect(r[0].registerable).toBe(false);
    expect(r[0].reason).toMatch(/keeps no display register/);
  });

  it("a zero-qty (retired) register row does not count as registered", () => {
    const spent = { hub1: { p1__6: { qty: 0, retiredAt: "2026-09-01T00:00:00.000Z" } }, hub2: {} };
    const r = findUnregisteredDisplays({ slots: { "marathon-pe": { p1: slot() } }, registerByHub: spent, productsById: P });
    expect(r).toHaveLength(1);
    expect(r[0].registerable).toBe(true);
  });

  it("newest floor first, and empty inputs are safe", () => {
    const r = find({
      "marathon-pe": { p2: slot({ at: "2026-08-01T00:00:00.000Z" }) },
      trophy: { p3: slot({ at: "2026-09-05T00:00:00.000Z" }) },
    });
    expect(r.map((x) => x.productId)).toEqual(["p3", "p2"]);
    expect(findUnregisteredDisplays({ slots: null, registerByHub: null, productsById: null })).toEqual([]);
  });

  it("registerKey separates store, product, size and hub", () => {
    const base = { store: "marathon-pe", productId: "p1", sizeKey: "6", bookedHub: "hub1" };
    expect(registerKey(base)).toBe(registerKey({ ...base }));
    for (const k of ["store", "productId", "sizeKey", "bookedHub"]) {
      expect(registerKey(base)).not.toBe(registerKey({ ...base, [k]: "x" }));
    }
  });
});

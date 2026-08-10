// ─── ONE-SIZE SOLVE — the explicit-target branch Solve never had ─────────────
// THE BUG (measured against the live snapshot, 2026-08-10): 356 stranded
// clothing cards, 34 of them with Solve greyed. 33 of those 34 are one-size
// products whose only catalogue size is the "_" sentinel — 32 beanies and a bag.
//
// The mirror in solvePlan.js reproduced resolveTarget's SECOND and THIRD
// branches (subcategory policy, then the size run) and omitted its FIRST: an
// explicit /stock_targets row. For a garment-sized product that omission is
// invisible, because the size run covers it anyway. For a one-size product it is
// total: "_" has no entry in a garment-letter run, and adding one was rejected
// outright by the owner (refill-engine.cjs — "_" is shared by every one-size
// product, so it would silently arm sunglasses, belts and jewellery too). An
// explicit row is therefore the ONLY target a one-size product can ever hold,
// and with that branch missing no configuration on earth could enable Solve for
// it. The button was not mis-computed; the class was locked out.
//
// These tests pin the branch, its two ordering rules (explicit outranks the run,
// explicit survives the kill switch), and the encoding the lookup must use.
import { describe, it, expect } from "vitest";
import { resolvedRun, explicitTarget, qualifyingSizes, solvePlan } from "./solvePlan";

// The live config, 2026-08-10 (/config/refillEngine).
const STD = {
  hub2: { L: 3, M: 3, S: 2, XL: 2, XXL: 2, XXXL: 1 },
  "marathon-pe": { L: 2, M: 2, S: 2, XL: 1, XXL: 1, XXXL: 1 },
  trophy: { L: 2, M: 2, S: 2, XL: 1, XXL: 1, XXXL: 1 },
};
// A beanie exactly as the catalogue holds it: one size, the "_" sentinel,
// 10 units at Central, carried nowhere. (p1786360754058 "Hugo Boss beanie
// black #3" is the largest at 20; this is the common shape.)
const BEANIE = "p1786357771559";
const ONE_SIZE = ["_"];
// The row an operator would write for it — the 5/15 policy, shop leg.
const row = (target, extra = {}) => ({ target, minQty: Math.max(1, target - 1), ...extra });

describe("explicitTarget — the engine's priority-1 source, keyed the engine's way", () => {
  it("reads a row for the one-size sentinel", () => {
    const targets = { trophy: { [BEANIE]: { _: row(5) } } };
    expect(explicitTarget(targets, "trophy", BEANIE, "_")).toBe(5);
  });
  it("ENCODES the size before looking up — /stock_targets keys are encoded", () => {
    // The half-size case is the one that separates a correct lookup from a
    // plausible one: the row can only be STORED as "5_5" (RTDB rejects "." in a
    // key), while the size flowing through this module is the raw "5.5". A raw
    // lookup finds nothing and reads as "no policy" — the exact encoded-vs-decoded
    // miss that silently zeroed whole sizes in the sneaker Solve.
    const targets = { trophy: { [BEANIE]: { "5_5": row(2) } } };
    expect(explicitTarget(targets, "trophy", BEANIE, "5.5")).toBe(2);
  });
  it("an explicit 0 is a real answer (deliberately excluded), not an absent row", () => {
    expect(explicitTarget({ trophy: { [BEANIE]: { _: row(0) } } }, "trophy", BEANIE, "_")).toBe(0);
  });
  it("absent rows, non-numeric and non-finite targets read as no row", () => {
    expect(explicitTarget({}, "trophy", BEANIE, "_")).toBe(null);
    expect(explicitTarget(null, "trophy", BEANIE, "_")).toBe(null);
    expect(explicitTarget({ trophy: { [BEANIE]: { _: { target: "5" } } } }, "trophy", BEANIE, "_")).toBe(null);
    expect(explicitTarget({ trophy: { [BEANIE]: { _: { target: NaN } } } }, "trophy", BEANIE, "_")).toBe(null);
  });
});

describe("a one-size product with stock at a source is solvable, exactly like a sized one", () => {
  // Central-stranded, so BOTH hub2 and the store must hold a target — the
  // load-bearing seedLocations rule, unchanged by any of this.
  const targets = {
    hub2: { [BEANIE]: { _: row(15) } },
    trophy: { [BEANIE]: { _: row(5, { reorderPoint: 0 }) } },
  };
  const run = () => resolvedRun({
    std: STD, subRun: undefined, subcategory: "Caps & Hats", sizes: ONE_SIZE,
    targets, pid: BEANIE, ruleBasedTargets: true,
  });

  it("qualifies its one size once a row exists at every seed location", () => {
    expect(qualifyingSizes(ONE_SIZE, "central", "trophy", run())).toEqual(["_"]);
  });

  it("was NOT solvable before the row — greying with no policy stays correct", () => {
    const bare = resolvedRun({ std: STD, sizes: ONE_SIZE, targets: {}, pid: BEANIE, ruleBasedTargets: true });
    expect(qualifyingSizes(ONE_SIZE, "central", "trophy", bare)).toEqual([]);
  });

  it("a row at the store but NOT at hub2 does not solve a central-stranded product", () => {
    // Seeding the store alone leaves the engine's first leg (central→hub2) with
    // nothing to raise, so the shop would never actually be fed.
    const storeOnly = resolvedRun({
      std: STD, sizes: ONE_SIZE, targets: { trophy: { [BEANIE]: { _: row(5) } } },
      pid: BEANIE, ruleBasedTargets: true,
    });
    expect(qualifyingSizes(ONE_SIZE, "central", "trophy", storeOnly)).toEqual([]);
    // …but it IS enough for a hub2-stranded one, which only seeds the store.
    expect(qualifyingSizes(ONE_SIZE, "hub2", "trophy", storeOnly)).toEqual(["_"]);
  });

  it("the confirm estimate reads the row's numbers, not a garment run", () => {
    const p = solvePlan({ std: run(), sizes: ONE_SIZE, source: "central", store: "trophy", availAt: () => 10 });
    expect(p.storeUnits).toBe(5);    // the shop leg
    expect(p.hubUnits).toBe(15);     // the hub buffer leg
    expect(p.twoLeg).toBe(true);
    expect(p.cover).toBe(10);        // Central holds 10 of the 15 hub2 wants
  });

  it("an explicit 0 keeps it deliberately excluded", () => {
    const excluded = resolvedRun({
      std: STD, sizes: ONE_SIZE, pid: BEANIE, ruleBasedTargets: true,
      targets: { hub2: { [BEANIE]: { _: row(15) } }, trophy: { [BEANIE]: { _: row(0) } } },
    });
    expect(qualifyingSizes(ONE_SIZE, "central", "trophy", excluded)).toEqual([]);
  });
});

describe("branch ORDER — the two rules that make this a mirror and not an approximation", () => {
  it("an explicit row OUTRANKS the size run (resolveTarget's first branch)", () => {
    // M is 2 at Trophy by the run; the row says 7 and must win, because the
    // engine takes the row and never consults the run.
    const run = resolvedRun({
      std: STD, sizes: ["M"], pid: "tee", ruleBasedTargets: true,
      targets: { trophy: { tee: { M: row(7) } } },
    });
    expect(run.trophy.M).toBe(7);
  });

  it("an explicit row SURVIVES the kill switch; the size run does not", () => {
    // resolveTarget returns an explicit row BEFORE `if (!ruleTargetsEnabled)`,
    // so switching rule-based targets off reverts the engine to explicit-only —
    // it does not stop it refilling those rows. Solve must not grey them either.
    const off = resolvedRun({
      std: STD, sizes: ["M"], pid: "tee", ruleBasedTargets: false,
      targets: { hub2: { tee: { M: row(3) } }, trophy: { tee: { M: row(2) } } },
    });
    expect(qualifyingSizes(["M"], "central", "trophy", off)).toEqual(["M"]);
    // …while a rule-only product goes dark at the same setting.
    const ruleOnly = resolvedRun({ std: STD, sizes: ["M"], pid: "tee2", targets: {}, ruleBasedTargets: false });
    expect(qualifyingSizes(["M"], "central", "trophy", ruleOnly)).toEqual([]);
  });

  it("the kill switch is per destination, exactly as the engine reads it", () => {
    const run = resolvedRun({ std: STD, sizes: ["M"], pid: "tee", targets: {}, ruleBasedTargets: { hub2: true } });
    expect(qualifyingSizes(["M"], "central", "trophy", run)).toEqual([]);   // trophy off
    expect(qualifyingSizes(["M"], "hub2", "trophy", run)).toEqual([]);      // trophy still off
  });

  it("a location reachable ONLY through an explicit row is still considered", () => {
    // defaultRunByStore names three locations; a row may name a fourth.
    const run = resolvedRun({
      std: STD, sizes: ["_"], pid: BEANIE, ruleBasedTargets: true,
      targets: { hub3: { [BEANIE]: { _: row(4) } } },
    });
    expect(run.hub3).toEqual({ _: 4 });
  });
});

describe("a SIZED product's solve behaviour is unchanged", () => {
  // The regression guard for the whole change: with no explicit rows anywhere,
  // resolvedRun must be byte-identical to the effectiveStandard it replaced.
  const sizes = ["S", "M", "L", "XL", "XXL"];
  it("with no explicit rows, the resolved run IS the size run", () => {
    expect(resolvedRun({ std: STD, sizes, pid: "jersey", targets: {}, ruleBasedTargets: true })).toEqual(STD);
    expect(resolvedRun({ std: STD, sizes, pid: "jersey", targets: null, ruleBasedTargets: true })).toEqual(STD);
  });
  it("qualifying sizes and the estimate are what they always were", () => {
    const run = resolvedRun({ std: STD, sizes, pid: "jersey", targets: {}, ruleBasedTargets: true });
    expect(qualifyingSizes(sizes, "central", "trophy", run)).toEqual(sizes);
    const p = solvePlan({ std: run, sizes, source: "hub2", store: "trophy", availAt: () => 99 });
    expect(p.storeUnits).toBe(2 + 2 + 2 + 1 + 1);
    expect(p.twoLeg).toBe(false);
  });
  it("a size the run has no standard for stays excluded", () => {
    const run = resolvedRun({ std: STD, sizes: ["28", "30"], pid: "jeans", targets: {}, ruleBasedTargets: true });
    expect(qualifyingSizes(["28", "30"], "hub2", "trophy", run)).toEqual([]);
  });
  it("the subcategory policy still wins over the size run (watches keep 2)", () => {
    const run = resolvedRun({
      std: STD, subRun: { hub2: { Watches: 2 }, trophy: { Watches: 2 } }, subcategory: "Watches",
      sizes: ["_"], pid: "watch", targets: {}, ruleBasedTargets: true,
    });
    expect(qualifyingSizes(["_"], "central", "trophy", run)).toEqual(["_"]);
  });
  it("…and an explicit row still outranks even that", () => {
    const run = resolvedRun({
      std: STD, subRun: { trophy: { Watches: 2 } }, subcategory: "Watches",
      sizes: ["_"], pid: "watch", ruleBasedTargets: true,
      targets: { trophy: { watch: { _: row(6) } } },
    });
    expect(run.trophy._).toBe(6);
  });
  it("survives missing inputs without throwing", () => {
    expect(() => resolvedRun({})).not.toThrow();
    expect(resolvedRun({})).toEqual({});
  });
});

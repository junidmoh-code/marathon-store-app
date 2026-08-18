import { describe, it, expect } from "vitest";
import { seedLocations, standardUnits, solvePlan, qualifyingSizes, effectiveStandard, ruleTargetsEnabledFor, explicitTarget, resolvedRun } from "./solvePlan";

describe("ruleTargetsEnabledFor — mirrors the engine's kill switch", () => {
  it("true means on everywhere", () => {
    expect(ruleTargetsEnabledFor(true, "trophy")).toBe(true);
    expect(ruleTargetsEnabledFor(true, "hub2")).toBe(true);
  });
  it("an object is per-destination, and absent means off", () => {
    const v = { trophy: true, hub2: false };
    expect(ruleTargetsEnabledFor(v, "trophy")).toBe(true);
    expect(ruleTargetsEnabledFor(v, "hub2")).toBe(false);
    expect(ruleTargetsEnabledFor(v, "marathon-pe")).toBe(false);
  });
  it("anything else is OFF — the fail-safe direction", () => {
    for (const v of [false, undefined, null, 0, 1, "true", [], [true]]) {
      expect(ruleTargetsEnabledFor(v, "trophy")).toBe(false);
    }
  });
  it("a truthy-but-not-true per-destination value is still off", () => {
    expect(ruleTargetsEnabledFor({ trophy: 1 }, "trophy")).toBe(false);
    expect(ruleTargetsEnabledFor({ trophy: "yes" }, "trophy")).toBe(false);
  });
});

const STD = {
  hub2: { L: 3, M: 3, S: 2, XL: 2, XXL: 2, XXXL: 1 },
  trophy: { L: 2, M: 2, S: 2, XL: 1, XXL: 1, XXXL: 1 },
  "marathon-pe": { L: 2, M: 2, S: 2, XL: 1, XXL: 1, XXXL: 1 },
};

// The live watch policy (config.subcategoryRunByLocation), 2026-08-03.
const WATCH_POLICY = { hub2: { Watches: 2 }, trophy: { Watches: 2 }, "marathon-pe": { Watches: 2 } };

describe("effectiveStandard — mirrors the engine's subcategory policy", () => {
  it("a policy subcategory replaces the size run for that product", () => {
    const eff = effectiveStandard({ std: STD, subRun: WATCH_POLICY, subcategory: "Watches", sizes: ["_"] });
    expect(eff.trophy).toEqual({ _: 2 });
    expect(eff.hub2).toEqual({ _: 2 });
  });
  it("makes a one-size product solvable — the whole point", () => {
    const eff = effectiveStandard({ std: STD, subRun: WATCH_POLICY, subcategory: "Watches", sizes: ["_"] });
    expect(qualifyingSizes(["_"], "central", "trophy", eff)).toEqual(["_"]);
    // …and the estimate is the policy number at each leg, not a garment run.
    const p = solvePlan({ std: eff, sizes: ["_"], source: "central", store: "trophy", availAt: () => 174 });
    expect(p.storeUnits).toBe(2);
    expect(p.hubUnits).toBe(2);
  });
  it("leaves every other product's run untouched", () => {
    const eff = effectiveStandard({ std: STD, subRun: WATCH_POLICY, subcategory: "Eyewear", sizes: ["_"] });
    expect(eff).toEqual(STD);
    expect(qualifyingSizes(["_"], "hub2", "trophy", eff)).toEqual([]);   // sunglasses stay unsolvable
  });
  it("no subcategory, no policy node, or a non-positive value → the size run", () => {
    for (const args of [
      { subRun: WATCH_POLICY, subcategory: undefined },
      { subRun: {}, subcategory: "Watches" },
      { subRun: { trophy: { Watches: 0 } }, subcategory: "Watches" },
      { subRun: { trophy: { Watches: -2 } }, subcategory: "Watches" },
      { subRun: { trophy: { Watches: "2" } }, subcategory: "Watches" },
    ]) {
      expect(effectiveStandard({ std: STD, sizes: ["_"], ...args }).trophy).toEqual(STD.trophy);
    }
  });
  it("a garment-sized product in a policy subcategory gets the policy at every size", () => {
    // The two watches mis-filed with S/M — 'watches keep 2' must hold for them too.
    const eff = effectiveStandard({ std: STD, subRun: WATCH_POLICY, subcategory: "Watches", sizes: ["S"] });
    expect(eff.trophy).toEqual({ S: 2 });
    expect(eff.hub2).toEqual({ S: 2 });   // not the hub2 garment run
  });
  it("a non-string subcategory is refused, exactly as the engine refuses it", () => {
    // A numeric subcategory with a matching policy key: the engine's
    // `typeof sub === "string"` check rejects it, so this must too, or Solve
    // would enable a seed the engine never honours.
    const eff = effectiveStandard({ std: STD, subRun: { trophy: { 7: 2 } }, subcategory: 7, sizes: ["_"] });
    expect(eff.trophy).toEqual(STD.trophy);
    expect(effectiveStandard({ std: STD, subRun: WATCH_POLICY, subcategory: "", sizes: ["_"] }).trophy).toEqual(STD.trophy);
  });
  it("an array where the per-location map belongs is not indexed into", () => {
    expect(effectiveStandard({ std: STD, subRun: { trophy: [2] }, subcategory: "Watches", sizes: ["_"] }).trophy).toEqual(STD.trophy);
  });
  it("survives missing inputs without throwing", () => {
    expect(effectiveStandard({})).toEqual({});
    expect(effectiveStandard({ std: STD, subRun: null, subcategory: "Watches", sizes: null }).trophy).toEqual(STD.trophy);
  });
});

describe("qualifyingSizes — only sizes the engine has a standard for (Codex fix a)", () => {
  it("hub2-stranded: keeps sizes with a store standard, drops the rest", () => {
    // "34" (a waist/numeric size) has no standard → excluded; letters kept.
    expect(qualifyingSizes(["S", "M", "34", "L"], "hub2", "trophy", STD)).toEqual(["S", "M", "L"]);
  });
  it("central-stranded: a size must have a standard at BOTH hub2 AND the store", () => {
    // Contrive a size present at store but not hub2 → excluded for a central solve.
    const std = { hub2: { M: 3 }, trophy: { M: 2, L: 2 } };
    expect(qualifyingSizes(["M", "L"], "central", "trophy", std)).toEqual(["M"]); // L lacks a hub2 standard
    expect(qualifyingSizes(["M", "L"], "hub2", "trophy", std)).toEqual(["M", "L"]); // hub2-stranded only needs the store
  });
  it("no qualifying sizes → empty (product is not solvable)", () => {
    expect(qualifyingSizes(["28", "30", "32"], "hub2", "trophy", STD)).toEqual([]);
    expect(qualifyingSizes([], "hub2", "trophy", STD)).toEqual([]);
  });
  it("case-insensitive", () => {
    expect(qualifyingSizes(["m", "l"], "hub2", "trophy", STD)).toEqual(["m", "l"]);
  });
});

describe("seedLocations — the load-bearing rule", () => {
  it("central-stranded seeds Hub 2 AND the store (first leg needs Hub 2 carried)", () => {
    expect(seedLocations("central", "trophy")).toEqual(["hub2", "trophy"]);
    expect(seedLocations("central", "marathon-pe")).toEqual(["hub2", "marathon-pe"]);
  });
  it("hub2-stranded seeds the store only", () => {
    expect(seedLocations("hub2", "trophy")).toEqual(["trophy"]);
  });
});

describe("standardUnits", () => {
  it("sums the size-standard over catalog sizes (Real Madrid jersey → Trophy = 8)", () => {
    expect(standardUnits(STD.trophy, ["S", "M", "L", "XL", "XXL"])).toBe(2 + 2 + 2 + 1 + 1);
  });
  it("is case-insensitive and skips sizes with no standard", () => {
    expect(standardUnits(STD.trophy, ["m", "l", "5XL"])).toBe(2 + 2);
  });
  it("empty / missing inputs are 0", () => {
    expect(standardUnits(STD.trophy, [])).toBe(0);
    expect(standardUnits(undefined, ["M"])).toBe(0);
  });
});

describe("solvePlan", () => {
  it("hub2-stranded: one leg, coverage vs Hub 2 (worked example)", () => {
    const availAt = (loc, sz) => (loc === "hub2" ? ({ S: 2, M: 3, L: 3, XL: 3, XXL: 2 }[sz] || 0) : 0);
    const p = solvePlan({ std: STD, sizes: ["S", "M", "L", "XL", "XXL"], source: "hub2", store: "trophy", availAt });
    expect(p.twoLeg).toBe(false);
    expect(p.storeUnits).toBe(8);
    expect(p.cover).toBe(8);        // Hub 2 covers all 8
    expect(p.coverLoc).toBe("Hub 2");
  });
  it("hub2-stranded: partial coverage reported honestly", () => {
    const availAt = (loc, sz) => (loc === "hub2" ? ({ S: 1, M: 0, L: 2 }[sz] || 0) : 0);
    const p = solvePlan({ std: STD, sizes: ["S", "M", "L"], source: "hub2", store: "trophy", availAt });
    expect(p.storeUnits).toBe(6);   // 2+2+2
    expect(p.cover).toBe(3);        // min(2,1)+min(2,0)+min(2,2)=1+0+2
  });
  it("central-stranded: two legs, Hub 2 buffer coverage vs Central", () => {
    const availAt = (loc, sz) => (loc === "central" ? 5 : 0);
    const p = solvePlan({ std: STD, sizes: ["M", "L", "XL"], source: "central", store: "trophy", availAt });
    expect(p.twoLeg).toBe(true);
    expect(p.storeUnits).toBe(2 + 2 + 1);   // Trophy standard = 5
    expect(p.hubUnits).toBe(3 + 3 + 2);     // Hub 2 standard = 8
    expect(p.cover).toBe(8);                // Central has ≥ each size's hub standard
  });
  it("no availAt → coverage 0, never throws", () => {
    const p = solvePlan({ std: STD, sizes: ["M"], source: "hub2", store: "trophy" });
    expect(p.cover).toBe(0);
    expect(p.storeUnits).toBe(2);
  });
});

// ═══ CATEGORY POLICY — the engine's standing owner-armed source, mirrored ═════
// (2026-08-13.) resolveTarget resolves /config/refillEngine/categoryPolicy
// between explicit rows and the rule standards; these tests pin this file's
// mirror of it: same validation, same two size modes, same precedence, same
// survival of the kill switch.
import { categoryRun, resolvedRun, categoryPolicyLocs } from "./solvePlan";

const POLICY = {
  perfumes: {
    "marathon-pe": { target: 8, reorderPoint: 3, minQty: 4 },
    hub2: { target: 10, reorderPoint: 5, minQty: 5 },
  },
  "fitted-caps": {
    perSize: true,
    "marathon-pe": { target: 2, reorderPoint: 0 },
    hub2: { target: 5, reorderPoint: 0 },
  },
};

describe("categoryRun — the map folded into the { loc: { SIZE: target } } shape", () => {
  it("one-size mode speaks for the '_' sentinel ONLY, at exactly the mapped locations", () => {
    const run = categoryRun({ policy: POLICY, categoryKey: "perfumes", sizes: ["_"] });
    expect(run).toEqual({ "marathon-pe": { _: 8 }, hub2: { _: 10 } });
    expect(run.trophy).toBeUndefined();   // decision 5: unnamed locations get nothing
  });
  it("per-size mode covers every declared size, with dead sizes at an EXPLICIT 0", () => {
    const units = { S: 3, M: 1, XXXL: 0 };
    const run = categoryRun({
      policy: POLICY, categoryKey: "fitted-caps", sizes: ["S", "M", "XXXL"],
      unitsAnywhere: (sz) => units[sz] || 0,
    });
    expect(run["marathon-pe"]).toEqual({ S: 2, M: 2, XXXL: 0 });
    expect(run.hub2).toEqual({ S: 5, M: 5, XXXL: 0 });
  });
  it("arms NOTHING for an unmapped key, a missing map, or a malformed entry — fail-safe both sides", () => {
    expect(categoryRun({ policy: POLICY, categoryKey: "t-shirts", sizes: ["M"] })).toEqual({});
    expect(categoryRun({ policy: undefined, categoryKey: "perfumes", sizes: ["_"] })).toEqual({});
    expect(categoryRun({ policy: POLICY, categoryKey: undefined, sizes: ["_"] })).toEqual({});
    expect(categoryRun({ policy: POLICY, categoryKey: "", sizes: ["_"] })).toEqual({});
    for (const bad of [
      { "marathon-pe": { target: "8" } },
      { "marathon-pe": { target: -2 } },
      { "marathon-pe": { target: Infinity } },
      { "marathon-pe": 8 },
      ["not", "a", "map"],
    ]) {
      expect(categoryRun({ policy: { perfumes: bad }, categoryKey: "perfumes", sizes: ["_"] })).toEqual({});
    }
  });
});

describe("resolvedRun with the category policy — precedence is the engine's, exactly", () => {
  it("a mapped row-less perfume qualifies at the mapped legs with no run and no rows", () => {
    const run = resolvedRun({
      std: {}, sizes: ["_"], targets: null, pid: "scent1",
      ruleBasedTargets: true, categoryPolicy: POLICY, categoryKey: "perfumes",
    });
    expect(run["marathon-pe"]).toEqual({ _: 8 });
    expect(run.hub2).toEqual({ _: 10 });
    expect(qualifyingSizes(["_"], "central", "marathon-pe", run)).toEqual(["_"]);
    expect(qualifyingSizes(["_"], "central", "trophy", run)).toEqual([]);
  });
  it("an explicit row still WINS over the map — including an explicit 0", () => {
    const targets = { "marathon-pe": { scent1: { _: { target: 3 } } }, hub2: { scent1: { _: { target: 0 } } } };
    const run = resolvedRun({
      std: {}, sizes: ["_"], targets, pid: "scent1",
      ruleBasedTargets: true, categoryPolicy: POLICY, categoryKey: "perfumes",
    });
    expect(run["marathon-pe"]._).toBe(3);
    expect(run.hub2._).toBe(0);   // deliberately excluded beats the map's 10
  });
  it("the map survives the kill switch while the rule standards die with it", () => {
    const run = resolvedRun({
      std: { "marathon-pe": { M: 2 } }, sizes: ["_", "M"], targets: null, pid: "x",
      ruleBasedTargets: false, categoryPolicy: POLICY, categoryKey: "perfumes",
    });
    expect(run["marathon-pe"]).toEqual({ _: 8 });   // map alive, run dead
  });
  it("one-size mode never touches letter sizes — an uncollapsed mapped product keeps its run", () => {
    const run = resolvedRun({
      std: { "marathon-pe": { M: 2 } }, sizes: ["M"], targets: null, pid: "cap1",
      ruleBasedTargets: true, categoryPolicy: { "caps-beanies": { "marathon-pe": { target: 5 } } }, categoryKey: "caps-beanies",
    });
    expect(run["marathon-pe"].M).toBe(2);   // the garment run, untouched
    expect(run["marathon-pe"]._).toBe(5);   // the sentinel, mapped
  });
  it("per-size mode BEATS the garment run, dead-size 0 included", () => {
    const run = resolvedRun({
      std: { "marathon-pe": { S: 1, M: 2, XXXL: 1 } }, sizes: ["S", "M", "XXXL"], targets: null, pid: "fc1",
      ruleBasedTargets: true, categoryPolicy: POLICY, categoryKey: "fitted-caps",
      unitsAnywhere: (sz) => (sz === "XXXL" ? 0 : 4),
    });
    expect(run["marathon-pe"]).toEqual({ S: 2, M: 2, XXXL: 0 });
    // The dead size fails the qualifying test — it can never be seeded.
    expect(qualifyingSizes(["S", "M", "XXXL"], "hub2", "marathon-pe", run)).toEqual(["S", "M"]);
  });
  it("a product outside the map resolves byte-for-byte as before the map existed", () => {
    const args = { std: { "marathon-pe": { M: 2 }, hub2: { M: 3 } }, sizes: ["M"], targets: null, pid: "tee1", ruleBasedTargets: true };
    expect(resolvedRun({ ...args, categoryPolicy: POLICY, categoryKey: "t-shirts" }))
      .toEqual(resolvedRun(args));
  });
});

describe("categoryPolicyLocs + the Introduce-Existing guard (Sonnet review, PR #352)", () => {
  it("names exactly the validly-mapped locations, and nothing for malformed entries", () => {
    expect(categoryPolicyLocs(POLICY, "perfumes").sort()).toEqual(["hub2", "marathon-pe"]);
    expect(categoryPolicyLocs(POLICY, "fitted-caps").sort()).toEqual(["hub2", "marathon-pe"]);
    expect(categoryPolicyLocs(POLICY, "t-shirts")).toEqual([]);
    expect(categoryPolicyLocs(undefined, "perfumes")).toEqual([]);
    expect(categoryPolicyLocs(POLICY, undefined)).toEqual([]);
    expect(categoryPolicyLocs({ perfumes: { "marathon-pe": { target: "8" } } }, "perfumes")).toEqual([]);
    expect(categoryPolicyLocs({ perfumes: { perSize: true } }, "perfumes")).toEqual([]);
  });
  it("per-size mode REFUSES the '_' sentinel — mirrored with the engine", () => {
    const run = categoryRun({
      policy: POLICY, categoryKey: "fitted-caps", sizes: ["_", "M"],
      unitsAnywhere: () => 4,
    });
    expect(run["marathon-pe"]).toEqual({ M: 2 });   // no "_" key, ever
    expect(run.hub2).toEqual({ M: 5 });
  });
});

// ─── THE INTRODUCE ROW, MIRRORED (scripts/stage-introduce-set.mjs) ────────────
// The Option B introduce set writes rows carrying `introduce: true` and NO numeric
// `target`, so the hub2 size run keeps deciding the quantities. That only holds if
// BOTH readers agree the row is not an explicit pin — the engine's resolveTarget
// (pinned in functions/test/introduce-row-shape.test.cjs) and this file's mirror.
// If they ever disagree, Solve renders a target the engine is not serving, or greys
// one it is: the exact lie resolvedRun exists to prevent, and the reason #342 wrote
// the mirror in the first place.
describe("explicitTarget — an introduce-only row is not an explicit target", () => {
  const PID = "p1784206551366";                       // "Nike NOCTA Golf T-Shirt White"
  const ROW = { introduce: true, introducedAt: "2026-08-18T09:00:00.000Z", introducedBy: "scripts/stage-introduce-set.mjs" };
  const targets = { hub2: { [PID]: { S: { ...ROW }, M: { ...ROW }, L: { ...ROW } } } };

  it("returns null, so the size run is reached", () => {
    for (const size of ["S", "M", "L"]) {
      expect(explicitTarget(targets, "hub2", PID, size)).toBe(null);
    }
  });

  it("still returns the number once one is added — the contrast that justifies omitting it", () => {
    const pinned = { hub2: { [PID]: { ...targets.hub2[PID], M: { ...ROW, target: 1, minQty: 1 } } } };
    expect(explicitTarget(pinned, "hub2", PID, "M")).toBe(1);
    expect(explicitTarget(pinned, "hub2", PID, "L")).toBe(null);
  });

  it("target: 0 on an introduce row still reads as the excluded row it is", () => {
    const off = { hub2: { [PID]: { ...targets.hub2[PID], L: { ...ROW, target: 0, minQty: 0 } } } };
    expect(explicitTarget(off, "hub2", PID, "L")).toBe(0);
  });

  it("resolvedRun therefore hands the introduce-only sizes to the run", () => {
    const run = resolvedRun({
      std: { hub2: { S: 2, M: 3, L: 3, XL: 2, XXL: 2 } },
      subRun: {}, subcategory: "T-Shirts", sizes: ["S", "M", "L"],
      targets, pid: PID, ruleBasedTargets: true, categoryPolicy: {}, categoryKey: "t-shirts",
      unitsAnywhere: () => 0,
    });
    expect(run.hub2).toMatchObject({ S: 2, M: 3, L: 3 });
  });
});

import { describe, it, expect } from "vitest";
import { seedLocations, standardUnits, solvePlan, qualifyingSizes, effectiveStandard } from "./solvePlan";

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

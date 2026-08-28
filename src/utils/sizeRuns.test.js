// ─── SIZE RUNS — the invariants the admin tab stands on ──────────────────────
// Four things are load-bearing here and each is pinned:
//   1. ADD-ONLY: no code path removes, renames or reorders an existing size.
//   2. DUPLICATES BLOCKED: exact and near-identical spellings ("XXXXL" vs
//      "4XL") are refused, in-run and across runs — sizes are stock cell keys,
//      and a second spelling silently splits stock.
//   3. SORT POSITION: apparel letters and numeric runs each have an explicit
//      comparator; new sizes land in position, never alphabetically.
//   4. FALLBACK: a partial or missing registry can never blank a size grid,
//      and migrating the seed categories onto runs changes NO derivation.

import { describe, it, expect } from "vitest";
import {
  compareSizes, normalizeSizeInput, canonicalSizeKey, validateNewSize,
  appendSizeToRun, addSizeToRun, SIZE_RUN_SEED, runSizes, sizeRunsOf, sizesForCat,
  xlCount, xsCount,
} from "./sizeRuns.js";
import {
  TAXONOMY_SEED, SIZES_APPAREL, SIZES_FOOTWEAR, SIZES_KIDS, SIZES_FITTED_CAP,
  SIZES_GLOVES, ONE_SIZE_SENTINEL, sizesOf, legacyFor, catByKey,
} from "./productTaxonomy.js";

// ── The comparator ───────────────────────────────────────────────────────────
describe("compareSizes", () => {
  it("orders the full apparel ladder: XXS < XS < S < M < L < XL < XXL < XXXL < 4XL < 5XL", () => {
    const ladder = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL", "5XL"];
    for (let i = 0; i < ladder.length - 1; i++) {
      expect(compareSizes(ladder[i], ladder[i + 1])).toBeLessThan(0);
      expect(compareSizes(ladder[i + 1], ladder[i])).toBeGreaterThan(0);
    }
  });
  it("treats X-count and numeric-prefix forms as the same rank (XXXXL == 4XL)", () => {
    expect(compareSizes("XXXXL", "4XL")).toBe(0);
    expect(compareSizes("XXL", "2XL")).toBe(0);
  });
  it("sorts numeric runs numerically, halves included (5 < 5.5 < 6 < 10 < 13)", () => {
    expect(compareSizes("5", "5.5")).toBeLessThan(0);
    expect(compareSizes("5.5", "6")).toBeLessThan(0);
    expect(compareSizes("9", "10")).toBeLessThan(0);   // NOT string order
    expect(compareSizes("10", "13")).toBeLessThan(0);
  });
  it("is total on mixed input (numbers before letters — deterministic, tested, never NaN)", () => {
    expect(compareSizes("10", "M")).toBeLessThan(0);
    expect(compareSizes("M", "10")).toBeGreaterThan(0);
    expect(Number.isNaN(compareSizes("??", "M"))).toBe(false);
  });
  it("xlCount / xsCount parse both families", () => {
    expect(xlCount("XL")).toBe(1);
    expect(xlCount("XXXL")).toBe(3);
    expect(xlCount("4XL")).toBe(4);
    expect(xlCount("M")).toBe(null);
    expect(xsCount("XS")).toBe(1);
    expect(xsCount("2XS")).toBe(2);
  });
});

// ── Normalisation + canonical folding ────────────────────────────────────────
describe("normalizeSizeInput", () => {
  it("uppercases, strips whitespace, canonicalises numbers", () => {
    expect(normalizeSizeInput(" 4xl ")).toBe("4XL");
    expect(normalizeSizeInput("xxxl")).toBe("XXXL");
    expect(normalizeSizeInput("05")).toBe("5");
    expect(normalizeSizeInput("5.50")).toBe("5.5");
  });
  it("refuses garbage: empty, illegal chars, absurd length", () => {
    expect(normalizeSizeInput("")).toBe(null);
    expect(normalizeSizeInput("  ")).toBe(null);
    expect(normalizeSizeInput("5/6")).toBe(null);
    expect(normalizeSizeInput("a".repeat(20))).toBe(null);
    expect(normalizeSizeInput("$XL")).toBe(null);
  });
  it("the one-size sentinel cannot be produced by typing", () => {
    expect(normalizeSizeInput("_")).toBe(null);
    expect(normalizeSizeInput(" _ ")).toBe(null);
  });
});

describe("canonicalSizeKey", () => {
  it("folds every spelling of one physical size to one key", () => {
    expect(canonicalSizeKey("XXXXL")).toBe(canonicalSizeKey("4XL"));
    expect(canonicalSizeKey("xxl")).toBe(canonicalSizeKey("2XL"));
    expect(canonicalSizeKey("XXXL")).toBe(canonicalSizeKey("3XL"));
    expect(canonicalSizeKey("5.0")).toBe(canonicalSizeKey("5"));
    expect(canonicalSizeKey("XXS")).toBe(canonicalSizeKey("2XS"));
  });
  it("does NOT fold distinct sizes", () => {
    expect(canonicalSizeKey("4XL")).not.toBe(canonicalSizeKey("5XL"));
    expect(canonicalSizeKey("5")).not.toBe(canonicalSizeKey("5.5"));
    expect(canonicalSizeKey("M")).not.toBe(canonicalSizeKey("L"));
  });
});

// ── Duplicate blocking ───────────────────────────────────────────────────────
describe("validateNewSize", () => {
  const runs = {
    apparel: { label: "Apparel", sizes: ["S", "M", "L", "XL", "XXL", "XXXL", "4XL"] },
    gloves: { label: "Gloves", sizes: ["M", "L"] },
    footwear: { label: "Footwear", sizes: ["3", "4", "5", "5.5", "6"] },
  };
  it("rejects an exact match in the target run", () => {
    const v = validateNewSize(runs, "apparel", "XXL");
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("exact-duplicate");
  });
  it("BLOCKS a near-identical spelling in the target run, naming the existing size", () => {
    for (const typed of ["XXXXL", "xxxxl", " 4 XL "]) {
      const v = validateNewSize(runs, "apparel", typed);
      expect(v.ok).toBe(false);
      expect(v.existing).toBe("4XL");
      expect(v.message).toContain("4XL");
    }
    const v3 = validateNewSize(runs, "apparel", "3XL");   // vs existing XXXL
    expect(v3.ok).toBe(false);
    expect(v3.existing).toBe("XXXL");
  });
  it("BLOCKS a different spelling of a size that exists in ANOTHER run", () => {
    const v = validateNewSize(runs, "gloves", "XXXXL");   // apparel spells it 4XL
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("near-duplicate-other-run");
    expect(v.existing).toBe("4XL");
  });
  it("ALLOWS the identical spelling in another run (M lives in gloves AND apparel today)", () => {
    const v = validateNewSize(runs, "footwear", "M");
    expect(v.ok).toBe(true);
    expect(v.size).toBe("M");
  });
  it("numeric near-duplicates fold too (5.0 vs 5)", () => {
    const v = validateNewSize(runs, "footwear", "5.0");
    expect(v.ok).toBe(false);
    expect(v.existing).toBe("5");
  });
  it('the reserved "_" sentinel can never be created', () => {
    const v = validateNewSize(runs, "apparel", "_");
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("reserved");
    expect(validateNewSize(runs, "apparel", " _ ").ok).toBe(false);
  });
  it("accepts a genuinely new size, normalised", () => {
    const v = validateNewSize(runs, "apparel", "5xl");
    expect(v).toEqual({ ok: true, size: "5XL" });
  });
});

// ── Add-only append in correct sort position ─────────────────────────────────
describe("appendSizeToRun / addSizeToRun", () => {
  it("inserts 4XL after XXXL, not alphabetically", () => {
    expect(appendSizeToRun(["S", "M", "L", "XL", "XXL", "XXXL"], "4XL"))
      .toEqual(["S", "M", "L", "XL", "XXL", "XXXL", "4XL"]);
  });
  it("inserts XS before S, 5XL at the end", () => {
    expect(appendSizeToRun(["S", "M", "L"], "XS")).toEqual(["XS", "S", "M", "L"]);
    expect(appendSizeToRun(["S", "M", "L", "XL", "XXL", "XXXL", "4XL"], "5XL"))
      .toEqual(["S", "M", "L", "XL", "XXL", "XXXL", "4XL", "5XL"]);
  });
  it("inserts numerically into a numeric run (12 between 11 and 13, 6.5 between 6 and 7)", () => {
    expect(appendSizeToRun(["10", "11", "13"], "12")).toEqual(["10", "11", "12", "13"]);
    expect(appendSizeToRun(["5", "6", "7"], "6.5")).toEqual(["5", "6", "6.5", "7"]);
  });
  it("NEVER reorders an existing run — a hand-scrambled run keeps its order, byte for byte", () => {
    const odd = ["XL", "S", "M"];   // console-scrambled
    const out = appendSizeToRun(odd, "4XL");
    // The original three appear in their original relative order.
    const survivors = out.filter((s) => odd.includes(s));
    expect(survivors).toEqual(odd);
    expect(out).toHaveLength(4);
  });
  it("the result is ALWAYS the old list plus exactly one insertion", () => {
    for (const [run, add] of [
      [["S", "M"], "L"], [["3", "4"], "3.5"], [[], "S"],
      [runSizes(SIZE_RUN_SEED.apparel), "5XL"],
    ]) {
      const out = appendSizeToRun(run, add);
      expect(out).toHaveLength(run.length + 1);
      expect(out.filter((s) => s !== add || run.includes(s))).toEqual(expect.arrayContaining(run));
      const idx = out.findIndex((s, i) => run[i] !== s);   // remove the insertion → original
      const stripped = [...out];
      stripped.splice(idx === -1 ? out.length - 1 : idx, 1);
      expect(stripped).toEqual(run.map(String));
    }
  });
  it("addSizeToRun refuses what validateNewSize refuses and appends what it allows", () => {
    const runs = { apparel: { sizes: ["S", "M", "L", "XL", "XXL", "XXXL"] } };
    expect(addSizeToRun(runs, "apparel", "xxxl").ok).toBe(false);
    const ok = addSizeToRun(runs, "apparel", "4xl");
    expect(ok.ok).toBe(true);
    expect(ok.sizes).toEqual(["S", "M", "L", "XL", "XXL", "XXXL", "4XL"]);
  });
});

// ── The seed ─────────────────────────────────────────────────────────────────
describe("SIZE_RUN_SEED", () => {
  it("the apparel run carries XXXL AND 4XL, in correct sort position", () => {
    expect(SIZE_RUN_SEED.apparel.sizes).toEqual(["S", "M", "L", "XL", "XXL", "XXXL", "4XL"]);
  });
  it("every other run is byte-identical to its constant (day-one behaviour unchanged)", () => {
    expect(SIZE_RUN_SEED.footwear.sizes).toEqual(SIZES_FOOTWEAR);
    expect(SIZE_RUN_SEED.kids.sizes).toEqual(SIZES_KIDS);
    expect(SIZE_RUN_SEED["fitted-cap"].sizes).toEqual(SIZES_FITTED_CAP);
    expect(SIZE_RUN_SEED.gloves.sizes).toEqual(SIZES_GLOVES);
  });
  it("SIZES_APPAREL itself is untouched (legacy readers of the constant see the old list)", () => {
    expect(SIZES_APPAREL).toEqual(["S", "M", "L", "XL", "XXL", "XXXL"]);
  });
  it("no run contains the one-size sentinel", () => {
    for (const run of Object.values(SIZE_RUN_SEED)) {
      expect(run.sizes).not.toContain(ONE_SIZE_SENTINEL);
    }
  });
});

// ── Resolution + fallback ────────────────────────────────────────────────────
describe("sizesForCat", () => {
  const catWithRun = { key: "t-shirts", sizeMode: "list", sizeRunKey: "apparel", sizes: ["S", "M", "L", "XL", "XXL", "XXXL"] };

  it("resolves through the LIVE run when present", () => {
    const registry = { sizeRuns: { apparel: { sizes: ["S", "M", "L", "XL", "XXL", "XXXL", "4XL", "5XL"] } } };
    expect(sizesForCat(registry, catWithRun)).toEqual(["S", "M", "L", "XL", "XXL", "XXXL", "4XL", "5XL"]);
  });
  it("falls back to the SEEDED run when the live registry has no runs (partial registry never blanks a grid)", () => {
    expect(sizesForCat({}, catWithRun)).toEqual(SIZE_RUN_SEED.apparel.sizes);
    expect(sizesForCat(null, catWithRun)).toEqual(SIZE_RUN_SEED.apparel.sizes);
  });
  it("falls back to the category's LITERAL sizes when the runKey is unknown", () => {
    const cat = { key: "designer-shoes", sizeMode: "list", sizeRunKey: "no-such-run", sizes: ["3", "4", "5"] };
    expect(sizesForCat({}, cat)).toEqual(["3", "4", "5"]);
  });
  it("a BLANKED live run cannot blank the grid — empty live sizes fall through to the seed", () => {
    const registry = { sizeRuns: { apparel: { sizes: [] } } };
    expect(sizesForCat(registry, catWithRun)).toEqual(SIZE_RUN_SEED.apparel.sizes);
  });
  it("a category with NO runKey behaves exactly like today's sizesOf", () => {
    for (const cat of Object.values(TAXONOMY_SEED.cats)) {
      expect(sizesForCat({}, cat)).toEqual(sizesOf(cat));
    }
  });
  it("one-size categories are forced to the sentinel regardless of runKey", () => {
    const cat = { key: "bags", sizeMode: "one", sizeRunKey: "apparel", sizes: ["_"] };
    expect(sizesForCat({}, cat)).toEqual([ONE_SIZE_SENTINEL]);
  });
  it("sizeRunsOf ignores a garbled live node and keeps console-added runs", () => {
    const runs = sizeRunsOf({ sizeRuns: { junk: null, extra: { label: "Extra", sizes: ["A", "B"] } } });
    expect(runs.apparel.sizes).toEqual(SIZE_RUN_SEED.apparel.sizes);
    expect(runs.extra.sizes).toEqual(["A", "B"]);
  });
});

// ── The migration changes NO derivation ──────────────────────────────────────
// Simulate exactly what scripts/seed-size-runs.mjs writes: sizeRuns + a
// sizeRunKey on every category whose literal sizes match a run. Every one of
// the 31 seeded categories must derive the IDENTICAL legacy triple, and the
// only size-list change anywhere is the apparel run gaining 4XL.
describe("the 31 seeded categories after the size-run migration", () => {
  const RUN_FOR = (sizes) => {
    const j = sizes.join(",");
    if (j === SIZES_APPAREL.join(",")) return "apparel";
    if (j === SIZES_FOOTWEAR.join(",")) return "footwear";
    if (j === SIZES_KIDS.join(",")) return "kids";
    if (j === SIZES_FITTED_CAP.join(",")) return "fitted-cap";
    if (j === SIZES_GLOVES.join(",")) return "gloves";
    return null;
  };
  const migrated = {
    ...TAXONOMY_SEED,
    sizeRuns: Object.fromEntries(Object.entries(SIZE_RUN_SEED).map(([k, r]) => [k, { ...r }])),
    cats: Object.fromEntries(Object.entries(TAXONOMY_SEED.cats).map(([k, c]) => {
      const rk = c.sizeMode === "list" ? RUN_FOR(c.sizes.map(String)) : null;
      return [k, rk ? { ...c, sizeRunKey: rk } : { ...c }];
    })),
  };

  it("covers all 31 categories", () => {
    expect(Object.keys(migrated.cats)).toHaveLength(31);
  });
  it("every category derives the IDENTICAL legacy triple before and after", () => {
    for (const key of Object.keys(TAXONOMY_SEED.cats)) {
      expect(legacyFor(migrated, key)).toEqual(legacyFor(TAXONOMY_SEED, key));
    }
  });
  it("apparel categories gain exactly [4XL] at the end; every other category's sizes are byte-identical", () => {
    for (const [key, before] of Object.entries(TAXONOMY_SEED.cats)) {
      const oldSizes = sizesOf(before);
      const newSizes = sizesForCat(migrated, catByKey(migrated, key));
      if (migrated.cats[key].sizeRunKey === "apparel") {
        expect(newSizes).toEqual([...oldSizes, "4XL"]);
      } else {
        expect(newSizes).toEqual(oldSizes);
      }
    }
  });
});

// ── ADD-ONLY as a module surface ─────────────────────────────────────────────
// The module must not export anything that can remove, rename or reorder a
// size. If someone adds a removal path later, this test names it.
describe("the module exports no removal path", () => {
  it("every exported function is on the allow-list", async () => {
    const mod = await import("./sizeRuns.js");
    const fns = Object.keys(mod).filter((k) => typeof mod[k] === "function").sort();
    expect(fns).toEqual([
      "addSizeToRun", "appendSizeToRun", "canonicalSizeKey", "compareSizes",
      "normalizeSizeInput", "runSizes", "sizeRunsOf", "sizesForCat",
      "validateNewSize", "xlCount", "xsCount",
    ]);
  });
  it("no export name suggests mutation beyond append (remove/rename/reorder/delete/retire)", async () => {
    const mod = await import("./sizeRuns.js");
    for (const name of Object.keys(mod)) {
      expect(name).not.toMatch(/remove|rename|reorder|delete|retire|replace|set/i);
    }
  });
});

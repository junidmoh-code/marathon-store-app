// ─── MISSING SNEAKERS — detection tests ───────────────────────────────────────
// Pins the owner's rule ("Central has it, neither hub does") and the two things
// that make it differ from the clothing rule on purpose: it is UNIT-based rather
// than carriage-based, and the shops are deliberately not part of the test.
import { describe, it, expect } from "vitest";
import { computeMissingFootwear, seedableSizes, footwearSizeRank, sizeKeyOf, footwearSolvePlan, footwearPickPlan } from "./missingFootwearCore.js";

const SHOE = { id: "sh1", name: "Nike Air Max 1", category: "Footwear", sizes: ["5.5", "6", "7"] };
const SHOE2 = { id: "sh2", name: "Nike Air Force 1", category: "Footwear", sizes: ["6", "7"] };
const TEE = { id: "cl1", name: "Chelsea jersey", category: "Clothing", productType: "clothing", sizes: ["S", "M"] };

const cell = (qty) => ({ qty });
const run = ({ products = [SHOE, SHOE2, TEE], ...stock }) =>
  computeMissingFootwear({ allStock: stock, products });

describe("the rule — Central has it, neither hub does", () => {
  it("flags a shoe with Central stock and nothing at either hub", () => {
    const cards = run({ central: { sh1: { 6: cell(9) } } });
    expect(cards.map((c) => c.pid)).toEqual(["sh1"]);
    expect(cards[0].centralUnits).toBe(9);
    expect(cards[0].kind).toBe("never_introduced");
  });

  it("does NOT flag it when a hub holds units", () => {
    expect(run({ central: { sh1: { 6: cell(9) } }, hub1: { sh1: { 6: cell(1) } } })).toHaveLength(0);
    expect(run({ central: { sh1: { 6: cell(9) } }, hub2: { sh1: { 6: cell(1) } } })).toHaveLength(0);
  });

  it("ignores a shoe with no Central stock — nothing to assign", () => {
    expect(run({ central: { sh1: { 6: cell(0) } } })).toHaveLength(0);
  });

  it("ignores clothing entirely — that is the other tab", () => {
    expect(run({ central: { cl1: { S: cell(9) } } })).toHaveLength(0);
  });

  it("keys off CATEGORY, so a shoe with no productType still counts", () => {
    // 801 of 1,369 live footwear records have no productType — the reason this
    // must not key off productType.
    const noType = { id: "sh3", name: "Air Max 90", category: "Footwear", sizes: ["6"] };
    expect(run({ products: [noType], central: { sh3: { 6: cell(3) } } })).toHaveLength(1);
  });
});

describe("UNIT-based, not carriage-based (owner: include sold-but-carried)", () => {
  it("flags a shoe whose hub cell EXISTS but is empty, and marks it sold_out", () => {
    const cards = run({ central: { sh1: { 6: cell(9) } }, hub1: { sh1: { 6: cell(0) } } });
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe("sold_out");
    expect(cards[0].carriedAt).toEqual(["hub1"]);
    expect(cards[0].missingFrom).toEqual(["hub2"]);
    // This is the divergence from clothing: a carriage-based rule would drop it.
  });

  it("never_introduced only when NEITHER hub has a cell at all", () => {
    const cards = run({ central: { sh1: { 6: cell(9) } } });
    expect(cards[0].kind).toBe("never_introduced");
    expect(cards[0].missingFrom).toEqual(["hub1", "hub2"]);
  });

  it("a negative hub cell counts as zero, not as stock", () => {
    const cards = run({ central: { sh1: { 6: cell(9) } }, hub1: { sh1: { 6: cell(-4) } } });
    expect(cards).toHaveLength(1);
  });
});

describe("shops are deliberately excluded", () => {
  it("shop stock does NOT clear a row — shoes pass through, they hold no buffer", () => {
    const cards = run({
      central: { sh1: { 6: cell(9) } },
      "marathon-pe": { sh1: { 6: cell(3) } },
      trophy: { sh1: { 6: cell(2) } },
    });
    expect(cards).toHaveLength(1);
  });
});

describe("sizes and ordering", () => {
  it("lists only Central sizes that actually hold stock, in numeric order", () => {
    const cards = run({ central: { sh1: { 7: cell(2), "5_5": cell(1), 6: cell(0) } } });
    expect(cards[0].sizes.map((s) => s.size)).toEqual(["5.5", "7"]);   // 6 has none
  });

  it("decodes the half-size key back to a display size", () => {
    const cards = run({ central: { sh1: { "5_5": cell(4) } } });
    expect(cards[0].sizes[0]).toMatchObject({ sizeKey: "5_5", size: "5.5", avail: 4 });
  });

  it("orders shoe sizes numerically, unlike the letter-size table", () => {
    expect([10, 5.5, 9, 6].sort((a, b) => footwearSizeRank(a) - footwearSizeRank(b))).toEqual([5.5, 6, 9, 10]);
    expect(footwearSizeRank("5_5")).toBe(5.5);
  });

  it("sorts cards by stranded units, largest first", () => {
    const cards = run({ central: { sh1: { 6: cell(3) }, sh2: { 6: cell(30) } } });
    expect(cards.map((c) => c.pid)).toEqual(["sh2", "sh1"]);
  });
});

describe("duplicate catalogue records (10% of live rows)", () => {
  const TWIN_A = { id: "twA", name: "Lacoste Marice Navy", category: "Footwear", sizes: ["6"] };
  const TWIN_B = { id: "twB", name: "lacoste marice navy  ", category: "Footwear", sizes: ["6"] };

  it("badges a row whose same-named twin holds hub stock", () => {
    const cards = computeMissingFootwear({
      allStock: { central: { twA: { 6: cell(81) } }, hub1: { twB: { 6: cell(8) } } },
      products: [TWIN_A, TWIN_B],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].pid).toBe("twA");
    expect(cards[0].duplicateOf).toBe("twB");   // name match ignores case + spacing
  });

  it("does NOT drop the row — the Central stock is genuinely stranded", () => {
    const cards = computeMissingFootwear({
      allStock: { central: { twA: { 6: cell(81) } }, hub1: { twB: { 6: cell(8) } } },
      products: [TWIN_A, TWIN_B],
    });
    expect(cards[0].centralUnits).toBe(81);
  });

  it("duplicateOf is null when the twin has no hub stock either", () => {
    const cards = computeMissingFootwear({
      allStock: { central: { twA: { 6: cell(5) } }, hub1: { twB: { 6: cell(0) } } },
      products: [TWIN_A, TWIN_B],
    });
    expect(cards.find((c) => c.pid === "twA").duplicateOf).toBeNull();
  });

  it("a lone record is never badged against itself", () => {
    const cards = run({ central: { sh1: { 6: cell(4) } } });
    expect(cards[0].duplicateOf).toBeNull();
  });
});

describe("seedableSizes — what Solve may write", () => {
  const footwearRun = { hub1: { "5_5": 2, 6: 3, 7: 2 } };

  it("offers only sizes with a positive standard at that hub", () => {
    expect(seedableSizes({ allStock: {}, pid: "sh1", catalogSizes: ["5.5", "6", "7", "13"], hub: "hub1", footwearRun }))
      .toEqual(["5.5", "6", "7"]);   // 13 has no standard
  });

  it("skips sizes whose cell already exists — seed-if-absent", () => {
    const allStock = { hub1: { sh1: { 6: cell(0) } } };
    expect(seedableSizes({ allStock, pid: "sh1", catalogSizes: ["5.5", "6", "7"], hub: "hub1", footwearRun }))
      .toEqual(["5.5", "7"]);
  });

  it("is EMPTY when footwear targeting is not configured — Solve must be disabled", () => {
    // Guards the false-success trap: seeding a cell the engine will never refill
    // looks like progress and silently is not.
    expect(seedableSizes({ allStock: {}, pid: "sh1", catalogSizes: ["6", "7"], hub: "hub1", footwearRun: undefined }))
      .toEqual([]);
  });

  it("resolves the half size through its ENCODED key", () => {
    expect(sizeKeyOf("5.5")).toBe("5_5");
    expect(seedableSizes({ allStock: {}, pid: "sh1", catalogSizes: ["5.5"], hub: "hub1", footwearRun })).toEqual(["5.5"]);
    // A raw-keyed run map must NOT resolve — RTDB cannot store "5.5" as a key.
    expect(seedableSizes({ allStock: {}, pid: "sh1", catalogSizes: ["5.5"], hub: "hub1", footwearRun: { hub1: { "5.5": 2 } } })).toEqual([]);
  });
});

describe("footwearSolvePlan — policy capped by Central stock", () => {
  const policy = { 3: 2, 4: 2, 5: 2, "5_5": 2, 6: 3, 7: 2, 8: 2, 9: 2, 10: 1, 11: 1 };
  const central = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { qty: v }]));

  it("the owner's worked example: 2 per size, but size 8 has only one piece", () => {
    const plan = footwearSolvePlan({
      catalogSizes: ["6", "7", "8", "9", "10"],
      policy: { 6: 2, 7: 2, 8: 2, 9: 2, 10: 2 },
      centralCells: central({ 6: 9, 7: 9, 8: 1, 9: 9, 10: 9 }),
    });
    expect(plan).toEqual([
      { size: "6", qty: 2, want: 2, avail: 9 },
      { size: "7", qty: 2, want: 2, avail: 9 },
      { size: "8", qty: 1, want: 2, avail: 1 },   // capped by stock, not policy
      { size: "9", qty: 2, want: 2, avail: 9 },
      { size: "10", qty: 2, want: 2, avail: 9 },
    ]);
  });

  it("drops a size Central cannot supply at all rather than asking for zero", () => {
    const plan = footwearSolvePlan({
      catalogSizes: ["6", "7"], policy, centralCells: central({ 6: 4, 7: 0 }),
    });
    expect(plan.map((l) => l.size)).toEqual(["6"]);
  });

  it("honours the per-size policy, not a flat number", () => {
    const plan = footwearSolvePlan({
      catalogSizes: ["6", "10"], policy, centralCells: central({ 6: 99, 10: 99 }),
    });
    expect(plan).toEqual([
      { size: "6", qty: 3, want: 3, avail: 99 },    // policy 3
      { size: "10", qty: 1, want: 1, avail: 99 },   // policy 1
    ]);
  });

  it("skips a catalog size with no policy entry", () => {
    const plan = footwearSolvePlan({
      catalogSizes: ["6", "13"], policy, centralCells: central({ 6: 5, 13: 5 }),
    });
    expect(plan.map((l) => l.size)).toEqual(["6"]);
  });

  it("resolves the half size through its encoded key and orders it numerically", () => {
    const plan = footwearSolvePlan({
      catalogSizes: ["6", "5.5", "3"], policy, centralCells: central({ 6: 5, "5_5": 5, 3: 5 }),
    });
    expect(plan.map((l) => l.size)).toEqual(["3", "5.5", "6"]);
    expect(plan.find((l) => l.size === "5.5").qty).toBe(2);
  });

  it("skips sizes that already have an OPEN request — no double-picking", () => {
    const plan = footwearSolvePlan({
      catalogSizes: ["6", "7", "8"], policy, centralCells: central({ 6: 9, 7: 9, 8: 9 }),
      openSizes: ["7"],
    });
    expect(plan.map((l) => l.size)).toEqual(["6", "8"]);
  });

  it("returns nothing when the policy is absent — Solve must stay disabled", () => {
    expect(footwearSolvePlan({ catalogSizes: ["6"], policy: {}, centralCells: central({ 6: 9 }) })).toEqual([]);
  });

  it("ignores the one-size sentinel", () => {
    expect(footwearSolvePlan({ catalogSizes: ["_"], policy: { _: 2 }, centralCells: central({ _: 9 }) })).toEqual([]);
  });
});

describe("network-wide reservation — two hubs cannot claim the same Central units", () => {
  const policy = { 8: 2 };
  const central = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { qty: v }]));

  it("subtracts stock already owed to ANOTHER hub", () => {
    // Central holds 3; Hub 1 already has 2 on order, so only 1 is really free.
    const plan = footwearSolvePlan({
      catalogSizes: ["8"], policy, centralCells: central({ 8: 3 }), reserved: { 8: 2 },
    });
    expect(plan).toEqual([{ size: "8", qty: 1, want: 2, avail: 1 }]);
  });

  it("drops the size entirely once everything is spoken for", () => {
    expect(footwearSolvePlan({
      catalogSizes: ["8"], policy, centralCells: central({ 8: 2 }), reserved: { 8: 2 },
    })).toEqual([]);
  });

  it("over-reservation never yields a negative availability", () => {
    expect(footwearSolvePlan({
      catalogSizes: ["8"], policy, centralCells: central({ 8: 1 }), reserved: { 8: 9 },
    })).toEqual([]);
  });

  it("absent reserved map behaves exactly as before", () => {
    expect(footwearSolvePlan({ catalogSizes: ["8"], policy, centralCells: central({ 8: 3 }) }))
      .toEqual([{ size: "8", qty: 2, want: 2, avail: 3 }]);
  });

  it("reservation is keyed by the ENCODED size, so half sizes are counted", () => {
    const plan = footwearSolvePlan({
      catalogSizes: ["5.5"], policy: { "5_5": 2 }, centralCells: central({ "5_5": 3 }), reserved: { "5_5": 2 },
    });
    expect(plan).toEqual([{ size: "5.5", qty: 1, want: 2, avail: 1 }]);
  });
});

describe("one shared size-key encoder — the same one the stock cells use", () => {
  it("is the canonical stockSizeKey, so a key always matches its /stock cell", () => {
    // The earlier local copy TRIMMED. That was not just a divergence, it was
    // wrong: a size stored as " 8" lives in the cell "_8" (stockSizeKey does not
    // trim), so a trimming encoder computed "8" and read straight past both the
    // Central availability AND the reservation. (CodeRabbit #291.)
    expect(sizeKeyOf(" 8")).toBe("_8");
    expect(sizeKeyOf("5.5")).toBe("5_5");
    expect(sizeKeyOf("")).toBe("_");
    expect(sizeKeyOf(null)).toBe("_");
  });

  it("a padded size resolves against the cell it is actually stored in", () => {
    const plan = footwearSolvePlan({
      catalogSizes: [" 8"], policy: { _8: 2 },
      centralCells: { _8: { qty: 3 } },        // how stockSizeKey(" 8") writes it
      reserved: { [sizeKeyOf(" 8")]: 2 },
    });
    expect(plan).toEqual([{ size: " 8", qty: 1, want: 2, avail: 1 }]);
  });
});

// ─── PICK PLAN — the operator's own sizes/quantities ─────────────────────────
// "Move" now raises a request instead of transferring stock (owner, 2026-07-31).
// These pin the guard rails it MUST share with Solve, because the two write into
// the same queue against the same Central shelf.
describe("footwearPickPlan", () => {
  it("raises exactly what was typed when Central can cover it", () => {
    expect(footwearPickPlan({
      picks: [{ size: "7", qty: 2 }],
      centralCells: { 7: { qty: 5 } },
    })).toEqual([{ size: "7", qty: 2, asked: 2, avail: 5 }]);
  });

  it("CAPS a short ask instead of refusing it, and reports what was asked", () => {
    // The operator asked for 4; Central has 1. They get 1 and can see why,
    // rather than the line vanishing and being re-entered.
    expect(footwearPickPlan({
      picks: [{ size: "7", qty: 4 }],
      centralCells: { 7: { qty: 1 } },
    })).toEqual([{ size: "7", qty: 1, asked: 4, avail: 1 }]);
  });

  it("subtracts units already promised to ANOTHER hub — free stock, not shelf stock", () => {
    // Central shows 3, but 2 are owed to the other hub. Without this the same
    // units are committed twice and whoever picks second comes up short.
    expect(footwearPickPlan({
      picks: [{ size: "7", qty: 3 }],
      centralCells: { 7: { qty: 3 } },
      reserved: { 7: 2 },
    })).toEqual([{ size: "7", qty: 1, asked: 3, avail: 1 }]);
  });

  it("drops a size already open AT THIS HUB rather than duplicating it", () => {
    expect(footwearPickPlan({
      picks: [{ size: "7", qty: 2 }],
      centralCells: { 7: { qty: 9 } },
      openSizes: ["7"],
    })).toEqual([]);
  });

  it("drops a size Central cannot supply at all", () => {
    expect(footwearPickPlan({
      picks: [{ size: "7", qty: 2 }, { size: "8", qty: 1 }],
      centralCells: { 7: { qty: 0 }, 8: { qty: 4 } },
    })).toEqual([{ size: "8", qty: 1, asked: 1, avail: 4 }]);
  });

  it("ignores zero, negative and non-numeric quantities", () => {
    expect(footwearPickPlan({
      picks: [{ size: "6", qty: 0 }, { size: "7", qty: -3 }, { size: "8", qty: "x" }],
      centralCells: { 6: { qty: 5 }, 7: { qty: 5 }, 8: { qty: 5 } },
    })).toEqual([]);
  });

  it("half sizes resolve against the cell they are stored in, not a raw '5.5' key", () => {
    // 5.5 is 538 live cells. A raw lookup misses every one of them.
    expect(footwearPickPlan({
      picks: [{ size: "5.5", qty: 2 }],
      centralCells: { "5_5": { qty: 2 } },
    })).toEqual([{ size: "5.5", qty: 2, asked: 2, avail: 2 }]);
  });

  it("returns lines in numeric size order, not the order they were typed", () => {
    expect(footwearPickPlan({
      picks: [{ size: "10", qty: 1 }, { size: "5.5", qty: 1 }, { size: "7", qty: 1 }],
      centralCells: { 10: { qty: 2 }, "5_5": { qty: 2 }, 7: { qty: 2 } },
    }).map((l) => l.size)).toEqual(["5.5", "7", "10"]);
  });

  it("skips the one-size sentinel", () => {
    expect(footwearPickPlan({ picks: [{ size: "_", qty: 2 }], centralCells: { _: { qty: 5 } } })).toEqual([]);
  });
});

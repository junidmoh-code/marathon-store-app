// ─── MISSING SNEAKERS — detection tests ───────────────────────────────────────
// Pins the owner's rule ("Central has it, neither hub does") and the two things
// that make it differ from the clothing rule on purpose: it is UNIT-based rather
// than carriage-based, and the shops are deliberately not part of the test.
import { describe, it, expect } from "vitest";
import { computeMissingFootwear, seedableSizes, footwearSizeRank, sizeKeyOf } from "./missingFootwearCore.js";

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

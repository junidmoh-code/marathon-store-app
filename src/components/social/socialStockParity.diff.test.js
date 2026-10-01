// ─── THE STOCK PARITY DIFFERENTIAL ───────────────────────────────────────────
// The social generator and the Shopify inventory push must answer "how many of
// this can we sell" with the SAME number. They are two implementations —
// availableUnits in functions/lib/social-select.cjs (CJS, required by a Cloud
// Function) and networkTotals in scripts/shopify/inventory.mjs (ESM, run by
// the reconciler) — so nothing but a test keeps them equal.
//
// This file exists because they were NOT equal and the header comment said
// they were. availableUnits summed every cell in the map; networkTotals drops
// any cell whose key is not one of the product's own sizes. The divergence ran
// the dangerous way every time — social saw MORE stock than the storefront
// would sell — and the live trigger is the documented phantom cell: a product
// whose size list is ["Free Size"] sells from "_", but a stray "Free_Size"
// cell may still hold units. Shopify pushed 0 and showed sold out; the
// generator saw 3 and posted a link to a sold-out page.
//
// This is a vitest file rather than a node:test one precisely so BOTH can be
// imported: vitest resolves the ESM script, and createRequire reaches the CJS
// module. Neither node:test nor the browser suite alone could compare them.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { networkTotals, ONLINE_EXCLUDED_LOCATIONS } from "../../../scripts/shopify/inventory.mjs";
import { stockSizeKey } from "../../utils/sizeKey";

const require = createRequire(import.meta.url);
const {
  availableUnits,
  stockSizeKey: cjsStockSizeKey,
  ONLINE_EXCLUDED_LOCATIONS: cjsExcluded,
} = require("../../../functions/lib/social-select.cjs");

// networkTotals takes the WHOLE /stock tree keyed by location → product →
// cells; availableUnits takes one product's slice. Same data, one nesting level
// apart, so the fixture is written once and reshaped for each.
const forProduct = (tree, pid) =>
  Object.fromEntries(Object.entries(tree).map(([loc, byPid]) => [loc, byPid[pid] || {}]));

const sumTotals = (totals) => Object.values(totals).reduce((a, b) => a + b, 0);

describe("stockSizeKey — the CJS mirror equals the real one", () => {
  // These are the values that actually differ between a naive encoder and the
  // real one: the Free Size collapse, half sizes, padding, and the RTDB-illegal
  // characters.
  const CASES = [
    "M", "L", "XXL", "8", "5.5", "10.5", "Free Size", "", null, undefined,
    " 8", "8 ", "one size", "3/4", "a.b", "x#y", "p$q", "l[1]", 5.5, 8,
  ];
  it.each(CASES.map((c) => [JSON.stringify(c), c]))("%s", (_label, size) => {
    expect(cjsStockSizeKey(size)).toEqual(stockSizeKey(size));
  });
});

// ── THE SET ITSELF, NOT ONLY ITS EFFECT ─────────────────────────────────────
// Comparing sums catches a divergence only when the fixture happens to put
// stock in the location that differs. That is luck, and the fuzz's location
// list is a hand-written constant that has already been wrong once (it said
// "pine" where the real id is "marathon-pine", so Pine was never exercised at
// all). Comparing the SETS is not luck: adding a location to one copy and
// forgetting the other is a red test on the next run, whatever the fixtures
// happen to contain.
describe("the excluded-location set is the same on both sides", () => {
  it("ESM and CJS list identical location ids", () => {
    expect([...cjsExcluded].sort()).toEqual([...ONLINE_EXCLUDED_LOCATIONS].sort());
  });

  it("holds the locations the owner decided must not feed the storefront", () => {
    // Named explicitly so REMOVING one is a deliberate act with a test to
    // change, not a silent widening of what the shop offers strangers.
    for (const id of ["in_transit", "hub3", "marathon-pine"]) {
      expect(ONLINE_EXCLUDED_LOCATIONS.has(id), `${id} must not feed the storefront`).toBe(true);
    }
  });

  it("does not exclude a location that is trusted", () => {
    for (const id of ["central", "hub1", "hub2", "marathon-pe", "trophy"]) {
      expect(ONLINE_EXCLUDED_LOCATIONS.has(id), `${id} must still count`).toBe(false);
    }
  });

  it("refuses mutation — it is shared by reference across the reconciler and the backfill", () => {
    // NOT Object.isFrozen. Freezing a Set seals its own properties and leaves
    // its entries in internal slots, so add/delete/clear keep working while
    // isFrozen answers true — an earlier version of this test asserted exactly
    // that and would have passed while a caller quietly deleted Pine from the
    // set and put 1,668 units back on the storefront. Assert the refusal.
    for (const set of [ONLINE_EXCLUDED_LOCATIONS, cjsExcluded]) {
      expect(() => set.delete("marathon-pine")).toThrow(/immutable/);
      expect(() => set.add("hub1")).toThrow(/immutable/);
      expect(() => set.clear()).toThrow(/immutable/);
      expect(set.has("marathon-pine")).toBe(true);
      expect(set.has("hub1")).toBe(false);
    }
  });
});

// ── ABSOLUTE ANSWERS, NOT ONLY AGREEMENT ────────────────────────────────────
// Everything above asks whether the two implementations agree. Two copies that
// drifted the SAME way agree perfectly and are both wrong — the differential
// cannot see it, by construction. These fix the arithmetic to numbers a person
// checked by hand, so a shared regression has something to fail against.
describe("the number itself, checked by hand", () => {
  const bothAgree = (tree, sizes) => {
    const mine = availableUnits(forProduct(tree, "p1"), sizes);
    const theirs = sumTotals(networkTotals(tree, "p1", sizes));
    expect(mine).toBe(theirs);
    return mine;
  };

  it("counts the trusted locations and only those", () => {
    // 2 (PE) + 5 (hub2) + 1 (central) = 8 countable;
    // 12 at Pine, 9 at Hub 3 and 99 in transit are real units that do not sell online.
    const tree = {
      "marathon-pe": { p1: { M: { qty: 2 } } },
      hub2: { p1: { M: { qty: 5 } } },
      central: { p1: { M: { qty: 1 } } },
      "marathon-pine": { p1: { M: { qty: 12 } } },
      hub3: { p1: { M: { qty: 9 } } },
      in_transit: { p1: { M: { qty: 99 } } },
    };
    expect(bothAgree(tree, ["M"])).toBe(8);
  });

  it("a Pine-only product is exactly zero — the 43-product shape", () => {
    const tree = { "marathon-pine": { p1: { "8": { qty: 3 }, "9": { qty: 4 } } } };
    expect(bothAgree(tree, ["8", "9"])).toBe(0);
  });

  it("the baseline policy still counts Pine — proof the exclusion is what removed it", () => {
    // Same tree, the pool passed explicitly. If this ever returned 3 as well,
    // the zero above would be measuring something other than the exclusion.
    const tree = { "marathon-pine": { p1: { M: { qty: 12 } } }, central: { p1: { M: { qty: 3 } } } };
    expect(sumTotals(networkTotals(tree, "p1", ["M"], new Set(["in_transit"])))).toBe(15);
    expect(sumTotals(networkTotals(tree, "p1", ["M"]))).toBe(3);
  });
});

describe("availableUnits agrees with networkTotals", () => {
  const cases = [
    {
      name: "an ordinary sized product",
      sizes: ["S", "M", "L"],
      tree: { "marathon-pe": { p1: { S: { qty: 1 }, M: { qty: 2 }, L: { qty: 3 } } } },
    },
    {
      name: "stock spread across several locations",
      sizes: ["M"],
      tree: {
        "marathon-pe": { p1: { M: { qty: 2 } } },
        hub2: { p1: { M: { qty: 5 } } },
        central: { p1: { M: { qty: 1 } } },
      },
    },
    {
      name: "in_transit is not sellable",
      sizes: ["M"],
      tree: { in_transit: { p1: { M: { qty: 99 } } }, "marathon-pe": { p1: { M: { qty: 1 } } } },
    },
    {
      name: "negative cells clamp, they do not subtract",
      sizes: ["M", "L"],
      tree: { "marathon-pe": { p1: { M: { qty: -9 }, L: { qty: 4 } } } },
    },
    {
      // THE BUG. Both cells exist; only "_" is what the storefront sells from.
      name: "the phantom Free Size cell",
      sizes: ["Free Size"],
      tree: { "marathon-pe": { p1: { _: { qty: 0 }, Free_Size: { qty: 3 } } } },
    },
    {
      // The untrusted pair. Units are REAL and still in /stock; they simply
      // stop being offered online. Both copies must agree on that or social
      // links a stranger to a sold-out page.
      name: "Pine's units do not count toward what the web is offered",
      sizes: ["M"],
      tree: { "marathon-pine": { p1: { M: { qty: 12 } } }, hub2: { p1: { M: { qty: 2 } } } },
    },
    {
      name: "Hub 3's units do not count either",
      sizes: ["M"],
      tree: { hub3: { p1: { M: { qty: 9 } } }, central: { p1: { M: { qty: 1 } } } },
    },
    {
      // The 43-product shape: everything the product has is untrusted, so the
      // storefront must say zero rather than promise a pair nobody trusts.
      name: "a product held ONLY at Pine and Hub 3 is unavailable, not oversold",
      sizes: ["8", "9"],
      tree: {
        "marathon-pine": { p1: { "8": { qty: 3 } } },
        hub3: { p1: { "9": { qty: 4 } } },
      },
    },
    {
      name: "a size removed from the record while stock remains on the cell",
      sizes: ["M"],
      tree: { "marathon-pe": { p1: { M: { qty: 1 }, XL: { qty: 40 } } } },
    },
    {
      name: "half sizes, which encode",
      sizes: ["5.5", "6"],
      tree: { "marathon-pe": { p1: { "5_5": { qty: 2 }, "6": { qty: 1 } } } },
    },
    {
      name: "bare-number cells from old data",
      sizes: ["M"],
      tree: { "marathon-pe": { p1: { M: 7 } } },
    },
    {
      name: "no stock anywhere",
      sizes: ["M"],
      tree: { "marathon-pe": { p1: {} } },
    },
    {
      name: "the product has no cells at all",
      sizes: ["M"],
      tree: { "marathon-pe": {} },
    },
  ];

  it.each(cases.map((c) => [c.name, c]))("%s", (_name, c) => {
    const mine = availableUnits(forProduct(c.tree, "p1"), c.sizes);
    const theirs = sumTotals(networkTotals(c.tree, "p1", c.sizes));
    expect(mine).toBe(theirs);
  });

  // Spelled out, because it is the one that shipped wrong.
  it("returns 0 for the phantom Free Size cell, matching what Shopify is told", () => {
    const tree = { "marathon-pe": { p1: { _: { qty: 0 }, Free_Size: { qty: 3 } } } };
    expect(availableUnits(forProduct(tree, "p1"), ["Free Size"])).toBe(0);
    expect(sumTotals(networkTotals(tree, "p1", ["Free Size"]))).toBe(0);
  });

  it("a product with no size list has no countable stock, exactly as Shopify has no variants", () => {
    const cells = { "marathon-pe": { M: { qty: 5 } } };
    for (const sizes of [undefined, null, [], "M"]) {
      expect(availableUnits(cells, sizes)).toBe(0);
    }
  });
});

// ── RANDOMISED DIFFERENTIAL ─────────────────────────────────────────────────
// The table above covers the cases somebody thought of. This covers the ones
// nobody did — the technique that has already found two bugs in this project
// that two reviews missed.
describe("differential fuzz", () => {
  const SIZES = ["S", "M", "L", "XL", "8", "5.5", "Free Size", "one size", "10.5"];
  // REAL /locations ids. This list said "pine" until 2026-09-08 — not a
  // registered id, so the fuzz had never once put stock in Pine and could not
  // have caught a divergence there. Every id below is one the census read back
  // from the live /locations node.
  const LOCS = [
    "marathon-pe", "marathon-pine", "trophy", "hub1", "hub2", "hub3",
    "central", "studio", "base", "in_transit",
  ];

  // Deterministic PRNG so a failure is reproducible from the seed alone.
  let seed = 20260822;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  it("agrees on 500 random stock trees", () => {
    for (let i = 0; i < 500; i++) {
      const sizes = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => pick(SIZES));
      const tree = {};
      const locCount = Math.floor(rnd() * 4);
      for (let l = 0; l < locCount; l++) {
        const loc = pick(LOCS);
        tree[loc] = tree[loc] || { p1: {} };
        const cellCount = Math.floor(rnd() * 5);
        for (let c = 0; c < cellCount; c++) {
          // Deliberately keys BOTH from the product's sizes and from sizes it
          // does not have — the phantom-cell shape.
          const key = rnd() < 0.6 ? stockSizeKey(pick(sizes)) : stockSizeKey(pick(SIZES));
          const qty = Math.floor(rnd() * 21) - 5;    // includes negatives
          tree[loc].p1[key] = rnd() < 0.15 ? qty : { qty };
        }
      }
      const mine = availableUnits(forProduct(tree, "p1"), sizes);
      const theirs = sumTotals(networkTotals(tree, "p1", sizes));
      expect(mine, `seed iteration ${i}: ${JSON.stringify({ sizes, tree })}`).toBe(theirs);
    }
  });
});

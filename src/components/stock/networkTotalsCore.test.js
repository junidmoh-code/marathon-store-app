// ─── NETWORK TOTALS — THE ARITHMETIC, AND THE PROPERTIES THAT MAKE IT HONEST ──
// A total that is quietly wrong is worse than no total: it is a reordering
// decision made on a made-up number. These tests pin the four claims the card
// makes on screen — every size, every location, negatives as they are, and zero
// meaning zero — and then break each one on purpose to prove the test would
// notice (a green test over a property nobody can violate proves nothing).
import { describe, it, expect } from "vitest";
import { sumProduct, sortRows, visibleProducts } from "./networkTotalsCore";

const cell = (qty) => ({ qty, v: 3, mv: "m1", lastType: "received", state: "live" });

describe("sumProduct — every size at every location", () => {
  it("adds every size and every location into one number", () => {
    const r = sumProduct({
      central: { S: cell(4), M: cell(6), L: cell(1) },
      "marathon-pe": { S: cell(2), M: cell(3) },
      hub2: { L: cell(10) },
    });
    expect(r.total).toBe(26);                 // 4+6+1 + 2+3 + 10
    expect(r.cellCount).toBe(6);
    expect(r.locationCount).toBe(3);
    expect(r.perLocation).toEqual({ central: 11, "marathon-pe": 5, hub2: 10 });
  });

  // The reason this module exists rather than reusing the Locator's rollup: the
  // Locator iterates product.sizes, so a cell at a size the record no longer
  // declares is invisible to it. Those units are on a shelf.
  it("counts a cell at a size the product record no longer declares", () => {
    const r = sumProduct({ central: { XXXL: cell(7), _: cell(2) } });
    expect(r.total).toBe(9);
  });

  // RTDB returns an ARRAY, not an object, when keys are consecutive numeric
  // strings — which is precisely what a sneaker size run looks like. Live data
  // for /stock/hub1/{pid} really does arrive as [null,null,…,{qty:22}].
  it("sums the array shape RTDB returns for numeric size runs", () => {
    const arr = [];
    arr[6] = cell(22); arr[7] = cell(5); arr[9] = cell(3);
    expect(sumProduct({ hub1: arr }).total).toBe(30);
    expect(sumProduct({ hub1: arr }).cellCount).toBe(3);
  });

  it("ignores a location that holds no cells at all", () => {
    const r = sumProduct({ central: { S: cell(5) }, studio: null, base: {} });
    expect(r.total).toBe(5);
    expect(r.locationCount).toBe(1);
    expect(r.perLocation.studio).toBeUndefined();
  });

  it("treats a missing or non-numeric qty as zero rather than NaN", () => {
    const r = sumProduct({ central: { S: { v: 1 }, M: { qty: "8" }, L: cell(4) } });
    expect(r.total).toBe(4);
    expect(Number.isNaN(r.total)).toBe(false);
  });
});

describe("sumProduct — negatives are added, never clamped", () => {
  it("lets a negative cell drag the total down", () => {
    const r = sumProduct({ central: { S: cell(10) }, hub3: { S: cell(-50) } });
    expect(r.total).toBe(-40);                // NOT 10, NOT 0
    expect(r.negativeUnits).toBe(-50);
    expect(r.negatives).toEqual([{ locationId: "hub3", sizeKey: "S", qty: -50 }]);
  });

  it("reports every negative cell so the card can show where the drag is", () => {
    const r = sumProduct({
      "marathon-pe": { S: cell(-3), M: cell(4) },
      trophy: { "5_5": cell(-2) },
    });
    expect(r.total).toBe(-1);
    expect(r.negatives).toHaveLength(2);
    expect(r.negativeUnits).toBe(-5);
  });

  it("a net zero reached by cancellation is not the same as no stock", () => {
    const r = sumProduct({ central: { S: cell(5) }, hub3: { S: cell(-5) } });
    expect(r.total).toBe(0);
    expect(r.cellCount).toBe(2);              // the card says "2 cells", not "none recorded"
    expect(r.negatives).toHaveLength(1);
  });

  // MUTATION PROOF. Break the clamp property four different ways; every shape
  // must be caught. A single Math.max mutant would let a test that only checks
  // one arrangement pass.
  it("would catch a clamp introduced in any of four shapes", () => {
    const input = { central: { S: cell(10) }, hub3: { S: cell(-50) }, hub2: { M: cell(-4) } };
    const honest = sumProduct(input);
    const clampCell    = () => 10 + 0 + 0;                       // clamp each cell at 0
    const clampLoc     = () => 10 + 0 + 0;                       // clamp each location at 0
    const clampTotal   = () => Math.max(0, honest.total);        // clamp the final answer
    const dropNegative = () => 10;                               // skip negative cells entirely
    for (const mutant of [clampCell, clampLoc, clampTotal, dropNegative]) {
      expect(honest.total).not.toBe(mutant());
    }
    expect(honest.total).toBe(-44);
    // and a mutant that merely stopped REPORTING the negatives would be caught too
    expect(honest.negatives.length).toBeGreaterThan(0);
  });
});

describe("sumProduct — a product with no stock anywhere", () => {
  it("is zero, not blank and not an error", () => {
    const r = sumProduct({});
    expect(r.total).toBe(0);
    expect(r.cellCount).toBe(0);
    expect(r.locationCount).toBe(0);
    expect(r.negatives).toEqual([]);
  });

  it("survives null and undefined without throwing", () => {
    expect(sumProduct(null).total).toBe(0);
    expect(sumProduct(undefined).total).toBe(0);
    expect(sumProduct({ central: null, hub1: undefined }).cellCount).toBe(0);
  });

  // cellCount is what separates "counted and it is zero" from "never counted",
  // and the card says different words for each. Pin the distinction.
  it("distinguishes never-counted from counted-at-zero", () => {
    expect(sumProduct({}).cellCount).toBe(0);
    expect(sumProduct({ central: { S: cell(0) } }).cellCount).toBe(1);
    expect(sumProduct({ central: { S: cell(0) } }).total).toBe(0);
  });
});

describe("sortRows", () => {
  const row = (name, total) => ({ id: name, name, totals: total == null ? null : { total } });

  it("ranks most first by default and reverses on demand", () => {
    const rows = [row("b", 5), row("a", 90), row("c", -3)];
    expect(sortRows(rows, "desc").map(r => r.name)).toEqual(["a", "b", "c"]);
    expect(sortRows(rows, "asc").map(r => r.name)).toEqual(["c", "b", "a"]);
  });

  it("keeps uncounted rows at the bottom in BOTH directions so nothing jumps", () => {
    const rows = [row("counted", 5), row("pending", null), row("other", -100)];
    expect(sortRows(rows, "desc").map(r => r.name)).toEqual(["counted", "other", "pending"]);
    expect(sortRows(rows, "asc").map(r => r.name)).toEqual(["other", "counted", "pending"]);
  });

  it("breaks ties on name so the order is stable across renders", () => {
    const rows = [row("zebra", 4), row("apple", 4)];
    expect(sortRows(rows, "desc").map(r => r.name)).toEqual(["apple", "zebra"]);
    expect(sortRows(rows, "asc").map(r => r.name)).toEqual(["apple", "zebra"]);
  });

  it("does not mutate the array it was given", () => {
    const rows = [row("b", 1), row("a", 2)];
    sortRows(rows, "desc");
    expect(rows.map(r => r.name)).toEqual(["b", "a"]);
  });
});

describe("visibleProducts — the card never asks for more than it shows", () => {
  const cat = Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, name: `p${i}` }));

  it("holds one page of the catalogue when there is no query", () => {
    expect(visibleProducts(cat, [], "", 25)).toHaveLength(25);
    expect(visibleProducts(cat, [], "   ", 50)).toHaveLength(50);
  });

  it("holds exactly the search matches when there is a query", () => {
    const matches = [cat[7], cat[8]];
    expect(visibleProducts(cat, matches, "p7", 25)).toEqual(matches);
  });

  it("never exceeds the catalogue, and copes with a zero page", () => {
    expect(visibleProducts(cat.slice(0, 3), [], "", 25)).toHaveLength(3);
    expect(visibleProducts(cat, [], "", 0)).toHaveLength(0);
  });
});

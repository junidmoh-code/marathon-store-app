// ─── NETWORK TOTALS — THE ARITHMETIC, AND THE PROPERTIES THAT MAKE IT HONEST ──
// A total that is quietly wrong is worse than no total: it is a reordering
// decision made on a made-up number. These tests pin the four claims the card
// makes on screen — every size, every location, negatives as they are, and zero
// meaning zero — and then break each one on purpose to prove the test would
// notice (a green test over a property nobody can violate proves nothing).
import { describe, it, expect } from "vitest";
import { sumProduct, sortRows, visibleProducts, countedLocations, EXCLUDED_LOCATIONS } from "./networkTotalsCore";

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

  // /stock/{loc}/{pid}/_meta sits at the SIZE level and is an object, so a naive
  // reader counts it as a cell. The total survives (it has no qty) but every
  // claim the card makes about the total does not.
  it("does not count _meta as a cell", () => {
    const withMeta = sumProduct({ central: { _meta: { lastCountedAt: "2026-08-01" }, S: cell(4) } });
    expect(withMeta.total).toBe(4);
    expect(withMeta.cellCount).toBe(1);

    // The case that matters: a location holding ONLY a surviving _meta must not
    // turn "no stock recorded anywhere" into "1 cell across 1 location".
    const onlyMeta = sumProduct({ hub3: { _meta: { drainedAt: "2026-07-26" } } });
    expect(onlyMeta.total).toBe(0);
    expect(onlyMeta.cellCount).toBe(0);
    expect(onlyMeta.locationCount).toBe(0);
    expect(onlyMeta.perLocation).toEqual({});
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

describe("sumProduct — a negative cell counts as zero", () => {
  // OWNER DECISION 2026-08-22, reversing how this first shipped: the card is a
  // clean list of names and numbers, so a negative cell adds nothing and is
  // never mentioned. The trade is real and deliberate — this screen reports
  // what can be counted on, not what the ledger says. The ledger's negatives
  // remain Inventory Health's Negative Inventory card's business.
  it("does not let a negative cell drag the total down", () => {
    const r = sumProduct({ central: { S: cell(10) }, hub2: { S: cell(-50) } });
    expect(r.total).toBe(10);              // not −40
  });

  it("never returns a negative total, however the negatives are arranged", () => {
    expect(sumProduct({ central: { S: cell(-50) } }).total).toBe(0);
    expect(sumProduct({ central: { S: cell(-3), M: cell(1) } }).total).toBe(1);
    expect(sumProduct({ a: { S: cell(-3) }, b: { S: cell(-9) } }).total).toBe(0);
  });

  it("reports nothing about negatives at all", () => {
    const r = sumProduct({ hub2: { S: cell(-50) } });
    expect(r.negatives).toBeUndefined();
    expect(r.negativeUnits).toBeUndefined();
  });

  // A negative cell is still a CELL — it exists, it just adds nothing. Folding
  // it out of cellCount would make a location that holds a cell look like one
  // that never had one.
  it("still counts a negative cell as a cell that exists", () => {
    const r = sumProduct({ hub2: { S: cell(-50) } });
    expect(r.cellCount).toBe(1);
    expect(r.locationCount).toBe(1);
    expect(r.perLocation).toEqual({ hub2: 0 });
  });

  // MUTATION PROOF, the other way round now: prove the clamp is per CELL and not
  // per location or per total, because those three agree on simple inputs and
  // disagree exactly where it matters.
  it("clamps per cell, not per location and not on the final answer", () => {
    const input = { central: { S: cell(10), M: cell(-4) }, hub2: { S: cell(-50) } };
    expect(sumProduct(input).total).toBe(10);
    const clampPerLocation = Math.max(0, 10 - 4) + Math.max(0, -50);   // 6
    const clampFinalOnly   = Math.max(0, 10 - 4 - 50);                 // 0
    const noClampAtAll     = 10 - 4 - 50;                              // −44
    for (const wrong of [clampPerLocation, clampFinalOnly, noClampAtAll]) {
      expect(sumProduct(input).total).not.toBe(wrong);
    }
  });
});

describe("countedLocations — everywhere except Pine and Hub 3", () => {
  const ALL = ["studio", "central", "base", "hub1", "hub2", "hub3", "marathon-pe", "trophy", "marathon-pine", "in_transit"];

  it("drops exactly Pine and Hub 3, and keeps everything else", () => {
    expect(countedLocations(ALL)).toEqual(
      ["base", "central", "hub1", "hub2", "in_transit", "marathon-pe", "studio", "trophy"],
    );
  });

  it("names the exclusions in one place so the number and the caption agree", () => {
    expect(EXCLUDED_LOCATIONS).toEqual(["marathon-pine", "hub3"]);
    for (const id of EXCLUDED_LOCATIONS) expect(countedLocations(ALL)).not.toContain(id);
  });

  // Studio and Base were consolidated into Central in July 2026. They stay in
  // /locations as active:false so historical movements remain valid, but they
  // are not places any more and their cells must not reach this number.
  it("drops a retired location on the registry's own active flag", () => {
    const reg = Object.fromEntries(ALL.map((id) => [id, { id, active: id !== "studio" && id !== "base" }]));
    expect(countedLocations(ALL, reg)).toEqual(["central", "hub1", "hub2", "in_transit", "marathon-pe", "trophy"]);
  });

  // An id the registry does not describe is COUNTED. A location holding units
  // should show up in the total and be noticed, not vanish from it silently.
  it("counts a location the registry does not describe", () => {
    expect(countedLocations(["central", "newplace"], { central: { active: true } })).toEqual(["central", "newplace"]);
  });

  it("counts everything when there is no registry to consult", () => {
    expect(countedLocations(["studio", "central"])).toEqual(["central", "studio"]);
  });

  it("keeps a location that merely looks similar", () => {
    expect(countedLocations(["hub1", "hub2", "hub30", "pine"])).toEqual(["hub1", "hub2", "hub30", "pine"]);
  });

  it("copes with an empty or missing registry", () => {
    expect(countedLocations([])).toEqual([]);
    expect(countedLocations(null)).toEqual([]);
  });
});

describe("sumProduct — a product with no stock anywhere", () => {
  it("is zero, not blank and not an error", () => {
    const r = sumProduct({});
    expect(r.total).toBe(0);
    expect(r.cellCount).toBe(0);
    expect(r.locationCount).toBe(0);
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

  it("holds one page of the search matches when there is a query", () => {
    const matches = [cat[7], cat[8]];
    expect(visibleProducts(cat, matches, "p7", 25)).toEqual(matches);
  });

  // Measured on the live catalogue: "nike" matches far more than a screenful and
  // cost 121 KB unpaged against 44 KB for a page. Both modes page.
  it("pages a broad search instead of pulling every match at once", () => {
    const broad = cat.slice(0, 80);
    expect(visibleProducts(cat, broad, "p", 25)).toHaveLength(25);
    expect(visibleProducts(cat, broad, "p", 50)).toHaveLength(50);
  });

  it("never exceeds the catalogue, and copes with a zero page", () => {
    expect(visibleProducts(cat.slice(0, 3), [], "", 25)).toHaveLength(3);
    expect(visibleProducts(cat, [], "", 0)).toHaveLength(0);
  });
});

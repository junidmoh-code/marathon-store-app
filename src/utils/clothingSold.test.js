import { describe, it, expect } from "vitest";
import {
  saDateOf,
  saStartIso,
  sizeSortKey,
  nettedSoldRows,
  clothingSoldEventsForPeriod,
  tallyRefills,
  sizeOutHub,
  clothingSectionLabel,
  CLOTHING_REFILL_REASON,
  CLOTHING_SOLD_STORES,
} from "./clothingSold";

// Catalogue join. p1/p2 clothing (explicit productType), p3 sneaker, p4 no
// productType → size-letter fallback, p5 clothing w/ photoUrl, no gallery.
const PRODUCTS = {
  p1: { id: "p1", name: "Nike Tee",    productType: "clothing", photoUrl: "u1", photo: "b1", category: "Clothing", subcategory: "T-Shirts", gallery: ["u1", "g2"] },
  p2: { id: "p2", name: "Puma Hoodie", productType: "clothing", category: "Clothing", subcategory: "Hoodies & Sweatshirts" },
  p3: { id: "p3", name: "Air Max 90",  productType: "sneaker" },
  p4: { id: "p4", name: "Legacy Polo" },
  p5: { id: "p5", name: "Nike Cap",    productType: "clothing", photoUrl: "only1", category: "Clothing", subcategory: "Caps & Hats" },
};

const sold = (saleId, productId, size, t, extra = {}) => ({
  type: "sold", productId, size, qty: 1, from: "marathon-pe",
  ts: `2026-06-16T${t}:00:00.000Z`, link: { saleId }, ...extra,
});
const ret = (productId, size, t, extra = {}) => ({
  type: "return", productId, size, qty: 1, to: "marathon-pe",
  ts: `2026-06-16T${t}:00:00.000Z`, link: { saleId: "REF" }, ...extra,
});
// A refill transfer (hub→store), tagged so tallyRefills counts it.
const refill = (productId, size, qty, extra = {}) => ({
  type: "transfer_out", reason: CLOTHING_REFILL_REASON, productId, size, qty,
  from: "hub1", to: "marathon-pe", ts: "2026-06-16T20:00:00.000Z", link: { refillId: "R1" }, ...extra,
});
const base = { productsById: PRODUCTS };
const PAST = "2026-06-17"; // cutoff: all 06-16 sales are backlog

const g0 = (opts) => clothingSoldEventsForPeriod({ ...base, cutoff: PAST, store: null, stores: CLOTHING_SOLD_STORES, ...opts })[0];

describe("saDateOf / saStartIso / sizeSortKey", () => {
  it("saDateOf slices in SA time (+2h), '' on empty/malformed", () => {
    expect(saDateOf("2026-06-16T12:00:00.000Z")).toBe("2026-06-16");
    expect(saDateOf("2026-06-16T23:00:00.000Z")).toBe("2026-06-17");
    expect(saDateOf("")).toBe("");
    expect(saDateOf("not-a-date")).toBe("");
  });
  it("saStartIso is 22:00 UTC the previous day (midnight SA)", () => {
    expect(saStartIso("2026-06-16")).toBe("2026-06-15T22:00:00.000Z");
    expect(saDateOf(saStartIso("2026-06-16"))).toBe("2026-06-16");
  });
  it("sizeSortKey orders letters then numeric waists", () => {
    expect(sizeSortKey("S")).toBeLessThan(sizeSortKey("M"));
    expect(sizeSortKey("XL")).toBeLessThan(sizeSortKey("XXL"));
    expect(sizeSortKey("XXXL")).toBeLessThan(sizeSortKey("32"));
  });
});

describe("grouping — per-size sold/refilled/outstanding", () => {
  it("one card per (store,product); sizes carry the full breakdown", () => {
    const g = g0({ movements: [sold("S1", "p1", "M", "08"), sold("S2", "p1", "M", "09"), sold("S3", "p1", "L", "10")] });
    expect(g).toMatchObject({ productId: "p1", store: "marathon-pe", total: 3, soldTotal: 3, done: false });
    expect(g.sizes).toEqual([
      { size: "M", sold: 2, refilled: 0, outstanding: 2, outHub: null },
      { size: "L", sold: 1, refilled: 0, outstanding: 1, outHub: null },
    ]);
  });
  it("excludes sneakers; size-letter fallback when productType absent", () => {
    const g = g0({ movements: [sold("S1", "p3", "9", "08"), sold("S2", "p4", "L", "09"), sold("S3", "p4", "9", "10")] });
    expect(g.productId).toBe("p4");
    expect(g.sizes.map(s => s.size)).toEqual(["L"]);
  });
});

describe("return netting (unchanged)", () => {
  it("drops refunded units by (store,product,size), most-recent-first", () => {
    const rows = nettedSoldRows({ ...base, movements: [sold("S1", "p1", "M", "08", { qty: 2 }), ret("p1", "M", "11", { qty: 1 })] });
    expect(rows.reduce((n, r) => n + r.qty, 0)).toBe(1);
  });
  it("a fully-returned product yields no card", () => {
    expect(clothingSoldEventsForPeriod({ ...base, cutoff: PAST, store: null, stores: CLOTHING_SOLD_STORES, movements: [sold("S1", "p1", "M", "08"), ret("p1", "M", "11")] })).toHaveLength(0);
  });
});

describe("tallyRefills — ledger-derived refilled units", () => {
  it("sums refill-tagged transfer_out qty by (store,product,size)", () => {
    const t = tallyRefills([refill("p1", "M", 2), refill("p1", "M", 1), refill("p1", "L", 3)]);
    expect(t.get("marathon-pe p1 M")).toBe(3);
    expect(t.get("marathon-pe p1 L")).toBe(3);
  });
  it("ignores untagged transfers, wrong type, missing destination", () => {
    const t = tallyRefills([
      { type: "transfer_out", productId: "p1", size: "M", qty: 9, to: "marathon-pe" },          // no reason tag
      { type: "sold", productId: "p1", size: "M", qty: 9, from: "marathon-pe", reason: CLOTHING_REFILL_REASON }, // wrong type
      refill("p1", "M", 2, { to: null }),                                                        // no destination
      refill("p1", "M", 4),                                                                      // counts
    ]);
    expect(t.get("marathon-pe p1 M")).toBe(4);
  });
});

describe("outstanding = sold − refilled", () => {
  it("a partial refill leaves the remainder outstanding", () => {
    const g = g0({ movements: [sold("S1", "p1", "M", "08"), sold("S2", "p1", "M", "09"), refill("p1", "M", 1)] });
    const m = g.sizes.find(s => s.size === "M");
    expect(m).toMatchObject({ sold: 2, refilled: 1, outstanding: 1 });
    expect(g.total).toBe(1);
    expect(g.done).toBe(false);
  });
  it("a full refill clears the size; card done when all sizes clear", () => {
    const g = g0({ movements: [sold("S1", "p1", "M", "08"), sold("S2", "p1", "M", "09"), refill("p1", "M", 2)] });
    expect(g.total).toBe(0);
    expect(g.done).toBe(true);
    expect(g.sizes[0]).toMatchObject({ sold: 2, refilled: 2, outstanding: 0 });
  });
  it("over-refill never drives outstanding negative", () => {
    const g = g0({ movements: [sold("S1", "p1", "M", "08"), refill("p1", "M", 5)] });
    expect(g.sizes[0].outstanding).toBe(0);
    expect(g.total).toBe(0);
  });
  it("refill at a DIFFERENT store does not offset this store", () => {
    const g = g0({ movements: [sold("S1", "p1", "M", "08"), refill("p1", "M", 1, { to: "trophy" })] });
    expect(g.sizes[0].outstanding).toBe(1);
  });
});

describe("out-from-hub marker", () => {
  it("sizeOutHub returns the flagged hub, else null", () => {
    const oos = { "marathon-pe": { p1: { M: { outHub: "hub1" } } } };
    expect(sizeOutHub(oos, "marathon-pe", "p1", "M")).toBe("hub1");
    expect(sizeOutHub(oos, "marathon-pe", "p1", "L")).toBe(null);
    expect(sizeOutHub(null, "marathon-pe", "p1", "M")).toBe(null);
  });
  it("an out-flag tags the size but KEEPS it outstanding (never done)", () => {
    const oos = { "marathon-pe": { p1: { M: { outHub: "hub1" } } } };
    const g = g0({ movements: [sold("S1", "p1", "M", "08"), sold("S2", "p1", "M", "09")], oos });
    expect(g.sizes[0]).toMatchObject({ sold: 2, outstanding: 2, outHub: "hub1" });
    expect(g.total).toBe(2);
    expect(g.done).toBe(false);
  });
  it("a refill still clears an out-flagged size", () => {
    const oos = { "marathon-pe": { p1: { M: { outHub: "hub1" } } } };
    const g = g0({ movements: [sold("S1", "p1", "M", "08"), sold("S2", "p1", "M", "09"), refill("p1", "M", 2)], oos });
    expect(g.sizes[0]).toMatchObject({ sold: 2, refilled: 2, outstanding: 0, outHub: "hub1" });
    expect(g.done).toBe(true);
  });
});

describe("scope split + photos/category", () => {
  const TODAY = "2026-06-16";
  const movements = [sold("S1", "p1", "M", "08"), sold("S2", "p2", "L", "09", { from: "trophy" }), sold("S3", "p2", "S", "10", { from: "marathon-pine" })];
  const b = { ...base, movements };
  it("per-store daily tab vs merged backlog (Pine now covered)", () => {
    expect(clothingSoldEventsForPeriod({ ...b, cutoff: TODAY, store: "marathon-pe" }).map(g => g.productId)).toEqual(["p1"]);
    expect(clothingSoldEventsForPeriod({ ...b, cutoff: TODAY, store: "marathon-pine" }).map(g => g.productId)).toEqual(["p2"]);
    expect(clothingSoldEventsForPeriod({ ...b, cutoff: PAST, store: null, stores: CLOTHING_SOLD_STORES }).map(g => g.store).sort()).toEqual(["marathon-pe", "marathon-pine", "trophy"]);
  });
  it("attaches deduped photos + category/subcategory", () => {
    const g = g0({ movements: [sold("S1", "p1", "M", "08")] });
    expect(g.photos).toEqual(["u1", "g2"]);
    expect(g.subcategory).toBe("T-Shirts");
  });
  it("clothingSectionLabel prefers subcategory then category then Other", () => {
    expect(clothingSectionLabel({ subcategory: "T-Shirts" })).toBe("T-Shirts");
    expect(clothingSectionLabel({ category: "Clothing" })).toBe("Clothing");
    expect(clothingSectionLabel({})).toBe("Other");
  });
});

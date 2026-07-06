import { describe, it, expect } from "vitest";
import {
  saDateOf,
  saStartIso,
  cellId,
  clothingSoldCells,
  clothingSoldEventsForPeriod,
  CLOTHING_SOLD_STORES,
} from "./clothingSold";

// Catalogue join. p1/p2 are clothing (explicit productType), p3 is a sneaker,
// p4 has NO productType — classification must fall back to the size letter.
const PRODUCTS = {
  p1: { id: "p1", name: "Nike Tee",   productType: "clothing", photoUrl: "u1", photo: "b1" },
  p2: { id: "p2", name: "Puma Hoodie", productType: "clothing" },
  p3: { id: "p3", name: "Air Max 90",  productType: "sneaker" },
  p4: { id: "p4", name: "Legacy Polo" }, // no productType → size-letter fallback
};

// A `sold` movement. Timestamps use mid-day UTC so the +2h SA shift never
// crosses a date boundary in these fixtures.
const sold = (saleId, productId, size, t, extra = {}) => ({
  type: "sold", productId, size, qty: 1, from: "marathon-pe",
  ts: `2026-06-16T${t}:00:00.000Z`, link: { saleId }, ...extra,
});
const ret = (saleId, productId, size, t, extra = {}) => ({
  type: "return", productId, size, qty: 1, to: "marathon-pe",
  ts: `2026-06-16T${t}:00:00.000Z`, link: { saleId }, ...extra,
});

describe("saDateOf / saStartIso / cellId", () => {
  it("saDateOf slices in SA time (+2h)", () => {
    expect(saDateOf("2026-06-16T12:00:00.000Z")).toBe("2026-06-16");
    // 23:00 UTC is 01:00 next day in SA
    expect(saDateOf("2026-06-16T23:00:00.000Z")).toBe("2026-06-17");
    expect(saDateOf("")).toBe("");
  });
  it("saStartIso is 22:00 UTC the previous day (midnight SA)", () => {
    expect(saStartIso("2026-06-16")).toBe("2026-06-15T22:00:00.000Z");
    // round-trips: the start instant slices back to the same SA-date
    expect(saDateOf(saStartIso("2026-06-16"))).toBe("2026-06-16");
  });
  it("cellId is dot-free and stable per (sale, product, size)", () => {
    expect(cellId("S1", "p1", "M")).toBe("S1__p1__M");
    expect(cellId("S1", "p1", "5.5")).toBe("S1__p1__5_5"); // half-size encoded
    expect(cellId("S1", "p1", null)).toBe("S1__p1___");     // one-size sentinel
  });
});

describe("clothingSoldCells — classification", () => {
  it("keeps clothing (explicit productType), drops sneakers", () => {
    const movements = [
      sold("S1", "p1", "M", "08"),
      sold("S2", "p3", "9", "09"), // sneaker → dropped
    ];
    const cells = clothingSoldCells({ movements, productsById: PRODUCTS });
    expect(cells.map((c) => c.productId)).toEqual(["p1"]);
  });
  it("falls back to size-letter for a product with no productType", () => {
    const movements = [
      sold("S1", "p4", "L", "08"), // letter size → clothing
      sold("S2", "p4", "9", "09"), // numeric size → sneaker → dropped
    ];
    const cells = clothingSoldCells({ movements, productsById: PRODUCTS });
    expect(cells.map((c) => c.size)).toEqual(["L"]);
  });
  it("carries name/photo from the joined product + RAW size + store", () => {
    const cells = clothingSoldCells({ movements: [sold("S1", "p1", "M", "08")], productsById: PRODUCTS });
    expect(cells[0]).toMatchObject({
      productName: "Nike Tee", photoUrl: "u1", photo: "b1",
      size: "M", store: "marathon-pe", saleId: "S1", qty: 1, saDate: "2026-06-16",
    });
  });
});

describe("clothingSoldCells — qty + netting", () => {
  it("sums qty within a cell and keeps the earliest sold ts", () => {
    const movements = [
      sold("S1", "p1", "M", "10", { qty: 2 }),
      sold("S1", "p1", "M", "08", { qty: 3 }), // same cell, earlier
    ];
    const cells = clothingSoldCells({ movements, productsById: PRODUCTS });
    expect(cells).toHaveLength(1);
    expect(cells[0].qty).toBe(5);
    expect(cells[0].ts).toBe("2026-06-16T08:00:00.000Z");
  });
  it("nets a void/return against the same (saleId,productId,size) cell", () => {
    const movements = [
      sold("S1", "p1", "M", "08", { qty: 2 }),
      ret("S1", "p1", "M", "11", { qty: 1 }), // 1 returned → net 1
    ];
    const cells = clothingSoldCells({ movements, productsById: PRODUCTS });
    expect(cells[0].qty).toBe(1);
  });
  it("drops a fully-returned cell (net <= 0)", () => {
    const movements = [
      sold("S1", "p1", "M", "08", { qty: 2 }),
      ret("S1", "p1", "M", "11", { qty: 2 }),
    ];
    expect(clothingSoldCells({ movements, productsById: PRODUCTS })).toHaveLength(0);
  });
  it("a return on a DIFFERENT sale id does not net (per-cell only)", () => {
    const movements = [
      sold("S1", "p1", "M", "08", { qty: 1 }),
      ret("S2", "p1", "M", "11", { qty: 1 }), // different sale → no netting
    ];
    expect(clothingSoldCells({ movements, productsById: PRODUCTS })[0].qty).toBe(1);
  });
  it("ignores non sold/return movement types", () => {
    const movements = [
      { type: "transfer_out", productId: "p1", size: "M", qty: 5, ts: "2026-06-16T08:00:00.000Z", link: { saleId: "S9" } },
      sold("S1", "p1", "M", "08"),
    ];
    expect(clothingSoldCells({ movements, productsById: PRODUCTS })).toHaveLength(1);
  });
  it("tolerates an empty/absent movements list", () => {
    expect(clothingSoldCells({ movements: null, productsById: PRODUCTS })).toEqual([]);
  });
});

describe("clothingSoldEventsForPeriod — scope split", () => {
  // cutoff = the day AFTER our sale fixtures, so 06-16 sales are "today's fresh".
  const CUTOFF_TODAY = "2026-06-16";   // 06-16 sales are >= cutoff  → per-store
  const CUTOFF_TOMORROW = "2026-06-17"; // 06-16 sales are <  cutoff → backlog

  const movements = [
    sold("S1", "p1", "M", "08"),                              // PE
    sold("S2", "p2", "L", "09", { from: "trophy" }),          // Trophy
    sold("S3", "p2", "S", "10", { from: "marathon-pine" }),   // Pine (not covered)
  ];
  const base = { movements, productsById: PRODUCTS };

  it("per-store tab: saDate >= cutoff AND store match", () => {
    const pe = clothingSoldEventsForPeriod({ ...base, cutoff: CUTOFF_TODAY, store: "marathon-pe" });
    expect(pe.map((c) => c.saleId)).toEqual(["S1"]);
    const trophy = clothingSoldEventsForPeriod({ ...base, cutoff: CUTOFF_TODAY, store: "trophy" });
    expect(trophy.map((c) => c.saleId)).toEqual(["S2"]);
  });

  it("per-store tab is empty when the sale day is already in the past", () => {
    // cutoff has advanced past the sale date → nothing is 'today' anymore
    expect(clothingSoldEventsForPeriod({ ...base, cutoff: CUTOFF_TOMORROW, store: "marathon-pe" })).toHaveLength(0);
  });

  it("backlog: saDate < cutoff, merged across the covered stores only", () => {
    const backlog = clothingSoldEventsForPeriod({ ...base, cutoff: CUTOFF_TOMORROW, store: null, stores: CLOTHING_SOLD_STORES });
    // PE + Trophy merge; Pine excluded (not in CLOTHING_SOLD_STORES)
    expect(backlog.map((c) => c.saleId).sort()).toEqual(["S1", "S2"]);
  });

  it("backlog excludes today's fresh sales (>= cutoff)", () => {
    // With cutoff=today, 06-16 sales are 'today' → NOT backlog
    expect(clothingSoldEventsForPeriod({ ...base, cutoff: CUTOFF_TODAY, store: null, stores: CLOTHING_SOLD_STORES })).toHaveLength(0);
  });

  it("windowStartSaDate drops cells older than the read window", () => {
    const old = [sold("S0", "p1", "M", "08", { ts: "2026-05-01T08:00:00.000Z" })];
    const out = clothingSoldEventsForPeriod({ movements: old, productsById: PRODUCTS, cutoff: CUTOFF_TOMORROW, store: null, stores: CLOTHING_SOLD_STORES, windowStartSaDate: "2026-06-03" });
    expect(out).toHaveLength(0);
  });
});

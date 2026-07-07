import { describe, it, expect } from "vitest";
import {
  saDateOf,
  saStartIso,
  sizeSortKey,
  nettedSoldRows,
  clothingSoldEventsForPeriod,
  isGroupRefilled,
  clothingSectionLabel,
  CLOTHING_SOLD_STORES,
} from "./clothingSold";

// Catalogue join. p1/p2 clothing (explicit productType), p3 sneaker, p4 has NO
// productType → classification falls back to the size letter.
const PRODUCTS = {
  p1: { id: "p1", name: "Nike Tee",    productType: "clothing", photoUrl: "u1", photo: "b1", category: "Clothing", subcategory: "T-Shirts", gallery: ["u1", "g2"] },
  p2: { id: "p2", name: "Puma Hoodie", productType: "clothing", category: "Clothing", subcategory: "Hoodies & Sweatshirts" },
  p3: { id: "p3", name: "Air Max 90",  productType: "sneaker" },
  p4: { id: "p4", name: "Legacy Polo" },
};

// A `sold` movement on 2026-06-16 at hour `t`. Mid-day UTC so the +2h SA shift
// never crosses a date line unless a fixture overrides ts.
const sold = (saleId, productId, size, t, extra = {}) => ({
  type: "sold", productId, size, qty: 1, from: "marathon-pe",
  ts: `2026-06-16T${t}:00:00.000Z`, link: { saleId }, ...extra,
});
// A `return` movement — `to` is the store; link.saleId is a refund id.
const ret = (productId, size, t, extra = {}) => ({
  type: "return", productId, size, qty: 1, to: "marathon-pe",
  ts: `2026-06-16T${t}:00:00.000Z`, link: { saleId: "REF" }, ...extra,
});
const base = { productsById: PRODUCTS };
const PAST = "2026-06-17"; // cutoff: all 06-16 sales are backlog (saDate < cutoff)

describe("saDateOf / saStartIso / sizeSortKey", () => {
  it("saDateOf slices in SA time (+2h)", () => {
    expect(saDateOf("2026-06-16T12:00:00.000Z")).toBe("2026-06-16");
    expect(saDateOf("2026-06-16T23:00:00.000Z")).toBe("2026-06-17");
  });
  it("saStartIso is 22:00 UTC the previous day (midnight SA)", () => {
    expect(saStartIso("2026-06-16")).toBe("2026-06-15T22:00:00.000Z");
    expect(saDateOf(saStartIso("2026-06-16"))).toBe("2026-06-16");
  });
  it("sizeSortKey orders letters then numeric waists", () => {
    expect(sizeSortKey("S")).toBeLessThan(sizeSortKey("M"));
    expect(sizeSortKey("M")).toBeLessThan(sizeSortKey("XL"));
    expect(sizeSortKey("XL")).toBeLessThan(sizeSortKey("XXL"));
    expect(sizeSortKey("XXXL")).toBeLessThan(sizeSortKey("32"));
  });
});

describe("one card per (store, product), aggregated across days", () => {
  it("collapses many (sale,size,day) cells of one product into ONE card", () => {
    const movements = [
      sold("S1", "p1", "M", "08"),
      sold("S2", "p1", "M", "09", { ts: "2026-06-15T09:00:00.000Z" }), // different day
      sold("S3", "p1", "L", "10"),
      sold("S4", "p1", "S", "11"),
    ];
    const groups = clothingSoldEventsForPeriod({ ...base, movements, cutoff: PAST, store: null, stores: CLOTHING_SOLD_STORES });
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g).toMatchObject({ productId: "p1", productName: "Nike Tee", store: "marathon-pe", total: 4 });
    expect(g.sizes).toEqual([{ size: "S", qty: 1 }, { size: "M", qty: 2 }, { size: "L", qty: 1 }]); // S<M<L
    expect(g.latestTs).toBe("2026-06-16T11:00:00.000Z"); // newest sale
  });

  it("keeps different products and different stores as separate cards", () => {
    const movements = [
      sold("S1", "p1", "M", "08"),
      sold("S2", "p2", "L", "09"),                         // diff product
      sold("S3", "p1", "M", "10", { from: "trophy" }),     // diff store, same product
    ];
    const groups = clothingSoldEventsForPeriod({ ...base, movements, cutoff: PAST, store: null, stores: CLOTHING_SOLD_STORES });
    expect(groups).toHaveLength(3);
  });

  it("excludes sneakers; falls back to size-letter when productType absent", () => {
    const movements = [
      sold("S1", "p3", "9", "08"),   // sneaker → dropped
      sold("S2", "p4", "L", "09"),   // no productType, letter → clothing
      sold("S3", "p4", "9", "10"),   // no productType, numeric → sneaker → dropped
    ];
    const groups = clothingSoldEventsForPeriod({ ...base, movements, cutoff: PAST, store: null, stores: CLOTHING_SOLD_STORES });
    expect(groups.map((g) => g.productId)).toEqual(["p4"]);
    expect(groups[0].sizes).toEqual([{ size: "L", qty: 1 }]);
  });

  it("sums qty within a size", () => {
    const groups = clothingSoldEventsForPeriod({ ...base, movements: [sold("S1", "p1", "M", "08", { qty: 3 }), sold("S2", "p1", "M", "09", { qty: 2 })], cutoff: PAST, store: null, stores: CLOTHING_SOLD_STORES });
    expect(groups[0].sizes).toEqual([{ size: "M", qty: 5 }]);
    expect(groups[0].total).toBe(5);
  });
});

describe("return netting by (store, product, size)", () => {
  it("drops a refunded unit even though the return has a different saleId", () => {
    const rows = nettedSoldRows({ ...base, movements: [sold("S1", "p1", "M", "08", { qty: 2 }), ret("p1", "M", "11", { qty: 1 })] });
    expect(rows.reduce((n, r) => n + r.qty, 0)).toBe(1);
  });
  it("cancels the MOST RECENT sold unit first (older day survives)", () => {
    const movements = [
      sold("S1", "p1", "M", "08", { ts: "2026-06-15T08:00:00.000Z" }), // older
      sold("S2", "p1", "M", "09", { ts: "2026-06-16T09:00:00.000Z" }), // newer
      ret("p1", "M", "12", { qty: 1 }),
    ];
    const rows = nettedSoldRows({ ...base, movements });
    expect(rows).toHaveLength(1);
    expect(rows[0].saDate).toBe("2026-06-15");
  });
  it("a fully-returned product yields no card", () => {
    const groups = clothingSoldEventsForPeriod({ ...base, movements: [sold("S1", "p1", "M", "08"), ret("p1", "M", "11")], cutoff: PAST, store: null, stores: CLOTHING_SOLD_STORES });
    expect(groups).toHaveLength(0);
  });
  it("a return at a DIFFERENT store does not net", () => {
    const rows = nettedSoldRows({ ...base, movements: [sold("S1", "p1", "M", "08"), ret("p1", "M", "11", { to: "trophy" })] });
    expect(rows.reduce((n, r) => n + r.qty, 0)).toBe(1);
  });
  it("ignores non sold/return movement types", () => {
    const movements = [{ type: "transfer_out", productId: "p1", size: "M", qty: 5, ts: "2026-06-16T08:00:00.000Z", from: "marathon-pe" }, sold("S1", "p1", "M", "08")];
    expect(nettedSoldRows({ ...base, movements }).reduce((n, r) => n + r.qty, 0)).toBe(1);
  });
  it("tolerates an empty/absent movements list", () => {
    expect(nettedSoldRows({ ...base, movements: null })).toEqual([]);
  });
});

describe("scope split (daily per-store vs merged backlog)", () => {
  const TODAY = "2026-06-16";     // 06-16 sales are >= cutoff → per-store daily
  const movements = [
    sold("S1", "p1", "M", "08"),                            // PE
    sold("S2", "p2", "L", "09", { from: "trophy" }),        // Trophy
    sold("S3", "p2", "S", "10", { from: "marathon-pine" }), // Pine (not covered)
  ];
  const b = { ...base, movements };

  it("per-store daily tab: saDate >= cutoff AND store match", () => {
    expect(clothingSoldEventsForPeriod({ ...b, cutoff: TODAY, store: "marathon-pe" }).map((g) => g.productId)).toEqual(["p1"]);
    expect(clothingSoldEventsForPeriod({ ...b, cutoff: TODAY, store: "trophy" }).map((g) => g.productId)).toEqual(["p2"]);
  });
  it("per-store tab empty once the sale day is in the past", () => {
    expect(clothingSoldEventsForPeriod({ ...b, cutoff: PAST, store: "marathon-pe" })).toHaveLength(0);
  });
  it("backlog: saDate < cutoff, merged across covered stores only (Pine excluded)", () => {
    const backlog = clothingSoldEventsForPeriod({ ...b, cutoff: PAST, store: null, stores: CLOTHING_SOLD_STORES });
    expect(backlog.map((g) => g.store).sort()).toEqual(["marathon-pe", "trophy"]);
  });
  it("backlog excludes today's fresh sales (>= cutoff)", () => {
    expect(clothingSoldEventsForPeriod({ ...b, cutoff: TODAY, store: null, stores: CLOTHING_SOLD_STORES })).toHaveLength(0);
  });
  it("fromSaDate drops sales older than the picked window", () => {
    const movements2 = [
      sold("A", "p1", "M", "08", { ts: "2026-06-10T08:00:00.000Z" }), // before from
      sold("B", "p1", "L", "08", { ts: "2026-06-14T08:00:00.000Z" }), // inside
    ];
    const g = clothingSoldEventsForPeriod({ ...base, movements: movements2, cutoff: PAST, store: null, stores: CLOTHING_SOLD_STORES, fromSaDate: "2026-06-12" });
    expect(g).toHaveLength(1);
    expect(g[0].sizes).toEqual([{ size: "L", qty: 1 }]);
  });
  it("toSaDate drops sales newer than the picked window (still < cutoff)", () => {
    const movements2 = [
      sold("A", "p1", "M", "08", { ts: "2026-06-13T08:00:00.000Z" }), // inside [12,14]
      sold("B", "p2", "L", "08", { ts: "2026-06-16T08:00:00.000Z" }), // after to
    ];
    const g = clothingSoldEventsForPeriod({ ...base, movements: movements2, cutoff: PAST, store: null, stores: CLOTHING_SOLD_STORES, fromSaDate: "2026-06-12", toSaDate: "2026-06-14" });
    expect(g.map((x) => x.productId)).toEqual(["p1"]);
  });
});

describe("group carries category/subcategory + deduped photos", () => {
  it("attaches category, subcategory, and a deduped photo list for the lightbox", () => {
    const g = clothingSoldEventsForPeriod({ ...base, movements: [sold("S1", "p1", "M", "08")], cutoff: PAST, store: null, stores: CLOTHING_SOLD_STORES })[0];
    expect(g.category).toBe("Clothing");
    expect(g.subcategory).toBe("T-Shirts");
    expect(g.photos).toEqual(["u1", "g2"]); // photoUrl first, gallery deduped
  });
  it("group with no gallery still lists the primary photo", () => {
    const g = clothingSoldEventsForPeriod({ ...base, movements: [sold("S1", "p2", "L", "08")], cutoff: PAST, store: null, stores: CLOTHING_SOLD_STORES })[0];
    expect(g.photos).toEqual([]); // p2 has no photoUrl/gallery
  });
});

describe("clothingSectionLabel", () => {
  it("prefers subcategory, then category, then Other", () => {
    expect(clothingSectionLabel({ subcategory: "T-Shirts", category: "Clothing" })).toBe("T-Shirts");
    expect(clothingSectionLabel({ category: "Clothing" })).toBe("Clothing");
    expect(clothingSectionLabel({})).toBe("Other");
  });
});

describe("isGroupRefilled — timestamp semantics", () => {
  const g = { store: "marathon-pe", productId: "p1", latestTs: "2026-06-16T10:00:00.000Z" };
  it("done when refilledAt is at/after the latest sale", () => {
    expect(isGroupRefilled(g, { "marathon-pe": { p1: { refilledAt: "2026-06-16T11:00:00.000Z" } } })).toBe(true);
  });
  it("pending again when a later sale post-dates the refill", () => {
    expect(isGroupRefilled(g, { "marathon-pe": { p1: { refilledAt: "2026-06-16T09:00:00.000Z" } } })).toBe(false);
  });
  it("pending when no refill recorded", () => {
    expect(isGroupRefilled(g, {})).toBe(false);
    expect(isGroupRefilled(g, { "marathon-pe": {} })).toBe(false);
  });
});

// Hub 3 counts EVERY category (Junid, 6 Nov 2026) — hubCountCore all-category mode.
import { describe, it, expect } from "vitest";
import {
  buildHubRows, seededRowFor, recoverSeededRows, isCountableCellKey, countsAllCategories,
  sizeLabelOf, sizeRank, progressOf,
} from "./hubCountCore";

const SHOE = { id: "s1", name: "Air Max", category: "Footwear", subcategory: "Sneakers", sizes: ["8", "5.5"] };
const TEE = { id: "t1", name: "Tee", category: "Clothing", subcategory: "T-Shirts", productType: "clothing", sizes: ["XL", "S", "M"] };
const BAG = { id: "b1", name: "Tote", category: "Bags", productType: "clothing" };
const cell = (qty) => ({ qty, v: 1 });
const HUB3 = {
  s1: { "8": cell(0), "5_5": cell(0), _: cell(0), _meta: { x: 1 } },
  t1: { S: cell(0), XL: cell(0), M: cell(0) },
  b1: { _: cell(0) },
};
const products = [SHOE, TEE, BAG];

describe("all-category count (Hub 3 only)", () => {
  it("only Hub 3 is an all-category hub", () => {
    expect(countsAllCategories("hub3")).toBe(true);
    for (const h of ["hub1", "hub2", "central", "marathon-pine", "concrete"]) expect(countsAllCategories(h)).toBe(false);
  });

  it("lists shoes AND clothing AND one-size lines at Hub 3", () => {
    const rows = buildHubRows({ products, hubStock: HUB3, allCategories: true });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.sizes.map((s) => s.sizeKey)]));
    expect(byId.s1).toEqual(["5_5", "8"]);             // a shoe's "_" stays excluded
    expect(byId.t1).toEqual(["S", "M", "XL"]);          // clothing run order
    expect(byId.b1).toEqual(["_"]);                     // one-size bag is a real cell
    expect(progressOf(rows, {})).toEqual({ done: 0, total: 6 });
  });

  it("Marathon's hubs keep the sneaker-only list, byte-for-byte", () => {
    const rows = buildHubRows({ products, hubStock: HUB3 });
    expect(rows.map((r) => r.id)).toEqual(["s1"]);
    expect(rows[0].sizes.map((s) => s.sizeKey)).toEqual(["5_5", "8"]);
  });

  it("one-size labels read 'One size'; the clothing run sorts XS→XXL", () => {
    expect(sizeLabelOf("_")).toBe("One size");
    expect(["XL", "S", "XXL", "M", "XS", "L"].sort((a, b) => sizeRank(a) - sizeRank(b))).toEqual(["XS", "S", "M", "L", "XL", "XXL"]);
    expect(isCountableCellKey("_", BAG, true)).toBe(true);
    expect(isCountableCellKey("_", BAG, false)).toBe(false);
    expect(isCountableCellKey("_", SHOE, true)).toBe(false);
    expect(isCountableCellKey("_meta", BAG, true)).toBe(false);
  });

  it("adding a product with no Hub 3 cell seeds its real sizes — or One size", () => {
    expect(seededRowFor(TEE, { allCategories: true }).sizes.map((s) => s.sizeKey)).toEqual(["S", "M", "XL"]);
    expect(seededRowFor(BAG, { allCategories: true }).sizes.map((s) => s.sizeKey)).toEqual(["_"]);
    expect(seededRowFor({ ...BAG, sizes: ["_"] }, { allCategories: true }).sizes.map((s) => s.sizeKey)).toEqual(["_"]);
    expect(seededRowFor(BAG)).not.toBeNull();            // outside Hub 3 the footwear fallback is unchanged
  });

  it("a recorded one-size count is recovered after a reload", () => {
    const counted = { "b9::_": { productId: "b9", sizeKey: "_" } };
    const rows = recoverSeededRows({ counted, hubStock: {}, products: [{ ...BAG, id: "b9" }], allCategories: true });
    expect(rows.map((r) => [r.id, r.sizes.map((s) => s.sizeKey)])).toEqual([["b9", ["_"]]]);
    expect(recoverSeededRows({ counted, hubStock: {}, products: [{ ...BAG, id: "b9" }] })).toEqual([]);
  });
});

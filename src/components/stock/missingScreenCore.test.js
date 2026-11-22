// ─── MISSING PRODUCTS — the list's own rules (order, search, filters, words) ──
import { describe, it, expect } from "vitest";
import { uploadedAtOf, categoryLabelOf, brandOf, buildRows, sortRows, filterRows, facet, whyProduct, whySneaker } from "./missingScreenCore";

const byId = new Map([
  ["p1795200000000", { id: "p1795200000000", name: "Tee", brand: "Fear of God", categoryKey: "t-shirts", styleCode: "FG-100" }],
  ["p1795100000000", { id: "p1795100000000", name: "Gazelle", brand: " Adidas ", category: "Footwear", subcategory: "Sneakers" }],
  ["old1", { id: "old1", name: "Old Cap", category: "Clothing", subcategory: "Clothing — Uncategorized" }],
]);
const keyOf = (p) => (p?.categoryKey ? p.categoryKey : p?.category === "Footwear" && p?.subcategory === "Sneakers" ? "sneakers" : null);
const rows = buildRows({
  productCards: [{ pid: "old1", name: "Old Cap" }, { pid: "p1795200000000", name: "Tee" }],
  sneakerCards: [{ pid: "p1795100000000", name: "Gazelle" }], byId, categoryKeyOf: keyOf,
});

describe("order", () => {
  it("a product id is its upload time; anything else sorts last", () => {
    expect(uploadedAtOf("p1795200000000")).toBe(1795200000000);
    for (const id of ["old1", "p12", "", null, "xp1795200000000"]) expect(uploadedAtOf(id)).toBe(0);
  });
  it("newest upload first, both kinds in one list; ties by name", () => {
    expect(rows.map((r) => [r.kind, r.name])).toEqual([["product", "Tee"], ["sneaker", "Gazelle"], ["product", "Old Cap"]]);
    expect(sortRows([{ name: "b", uploadedAt: 0 }, { name: "a", uploadedAt: 0 }]).map((r) => r.name)).toEqual(["a", "b"]);
  });
  it("a row keeps its card untouched", () => {
    const card = Object.freeze({ pid: "old1", name: "Old Cap" });
    expect(buildRows({ productCards: [card], byId, categoryKeyOf: keyOf })[0].card).toBe(card);
  });
});

describe("labels, search and filters", () => {
  it("names the category a person would use, and never invents a brand", () => {
    expect(rows.map((r) => r.category)).toEqual(["T Shirts", "Sneakers", "Clothing"]);
    expect(categoryLabelOf({}, null)).toBe("No category");
    expect(rows.map((r) => r.brand)).toEqual(["Fear of God", "Adidas", "No brand"]);
    expect(brandOf(null)).toBe("No brand");
  });
  it("search needs every word, across name, brand and style code", () => {
    expect(filterRows(rows, { search: "fear tee" }).map((r) => r.name)).toEqual(["Tee"]);
    expect(filterRows(rows, { search: "fg-100" }).map((r) => r.name)).toEqual(["Tee"]);
    expect(filterRows(rows, { search: "adidas tee" })).toEqual([]);
    expect(filterRows(rows, { search: "   " }).length).toBe(3);
  });
  it("filters combine; facets count what is on the list, A–Z", () => {
    expect(filterRows(rows, { category: "Sneakers", brand: "Adidas" }).map((r) => r.name)).toEqual(["Gazelle"]);
    expect(filterRows(rows, { category: "Sneakers", brand: "Fear of God" })).toEqual([]);
    expect(facet(rows, "brand")).toEqual([{ value: "Adidas", count: 1 }, { value: "Fear of God", count: 1 }, { value: "No brand", count: 1 }]);
    expect(facet([], "brand")).toEqual([]);
  });
});

describe("why it is on the list, in plain words", () => {
  const nameOf = (l) => ({ central: "Central", hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3", "marathon-pe": "Marathon PE", trophy: "Trophy", "marathon-pine": "Marathon Pine", concrete: "Concrete" }[l] || l);
  it("never sent out from Central", () => {
    expect(whyProduct({ source: "central", kind: "Only in Central", units: 24, missing: ["hub2", "marathon-pe", "trophy"], sizes: [] }, { nameOf, division: "Marathon" }))
      .toMatchObject({ why: "Never sent out to Marathon — not kept at Hub 2, Marathon PE or Trophy.", holds: "Central holds 24 units." });
  });
  it("stuck at a hub", () => {
    expect(whyProduct({ source: "hub2", kind: "Only in Hub 2", units: 1, missing: ["marathon-pe", "trophy"], sizes: [] }, { nameOf }))
      .toMatchObject({ why: "Stuck at Hub 2 — not kept at Marathon PE or Trophy yet.", holds: "Hub 2 holds 1 unit." });
  });
  it("a shop that keeps its own: never sent, and short of sizes (with what Central cannot send)", () => {
    expect(whyProduct({ source: "central", kind: "Not at Concrete", centralFed: "concrete", units: 6, missing: ["concrete"], sizes: [{ size: "S", avail: 6 }] }, { nameOf }).why)
      .toBe("Never sent to Concrete — Central has it.");
    const short = whyProduct({ source: "central", kind: "Sizes missing at Concrete", centralFed: "concrete", units: 3, missing: ["concrete"], sizes: [{ size: "S", avail: 3 }, { size: "M", avail: 0, centralNone: true }] }, { nameOf });
    expect(short.why).toBe("Concrete is short of sizes S, M.");
    expect(short.holds).toBe("Central holds 3 units of them — none of M.");
    const none = whyProduct({ source: "central", kind: "Sizes missing at Concrete", centralFed: "concrete", units: 0, missing: ["concrete"], sizes: [{ size: "M", avail: 0, centralNone: true }] }, { nameOf });
    expect(none).toMatchObject({ holds: "Central has none of them yet — nothing to send.", nothingToSend: true });
  });
  it("sneakers: never sent out, and sold out", () => {
    expect(whySneaker({ kind: "never_introduced", centralUnits: 18 }, { nameOf, hubs: ["hub1", "hub2"] }))
      .toEqual({ why: "Never sent out — Central has it, Hub 1 and Hub 2 do not.", holds: "Central holds 18 pairs." });
    expect(whySneaker({ kind: "never_introduced", centralUnits: 1 }, { nameOf, hubs: ["hub3"] }))
      .toEqual({ why: "Never sent out — Central has it, Hub 3 does not.", holds: "Central holds 1 pair." });
    expect(whySneaker({ kind: "sold_out", centralUnits: 4, carriedAt: ["hub1"] }, { nameOf, hubs: ["hub1", "hub2"] }).why)
      .toBe("Sold out at Hub 1 — it was kept there before and Central has more.");
  });
});

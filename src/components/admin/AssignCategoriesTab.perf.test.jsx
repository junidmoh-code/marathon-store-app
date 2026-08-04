// ─── ASSIGN CATEGORIES — the performance contract ─────────────────────────────
// This page froze every phone. Measured on live data 2026-08-04: 2,586 products
// in the backlog, each row carrying its own backdrop-filter layer and its own
// <select> of 31 categories — ~80,000 option nodes and 2,586 GPU-composited
// blurred layers, re-rendered in full on every keystroke.
//
// These tests exist so that any of those four mistakes coming back fails CI
// rather than a warehouse phone. They assert on the RENDERED TREE, because
// "how many nodes does this build" is the actual thing that broke.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// No DOM in this environment; the component legitimately uses window for its
// Escape-key handling. Supplying the environment changes no behaviour.
globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  update: async () => {},
}));
vi.mock("../../firebase.js", () => ({ database: { fake: true } }));

const AssignCategoriesTab = (await import("./AssignCategoriesTab.jsx")).default;
const { TAXONOMY_SEED } = await import("../../utils/productTaxonomy.js");

// A backlog product: no categoryKey, and not a legacy sneaker, so it queues.
const product = (i) => ({
  id: `p${i}`, name: `Product ${i}`, brand: "Nike",
  category: "Clothing", subcategory: "T-Shirts", productType: "clothing",
  photoUrl: `https://example.test/${i}.jpg`,
});
const BACKLOG = Array.from({ length: 500 }, (_, i) => product(i));

const render = (products) => {
  let tree;
  act(() => { tree = TestRenderer.create(<AssignCategoriesTab products={products} registry={TAXONOMY_SEED} />); });
  return tree;
};

// Every node carrying a backdrop-filter, blurred or not.
const blurred = (tree) => tree.root.findAll(
  (n) => n.type === "div" && n.props.style && n.props.style.backdropFilter, { deep: true });
const selects = (tree) => tree.root.findAll((n) => n.type === "select", { deep: true });
const options = (tree) => tree.root.findAll((n) => n.type === "option", { deep: true });
// Rows are identified by their per-row checkbox.
const rows = (tree) => tree.root.findAll(
  (n) => n.type === "input" && n.props.type === "checkbox", { deep: true });

let tree;
beforeEach(() => { tree = null; });

describe("the list does not render the whole backlog", () => {
  it("renders a bounded page of rows, not all 500", () => {
    tree = render(BACKLOG);
    const n = rows(tree).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(50);          // PAGE_SIZE is 40; this is the ceiling that matters
    expect(n).toBeLessThan(BACKLOG.length);
  });

  it("scales with the page size, NOT with the backlog — 500 and 2,586 cost the same", () => {
    const small = rows(render(BACKLOG)).length;
    const huge = rows(render(Array.from({ length: 2586 }, (_, i) => product(i)))).length;
    expect(huge).toBe(small);
  });

  it("says how much is hidden, so nobody thinks the queue is short", () => {
    tree = render(BACKLOG);
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain("Show more");
    expect(text).toMatch(/Showing/);
  });
});

describe("no per-row backdrop-filter — the layer that froze phones", () => {
  it("blurred elements are chrome only, and their count does not grow with the list", () => {
    const a = blurred(render(BACKLOG)).length;
    const b = blurred(render(Array.from({ length: 2586 }, (_, i) => product(i)))).length;
    expect(a).toBe(b);            // fixed chrome, not per row
    expect(a).toBeLessThanOrEqual(4);
  });

  it("no row carries a backdrop-filter", () => {
    tree = render(BACKLOG);
    // A row is a flex div holding a checkbox; none of them may be blurred.
    const rowDivs = tree.root.findAll(
      (n) => n.type === "div" && n.props.style?.display === "flex"
        && n.rendered && JSON.stringify(n.props.style).includes("borderRadius"), { deep: true });
    for (const d of rowDivs) {
      if (d.findAll((x) => x.type === "input" && x.props.type === "checkbox", { deep: true }).length) {
        expect(d.props.style.backdropFilter, "a row must never be blurred").toBeUndefined();
      }
    }
  });
});

describe("no <select> per row — the 80,000 option nodes", () => {
  it("option count does not scale with the number of rows", () => {
    const a = options(render(BACKLOG)).length;
    const b = options(render(Array.from({ length: 2586 }, (_, i) => product(i)))).length;
    expect(a).toBe(b);
  });

  it("the only selects are the two filters — the category list is not duplicated per row", () => {
    tree = render(BACKLOG);
    // Filters: "current category" + "brand". The bulk-assign select only exists
    // once something is selected, and no row may contribute one.
    expect(selects(tree).length).toBeLessThanOrEqual(2);
    expect(options(tree).length).toBeLessThan(400);   // was ~31 × row count
  });
});

describe("the empty and cleared states still work", () => {
  it("renders the done state when nothing needs assigning", () => {
    const assigned = [{ id: "a", name: "Done", categoryKey: "t-shirts" }];
    expect(JSON.stringify(render(assigned).toJSON())).toContain("Every product has a category");
  });

  it("legacy sneakers stay out of the queue but are offered for stamping", () => {
    const sneaker = { id: "s1", name: "AF1", category: "Footwear", subcategory: "Sneakers" };
    const text = JSON.stringify(render([sneaker]).toJSON());
    expect(text).toContain("legacy sneakers ready to stamp");
    expect(text).toContain("Every product has a category");   // queue itself is empty
  });
});

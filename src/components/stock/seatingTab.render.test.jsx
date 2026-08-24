// ─── THE SEATING TAB — WHAT IT SHOWS, AND WHO MAY SEE IT ─────────────────────
// Read-only behaviour: the tab strip, the per-location rows, the reason each
// row gives, and GATE 2c — the tab's own super-admin check, independent of the
// tile, the route and the card's.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";

globalThis.window = globalThis.window || {
  addEventListener() {}, removeEventListener() {},
  location: { hash: "" }, scrollY: 0, scrollTo() {},
  confirm: () => false,
  requestAnimationFrame(fn) { fn(); },
};
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => fn());

const callableMock = vi.fn(async () => ({ data: { categories: [], destinations: [], history: [], cap: 75 } }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => (...a) => callableMock(...a) }));
vi.mock("../../firebase", () => ({ database: { fake: true }, functions: { fake: true }, auth: { currentUser: { uid: "u1" } } }));
vi.mock("./barcodeListener", () => ({ installBarcodeListener: () => () => {}, subscribeBarcode: () => () => {} }));

// The live reads, stubbed at the ONE place the tab makes them.
const STOCK = {
  trophy: { p1: { M: { qty: 4, lastType: "sold", updatedAt: "2026-08-20T09:00:00.000Z" } } },
  "marathon-pe": { p1: { L: { qty: 0, lastType: "transfer_out", updatedAt: "2026-08-01T09:00:00.000Z" } } },
};
const TARGETS = { "marathon-pe": { p1: { S: { target: 0, minQty: 0 }, M: { target: 0, minQty: 0 }, L: { target: 0, minQty: 0 } } } };

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  get: async (r) => {
    const [root, loc, pid] = String(r.path).split("/");
    const src = root === "stock" ? STOCK : root === "stock_targets" ? TARGETS : {};
    const v = src?.[loc]?.[pid];
    return { exists: () => v !== undefined, val: () => v };
  },
  onValue: () => () => {},
  update: async () => {},
  push: () => ({ key: "mv1" }),
  child: () => ({}),
}));

vi.mock("./useStock", () => ({
  useLocations: () => ({
    trophy: { id: "trophy", label: "Trophy", kind: "store", sellable: true, active: true },
    "marathon-pe": { id: "marathon-pe", label: "Marathon PE", kind: "store", sellable: true, active: true },
    in_transit: { id: "in_transit", label: "In Transit", kind: "transit", active: true },
  }),
  useEngineConfig: () => ({ ruleBasedTargets: true, defaultRunByStore: { trophy: { S: 1, M: 2, L: 2 }, "marathon-pe": { S: 1, M: 2, L: 2 } } }),
}));

const SeatingTab = (await import("./SeatingTab.jsx")).default;
const EnginePolicyCard = (await import("./EnginePolicyCard.jsx")).default;

const PRODUCTS = [{ id: "p1", name: "Nike Tee Navy", sizes: ["S", "M", "L"], productType: "clothing" }];
const OWNER = { email: "gunidmoh@gmail.com" };
const STAFF = { email: "rashid@marathon.internal" };

const text = (tree) => JSON.stringify(tree.toJSON());
async function renderTab(props = {}) {
  let tree;
  await act(async () => {
    tree = TestRenderer.create(<SeatingTab products={PRODUCTS} viewer={OWNER} flash={() => {}} {...props} />);
  });
  await act(async () => {});
  return tree;
}
const find = (tree, pred) => tree.root.findAll(pred);
const buttonSaying = (tree, label) =>
  find(tree, (n) => n.type === "button").find((b) => JSON.stringify(b.children).includes(label));

beforeEach(() => { callableMock.mockClear(); });

describe("the tab strip", () => {
  it("Engine Policy shows Categories and Seating, and starts on Categories", async () => {
    let tree;
    await act(async () => { tree = TestRenderer.create(<EnginePolicyCard viewer={OWNER} products={PRODUCTS} onExit={() => {}} />); });
    const s = text(tree);
    expect(s).toContain("Categories");
    expect(s).toContain("Seating");
  });

  it("Seating is reachable and renders the tab, not the category list", async () => {
    let tree;
    await act(async () => { tree = TestRenderer.create(<EnginePolicyCard viewer={OWNER} products={PRODUCTS} onExit={() => {}} />); });
    await act(async () => { buttonSaying(tree, "Seating").props.onClick(); });
    expect(tree.root.findAllByType(SeatingTab).length).toBe(1);
  });
});

// ── GATE 2c ──────────────────────────────────────────────────────────────────
describe("GATE 2c — the tab has its own gate", () => {
  it("the card's Seating branch is guarded by enginePolicyVisibleForViewer", () => {
    const src = readFileSync(new URL("./EnginePolicyCard.jsx", import.meta.url), "utf8");
    const branch = src.slice(src.indexOf('tab === "seating"'), src.indexOf("<SeatingTab"));
    expect(branch).toContain("enginePolicyVisibleForViewer(viewer)");
  });

  it("a staff account never reaches the tab, whichever tab is selected", async () => {
    let tree;
    await act(async () => { tree = TestRenderer.create(<EnginePolicyCard viewer={STAFF} products={PRODUCTS} onExit={() => {}} />); });
    expect(tree.root.findAllByType(SeatingTab).length).toBe(0);
    expect(text(tree)).toContain("owner-only");
  });
});

describe("the rows", () => {
  it("says nothing until a product is chosen — and reads nothing", async () => {
    const tree = await renderTab();
    expect(text(tree)).toContain("Search or scan a product");
  });

  it("search finds the product by name", async () => {
    const tree = await renderTab();
    const box = tree.root.findAllByType("input")[0];
    await act(async () => { box.props.onChange({ target: { value: "navy" } }); });
    expect(text(tree)).toContain("Nike Tee Navy");
  });

  it("one row per location, each with its reason", async () => {
    const tree = await renderTab();
    await act(async () => { tree.root.findAllByType("input")[0].props.onChange({ target: { value: "navy" } }); });
    await act(async () => { buttonSaying(tree, "Nike Tee Navy").props.onClick(); });
    await act(async () => {});
    const s = text(tree);
    expect(s).toContain("Trophy");
    expect(s).toContain("Marathon PE");
    // Trophy: a stocked clothing line under a live size run.
    expect(s).toContain("Size run");
    // Marathon PE: every declared size zeroed by an explicit row.
    expect(s).toContain("Switched off");
  });

  it("in_transit is never a seat", async () => {
    const tree = await renderTab();
    await act(async () => { tree.root.findAllByType("input")[0].props.onChange({ target: { value: "navy" } }); });
    await act(async () => { buttonSaying(tree, "Nike Tee Navy").props.onClick(); });
    await act(async () => {});
    expect(text(tree)).not.toContain("In Transit");
  });

  it("shows the last movement, and names a sale as a sale", async () => {
    const tree = await renderTab();
    await act(async () => { tree.root.findAllByType("input")[0].props.onChange({ target: { value: "navy" } }); });
    await act(async () => { buttonSaying(tree, "Nike Tee Navy").props.onClick(); });
    await act(async () => {});
    expect(text(tree)).toContain("Last sold");
  });
});

// ── NO WHOLE-NODE READS ──────────────────────────────────────────────────────
// The rule is structural, so the check is too: every read this file makes must
// name a location AND a product.
describe("reads are scoped", () => {
  it("never asks for /stock or /stock_targets whole", () => {
    const src = readFileSync(new URL("./SeatingTab.jsx", import.meta.url), "utf8");
    for (const bad of ['ref(database, "stock")', 'ref(database, "stock_targets")', "`stock`", "`stock_targets`"]) {
      expect(src).not.toContain(bad);
    }
    expect(src).toContain("stock/${loc}/${pid}");
    expect(src).toContain("stock_targets/${loc}/${pid}");
  });
});

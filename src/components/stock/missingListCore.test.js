// ─── MISSING PRODUCTS — WHAT IS ON THE LIST (the pure rules) ─────────────────
import { describe, it, expect } from "vitest";
import { openRequestsByProduct, productRow, sneakerRow, createFrozenOrder, freezeOrder, tapProblem, openingOrder, rowKey } from "./missingListCore";

const cell = (qty) => ({ qty });
const tee = { id: "p1", name: "Tee", productType: "clothing", categoryKey: "t-shirts", sizes: ["S", "M", "L"] };
const names = { central: "Central", "marathon-pine": "Pine", concrete: "Concrete", hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3", "marathon-pe": "Marathon PE", trophy: "Trophy" };
const nameOf = (l) => names[l] || l;
// A direct (Central → shop) plan: what Central has free of the sizes the shop needs.
const directPlan = (need, free) => (_card, [store]) => {
  const got = (need[store] || []).filter((s) => (free[s] || 0) > 0).map((s) => ({ size: s, qty: Math.min(2, free[s]) }));
  return { lines: [{ store, hub: null, sizes: need[store] || [], firstBatch: got.length > 0, units: got.reduce((t, g) => t + g.qty, 0), got }] };
};

describe("openRequestsByProduct — what Central has already promised, from the request records", () => {
  it("only OPEN, non-shadow requests with units still to send count; one entry per hub and size", () => {
    const m = openRequestsByProduct([
      { productId: "p1", size: "M", qty: 2, requestingLocation: "hub2", status: "open", createdFrom: { source: "central" } },
      { productId: "p1", size: "M", qty: 3, requestingLocation: "hub2", status: "open" },
      { productId: "p1", size: "L", qty: 2, sentQty: 2, requestingLocation: "hub2", status: "open" },     // all sent
      { productId: "p1", size: "S", qty: 2, requestingLocation: "hub2", status: "cancelled" },
      { productId: "p1", size: "S", qty: 2, requestingLocation: "hub2", status: "fulfilled" },
      { productId: "p1", size: "S", qty: 2, requestingLocation: "hub2", status: "open", shadow: true },
      { productId: "p2", size: "8", qty: 1, requestingLocation: "hub1", status: "open" },
    ]);
    expect(m.get("p1")).toEqual({ hub2: { M: { qty: 5, source: "central" } } });
    expect(Object.keys(m.get("p2"))).toEqual(["hub1"]);
    expect(m.get("p3")).toBeUndefined();
  });
  it("a product is keyed by its id — two records with one name never share an entry", () => {
    const m = openRequestsByProduct([{ productId: "a", size: "8", qty: 1, requestingLocation: "hub1", status: "open" }]);
    expect(m.has("a")).toBe(true); expect(m.has("b")).toBe(false);
  });
});

describe("productRow — a card is a row only if a tap would send something", () => {
  const card = { pid: "p1", name: "Tee", source: "central", sizes: [] };
  const base = { card, section: 1, product: tee, dests: ["marathon-pine", "concrete"], tickable: ["marathon-pine", "concrete"], central: "central", nameOf };
  it("nothing any shop needs is at Central → not a row", () => {
    const allStock = { central: { p1: { M: cell(4) } } };
    expect(productRow({ ...base, allStock, planFor: directPlan({ concrete: ["S", "L"], "marathon-pine": [] }, {}) })).toBe(null);
  });
  it("one needed size is at Central → a row; only that size is sent, and the stock line counts only that size", () => {
    const allStock = { central: { p1: { M: cell(40), L: cell(3) } } };
    const row = productRow({ ...base, allStock, planFor: directPlan({ concrete: ["S", "L"], "marathon-pine": [] }, { L: 3 }) });
    expect(row.key).toBe(rowKey(1, "clothing", "p1"));
    expect(row.dests).toEqual([
      { id: "marathon-pine", name: "Pine", ok: false, sizes: [], units: 0 },
      { id: "concrete", name: "Concrete", ok: true, sizes: ["L"], units: 2 },
    ]);
    expect(row.stock).toBe(3);                    // not 43: M is not something a tap sends
    expect(row.sourceName).toBe("Central");
  });
  it("a shop the card may not be solved into is a dead button, whatever the plan says", () => {
    const allStock = { central: { p1: { L: cell(3) } } };
    const row = productRow({ ...base, tickable: ["concrete"], allStock, planFor: directPlan({ concrete: ["L"], "marathon-pine": ["L"] }, { L: 3 }) });
    expect(row.dests.map((d) => d.ok)).toEqual([false, true]);
  });
  it("a shop behind a hub: the row needs the source to hold a size the policy covers; reservations are netted off Central", () => {
    const hubPlan = (_c, [store]) => ({ lines: [{ store, hub: "hub2", sizes: ["M", "L"], firstBatch: false, units: 0, got: [] }] });
    const m = { ...base, section: 2, dests: ["marathon-pe", "trophy"], tickable: ["marathon-pe", "trophy"], planFor: hubPlan, routes: { hub2: "central" } };
    expect(productRow({ ...m, allStock: { central: { p1: { S: cell(9) } } } })).toBe(null);           // Central has only a size no policy covers
    const row = productRow({ ...m, allStock: { central: { p1: { M: cell(2), L: cell(5) } } } });
    expect(row.dests.map((d) => [d.id, d.ok, d.sizes])).toEqual([["marathon-pe", true, ["M", "L"]], ["trophy", true, ["M", "L"]]]);
    expect(row.stock).toBe(7);
    // every unit of M and L is already owed to Hub 2's open requests → nothing free → not a row
    const owed = { hub2: { M: { qty: 2, source: "central" }, L: { qty: 5, source: "central" } } };
    expect(productRow({ ...m, openByLoc: owed, allStock: { central: { p1: { M: cell(2), L: cell(5) } } } })).toBe(null);
  });
  it("a sneaker or slide filed with the clothing is never a row here", () => {
    const allStock = { central: { p1: { L: cell(3) } } };
    expect(productRow({ ...base, product: { ...tee, categoryKey: "slides" }, allStock, planFor: directPlan({ concrete: ["L"] }, { L: 3 }) })).toBe(null);
  });
});

describe("sneakerRow", () => {
  const card = { pid: "s1", name: "Dunk", centralUnits: 30, duplicateOf: null };
  const base = { card, section: 2, dests: ["hub1", "hub2"], nameOf };
  it("lines at a hub → a live button; the stock line is the free stock of the sizes sent", () => {
    const row = sneakerRow({ ...base, planFor: (_c, hub) => (hub === "hub1" ? [{ size: "8", qty: 2, avail: 5 }, { size: "9", qty: 1, avail: 1 }] : []) });
    expect(row.dests.map((d) => [d.id, d.ok, d.units])).toEqual([["hub1", true, 3], ["hub2", false, 0]]);
    expect(row.stock).toBe(6);
  });
  it("the other Marathon hub already has it → that hub is a dead button", () => {
    const row = sneakerRow({ ...base, planFor: () => [{ size: "8", qty: 2, avail: 5 }], refusal: (_c, [h]) => (h === "hub2" ? "seated at Hub 1" : null) });
    expect(row.dests.map((d) => d.ok)).toEqual([true, false]);
  });
  it("nothing to raise because NO policy names its sizes, and nobody has requested it → 'needs policy', with Central's stock", () => {
    const row = sneakerRow({ ...base, planFor: () => [], hasPolicy: () => false, requested: false });
    expect(row.needsPolicy).toBe(true);
    expect(row.stock).toBe(30);
    expect(row.dests.every((d) => !d.ok)).toBe(true);
  });
  it("nothing to raise because it IS requested, or because a policy exists and Central has none free → not a row at all", () => {
    expect(sneakerRow({ ...base, planFor: () => [], hasPolicy: () => false, requested: true })).toBe(null);
    expect(sneakerRow({ ...base, planFor: () => [], hasPolicy: (_c, h) => h === "hub1", requested: false })).toBe(null);
  });
});

describe("the order is frozen", () => {
  it("opens newest upload first; then nothing is re-sorted — a returning row keeps its place, a new one joins at the end", () => {
    expect(openingOrder([{ pid: "p1790000000000", name: "b" }, { pid: "p1795000000000", name: "a" }, { pid: "legacy", name: "c" }]).map((c) => c.name)).toEqual(["a", "b", "c"]);
    const f = createFrozenOrder();
    expect(freezeOrder(f, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(freezeOrder(f, ["c", "a"])).toEqual(["a", "b", "c"]);          // b left: order unchanged
    expect(freezeOrder(f, ["d", "b", "a", "c"])).toEqual(["a", "b", "c", "d"]);   // b back in its place; d appended
  });
});

describe("the gate at the tap", () => {
  const row = { dests: [{ id: "hub1", name: "Hub 1", ok: true }, { id: "hub2", name: "Hub 2", ok: false }] };
  it("only a live destination of THIS card goes through", () => {
    expect(tapProblem({ row, dest: "hub1" })).toBe(null);
    expect(tapProblem({ row, dest: "hub2" })).toMatch(/Nothing to send to Hub 2/);
    expect(tapProblem({ row, dest: "hub3" })).toMatch(/not a destination on this list/);
  });
});

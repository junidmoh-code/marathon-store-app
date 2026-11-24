// ─── MISSING PRODUCTS — WHAT IS ON THE LIST (the pure rules) ─────────────────
import { describe, it, expect } from "vitest";
import { openRequestsByProduct, productRow, sneakerRow, createFrozenOrder, freezeOrder, tapProblem, openingOrder, rowKey, shopOwners, pickNext } from "./missingListCore";

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
    // only Concrete would send something: only Concrete is OFFERED (no dead Pine)
    expect(row.dests).toEqual([{ id: "concrete", name: "Concrete", ok: true, sizes: ["L"], units: 2 }]);
    expect(row.stock).toBe(3);                    // not 43: M is not something a tap sends
    expect(row.sourceName).toBe("Central");
  });
  it("a shop the card may not be solved into is not offered, whatever the plan says", () => {
    const allStock = { central: { p1: { L: cell(3) } } };
    const row = productRow({ ...base, tickable: ["concrete"], allStock, planFor: directPlan({ concrete: ["L"], "marathon-pine": ["L"] }, { L: 3 }) });
    expect(row.dests.map((d) => d.id)).toEqual(["concrete"]);
  });
  it("ONE OWNER: owned by Concrete → Pine is never offered; owned by Pine → Concrete never; owned by both → not listed; neither → both", () => {
    const allStock = { central: { p1: { L: cell(3) } } };
    const plan = directPlan({ concrete: ["L"], "marathon-pine": ["L"] }, { L: 3 });
    expect(productRow({ ...base, allStock, planFor: plan, owners: ["concrete"] }).dests.map((d) => d.id)).toEqual(["concrete"]);
    expect(productRow({ ...base, allStock, planFor: plan, owners: ["marathon-pine"] }).dests.map((d) => d.id)).toEqual(["marathon-pine"]);
    expect(productRow({ ...base, allStock, planFor: plan, owners: ["marathon-pine", "concrete"] })).toBe(null);
    expect(productRow({ ...base, allStock, planFor: plan, owners: [] }).dests.map((d) => d.id)).toEqual(["marathon-pine", "concrete"]);
    // owned by Concrete, and a Concrete solve would send nothing → not on the list at all (never Pine instead)
    expect(productRow({ ...base, allStock, planFor: directPlan({ concrete: [], "marathon-pine": ["L"] }, { L: 3 }), owners: ["concrete"] })).toBe(null);
  });
  it("ONE OWNER, SAID ON THE CARD (Junid, 24 Nov 2026): the held-back shop is a note naming the owner, in its button's place", () => {
    const allStock = { central: { p1: { L: cell(3) } } };
    const plan = directPlan({ concrete: ["L"], "marathon-pine": ["L"] }, { L: 3 });
    const pine = productRow({ ...base, dests: ["concrete", "marathon-pine"], tickable: ["concrete", "marathon-pine"], allStock, planFor: plan, owners: ["marathon-pine"] });
    expect(pine.held).toEqual([{ id: "concrete", owner: "marathon-pine", note: "Pine\u2019s" }]);
    expect(pine.order).toEqual(["concrete", "marathon-pine"]);   // the note sits where Concrete's button would be
    const conc = productRow({ ...base, dests: ["concrete", "marathon-pine"], tickable: ["concrete", "marathon-pine"], allStock, planFor: plan, owners: ["concrete"] });
    expect(conc.held).toEqual([{ id: "marathon-pine", owner: "concrete", note: "Concrete\u2019s" }]);
    // nobody owns it → nothing held, both offered
    const free = productRow({ ...base, dests: ["concrete", "marathon-pine"], tickable: ["concrete", "marathon-pine"], allStock, planFor: plan, owners: [] });
    expect(free.held).toEqual([]);
    expect(free.order).toEqual(["concrete", "marathon-pine"]);
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
    expect(row.dests.map((d) => [d.id, d.ok, d.units])).toEqual([["hub1", true, 3]]);   // Hub 2 sends nothing: absent
    expect(row.stock).toBe(6);
  });
  it("the other Marathon hub already has it → that hub is not offered", () => {
    const row = sneakerRow({ ...base, planFor: () => [{ size: "8", qty: 2, avail: 5 }], refusal: (_c, [h]) => (h === "hub2" ? "seated at Hub 1" : null) });
    expect(row.dests.map((d) => d.id)).toEqual(["hub1"]);
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

describe("shopOwners — Junid's words: stock there, seated there, or a request queued there", () => {
  const shops = ["marathon-pine", "concrete"];
  it("units count; an EMPTY row (left by a count) does not", () => {
    expect(shopOwners({ shops, cells: { concrete: { M: { qty: 2 } }, "marathon-pine": { M: { qty: 0 } } } })).toEqual(["concrete"]);
  });
  it("a seat counts, with no units", () => {
    expect(shopOwners({ shops, cells: {}, seated: (s) => s === "marathon-pine" })).toEqual(["marathon-pine"]);
  });
  it("a queued request counts", () => {
    expect(shopOwners({ shops, cells: {}, queued: (s) => s === "concrete" })).toEqual(["concrete"]);
  });
  it("nothing anywhere → nobody owns it", () => {
    expect(shopOwners({ shops, cells: { concrete: { M: { qty: 0 } } } })).toEqual([]);
  });
});

describe("pickNext — choosing on one card", () => {
  it("a tap chooses, a second tap un-chooses", () => {
    expect(pickNext([], "hub3", { exclusive: true })).toEqual(["hub3"]);
    expect(pickNext(["hub3"], "hub3", { exclusive: true })).toEqual([]);
  });
  it("one-or-the-other: the second location switches the first off — never both", () => {
    expect(pickNext(["marathon-pine"], "concrete", { exclusive: true })).toEqual(["concrete"]);
    expect(pickNext(["hub1"], "hub2", { exclusive: true })).toEqual(["hub2"]);
  });
  it("where both may go (Marathon's shops), both can be chosen", () => {
    expect(pickNext(["marathon-pe"], "trophy")).toEqual(["marathon-pe", "trophy"]);
  });
});

// "NOTHING DISAPPEARS SILENTLY" (Junid, 23 Nov 2026): a dropped row says why.
import { decideProductRow, decideSneakerRow } from "./missingListCore";
describe("decideProductRow / decideSneakerRow — the same row, and why when there is none", () => {
  const card = { pid: "p1", name: "Tee", source: "central", sizes: [] };
  const base = { card, section: 1, product: tee, dests: ["marathon-pine", "concrete"], tickable: ["marathon-pine", "concrete"], central: "central", nameOf };
  const why = (a) => decideProductRow({ ...base, ...a }).why;
  it("a row → no reason, and the row is productRow's", () => {
    const allStock = { central: { p1: { L: cell(3) } } };
    const a = { allStock, planFor: directPlan({ concrete: ["L"] }, { L: 3 }) };
    expect(decideProductRow({ ...base, ...a })).toEqual({ row: productRow({ ...base, ...a }), why: null });
  });
  it("no shop it may go to → noShop; no size any policy names → noPolicy", () => {
    const allStock = { central: { p1: { L: cell(3) } } };
    expect(why({ allStock, tickable: [], planFor: directPlan({}, {}) })).toBe("noShop");
    expect(why({ allStock, planFor: directPlan({ concrete: [], "marathon-pine": [] }, {}) })).toBe("noPolicy");
  });
  it("the policy's sizes are at Central but every unit is promised → allPromised; Central has none of them → noSize", () => {
    const allStock = { central: { p1: { L: cell(3), M: cell(2) } } };
    expect(why({ allStock, planFor: directPlan({ concrete: ["L"] }, { L: 0 }) })).toBe("allPromised");
    expect(why({ allStock: { central: { p1: { M: cell(2) } } }, planFor: directPlan({ concrete: ["L"] }, {}) })).toBe("noSize");
  });
  it("Central's units are all in sizes the product's own list does not name → undeclaredSize", () => {
    expect(why({ allStock: { central: { p1: { XL: cell(3) } } }, planFor: directPlan({ concrete: ["S", "M", "L"] }, {}) })).toBe("undeclaredSize");
  });
  it("owned by both Pine and Concrete → bothShops; a sneaker or slide on this list → noView; no record → noRecord", () => {
    const allStock = { central: { p1: { L: cell(3) } } };
    const planFor = directPlan({ concrete: ["L"], "marathon-pine": ["L"] }, { L: 3 });
    expect(why({ allStock, planFor, owners: ["marathon-pine", "concrete"] })).toBe("bothShops");
    expect(why({ allStock, planFor, product: { ...tee, categoryKey: "slides" } })).toBe("noView");
    expect(why({ allStock, planFor, product: null })).toBe("noRecord");
  });
  it("sneakers: list not live, the other hub has it, requested, nothing free", () => {
    const sc = { pid: "s1", name: "Dunk", centralUnits: 30 };
    const sb = { card: sc, section: 2, dests: ["hub1", "hub2"], nameOf };
    const w = (a) => decideSneakerRow({ ...sb, ...a }).why;
    expect(w({ blocked: true, planFor: () => [] })).toBe("notLive");
    expect(w({ planFor: () => [{ size: "8", qty: 2, avail: 5 }], refusal: () => "the other hub has it" })).toBe("otherHub");
    expect(w({ planFor: () => [], hasPolicy: () => true, requested: true })).toBe("requested");
    expect(w({ planFor: () => [], hasPolicy: () => true, requested: false })).toBe("noSize");
    // requested wins: it is in Central's queue, whatever its numbers
    expect(w({ planFor: () => [], hasPolicy: () => false, requested: true })).toBe("requested");
    // the needs-policy card is a ROW (it is on the list), so it has no reason
    expect(decideSneakerRow({ ...sb, planFor: () => [], hasPolicy: () => false, requested: false })).toMatchObject({ why: null, row: { needsPolicy: true } });
  });
});

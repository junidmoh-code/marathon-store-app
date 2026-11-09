// ─── EACH DIVISION SEES ITS OWN HUB — ONE USER PER DIVISION ──────────────────
//
// Junid, 9 Nov 2026: a Pine or Concrete assistant sees what Hub 3 holds; a
// Marathon PE or Trophy assistant sees Hub 1 + Hub 2, as ever. A size at zero
// cannot be ordered, a product with every size at zero says "Unavailable", and
// the alternatives are what IS at the assistant's own hub. Never Central, never
// across the wall.
//
// The order screen's decisions are made by the real modules through
// orderScreenWorld (the screen's wiring over plain data; its lines are pinned
// against App.jsx in divisionAvailability.wiring.test.js).
import { describe, it, expect, afterEach } from "vitest";
import { __resetNetworkForTests } from "../../utils/networkStore";
import { orderScreenWorld } from "./__fixtures__/orderScreenWorld";
import { stockedAtHubs, heldProductKey, productUnavailable, unavailableProductIds, hubReadState, unavailableHint } from "./divisionAvailability";

const shoe = (id, hubs, extra = {}) => ({
  id, name: `Shoe ${id}`, category: "Footwear", productType: "sneaker", categoryKey: "sneakers",
  brand: "Nike", sizes: ["6", "7", "8"], retailPrice: 1200, photoUrl: `https://x/${id}.jpg`,
  ...(hubs ? { hubs } : {}), ...extra,
});
const PRODUCTS = [
  shoe("c-full", ["hub3"]),                // Hub 3: 6, 7, 8
  shoe("c-part", ["hub3"]),                // Hub 3: 7 only
  shoe("c-none", ["hub3"]),                // tagged Hub 3, Hub 3 holds none; Hub 1 holds plenty
  shoe("c-counted", ["hub1"]),             // tagged Hub 1, counted at Hub 3
  shoe("c-display", ["hub3"]),             // Hub 3's one unit is the pair on the wall
  shoe("m-only", ["hub1"]),                // Marathon's: Hub 1 only
  shoe("m-two", ["hub2"]),                 // Marathon's: Hub 2 only
  shoe("c-dead", ["hub3"], { deactivated: true }),
  { id: "c-tee", name: "Tee", category: "Clothing", productType: "clothing", categoryKey: "tshirts", sizes: ["S", "M"], retailPrice: 300, photoUrl: "https://x/t.jpg" },
  { id: "c-tee0", name: "Tee 0", category: "Clothing", productType: "clothing", categoryKey: "tshirts", sizes: ["S", "M"], retailPrice: 300, photoUrl: "https://x/t0.jpg" },
];
const q = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { qty: v }]));
const STOCK = {
  hub1: { "m-only": q({ 6: 4, 7: 4, 8: 4 }), "c-none": q({ 6: 9, 7: 9, 8: 9 }), "c-part": q({ 6: 5, 8: 5 }), "c-counted": q({ 6: 0 }) },
  hub2: { "m-two": q({ 6: 2, 7: 2, 8: 2 }), "c-tee": q({ S: 7, M: 7 }), "c-tee0": q({ S: 7, M: 7 }) },
  hub3: {
    "c-full": q({ 6: 2, 7: 1, 8: 3 }), "c-part": q({ 6: 0, 7: 2 }), "c-counted": q({ 6: 1, 7: 1, 8: 1 }),
    "c-display": q({ 7: 1 }), "c-dead": q({ 6: 3 }), "c-tee": q({ S: 0, M: 4 }), "c-tee0": q({ S: 0 }),
  },
  // Central is in the fixture so a test can prove nobody reads it.
  central: Object.fromEntries(PRODUCTS.map((p) => [p.id, q(Object.fromEntries(p.sizes.map((s) => [s, 50])))])),
};
const byId = (id) => PRODUCTS.find((p) => p.id === id);
const world = (shop, opts = {}) => orderScreenWorld({ shop, products: PRODUCTS, stock: STOCK, ...opts });
const OFF = { locations: { hub3: { solve: true, autoRefill: "off" } } };

afterEach(() => __resetNetworkForTests());

describe.each(["concrete", "marathon-pine"])("a Concrete-division assistant (%s)", (shop) => {
  it("reads Hub 3 and nothing else — not Hub 1, not Hub 2, not Central", () => {
    const w = world(shop);
    expect(w.subscribed).toEqual(["hub3"]);
    expect(w.servingHub).toBe("hub3");
    expect(w.hubData.hub1.ready).toBe(false);
    expect(w.hubData.hub2.ready).toBe(false);
    expect(Object.keys(w.hubData)).not.toContain("central");
  });

  it("sees the shoes Hub 3 is tagged for or holds — and none of Marathon's", () => {
    const ids = world(shop).catalogue(false).map((p) => p.id);
    expect(ids).toEqual(["c-full", "c-part", "c-none", "c-counted", "c-display"]);
    expect(ids).not.toContain("m-only");
    expect(ids).not.toContain("m-two");
  });

  it("a size's availability is Hub 3's own cell", () => {
    const w = world(shop);
    expect(w.sourcing(byId("c-full"), "6")).toEqual({ hub: "hub3", available: 2 });
    expect(w.sourcing(byId("c-part"), "7")).toEqual({ hub: "hub3", available: 2 });
    expect(w.sourcing(byId("c-counted"), "8")).toEqual({ hub: "hub3", available: 1 });
  });

  it("a size Hub 3 has none of is out — however much Hub 1, Hub 2 or Central hold", () => {
    const w = world(shop);
    expect(w.sneakerOut(byId("c-part"), "6")).toBe(true);     // Hub 1 holds 5
    expect(w.sneakerOut(byId("c-part"), "8")).toBe(true);     // no Hub 3 cell at all; Hub 1 holds 5
    expect(w.sourcing(byId("c-part"), "8")).toEqual({ hub: "hub3", available: 0 });
    for (const s of ["6", "7", "8"]) expect(w.sneakerOut(byId("c-none"), s)).toBe(true);   // Hub 1 holds 9 of each
    expect(w.sneakerOut(byId("c-full"), "7")).toBe(false);
  });

  it("a pair standing on a display is Hub 3 stock and is available", () => {
    const w = world(shop);
    expect(w.sourcing(byId("c-display"), "7")).toEqual({ hub: "hub3", available: 1 });
    expect(w.sneakerOut(byId("c-display"), "7")).toBe(false);
  });

  it("the cart counts: the last unit in the cart leaves the size out, and the line is placed at Hub 3", () => {
    const line = { product: byId("c-full"), size: "7" };
    const w = world(shop, { cart: [line] });
    expect(w.sneakerOut(byId("c-full"), "7")).toBe(true);
    expect(w.sneakerOut(byId("c-full"), "6")).toBe(false);
    expect(w.placedHub(line)).toBe("hub3");
  });

  it("the last pair in this device's cart does not make the card say Unavailable: it is still at Hub 3", () => {
    const line = { product: byId("c-display"), size: "7" };
    const w = world(shop, { cart: [line] });
    expect(w.sneakerOut(byId("c-display"), "7")).toBe(true);        // the chip: no more can be added
    expect([...w.unavailable(false)]).toEqual(["c-none"]);          // the card: the hub still holds it
  });

  it("a shoe tagged for another hub stays listed after its last pair at Hub 3 sells, and reads Unavailable", () => {
    const stock = { ...STOCK, hub3: { ...STOCK.hub3, "c-counted": q({ 6: 0, 7: 0, 8: 0 }) } };
    const w = orderScreenWorld({ shop, products: PRODUCTS, stock });
    expect(w.catalogue(false).map((p) => p.id)).toContain("c-counted");
    expect([...w.unavailable(false)].sort()).toEqual(["c-counted", "c-none"]);
  });

  it("a product with every size at zero is unavailable; one with a size left is not", () => {
    const out = world(shop).unavailable(false);
    expect([...out]).toEqual(["c-none"]);
  });

  it("clothing: greyed on Hub 3's cell, and unavailable when Hub 3 holds none (Hub 2's stock is not theirs)", () => {
    const w = world(shop);
    expect(w.clothingHubOf(byId("c-tee"))).toBe("hub3");
    expect(w.hubQty(byId("c-tee"), "S")).toBe(0);
    expect(w.hubQty(byId("c-tee"), "M")).toBe(4);
    expect([...w.unavailable(true)]).toEqual(["c-tee0"]);
  });

  it("alternatives for an out size are shoes Hub 3 holds in that size — never Marathon's, never a deactivated line", () => {
    const w = world(shop);
    const alt = w.alternatives(byId("c-none"), "6");
    expect(alt.rows.map((r) => r.product.id).sort()).toEqual(["c-counted", "c-full"]);
    for (const r of alt.rows) {
      expect(r.hub).toBe("hub3");
      expect(w.sneakerOut(r.product, r.matchedSize)).toBe(false);
      expect(STOCK.hub3[r.product.id][r.matchedSize].qty).toBeGreaterThan(0);
    }
    const all = ["6", "7", "8"].flatMap((s) => (w.alternatives(byId("c-none"), s)?.rows || []).map((r) => r.product.id));
    expect(all).not.toContain("m-only");
    expect(all).not.toContain("m-two");
    expect(all).not.toContain("c-dead");
    expect(all).not.toContain("c-none");
  });

  it("alternatives: nothing at Hub 3 in that size is an empty answer, not Marathon's shelf", () => {
    const w = orderScreenWorld({ shop, products: PRODUCTS, stock: { ...STOCK, hub3: { "c-part": q({ 7: 1 }) } } });
    expect(w.alternatives(byId("c-none"), "6").rows).toEqual([]);
  });

  it("before Hub 3 has answered: nothing is out, nothing is unavailable, nothing is suggested", () => {
    const w = world(shop, { hubsRead: [] });
    expect(w.sneakerOut(byId("c-none"), "6")).toBe(false);
    expect([...w.unavailable(false)]).toEqual([]);
    expect([...w.unavailable(true)]).toEqual([]);
    expect(w.alternatives(byId("c-none"), "6")).toBe(null);
    // …and a shoe held at Hub 3 under another hub's tag is not listed yet
    expect(w.catalogue(false).map((p) => p.id)).not.toContain("c-counted");
  });

  it("Hub 3 switched out of service on the Network card: no gate, as before the count", () => {
    const w = world(shop, { rawNetwork: OFF });
    expect(w.subscribed).toEqual([]);
    expect(w.sneakerOut(byId("c-none"), "6")).toBe(false);
    expect([...w.unavailable(false)]).toEqual([]);
    expect(w.alternatives(byId("c-none"), "6")).toBe(null);
    expect(w.placedHub({ product: byId("c-full"), size: "7" })).toBe("hub3");   // still ordered from Hub 3, by hand
  });
});

describe.each(["marathon-pe", "trophy"])("a Marathon-division assistant (%s)", (shop) => {
  it("reads Hub 1 + Hub 2 and never Hub 3 or Central", () => {
    const w = world(shop);
    expect(w.subscribed).toEqual(["hub1", "hub2"]);
    expect(w.sectionHubIds).toEqual([]);
    expect(Object.keys(w.hubData)).toEqual(["hub1", "hub2"]);
  });

  it("sees Marathon's shoes on Hub 1 / Hub 2 stock, whatever Hub 3 holds", () => {
    const w = world(shop);
    const ids = w.catalogue(false).map((p) => p.id);
    expect(ids).toEqual(["c-counted", "m-only", "m-two"]);       // tagged hub1 / hub2; the hub3-tagged are not theirs
    expect(w.sourcing(byId("m-only"), "6")).toEqual({ hub: "hub1", available: 4 });
    expect(w.sourcing(byId("m-two"), "6")).toEqual({ hub: "hub2", available: 2 });
    // c-counted: Hub 1 holds none, Hub 3 holds one of each — out for Marathon
    expect(w.sneakerOut(byId("c-counted"), "6")).toBe(true);
    expect(w.sneakerOut(byId("c-counted"), "7")).toBe(true);
  });

  it("alternatives come from Hub 1 / Hub 2 only", () => {
    const w = world(shop);
    // The pool is every shoe Hub 1 / Hub 2 hold in that size, whatever its tag
    // (the rule on main) — and a shoe only Hub 3 holds is never in it.
    const alt = w.alternatives(byId("c-counted"), "6");
    expect(alt.rows.map((r) => `${r.product.id}@${r.hub}`).sort()).toEqual(["c-none@hub1", "c-part@hub1", "m-only@hub1", "m-two@hub2"]);
    for (const r of alt.rows) expect(STOCK[r.hub][r.product.id][r.matchedSize].qty).toBeGreaterThan(0);
    const all = ["6", "7", "8"].flatMap((s) => (w.alternatives(byId("c-counted"), s)?.rows || []).map((r) => r.product.id));
    for (const id of ["c-full", "c-display", "c-counted"]) expect(all).not.toContain(id);   // Hub 3's alone
  });

  it("gets no card-level Unavailable state (Junid: their screen unchanged)", () => {
    expect([...world(shop).unavailable(false)]).toEqual([]);
    expect([...world(shop).unavailable(true)]).toEqual([]);
  });
});

describe("the questions asked of the cells", () => {
  const ready = (cells) => ({ cells, ready: true });
  it("stockedAtHubs: a cell at a hub that has answered, even at zero — a sold-out shoe stays listed", () => {
    const has = stockedAtHubs([ready({ a: q({ 6: 0, 7: 1 }), b: q({ 6: 0 }), c: { 7: 2 }, e: {} })]);
    expect(has({ id: "a" })).toBe(true);
    expect(has({ id: "b" })).toBe(true);
    expect(has({ id: "c" })).toBe(true);          // a bare number cell
    expect(has({ id: "e" })).toBe(false);         // no cell at all
    expect(has({ id: "zz" })).toBe(false);
    expect(has(null)).toBe(false);
  });
  it("stockedAtHubs: a hub that has not answered says nothing; a second hub can", () => {
    expect(stockedAtHubs([{ cells: { a: q({ 6: 5 }) }, ready: false }])({ id: "a" })).toBe(false);
    expect(stockedAtHubs([{ cells: {}, ready: true }, ready({ a: q({ 6: 5 }) })])({ id: "a" })).toBe(true);
    expect(stockedAtHubs([null, undefined])({ id: "a" })).toBe(false);
    expect(stockedAtHubs()({ id: "a" })).toBe(false);
    // RTDB array holes inside a product's sizes
    expect(stockedAtHubs([ready({ a: [null, { qty: 0 }, { qty: 2 }], b: null })])({ id: "a" })).toBe(true);
  });
  it("heldProductKey is the same string when only a quantity changes", () => {
    expect(heldProductKey([ready({ a: q({ 6: 1 }), b: q({ 7: 2 }) })])).toBe(heldProductKey([ready({ b: q({ 7: 0 }), a: q({ 6: 9 }) })]));
    expect(heldProductKey([ready({ a: q({ 6: 1 }) })])).not.toBe(heldProductKey([ready({ a: q({ 6: 1 }), b: q({ 7: 2 }) })]));
    expect(heldProductKey([])).toBe("");
  });
  it("hubReadState: ready only when settled and not errored", () => {
    expect(hubReadState({ cells: { a: 1 }, settled: true, error: null })).toEqual({ cells: { a: 1 }, ready: true });
    expect(hubReadState({ cells: {}, settled: false }).ready).toBe(false);
    expect(hubReadState({ cells: {}, settled: true, error: new Error("x") }).ready).toBe(false);
    expect(hubReadState(null)).toEqual({ cells: {}, ready: false });
  });
  it("productUnavailable: every size out, and only once availability is known", () => {
    const out = () => true, inn = () => false;
    expect(productUnavailable({ sizes: ["6", "7"], known: true, sizeOut: out })).toBe(true);
    expect(productUnavailable({ sizes: ["6", "7"], known: true, sizeOut: (s) => s === "6" })).toBe(false);
    expect(productUnavailable({ sizes: ["6", "7"], known: true, sizeOut: inn })).toBe(false);
    expect(productUnavailable({ sizes: ["6"], known: false, sizeOut: out })).toBe(false);
    expect(productUnavailable({ sizes: ["6"], known: undefined, sizeOut: out })).toBe(false);
    expect(productUnavailable({ sizes: [], known: true, sizeOut: out })).toBe(false);
    expect(productUnavailable({ sizes: null, known: true, sizeOut: out })).toBe(false);
  });
  it("unavailableProductIds: a product the judge declines is never listed", () => {
    const ids = unavailableProductIds([{ id: "a" }, { id: "b" }, null, {}], (p) => (p.id === "b" ? null : { sizes: ["6"], known: true, sizeOut: () => true }));
    expect([...ids]).toEqual(["a"]);
  });
  it("unavailableHint names the hub, and promises similar shoes only for footwear", () => {
    expect(unavailableHint(["Hub 3"])).toBe("No size of this is at Hub 3 right now. Tap the customer's size to see similar shoes that are.");
    expect(unavailableHint(["Hub 3"], { similar: false })).toBe("No size of this is at Hub 3 right now.");
    expect(unavailableHint(["Hub 3", "Hub 9"], { similar: false })).toBe("No size of this is at Hub 3 or Hub 9 right now.");
    expect(unavailableHint([], { similar: false })).toBe("No size of this is at the hub right now.");
  });
});

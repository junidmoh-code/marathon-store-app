import { describe, it, expect } from "vitest";
import { sellableAlternatives, alternativesForSize, alternativeSelection, MAX_ALTERNATIVES_SHOWN } from "./alternativesCore";
import { encodeNeighbour } from "../../utils/productNeighbours";

// A tiny world. Every live fact is a callback, exactly as the screen supplies
// it, so the whole join is exercised without mounting anything.
const P = (id, extra = {}) => ({ id, name: `shoe ${id}`, retailPrice: 750, photoUrl: "u", sizes: ["7", "8", "9"], ...extra });

function world(overrides = {}) {
  const products = overrides.products || { p1: P("p1"), p2: P("p2"), p3: P("p3") };
  return {
    resolveProduct: (pid) => products[pid] || null,
    sizesOf: (p) => p.sizes,
    availabilityKnown: () => true,
    sizeAvailable: () => true,
    isSellable: () => true,
    ...overrides,
    products,
  };
}
const call = (neighbours, w, requestedSize = "8", limit) =>
  sellableAlternatives({
    neighbours, requestedSize, resolveProduct: w.resolveProduct, sizesOf: w.sizesOf,
    availabilityKnown: w.availabilityKnown, sizeAvailable: w.sizeAvailable,
    isSellable: w.isSellable, ...(limit ? { limit } : {}),
  });

const LIST = [encodeNeighbour("p1", "s"), encodeNeighbour("p2", "a"), encodeNeighbour("p3", "x")];

describe("nothing that cannot be sold is ever shown", () => {
  it("drops a product that is not sellable", () => {
    const w = world({ isSellable: (p) => p.id !== "p2" });
    expect(call(LIST, w).map((r) => r.product.id)).toEqual(["p1", "p3"]);
  });
  // A Pine/hub3 shoe is never gated, so the screen has NO availability answer
  // for it — sneakerOut returns false there meaning "no gate", not "in stock".
  // Reading that as availability would put an unverified shoe in front of a
  // customer, which is the one failure this whole surface must not have.
  it("drops a product whose availability this screen cannot answer for", () => {
    const w = world({ availabilityKnown: (p) => p.id === "p1" });
    expect(call(LIST, w).map((r) => r.product.id)).toEqual(["p1"]);
  });
  it("drops a product with no available size at all", () => {
    const w = world({ sizeAvailable: (p) => p.id !== "p3" });
    expect(call(LIST, w).map((r) => r.product.id)).toEqual(["p1", "p2"]);
  });
  it("lists only the sizes that are actually available", () => {
    const w = world({ sizeAvailable: (p, s) => s !== "7" });
    expect(call(LIST, w)[0].sizes).toEqual(["8", "9"]);
  });
  // A size whose only unit is the Hub 1 DISPLAY PAIR reads as available —
  // correctly, per #324 — but selling it needs the display-pair request flow,
  // which this sheet has no prompt for. Offering it would create a plain cart
  // line for a pair on a shop floor, leaving a phantom display behind.
  it("drops a size that only exists as a display pair", () => {
    const w = world({ sizeAvailable: (p, s) => !(p.id === "p2" && s === "8") });
    const rows = call(LIST, w, "9");
    expect(rows.find((r) => r.product.id === "p2").sizes).toEqual(["7", "9"]);
  });
  it("…and drops the whole shoe when EVERY size is display-only", () => {
    const w = world({ sizeAvailable: (p) => p.id !== "p2" });
    expect(call(LIST, w).map((r) => r.product.id)).toEqual(["p1", "p3"]);
  });
  it("drops a pid that no longer resolves to a product", () => {
    const w = world({ products: { p1: P("p1") } });
    expect(call(LIST, w).map((r) => r.product.id)).toEqual(["p1"]);
  });
  // Merged products are followed to the survivor by resolveProductById, so an
  // older stored list can name two pids that are now ONE shoe.
  it("shows a merged pair once, not twice", () => {
    const survivor = P("p1");
    const w = world({ products: {}, resolveProduct: () => survivor });
    expect(call(LIST, w).map((r) => r.product.id)).toEqual(["p1"]);
  });
  // followMerge returns the LAST RESOLVED record on a dangling pointer or a
  // cycle, and that record is still merged-away. A priced, photographed,
  // non-deactivated corpse passes every other gate.
  it("drops a merged-away record that a broken pointer chain resolved to", () => {
    const corpse = P("p9", { mergedInto: "p-gone" });
    const w = world({ products: { p1: P("p1"), p2: corpse, p3: P("p3") },
                      isSellable: (p) => !p.mergedInto });
    expect(call(LIST, w).map((r) => r.product.id)).toEqual(["p1", "p3"]);
  });
});

describe("an empty result is a real answer", () => {
  it("no neighbours stored", () => {
    for (const v of [null, undefined, [], {}]) expect(call(v, world())).toEqual([]);
  });
  it("neighbours stored but none sellable", () => {
    expect(call(LIST, world({ isSellable: () => false }))).toEqual([]);
  });
  it("never fabricates a row to fill the space", () => {
    expect(call([encodeNeighbour("nope", "s")], world())).toEqual([]);
  });
});

describe("the stored ranking is kept among the survivors", () => {
  it("the gate removes; it never re-orders", () => {
    const products = { p1: P("p1", { sizes: ["8"] }), p2: P("p2", { sizes: ["7"] }), p3: P("p3", { sizes: ["8"] }) };
    expect(call(LIST, world({ products }), "8").map((r) => r.product.id)).toEqual(["p1", "p3"]);
  });
  it("with no requested size there is nothing to match, so nothing is offered", () => {
    expect(call(LIST, world(), "")).toEqual([]);
  });
  it("hasRequestedSize is true on every row, and matchedSize is the shoe's own label", () => {
    const products = { p1: P("p1", { sizes: ["7", "8.5"] }), p2: P("p2", { sizes: ["8_5"] }), p3: P("p3", { sizes: ["UK 8.5"] }) };
    const rows = call(LIST, world({ products }), "8.5");
    expect(rows.map((r) => [r.product.id, r.matchedSize, r.hasRequestedSize]))
      .toEqual([["p1", "8.5", true], ["p2", "8_5", true], ["p3", "UK 8.5", true]]);
  });
  it("a kids size never satisfies an adult request", () => {
    const products = { p1: P("p1", { sizes: ["6Y", "7Y"] }), p2: P("p2", { sizes: ["6"] }), p3: P("p3", { sizes: ["S"] }) };
    expect(call(LIST, world({ products }), "6").map((r) => r.product.id)).toEqual(["p2"]);
  });
  it("an unclassifiable requested size matches nothing, even a byte-equal label", () => {
    const products = { p1: P("p1", { sizes: ["S"] }), p2: P("p2", { sizes: ["S"] }), p3: P("p3", { sizes: ["S"] }) };
    expect(call(LIST, world({ products }), "S")).toEqual([]);
  });
});

describe("what the size gate removed is counted (telemetry, log only)", () => {
  const stats = (neighbours, w, requestedSize = "8") => alternativesForSize({
    neighbours, requestedSize, resolveProduct: w.resolveProduct, sizesOf: w.sizesOf,
    availabilityKnown: w.availabilityKnown, sizeAvailable: w.sizeAvailable, isSellable: w.isSellable,
  });
  it("counts only shoes that passed every other gate and failed the size", () => {
    const products = { p1: P("p1", { sizes: ["3", "4", "5", "5.5", "6"] }), p2: P("p2"), p3: P("p3", { sizes: ["6"] }) };
    const w = world({ products, isSellable: (p) => p.id !== "p3" });
    const r = stats(LIST, w);
    expect(r.rows.map((x) => x.product.id)).toEqual(["p2"]);
    expect(r.candidates).toBe(3);
    expect(r.sizeGateRemoved).toBe(1);       // p1; p3 was removed by isSellable, not by size
  });
  it("a shoe with nothing sellable at all is not the size gate's doing", () => {
    const w = world({ sizeAvailable: (p) => p.id !== "p1" });
    expect(stats(LIST, w).sizeGateRemoved).toBe(0);
  });
  it("counts past the display cap", () => {
    const products = {}, list = [];
    for (let i = 0; i < 12; i++) { products[`q${i}`] = P(`q${i}`, { sizes: i < 2 ? ["7"] : ["8"] }); list.push(encodeNeighbour(`q${i}`, "s")); }
    const r = stats(list, world({ products }));
    expect(r.rows).toHaveLength(8);
    expect(r.sizeGateRemoved).toBe(2);
  });
});

describe("the cap", () => {
  it("shows at most 8", () => {
    expect(MAX_ALTERNATIVES_SHOWN).toBe(8);
    const products = {}, list = [];
    for (let i = 0; i < 12; i++) { products[`q${i}`] = P(`q${i}`); list.push(encodeNeighbour(`q${i}`, "s")); }
    expect(call(list, world({ products }))).toHaveLength(8);
  });
  it("the cap applies AFTER the size gate, so a size match is never cut for rank", () => {
    const products = {}, list = [];
    for (let i = 0; i < 12; i++) {
      products[`q${i}`] = P(`q${i}`, { sizes: i === 11 ? ["8"] : ["7"] });
      list.push(encodeNeighbour(`q${i}`, "s"));
    }
    expect(call(list, world({ products }), "8").map((r) => r.product.id)).toEqual(["q11"]);
  });
});

describe("the reason line rides along with the row", () => {
  it("carries the stored code's sentence", () => {
    const rows = call(LIST, world(), "8");
    expect(rows[0].why).toMatch(/Same shape and colour/);
    expect(rows[1].why).toMatch(/Same shape, colour and brand/);
  });
});

describe("alternativeSelection — never back to the catalogue", () => {
  it("preselects the customer's size when the shoe has it", () => {
    const row = { product: P("p1"), sizes: ["8"], hasRequestedSize: true };
    expect(alternativeSelection(row, "8")).toEqual({ product: row.product, size: "8" });
  });
  it("preselects the CHOSEN shoe's own label for that size, not the tapped one", () => {
    const row = { product: P("p1"), sizes: ["8.5"], hasRequestedSize: true, matchedSize: "8.5" };
    expect(alternativeSelection(row, "8_5")).toEqual({ product: row.product, size: "8.5" });
  });
  it("opens the shoe's own grid when it does not", () => {
    const row = { product: P("p1"), sizes: ["9"], hasRequestedSize: false };
    expect(alternativeSelection(row, "8")).toEqual({ product: row.product, size: "" });
  });
  it("is null-safe", () => {
    expect(alternativeSelection(null, "8")).toBe(null);
    expect(alternativeSelection({}, "8")).toBe(null);
  });
});

// ─── JUNID'S CASE (2026-10-01) ───────────────────────────────────────────────
// He tapped a greyed size 8 on an Air Force. The sheet listed alternatives, and
// some of them do not come in an 8 at all — an Air Force that only runs 3–6
// (p1777977940582 "Air Force 1 Low Stüssy Cream White" carries exactly
// ["3","4","5","5.5","6"] on the live record). A row the assistant reads out
// that cannot be sold in the size the customer asked for is not an
// alternative; it is the refusal again, one tap later.
describe("every row is sellable in the size that was tapped", () => {
  const RUN_3_TO_6 = ["3", "4", "5", "5.5", "6"];
  it("a neighbour that only runs sizes 3–6 never appears for an adult 8", () => {
    const products = { p1: P("p1", { sizes: RUN_3_TO_6 }), p2: P("p2", { sizes: ["7", "8", "9"] }), p3: P("p3", { sizes: RUN_3_TO_6 }) };
    expect(call(LIST, world({ products }), "8").map((r) => r.product.id)).toEqual(["p2"]);
  });
  it("a neighbour that HAS an 8 on its grid but cannot sell one right now is dropped too", () => {
    const w = world({ sizeAvailable: (p, s) => !(p.id === "p1" && s === "8") });
    expect(call(LIST, w, "8").map((r) => r.product.id)).toEqual(["p2", "p3"]);
  });
});

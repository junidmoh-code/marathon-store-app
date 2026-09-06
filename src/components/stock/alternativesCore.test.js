import { describe, it, expect } from "vitest";
import { sellableAlternatives, alternativeSelection, MAX_ALTERNATIVES_SHOWN } from "./alternativesCore";
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
    const w = world({ sizeAvailable: (p, s) => s === "9" });
    expect(call(LIST, w)[0].sizes).toEqual(["9"]);
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

describe("the requested size leads, and rank is preserved inside each half", () => {
  it("a shoe that HAS the asked-for size comes first", () => {
    const products = { p1: P("p1", { sizes: ["7"] }), p2: P("p2", { sizes: ["8"] }), p3: P("p3", { sizes: ["7"] }) };
    const w = world({ products });
    expect(call(LIST, w, "8").map((r) => r.product.id)).toEqual(["p2", "p1", "p3"]);
  });
  it("and inside each half the stored ranking is untouched", () => {
    const products = { p1: P("p1", { sizes: ["8"] }), p2: P("p2", { sizes: ["7"] }), p3: P("p3", { sizes: ["8"] }) };
    const w = world({ products });
    expect(call(LIST, w, "8").map((r) => r.product.id)).toEqual(["p1", "p3", "p2"]);
  });
  it("with no requested size the stored order is kept exactly", () => {
    expect(call(LIST, world(), "").map((r) => r.product.id)).toEqual(["p1", "p2", "p3"]);
  });
  it("hasRequestedSize is only true when the size is genuinely available there", () => {
    const w = world({ sizeAvailable: (p, s) => s !== "8" });
    expect(call(LIST, w, "8").every((r) => r.hasRequestedSize === false)).toBe(true);
  });
});

describe("the cap", () => {
  it("shows at most 8", () => {
    expect(MAX_ALTERNATIVES_SHOWN).toBe(8);
    const products = {}, list = [];
    for (let i = 0; i < 12; i++) { products[`q${i}`] = P(`q${i}`); list.push(encodeNeighbour(`q${i}`, "s")); }
    expect(call(list, world({ products }))).toHaveLength(8);
  });
  it("the cap applies AFTER the partition, so a size match is never cut for rank", () => {
    const products = {}, list = [];
    for (let i = 0; i < 12; i++) {
      products[`q${i}`] = P(`q${i}`, { sizes: i === 11 ? ["8"] : ["7"] });
      list.push(encodeNeighbour(`q${i}`, "s"));
    }
    const got = call(list, world({ products }), "8");
    expect(got[0].product.id).toBe("q11");
    expect(got).toHaveLength(8);
  });
});

describe("the reason line rides along with the row", () => {
  it("carries the stored code's sentence", () => {
    const rows = call(LIST, world(), "");
    expect(rows[0].why).toMatch(/Same shape and colour/);
    expect(rows[1].why).toMatch(/Same shape, colour and brand/);
  });
});

describe("alternativeSelection — never back to the catalogue", () => {
  it("preselects the customer's size when the shoe has it", () => {
    const row = { product: P("p1"), sizes: ["8"], hasRequestedSize: true };
    expect(alternativeSelection(row, "8")).toEqual({ product: row.product, size: "8" });
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

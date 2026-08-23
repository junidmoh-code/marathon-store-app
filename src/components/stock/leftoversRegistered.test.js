// ─── LEFTOVERS — a registered product is never one ───────────────────────────
// Owner rule, 2026-08-23:
//     A PRODUCT REGISTERED WITH A LABEL NUMBER IS NOT A LEFTOVER. EVER.
// Registered = a style code, OR any label alias, OR any label code record — by
// any route, at any time, from any surface.
//
// Every test here is behavioural: given a catalogue and the stores' answers,
// IS THIS CARD ON THE LIST. Nothing asserts how the answer was computed.

import { describe, it, expect } from "vitest";
import { buildLeftovers } from "./hubCleanupCore.js";

const HUB = "hub1";
const shoe = (id, over = {}) => ({ id, name: `Shoe ${id}`, categoryKey: "sneakers", ...over });
const stock = (ids) => Object.fromEntries(ids.map((id) => [id, { "9": { qty: 4, v: 0 } }]));

const build = (products, over = {}) => buildLeftovers({
  hub: HUB, products, hubStock: stock(products.map((p) => p.id)), registered: {}, ...over,
}).map((r) => r.product.id);

describe("what makes a product a leftover", () => {
  it("footwear holding hub stock with no identity anywhere IS a leftover", () => {
    expect(build([shoe("a")])).toEqual(["a"]);
  });

  it("a product carrying a STYLE CODE is not a leftover", () => {
    expect(build([shoe("a", { styleCodeNormalised: "BQ6817302" })])).toEqual([]);
  });

  it("a product with only a LABEL CODE RECORD is not a leftover", () => {
    expect(build([shoe("a")], { identityMap: { a: { c: ["BQ6817302"], a: [] } } })).toEqual([]);
  });

  it("a product with only a LABEL ALIAS (wording, no code) is not a leftover", () => {
    expect(build([shoe("a")], { identityMap: { a: { c: [], a: [["NIKE", "AIR"]] } } })).toEqual([]);
  });

  it("a product registered as a COLOURWAY SIBLING of someone else's claim is not a leftover", () => {
    // The fold puts the claim's code on the sibling too, so the sibling reads
    // as registered — which is what it is.
    expect(build([shoe("a")], { identityMap: { a: { c: ["HF5509002"], a: [] } } })).toEqual([]);
  });

  it("being seen on the floor still excludes it — the old reason survives", () => {
    expect(build([shoe("a")], { registered: { k: { productId: "a" } } })).toEqual([]);
  });

  it("a NEWLY CREATED product that was registered at creation never appears", () => {
    const fresh = shoe("new", { styleCodeNormalised: "DD1391100" });
    expect(build([fresh])).toEqual([]);
  });

  it("holding no stock at this hub is not a leftover, registered or not", () => {
    expect(buildLeftovers({ hub: HUB, products: [shoe("a")], hubStock: {}, registered: {} })).toEqual([]);
  });

  it("a zero-quantity hub cell is not a leftover", () => {
    expect(buildLeftovers({
      hub: HUB, products: [shoe("a")], hubStock: { a: { "9": { qty: 0, v: 0 } } }, registered: {},
    })).toEqual([]);
  });

  it("a merged-away product never appears", () => {
    expect(build([shoe("a", { mergedInto: "b" })])).toEqual([]);
  });

  it("a non-footwear product never appears", () => {
    expect(build([shoe("a", { categoryKey: "t-shirts" })])).toEqual([]);
  });
});

describe("the list recomputes, it is never a snapshot", () => {
  it("registering a product by CODE takes it off the very next computation", () => {
    const before = build([shoe("a"), shoe("b")]);
    expect(before).toEqual(["a", "b"]);
    // Same call, one product now carrying a code — no reload, no cache.
    const after = build([shoe("a", { styleCodeNormalised: "X1" }), shoe("b")]);
    expect(after).toEqual(["b"]);
  });

  it("registering by ALIAS alone takes it off the very next computation", () => {
    expect(build([shoe("a")], { identityMap: {} })).toEqual(["a"]);
    expect(build([shoe("a")], { identityMap: { a: { c: [], a: [["ONE", "TWO"]] } } })).toEqual([]);
  });

  it("an ABSENT identity map degrades to the code field — it never hides an unregistered shoe", () => {
    expect(build([shoe("a"), shoe("b", { styleCodeNormalised: "X" })], { identityMap: null })).toEqual(["a"]);
  });
});

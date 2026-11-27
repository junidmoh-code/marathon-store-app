import { describe, it, expect } from "vitest";
import { filterProducts } from "./AllProductsList.jsx";
import { brandCheckQueue } from "./BrandCheckTab.jsx";
import { CONCRETE_SHIP_AT } from "../../utils/concreteListing.js";

const P = (id, extra = {}) => ({ id, name: `Thing ${id}`, category: "Clothing", ...extra });

describe("filterProducts", () => {
  const list = [P("p1"), P("p3", { listOnConcrete: true }), P("p2", { category: "Footwear" })];
  it("newest first, filters by category and Concrete state", () => {
    expect(filterProducts(list).map((p) => p.id)).toEqual(["p3", "p2", "p1"]);
    expect(filterProducts(list, { concrete: "on" }).map((p) => p.id)).toEqual(["p3"]);
    expect(filterProducts(list, { concrete: "off" }).map((p) => p.id)).toEqual(["p2", "p1"]);
  });
});

describe("brandCheckQueue", () => {
  it("lists only unverified new or re-marked products, newest first", () => {
    const a = `p${CONCRETE_SHIP_AT + 5}`, b = `p${CONCRETE_SHIP_AT + 9}`, old = `p${CONCRETE_SHIP_AT - 9}`;
    const q = brandCheckQueue([
      P(a), P(b), P(old), P(`p${CONCRETE_SHIP_AT + 7}`, { brandVerifiedAt: CONCRETE_SHIP_AT + 8 }),
      P(`p${CONCRETE_SHIP_AT - 50}`, { listOnConcreteSetAt: CONCRETE_SHIP_AT + 1 }),
    ]);
    expect(q.map((p) => p.id)).toEqual([b, a, `p${CONCRETE_SHIP_AT - 50}`]);
  });
});

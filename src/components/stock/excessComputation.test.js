// ─── HUB EXCESS COMPUTATION — the rules that must not rot ────────────────────
// Commit 5 of the excess-sneakers-hub-to-central build (docs/EXCESS-SNEAKERS.md).
//
// Every test here was MUTATION-PROVED: the guard it pins was deliberately
// broken, the suite was re-run, and the test named in the comment failed. A
// green test that survives its own guard's removal proves nothing.
//
// The formula under test (owner spec):
//   excess  = onHand - target(Keep) - reserved by open outbound refill
//                                     requests FROM that hub
//   movable = max(0, excess)      — a move leaves the cell at EXACTLY Keep
//   a card never renders below 1 movable unit
//
// ARMED SIZES ONLY: a size with no Keep number is unarmed — no card, ever. A
// blank is NEVER read as 0. That is the load-bearing one; see
// "blank size emits nothing" below.
import { describe, it, expect } from "vitest";
import {
  computeHubExcess,
  computeHubSneakerExcess,
  computeHubClothingExcess,
  reservedByHubFromOpenRequests,
  clothingExcessEnabled,
  isSneakerGroupProduct,
  EXCESS_HUB_LOCATIONS,
} from "./excessComputation.js";

// useStockCells() DECODES size keys, so a client-side cell map is keyed by the
// raw size ("9"), not the stored key ("9"). /stock_targets stays ENCODED.
const cells = (map) => Object.fromEntries(Object.entries(map).map(([k, qty]) => [k, { qty, v: 1 }]));

const PRODUCTS = {
  af1:  { id: "af1",  name: "Nike Air Force 1 White", categoryKey: "sneakers", sizes: ["7", "8", "9", "10"] },
  boot: { id: "boot", name: "Timberland 6-Inch Wheat", categoryKey: "boots",   sizes: ["7", "8", "9"] },
  tee:  { id: "tee",  name: "Essentials Tee Olive",   categoryKey: "tees",     productType: "clothing", sizes: ["S", "M", "L"] },
  cap:  { id: "cap",  name: "New Era 9Forty Navy",    categoryKey: "caps-beanies", sizes: ["One Size"] },
};

// The live shape Phase 2 wrote: config/refillEngine/categoryPolicy/sneakers
// = { perSize: true, hub1: {carriedOnly, sizes}, hub2: {...} }. NOTE there is
// no shop key anywhere in here — that is the point of "arming touches no shop".
const KEEP = (target, reorderPoint = 1) => ({ target, reorderPoint, minQty: 1 });
const sneakerSizes = { 7: KEEP(3), 8: KEEP(3), 9: KEEP(2), 10: KEEP(2) };
const CONFIG = {
  categoryPolicy: {
    sneakers: {
      perSize: true,
      hub1: { carriedOnly: true, sizes: sneakerSizes },
      hub2: { carriedOnly: true, sizes: sneakerSizes },
    },
    boots: {
      perSize: true,
      hub1: { carriedOnly: true, sizes: { 7: KEEP(2), 8: KEEP(2), 9: KEEP(2) } },
      hub2: { carriedOnly: true, sizes: { 7: KEEP(2), 8: KEEP(2), 9: KEEP(2) } },
    },
    tees: {
      perSize: true,
      hub1: { carriedOnly: true, sizes: { S: KEEP(2), M: KEEP(2), L: KEEP(2) } },
      hub2: { carriedOnly: true, sizes: { S: KEEP(2), M: KEEP(2), L: KEEP(2) } },
    },
  },
};

const ctxOf = (stock, over = {}) => ({
  products: PRODUCTS,
  stock,
  targets: over.targets || {},
  config: over.config || CONFIG,
});

const NONE = new Map();
const key = (r) => `${r.loc}|${r.pid}|${r.size}`;
const keys = (rows) => rows.map(key).sort();

describe("armed sizes only — a blank is never read as 0", () => {
  // MUTATION-PROVED: replacing `if (!t) continue` in computeHubExcess with a
  // `t || { target: 0 }` fallback (i.e. reading a blank as 0) fails this test —
  // size 11 becomes a 4-unit card.
  it("emits nothing for a size the policy does not name, however much is on hand", () => {
    const stock = { hub1: { af1: cells({ 9: 4, 11: 4 }) } };
    const p = { ...PRODUCTS, af1: { ...PRODUCTS.af1, sizes: ["9", "11"] } };
    const rows = computeHubSneakerExcess({ ...ctxOf(stock), products: p }, NONE);
    expect(keys(rows)).toEqual(["hub1|af1|9"]);          // 11 is UNARMED — no card
    expect(rows[0].excess).toBe(2);                      // 4 on hand − Keep 2
  });

  it("emits nothing for a product whose category has no policy at all", () => {
    const stock = { hub1: { cap: cells({ "One Size": 40 }) } };
    expect(computeHubExcess(ctxOf(stock), NONE)).toEqual([]);
  });

  it("a size named with a zero/absent target is not armed by the category policy", () => {
    // seatingCore: a category-policy row needs target > 0 to arm at all.
    const config = { categoryPolicy: { sneakers: { perSize: true,
      hub1: { carriedOnly: true, sizes: { 9: KEEP(0) } } } } };
    const stock = { hub1: { af1: cells({ 9: 9 }) } };
    expect(computeHubSneakerExcess(ctxOf(stock, { config }), NONE)).toEqual([]);
  });
});

describe("excess is per size, not per product", () => {
  // MUTATION-PROVED: summing a product's sizes into one row (or keying `out`
  // by pid instead of pid+size) fails this test.
  it("computes each size independently — a short size never cancels a long one", () => {
    // 9: 5 on hand vs Keep 2 → 3 movable. 8: 1 on hand vs Keep 3 → BELOW keep,
    // contributes nothing and must not net against size 9.
    const stock = { hub1: { af1: cells({ 8: 1, 9: 5 }) } };
    const rows = computeHubSneakerExcess(ctxOf(stock), NONE);
    expect(keys(rows)).toEqual(["hub1|af1|9"]);
    expect(rows[0].excess).toBe(3);
  });

  it("keeps two excess sizes of one product as two separate rows", () => {
    const stock = { hub1: { af1: cells({ 9: 5, 10: 4 }) } };
    const rows = computeHubSneakerExcess(ctxOf(stock), NONE);
    expect(keys(rows)).toEqual(["hub1|af1|10", "hub1|af1|9"]);
    expect(rows.map((r) => r.excess).sort()).toEqual([2, 3]);
  });
});

describe("reservation netting — an open outbound request reduces excess", () => {
  // MUTATION-PROVED: dropping `- reservedQty` from the excess expression, or
  // matching on r.requestingLocation (the DESTINATION) instead of r.source,
  // fails these.
  const open = (over) => ({ id: "r1", status: "open", productId: "af1", size: "9", qty: 2, source: "hub1", ...over });

  it("subtracts units already promised out of that hub", () => {
    const stock = { hub1: { af1: cells({ 9: 5 }) } };
    const reserved = reservedByHubFromOpenRequests([open()]);
    const rows = computeHubSneakerExcess(ctxOf(stock), reserved);
    expect(rows[0].excess).toBe(1);        // 5 − Keep 2 − 2 reserved
    expect(rows[0].reserved).toBe(2);
  });

  it("reads the fulfilling hub from createdFrom.source when source is absent", () => {
    const stock = { hub1: { af1: cells({ 9: 5 }) } };
    const reserved = reservedByHubFromOpenRequests([open({ source: undefined, createdFrom: { source: "hub1" } })]);
    expect(computeHubSneakerExcess(ctxOf(stock), reserved)[0].excess).toBe(1);
  });

  it("never nets a request the OTHER hub is fulfilling", () => {
    const stock = { hub1: { af1: cells({ 9: 5 }) }, hub2: { af1: cells({ 9: 5 }) } };
    const reserved = reservedByHubFromOpenRequests([open({ source: "hub2" })]);
    const rows = computeHubSneakerExcess(ctxOf(stock), reserved);
    expect(rows.find((r) => r.loc === "hub1").excess).toBe(3);   // untouched
    expect(rows.find((r) => r.loc === "hub2").excess).toBe(1);   // netted
  });

  it("ignores requests that are not open, and requests for another size", () => {
    const stock = { hub1: { af1: cells({ 9: 5 }) } };
    const reserved = reservedByHubFromOpenRequests([
      open({ status: "fulfilled" }), open({ id: "r2", size: "10" }),
    ]);
    expect(computeHubSneakerExcess(ctxOf(stock), reserved)[0].excess).toBe(3);
  });

  it("a reservation that swallows the whole surplus removes the card", () => {
    const stock = { hub1: { af1: cells({ 9: 5 }) } };
    const reserved = reservedByHubFromOpenRequests([open({ qty: 3 })]);
    expect(computeHubSneakerExcess(ctxOf(stock), reserved)).toEqual([]);
  });
});

describe("a move leaves the cell at exactly Keep, never below", () => {
  // MUTATION-PROVED: dropping the Math.max(0, …) clamp, or moving `onHand`
  // instead of `movable`, fails this.
  it("movable is exactly the units above Keep (plus what is reserved)", () => {
    for (const [onHand, reservedQty, expected] of [[5, 0, 3], [5, 2, 1], [2, 0, 0], [1, 0, 0]]) {
      const stock = { hub1: { af1: cells({ 9: onHand }) } };
      const reserved = new Map(reservedQty ? [["hub1|af1|9", reservedQty]] : []);
      const rows = computeHubSneakerExcess(ctxOf(stock), reserved);
      const movable = rows[0]?.excess || 0;
      expect(movable).toBe(expected);
      // The invariant the operator actually cares about: what is LEFT BEHIND.
      // A move tops the cell down to exactly Keep (+ whatever is already
      // promised out of it) — and a cell that was ALREADY below Keep is never
      // drawn down further, it is simply left alone.
      const KEEP_9 = 2;
      expect(onHand - movable).toBe(Math.min(onHand, KEEP_9 + reservedQty));
    }
  });

  it("never proposes a move out of a cell already at or below Keep", () => {
    const stock = { hub1: { af1: cells({ 9: 2, 10: 1 }) } };
    expect(computeHubSneakerExcess(ctxOf(stock), NONE)).toEqual([]);
  });

  it("clamps a negative (oversold) cell instead of proposing a move", () => {
    const stock = { hub1: { af1: cells({ 9: -4 }) } };
    expect(computeHubSneakerExcess(ctxOf(stock), NONE)).toEqual([]);
  });
});

describe("excess below 1 never renders", () => {
  // MUTATION-PROVED: changing `movable < minMovable` to `movable < 0` emits a
  // 0-unit card and fails this.
  it("drops a zero-unit row", () => {
    const stock = { hub1: { af1: cells({ 9: 2 }) } };
    expect(computeHubSneakerExcess(ctxOf(stock), NONE)).toEqual([]);
  });

  it("keeps the smallest real move — one unit", () => {
    const stock = { hub1: { af1: cells({ 9: 3 }) } };
    expect(computeHubSneakerExcess(ctxOf(stock), NONE)[0].excess).toBe(1);
  });
});

describe("an explicit per-product row excludes the cell entirely", () => {
  // Hub 1's 124 explicit /stock_targets rows are deliberate per-product
  // tuning (Phase 1 found every one of them an explicit 0 kill switch). They
  // stay editable individually and must NEVER surface as excess.
  // MUTATION-PROVED: removing the `t.source === "explicit"` skip turns the
  // 0-target row into a 9-unit card and fails this.
  it("excludes a cell covered by an explicit row, whatever the row's value", () => {
    const stock = { hub1: { af1: cells({ 9: 9 }) } };
    for (const target of [0, 1, 5]) {
      const targets = { hub1: { af1: { 9: { target } } } };
      expect(computeHubSneakerExcess(ctxOf(stock, { targets }), NONE)).toEqual([]);
    }
  });

  it("excludes only the covered size — the product's other sizes still card", () => {
    const stock = { hub1: { af1: cells({ 9: 9, 10: 5 }) } };
    const targets = { hub1: { af1: { 9: { target: 0 } } } };
    const rows = computeHubSneakerExcess(ctxOf(stock, { targets }), NONE);
    expect(keys(rows)).toEqual(["hub1|af1|10"]);
  });

  it("excludes only at the location the row names — the other hub is unaffected", () => {
    const stock = { hub1: { af1: cells({ 9: 9 }) }, hub2: { af1: cells({ 9: 9 }) } };
    const targets = { hub1: { af1: { 9: { target: 0 } } } };
    const rows = computeHubSneakerExcess(ctxOf(stock, { targets }), NONE);
    expect(keys(rows)).toEqual(["hub2|af1|9"]);
  });
});

describe("the sneakers group is all seven categories", () => {
  it("covers every member category and nothing else", () => {
    for (const categoryKey of ["boots", "designer-shoes", "kids-shoes", "loafers", "running-shoes", "slides", "sneakers"]) {
      expect(isSneakerGroupProduct({ categoryKey })).toBe(true);
    }
    for (const categoryKey of ["tees", "caps-beanies", "perfumes", undefined]) {
      expect(isSneakerGroupProduct({ categoryKey })).toBe(false);
    }
  });

  it("cards a boot exactly like a sneaker — the group moves together", () => {
    const stock = { hub1: { boot: cells({ 9: 5 }) } };
    expect(computeHubSneakerExcess(ctxOf(stock), NONE)[0].excess).toBe(3);
  });
});

describe("clothing excess is behind an off-by-default flag", () => {
  // MUTATION-PROVED: making clothingExcessEnabled default to true (or dropping
  // the `!locations.length` early return) emits clothing cards and fails the
  // "off" test.
  const stock = { hub1: { tee: cells({ M: 6 }) }, hub2: { tee: cells({ M: 6 }) } };

  it("emits ZERO clothing cards while the key is absent", () => {
    expect(computeHubClothingExcess(ctxOf(stock), NONE)).toEqual([]);
  });

  it("emits ZERO clothing cards for false and for garbled values", () => {
    for (const excessClothingEnabled of [false, 0, "yes", null, [], { hub1: "yes" }]) {
      const config = { ...CONFIG, excessClothingEnabled };
      expect(computeHubClothingExcess(ctxOf(stock, { config }), NONE)).toEqual([]);
    }
  });

  it("restores the cards when the key is flipped on — no code change", () => {
    const config = { ...CONFIG, excessClothingEnabled: true };
    const rows = computeHubClothingExcess(ctxOf(stock, { config }), NONE);
    expect(keys(rows)).toEqual(["hub1|tee|M", "hub2|tee|M"]);
    expect(rows[0].excess).toBe(4);        // 6 on hand − Keep 2
  });

  it("can be flipped on for one hub only", () => {
    const config = { ...CONFIG, excessClothingEnabled: { hub2: true } };
    expect(keys(computeHubClothingExcess(ctxOf(stock, { config }), NONE))).toEqual(["hub2|tee|M"]);
    expect(clothingExcessEnabled(config, "hub1")).toBe(false);
    expect(clothingExcessEnabled(config, "hub2")).toBe(true);
  });

  it("never lets the flag touch sneakers — they are unconditional", () => {
    const sneakerStock = { hub1: { af1: cells({ 9: 5 }) } };
    const off = computeHubSneakerExcess(ctxOf(sneakerStock), NONE);
    const on = computeHubSneakerExcess(ctxOf(sneakerStock, { config: { ...CONFIG, excessClothingEnabled: true } }), NONE);
    expect(keys(off)).toEqual(keys(on));
    expect(off[0].excess).toBe(3);
  });

  it("never double-counts a sneaker as clothing", () => {
    const config = { ...CONFIG, excessClothingEnabled: true };
    const both = { hub1: { af1: cells({ 9: 5 }), tee: cells({ M: 6 }) } };
    const clothing = computeHubClothingExcess(ctxOf(both, { config }), NONE);
    expect(keys(clothing)).toEqual(["hub1|tee|M"]);
  });
});

describe("arming touches no shop", () => {
  // The whole build is HUBS ONLY. Marathon PE / Trophy / Pine must never gain
  // a target or an excess card from any of this.
  // MUTATION-PROVED: adding "marathon-pe" to EXCESS_HUB_LOCATIONS fails the
  // first test; adding a marathon-pe leg to the category policy fails the
  // second.
  it("the location list is exactly the two hubs", () => {
    expect([...EXCESS_HUB_LOCATIONS]).toEqual(["hub1", "hub2"]);
  });

  it("emits nothing for a shop even when it is holding stock over target", () => {
    const stock = {
      hub1: { af1: cells({ 9: 5 }) },
      "marathon-pe": { af1: cells({ 9: 50 }) },
      trophy: { af1: cells({ 9: 50 }) },
      pine: { af1: cells({ 9: 50 }) },
    };
    expect(keys(computeHubSneakerExcess(ctxOf(stock), NONE))).toEqual(["hub1|af1|9"]);
  });

  it("emits nothing even if a shop is asked for by name — the policy has no shop leg", () => {
    const stock = { "marathon-pe": { af1: cells({ 9: 50 }) } };
    const rows = computeHubExcess(ctxOf(stock), NONE, { locations: ["marathon-pe", "trophy", "pine"] });
    expect(rows).toEqual([]);
  });
});

describe("products that must never card", () => {
  it("skips a deactivated product", () => {
    const products = { ...PRODUCTS, af1: { ...PRODUCTS.af1, deactivated: { at: 1 } } };
    const stock = { hub1: { af1: cells({ 9: 9 }) } };
    expect(computeHubSneakerExcess({ ...ctxOf(stock), products }, NONE)).toEqual([]);
  });

  it("skips a stock cell with no matching product record", () => {
    const stock = { hub1: { ghost: cells({ 9: 9 }) } };
    expect(computeHubSneakerExcess(ctxOf(stock), NONE)).toEqual([]);
  });
});

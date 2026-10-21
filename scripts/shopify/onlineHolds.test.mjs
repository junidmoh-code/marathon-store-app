// Website-order holds in the push: a reserved unit never goes back on sale,
// and an order Shopify is already committing is never hidden twice.
import { describe, it, expect } from "vitest";
import { planProduct, onlineHoldAdjustment, reservedBySize } from "./inventorySync.mjs";

const map = {
  shopifyProductId: "gid://shopify/Product/1",
  variants: {
    "8": { shopifyVariantId: "gid://shopify/ProductVariant/8", shopifyInventoryItemId: "gid://shopify/InventoryItem/8" },
    "9": { shopifyVariantId: "gid://shopify/ProductVariant/9", shopifyInventoryItemId: "gid://shopify/InventoryItem/9" },
  },
};
const item = (k) => `gid://shopify/InventoryItem/${k}`;
const pushed = (plan, k) => plan.known.find((i) => i.sizeKey === k).quantity;
// What a buyer can add to cart once the push lands: Shopify's own arithmetic.
const sellable = (plan, k, committed) => pushed(plan, k) - committed;

describe("onlineHoldAdjustment", () => {
  it("subtracts only the part of a hold Shopify is not committing", () => {
    expect(onlineHoldAdjustment(1, 1)).toBe(0);
    expect(onlineHoldAdjustment(1, 0)).toBe(1);
    expect(onlineHoldAdjustment(0, 1)).toBe(0);
    expect(onlineHoldAdjustment(3, 1)).toBe(2);
    expect(onlineHoldAdjustment(undefined, undefined)).toBe(0);
    expect(onlineHoldAdjustment(-2, 0)).toBe(0);
  });
});

describe("reservedBySize", () => {
  it("sums every order's row per size and drops empty sizes", () => {
    expect(reservedBySize({
      "8": { o1: { qty: 1, ref: "WEB-1", locs: { hub1: 1 } }, o2: { qty: 2, ref: "WEB-2", locs: { hub2: 2 } } },
      "9": { o3: { qty: 0 } },
    })).toEqual({ "8": 3 });
    expect(reservedBySize(null)).toEqual({});
  });
});

describe("planProduct with website holds", () => {
  const baseline = new Map([[item(8), 2], [item(9), 1]]);
  const totals = { "8": 2, "9": 1 };

  it("an order open on both sides leaves on_hand at the app's count (Shopify holds it as committed)", () => {
    const committed = new Map([[item(8), 1]]);
    const plan = planProduct({ map, variants: null, baseline, totals, reserved: { "8": 1 }, committed });
    expect(pushed(plan, "8")).toBe(2);
    expect(sellable(plan, "8", 1)).toBe(1); // 2 held, 1 promised: one left to sell
  });

  it("an order fulfilled in the admin before it was packed does not put the sold unit back on sale", () => {
    // Shopify lowered on_hand to 1 at fulfilment; the app still holds 2 until the pack.
    const plan = planProduct({ map, variants: null, baseline: new Map([[item(8), 1], [item(9), 1]]), totals, reserved: { "8": 1 }, committed: new Map() });
    expect(pushed(plan, "8")).toBe(1);
    expect(sellable(plan, "8", 0)).toBe(1);
    expect(plan.drift.find((d) => d.sizeKey === "8")).toBeUndefined(); // nothing to push back
  });

  it("the last unit, reserved and no longer committed, is never offered again", () => {
    const plan = planProduct({ map, variants: null, baseline, totals: { "8": 1, "9": 1 }, reserved: { "8": 1 }, committed: new Map() });
    expect(pushed(plan, "8")).toBe(0);
  });

  it("never pushes a negative quantity", () => {
    const plan = planProduct({ map, variants: null, baseline, totals: { "8": 0, "9": 1 }, reserved: { "8": 2 }, committed: new Map() });
    expect(pushed(plan, "8")).toBe(0);
  });

  it("a reservation on one size does not touch another", () => {
    const plan = planProduct({ map, variants: null, baseline, totals, reserved: { "8": 1 }, committed: new Map() });
    expect(pushed(plan, "9")).toBe(1);
  });

  it("an older caller passing no holds pushes exactly what it always did", () => {
    const plan = planProduct({ map, variants: null, baseline, totals });
    expect(pushed(plan, "8")).toBe(2);
    expect(pushed(plan, "9")).toBe(1);
  });

  it("an order not yet pulled in by the poller is left to Shopify's committed count", () => {
    const plan = planProduct({ map, variants: null, baseline, totals, reserved: {}, committed: new Map([[item(8), 1]]) });
    expect(pushed(plan, "8")).toBe(2);
    expect(sellable(plan, "8", 1)).toBe(1);
  });
});

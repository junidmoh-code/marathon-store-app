// Tests for per-user store assignment logic (Phase 15). Covers the order-flow
// gate scenarios and the admin-UI toggle/warning behavior from the PR spec.

import { describe, it, expect } from "vitest";
import {
  STORE_IDS,
  effectiveStoreIds,
  nextStoreIds,
  placesOrders,
  shouldWarnNoStore,
  SHOP_TO_UNIVERSE,
  shopUniverse,
} from "./stores";

describe("effectiveStoreIds — order placement gate", () => {
  it("storeIds=['pine'] → only Pine", () => {
    expect(effectiveStoreIds({ storeIds: ["pine"] })).toEqual(["pine"]);
  });

  it("storeIds=['pine','central'] → both", () => {
    expect(effectiveStoreIds({ storeIds: ["pine", "central"] }).sort())
      .toEqual(["central", "pine"]);
  });

  it("storeIds=[] → no access (empty)", () => {
    expect(effectiveStoreIds({ storeIds: [] })).toEqual([]);
  });

  it("no storeIds field (legacy) → all stores", () => {
    expect(effectiveStoreIds({}).sort()).toEqual(["central", "pine"]);
    expect(effectiveStoreIds(null).sort()).toEqual(["central", "pine"]);
  });

  it("super admin → all stores regardless of field", () => {
    expect(effectiveStoreIds({ storeIds: [] }, true).sort()).toEqual(["central", "pine"]);
    expect(effectiveStoreIds({ storeIds: ["pine"] }, true).sort()).toEqual(["central", "pine"]);
  });

  it("filters out unknown store ids", () => {
    expect(effectiveStoreIds({ storeIds: ["pine", "bogus"] })).toEqual(["pine"]);
  });

  it("dedupes and canonicalizes order (duplicate can't inflate length)", () => {
    expect(effectiveStoreIds({ storeIds: ["pine", "pine"] })).toEqual(["pine"]);
    expect(effectiveStoreIds({ storeIds: ["pine", "central"] })).toEqual(["central", "pine"]);
  });

  it("returns a copy, not the canonical STORE_IDS reference", () => {
    const out = effectiveStoreIds({}, true);
    expect(out).not.toBe(STORE_IDS);
  });
});

describe("shopUniverse — shop → routing-universe bridge", () => {
  it("Marathon PE and Trophy both map to the central universe", () => {
    expect(shopUniverse("marathon-pe")).toBe("central");
    expect(shopUniverse("trophy")).toBe("central");
  });

  it("Pine maps to the pine universe", () => {
    expect(shopUniverse("marathon-pine")).toBe("pine");
  });

  it("unknown/unmapped shop defaults to central (never accidentally pine)", () => {
    expect(shopUniverse("future-shop")).toBe("central");
    expect(shopUniverse(undefined)).toBe("central");
  });

  it("every mapped shop resolves to a real STORE_ID", () => {
    for (const universe of Object.values(SHOP_TO_UNIVERSE)) {
      expect(STORE_IDS).toContain(universe);
    }
  });
});

describe("nextStoreIds — admin toggle persistence", () => {
  it("toggling Pine off then on persists correctly (from both-assigned)", () => {
    const off = nextStoreIds(["central", "pine"], "pine", false);
    expect(off).toEqual(["central"]);
    const on = nextStoreIds(off, "pine", true);
    expect(on).toEqual(["central", "pine"]);
  });

  it("unchecking one store on a legacy (all-access) user keeps the other", () => {
    // field absent → seed from all stores so we don't collapse to just [pine]
    expect(nextStoreIds(undefined, "pine", false)).toEqual(["central"]);
    expect(nextStoreIds(undefined, "central", false)).toEqual(["pine"]);
  });

  it("unchecking the last assigned store yields [] (no access)", () => {
    expect(nextStoreIds(["pine"], "pine", false)).toEqual([]);
  });

  it("result is ordered by STORE_IDS and de-duplicated", () => {
    expect(nextStoreIds(["pine"], "central", true)).toEqual(["central", "pine"]);
    expect(nextStoreIds(["pine", "pine"], "pine", true)).toEqual(["pine"]);
  });
});

describe("shouldWarnNoStore — admin warning indicator", () => {
  it("empty storeIds + store_assistant role → warn", () => {
    expect(shouldWarnNoStore({ storeIds: [], role: "store_assistant" })).toBe(true);
  });

  it("empty storeIds + place_orders permission → warn", () => {
    expect(shouldWarnNoStore({ storeIds: [], permissions: ["place_orders"] })).toBe(true);
  });

  it("empty storeIds but not an order-taker (e.g. warehouse) → no warn", () => {
    expect(shouldWarnNoStore({ storeIds: [], role: "warehouse" })).toBe(false);
  });

  it("legacy user (no field) → no warn even if order-taker", () => {
    expect(shouldWarnNoStore({ role: "store_assistant" })).toBe(false);
  });

  it("assigned store + order-taker → no warn", () => {
    expect(shouldWarnNoStore({ storeIds: ["pine"], role: "store_assistant" })).toBe(false);
  });
});

describe("placesOrders", () => {
  it("true for store_assistant role, place_orders/store_assistant perms", () => {
    expect(placesOrders({ role: "store_assistant" })).toBe(true);
    expect(placesOrders({ permissions: ["place_orders"] })).toBe(true);
    expect(placesOrders({ permissions: ["store_assistant"] })).toBe(true);
  });
  it("false for warehouse-only / empty", () => {
    expect(placesOrders({ role: "warehouse", permissions: ["warehouse"] })).toBe(false);
    expect(placesOrders({})).toBe(false);
    expect(placesOrders(null)).toBe(false);
  });
});

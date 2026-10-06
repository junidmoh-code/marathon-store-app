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
  STORE_LABELS, SHOP_IDS, SHOP_LABELS, shopIdsOf, shopLabelOf,
} from "./stores";
import { normalizeNetwork, SEED_REGISTRY } from "./networkRegistry";

// ─── THE VOCABULARIES, PINNED ON THE SEED ────────────────────────────────────
// These used to be typed literals. They are read off the registry now; this is
// the proof that Marathon PE, Trophy and Pine got exactly what they had, in the
// order they had it, and Concrete was added AFTER them.
describe("vocabularies read off the registry seed", () => {
  it("STORE_IDS / STORE_LABELS: central, pine as before; concrete appended", () => {
    expect(STORE_IDS).toEqual(["central", "pine", "concrete"]);
    expect(STORE_LABELS).toEqual({ central: "Central", pine: "Pine", concrete: "Concrete" });
  });
  it("SHOP_IDS / SHOP_LABELS: the three shops as before; Concrete appended", () => {
    expect(SHOP_IDS).toEqual(["marathon-pe", "trophy", "marathon-pine", "concrete"]);
    expect(SHOP_LABELS).toEqual({ "marathon-pe": "Marathon PE", trophy: "Trophy", "marathon-pine": "Pine", concrete: "Concrete" });
    expect(Object.keys(SHOP_LABELS)).toEqual(SHOP_IDS);
  });
  it("SHOP_TO_UNIVERSE: the old map, plus concrete → concrete", () => {
    expect(SHOP_TO_UNIVERSE).toEqual({ "marathon-pe": "central", trophy: "central", "marathon-pine": "pine", concrete: "concrete" });
    expect(Object.keys(SHOP_TO_UNIVERSE)).toEqual(SHOP_IDS);
  });
  it("the live functions follow /network: a renamed Pine shows its new name, a new shop appears", () => {
    const net = normalizeNetwork({ locations: {
      "marathon-pine": { name: "Pinetown" },
      kloof: { type: "store", section: 1, name: "Kloof", universe: "kloof", sort: 14 },
    } });
    expect(shopLabelOf("marathon-pine", net)).toBe("Pinetown");
    expect(shopLabelOf("marathon-pine", SEED_REGISTRY)).toBe("Pine");
    expect(shopIdsOf(net)).toEqual(["marathon-pe", "trophy", "marathon-pine", "concrete", "kloof"]);
    expect(shopUniverse("kloof", net)).toBe("kloof");
    expect(shopLabelOf("nowhere", net)).toBe("nowhere");
  });
});

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
    expect(effectiveStoreIds({}).sort()).toEqual(["central", "concrete", "pine"]);
    expect(effectiveStoreIds(null).sort()).toEqual(["central", "concrete", "pine"]);
  });

  it("super admin → all stores regardless of field", () => {
    expect(effectiveStoreIds({ storeIds: [] }, true).sort()).toEqual(["central", "concrete", "pine"]);
    expect(effectiveStoreIds({ storeIds: ["pine"] }, true).sort()).toEqual(["central", "concrete", "pine"]);
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

  // It used to default to "central". That is Section 2: an unmapped Section 1
  // shop must not fall into Marathon PE's routing by default.
  it("unknown/unmapped shop has NO universe (never central, never pine)", () => {
    expect(shopUniverse("future-shop")).toBe(null);
    expect(shopUniverse(undefined)).toBe(null);
    // A hub is not a shop either.
    expect(shopUniverse("hub2")).toBe(null);
  });

  it("Concrete is a shop with its own universe", () => {
    expect(shopUniverse("concrete")).toBe("concrete");
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
    expect(nextStoreIds(undefined, "pine", false)).toEqual(["central", "concrete"]);
    expect(nextStoreIds(undefined, "central", false)).toEqual(["pine", "concrete"]);
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

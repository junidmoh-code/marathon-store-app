// ── ID-map tests: mapping shape + idempotency planner ────────────────────────
// Pure-function tests (no RTDB, no emulator): buildMapping's key encoding and
// gid validation, and planIdMapWrite's create / noop / merge / refuse matrix —
// the idempotency contract the live writer rides on.
import { describe, it, expect } from "vitest";
import { buildMapping, planIdMapWrite, claimKeyFor, planClaim } from "./idMap.mjs";

const gid = {
  product: (n) => `gid://shopify/Product/${n}`,
  variant: (n) => `gid://shopify/ProductVariant/${n}`,
  item: (n) => `gid://shopify/InventoryItem/${n}`,
};

const rows = [
  { size: "5.5", variantId: gid.variant(1), inventoryItemId: gid.item(11) },
  { size: "6", variantId: gid.variant(2), inventoryItemId: gid.item(12) },
  { size: "M", variantId: gid.variant(3), inventoryItemId: gid.item(13) },
  { size: "_", variantId: gid.variant(4), inventoryItemId: gid.item(14) },
];

describe("buildMapping", () => {
  it("keys variants by the app's RTDB size encoding (5.5 → 5_5, sentinel intact)", () => {
    const m = buildMapping(gid.product(9), rows);
    expect(Object.keys(m.variants).sort()).toEqual(["5_5", "6", "M", "_"].sort());
    expect(m.variants["5_5"]).toEqual({
      shopifyVariantId: gid.variant(1),
      shopifyInventoryItemId: gid.item(11),
    });
    expect(m.shopifyProductId).toBe(gid.product(9));
  });

  it("rejects non-gid IDs and empty rows", () => {
    expect(() => buildMapping("123456", rows)).toThrow(/Product gid/);
    expect(() =>
      buildMapping(gid.product(9), [{ size: "6", variantId: "42", inventoryItemId: gid.item(1) }])
    ).toThrow(/ProductVariant gid/);
    expect(() => buildMapping(gid.product(9), [])).toThrow(/no variants/);
  });

  it("rejects two rows that collapse onto one size key", () => {
    expect(() =>
      buildMapping(gid.product(9), [
        { size: "5.5", variantId: gid.variant(1), inventoryItemId: gid.item(1) },
        { size: "5_5", variantId: gid.variant(2), inventoryItemId: gid.item(2) },
      ])
    ).toThrow(/duplicate size key/);
  });
});

describe("planIdMapWrite — idempotency contract", () => {
  const mapping = buildMapping(gid.product(9), rows);

  it("no existing node → create", () => {
    expect(planIdMapWrite(null, mapping)).toEqual({ action: "create" });
  });

  it("identical existing node → noop (re-run safe)", () => {
    const existing = JSON.parse(JSON.stringify(mapping));
    expect(planIdMapWrite(existing, mapping)).toEqual({ action: "noop" });
  });

  it("same product, strictly new size keys → merge of ONLY the new keys", () => {
    const existing = {
      shopifyProductId: gid.product(9),
      variants: { "5_5": mapping.variants["5_5"], 6: mapping.variants["6"] },
    };
    expect(planIdMapWrite(existing, mapping)).toEqual({ action: "merge", newKeys: ["M", "_"] });
  });

  it("pending node (product id only, no variants yet) → merge of every key", () => {
    // round-trip --commit writes {shopifyProductId, variants:{}} immediately
    // after creation; the full mapping after read-back must merge cleanly.
    const existing = { shopifyProductId: gid.product(9) };
    const plan = planIdMapWrite(existing, mapping);
    expect(plan.action).toBe("merge");
    expect(plan.newKeys.sort()).toEqual(["5_5", "6", "M", "_"].sort());
  });

  it("different shopifyProductId → refuses (duplicate-product guard)", () => {
    const existing = { ...JSON.parse(JSON.stringify(mapping)), shopifyProductId: gid.product(8) };
    expect(() => planIdMapWrite(existing, mapping)).toThrow(/refusing to overwrite/);
  });

  it("same size key with different variant IDs → refuses", () => {
    const existing = JSON.parse(JSON.stringify(mapping));
    existing.variants["6"].shopifyVariantId = gid.variant(999);
    expect(() => planIdMapWrite(existing, mapping)).toThrow(/refusing to overwrite variant 6/);
  });
});

// ── The claim index ──────────────────────────────────────────────────────────
// The uniqueness guarantee moved off a whole-node transaction and onto one
// child of /shopify_sync/_claims. These are the two pure pieces that decide it.
describe("claimKeyFor", () => {
  it("keys on the numeric id, because a gid cannot be an RTDB path segment", () => {
    expect(claimKeyFor(gid.product(9339656536213))).toBe("9339656536213");
  });

  it("refuses anything that is not a Product gid rather than inventing a key", () => {
    expect(() => claimKeyFor(gid.variant(1))).toThrow(/Product gid/);
    expect(() => claimKeyFor("9339656536213")).toThrow(/Product gid/);
    expect(() => claimKeyFor(null)).toThrow(/Product gid/);
    expect(() => claimKeyFor("gid://shopify/Product/12ab")).toThrow(/Product gid/);
  });
});

describe("planClaim", () => {
  it("claims a gid nobody holds", () => {
    expect(planClaim(null, "p1")).toEqual({ action: "claim" });
  });

  it("treats a claim this record already holds as held, not as a conflict", () => {
    expect(planClaim("p1", "p1")).toEqual({ action: "held" });
  });

  it("REFUSES a gid another record holds — the guarantee the root transaction existed for", () => {
    const plan = planClaim("p2", "p1");
    expect(plan.action).toBe("refuse");
    expect(plan.refusal).toMatch(/already claimed by record p2/);
  });
});

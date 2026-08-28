// Adoption rewrites a Shopify product in place — title, handle, description,
// media, price, inventory, collections. Adopting the wrong one overwrites a
// real listing that is trading. So every one of these is a refusal test, and
// the two that say "ok" are the narrow shape that is genuinely litter.
import { describe, it, expect } from "vitest";
import { adoptionVerdict } from "./adopt.mjs";

const PUB = "gid://shopify/Publication/1";
const gql = (product) => async () => ({ product });
const base = {
  id: "gid://shopify/Product/9", title: "Orphan", handle: "sneaker-black",
  status: "DRAFT", totalInventory: 0, publishedOnPublication: false,
  resourcePublicationsCount: { count: 0 },
  variants: { pageInfo: { hasNextPage: false }, nodes: [{ inventoryQuantity: 0 }] },
};

describe("adoptionVerdict", () => {
  it("adopts a draft orphan with no stock on no channel", async () => {
    const v = await adoptionVerdict(gql(base), base.id, PUB);
    expect(v.ok).toBe(true);
    expect(v.why).toMatch(/no stock/);
  });

  it("adopts an UNPUBLISHED product with no stock even if it is ACTIVE", async () => {
    // Status ACTIVE alone does not put it in front of a customer — a sales
    // channel does. An active product on NO channel, with no stock, is litter.
    const v = await adoptionVerdict(gql({ ...base, status: "ACTIVE" }), base.id, PUB);
    expect(v.ok).toBe(true);
  });

  it("REFUSES a product that is on sale on the storefront right now", async () => {
    const v = await adoptionVerdict(
      gql({ ...base, status: "ACTIVE", publishedOnPublication: true, resourcePublicationsCount: { count: 1 } }),
      base.id, PUB);
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/on sale on the storefront/);
  });

  it("REFUSES an ACTIVE product live on ANOTHER sales channel — POS, Shop, a marketplace", async () => {
    // The first version checked only the Online Store publication, so a product
    // selling through the POS or the Shop app looked like litter and would have
    // been rewritten in place — title, handle, media, price (Codex review).
    const v = await adoptionVerdict(
      gql({ ...base, status: "ACTIVE", publishedOnPublication: false, resourcePublicationsCount: { count: 1 } }),
      base.id, PUB);
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/another sales channel/);
  });

  it("REFUSES a DRAFT product attached to a channel — it goes VISIBLE the moment status flips", async () => {
    // Shopify's status and its publications are independent. A draft already
    // attached to a channel becomes visible there the instant it turns ACTIVE —
    // which is exactly what adopting it does, since the reconciler sets ACTIVE
    // at the end of a publish. Adoption would have put our product in front of
    // customers on a channel nobody chose (CodeRabbit review).
    const v = await adoptionVerdict(
      gql({ ...base, status: "DRAFT", resourcePublicationsCount: { count: 2 } }), base.id, PUB);
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/another sales channel/);
  });

  it("REFUSES a DRAFT product already set up on OUR storefront channel", async () => {
    const v = await adoptionVerdict(
      gql({ ...base, status: "DRAFT", publishedOnPublication: true, resourcePublicationsCount: { count: 1 } }),
      base.id, PUB);
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/already set up on the storefront/);
  });

  it("REFUSES when the shop will not say which channels it is on — an unknown is not a yes", async () => {
    const v = await adoptionVerdict(
      gql({ ...base, status: "ACTIVE", resourcePublicationsCount: null }), base.id, PUB);
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/would not say which sales channels/);
  });

  it("REFUSES anything holding stock", async () => {
    const v = await adoptionVerdict(gql({ ...base, totalInventory: 3 }), base.id, PUB);
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/3 units of stock/);
  });

  it("REFUSES on variant quantities even when totalInventory says zero", async () => {
    // totalInventory only counts TRACKED variants, and an untracked variant is
    // the one that sells for ever — this repo has repaired that once already.
    // Reading only the summary would let a stocked product look empty.
    const v = await adoptionVerdict(gql({
      ...base, totalInventory: 0,
      variants: { pageInfo: { hasNextPage: false }, nodes: [{ inventoryQuantity: 0 }, { inventoryQuantity: 2 }] },
    }), base.id, PUB);
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/2 units/);
  });

  it("ignores a NEGATIVE variant quantity rather than letting it cancel real stock out", async () => {
    const v = await adoptionVerdict(gql({
      ...base, totalInventory: 0,
      variants: { pageInfo: { hasNextPage: false }, nodes: [{ inventoryQuantity: -5 }, { inventoryQuantity: 5 }] },
    }), base.id, PUB);
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/5 units/);
  });

  it("REFUSES when the variants are unpaginated — an unknown is not a yes", async () => {
    const v = await adoptionVerdict(gql({
      ...base, variants: { pageInfo: { hasNextPage: true }, nodes: [{ inventoryQuantity: 0 }] },
    }), base.id, PUB);
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/cannot see all their stock/);
  });

  it("REFUSES when the product vanished between the probe and the question", async () => {
    const v = await adoptionVerdict(gql(null), base.id, PUB);
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/disappeared/);
  });

  it("REFUSES when the shop cannot be asked at all", async () => {
    const v = await adoptionVerdict(async () => { throw new Error("429 throttled"); }, base.id, PUB);
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/429 throttled/);
  });

  it("never names a script in anything a person reads", async () => {
    const verdicts = await Promise.all([
      adoptionVerdict(gql({ ...base, totalInventory: 1 }), base.id, PUB),
      adoptionVerdict(gql({ ...base, status: "ACTIVE", publishedOnPublication: true }), base.id, PUB),
      adoptionVerdict(gql(null), base.id, PUB),
    ]);
    for (const v of verdicts) expect(v.why).not.toMatch(/\.mjs|round-trip|script/);
  });
});

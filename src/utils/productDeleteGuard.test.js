import { describe, it, expect } from "vitest";
import { judgeProductDelete, checkProductDelete } from "./productDeleteGuard";

const fakeRead = (tree, { throwOn } = {}) => async (path) => {
  if (throwOn && path.startsWith(throwOn)) throw new Error("permission denied");
  return path.split("/").reduce((n, k) => (n == null ? null : n[k] ?? null), tree);
};
const registry = { hub1: {}, hub2: {}, central: {} };

describe("judgeProductDelete", () => {
  it("allows a record with no stock cell and no Shopify link", () => {
    expect(judgeProductDelete({ cells: [{ loc: "hub1", sizes: 0 }] }).ok).toBe(true);
  });
  it("refuses when any location holds a cell — even a qty-0 one is history", () => {
    const v = judgeProductDelete({ cells: [{ loc: "hub1", sizes: 0 }, { loc: "central", sizes: 2 }] });
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/central/);
    expect(v.message).toMatch(/Deactivate/);
    expect(v.message).toMatch(/Merge/);
  });
  it("refuses when linked to Shopify by map or by publish node", () => {
    expect(judgeProductDelete({ shopifyProductId: "gid://shopify/Product/1" }).ok).toBe(false);
    expect(judgeProductDelete({ publishState: "live" }).ok).toBe(false);
  });
});

describe("checkProductDelete", () => {
  it("passes a never-stocked, never-listed product", async () => {
    const v = await checkProductDelete(fakeRead({ locations: registry, stock: {} }), "p1");
    expect(v.ok).toBe(true);
  });
  it("sees a qty-0 cell, the in_transit leg and the Shopify link (the 25 Oct case)", async () => {
    const tree = {
      locations: registry,
      stock: { in_transit: { p1: { 7: { qty: 0 } } }, central: { p1: { 8: { qty: 18 } } } },
      shopify_sync: { p1: { shopifyProductId: "gid://shopify/Product/9360134930581" } },
      shopify_publish: { p1: { state: "live" } },
    };
    const v = await checkProductDelete(fakeRead(tree), "p1");
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/central, in_transit/);
    expect(v.reasons.join(" ")).toMatch(/Shopify/);
  });
  it("sees an array-shaped stock node (numeric sizes)", async () => {
    const tree = { locations: registry, stock: { hub2: { p1: [null, null, null, null, null, null, { qty: 0 }] } } };
    expect((await checkProductDelete(fakeRead(tree), "p1")).ok).toBe(false);
  });
  it("fails closed when the registry is empty or a read throws", async () => {
    expect((await checkProductDelete(fakeRead({ stock: {} }), "p1")).ok).toBe(false);
    expect((await checkProductDelete(fakeRead({ locations: registry }, { throwOn: "shopify_sync" }), "p1")).ok).toBe(false);
  });
});

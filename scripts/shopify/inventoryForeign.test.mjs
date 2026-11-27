import { describe, it, expect } from "vitest";
import { reservedBySize, releasedBySize, foreignBySize, withoutForeignHolds } from "./inventorySync.mjs";
import { buildOrder } from "./onlineOrders/orderModel.mjs";
import { ownsOrder } from "./onlineOrders/poll.mjs";
import { orderLabel } from "../../src/utils/onlineOrders.js";

// This process is Marathon (SHOPIFY_STORE unset): rows without `store` are its own.
const holds = {
  9: { o1: { qty: 1 }, c1: { qty: 2, store: "concrete" } },
  10: { c2: { qty: 1, store: "concrete", released: 1 } },
};

describe("one stock pool, two stores", () => {
  it("own holds stay netted; another store's come off in full", () => {
    expect(reservedBySize(holds)).toEqual({ 9: 1 });
    expect(releasedBySize(holds)).toEqual({});
    expect(foreignBySize(holds)).toEqual({ 9: 2, 10: 1 });
    expect(withoutForeignHolds({ 9: 5, 10: 1, 11: 3 }, holds)).toEqual({ 9: 3, 10: 0, 11: 3 });
    expect(withoutForeignHolds({ 9: 5 }, null, { 9: 9 })).toEqual({ 9: 0 });
  });
  it("Marathon's arithmetic is unchanged when no row names a store", () => {
    const plain = { 9: { o1: { qty: 1 }, o2: { qty: 2, released: 1 } } };
    expect(reservedBySize(plain)).toEqual({ 9: 3 });
    expect(releasedBySize(plain)).toEqual({ 9: 1 });
    expect(withoutForeignHolds({ 9: 4 }, plain)).toEqual({ 9: 4 });
  });
});

describe("Concrete orders are tagged; Marathon's are not", () => {
  const node = { number: 1001, id: "gid://shopify/Order/1", name: "#1001", createdAt: "2026-11-15T10:00:00Z" };
  it("buildOrder tags only non-Marathon stores", () => {
    expect(buildOrder({ node, lines: [], nowMs: 1 }).sourceStore).toBeUndefined();
    expect(buildOrder({ node, lines: [], nowMs: 1, store: "concrete" }).sourceStore).toBe("concrete");
  });
  it("each poller owns only its own orders", () => {
    expect(ownsOrder({}, "marathon")).toBe(true);
    expect(ownsOrder({ sourceStore: "concrete" }, "marathon")).toBe(false);
    expect(ownsOrder({ sourceStore: "concrete" }, "concrete")).toBe(true);
  });
  it("labels say which store", () => {
    expect(orderLabel({ orderNumber: 1001 })).toBe("#1001");
    expect(orderLabel({ orderNumber: 1001, sourceStore: "concrete" })).toBe("Concrete #1001");
  });
});

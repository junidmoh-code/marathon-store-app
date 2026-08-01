import { describe, it, expect } from "vitest";
import {
  LISTS, LIST_MARKETING, LIST_DISPLAY, isListId, newItemRecord,
  itemIds, listSummaries, listsHolding, resolveListProducts,
} from "./attentionLists";

describe("LISTS", () => {
  it("is exactly Marketing and Display, in that order", () => {
    expect(LISTS.map((l) => l.id)).toEqual([LIST_MARKETING, LIST_DISPLAY]);
    expect(isListId("marketing")).toBe(true);
    expect(isListId("folders")).toBe(false);
  });
});

describe("newItemRecord", () => {
  it("stamps when and who, tolerating a missing user", () => {
    expect(newItemRecord({ uid: "u1", nowMs: 7 })).toEqual({ addedAt: 7, addedBy: "u1" });
    expect(newItemRecord({ nowMs: 7 }).addedBy).toBeNull();
  });
});

describe("itemIds", () => {
  it("orders by when it was picked, oldest first", () => {
    expect(itemIds({ items: { p2: { addedAt: 200 }, p1: { addedAt: 100 }, p3: { addedAt: 300 } } }))
      .toEqual(["p1", "p2", "p3"]);
  });

  it("survives a missing or malformed node", () => {
    expect(itemIds(null)).toEqual([]);
    expect(itemIds({})).toEqual([]);
    expect(itemIds({ items: "nope" })).toEqual([]);
  });
});

describe("listSummaries", () => {
  it("always returns BOTH lists, even when nothing has been picked", () => {
    // The tabs must not appear and disappear with the data.
    const s = listSummaries(null);
    expect(s.map((l) => [l.id, l.count])).toEqual([["marketing", 0], ["display", 0]]);
  });

  it("counts each list independently", () => {
    const s = listSummaries({
      marketing: { items: { p1: { addedAt: 1 }, p2: { addedAt: 2 } } },
      display: { items: { p3: { addedAt: 1 } } },
    });
    expect(s.map((l) => [l.id, l.count])).toEqual([["marketing", 2], ["display", 1]]);
    expect(s[0].productIds).toEqual(["p1", "p2"]);
  });
});

describe("listsHolding", () => {
  const s = listSummaries({
    marketing: { items: { p1: { addedAt: 1 } } },
    display: { items: { p1: { addedAt: 1 }, p2: { addedAt: 2 } } },
  });

  it("reports every list already holding the product", () => {
    expect(Array.from(listsHolding(s, "p1")).sort()).toEqual(["display", "marketing"]);
    expect(Array.from(listsHolding(s, "p2"))).toEqual(["display"]);
    expect(listsHolding(s, "nope").size).toBe(0);
    expect(listsHolding(null, "p1").size).toBe(0);
  });
});

describe("resolveListProducts", () => {
  const PRODUCTS = { p1: { id: "p1", name: "Nike Air Max", photoUrl: "u1" } };

  it("resolves against the catalogue, keeping the picked order", () => {
    const [marketing] = listSummaries({ marketing: { items: { p1: { addedAt: 1 } } } });
    expect(resolveListProducts(marketing, PRODUCTS)).toEqual([
      { id: "p1", product: PRODUCTS.p1, missing: false, name: "Nike Air Max", photo: "u1" },
    ]);
  });

  it("flags a product that has left the catalogue rather than dropping it", () => {
    const [marketing] = listSummaries({ marketing: { items: { gone: { addedAt: 1 } } } });
    expect(resolveListProducts(marketing, PRODUCTS)[0]).toMatchObject({ id: "gone", missing: true, product: null });
  });

  it("handles an empty list", () => {
    expect(resolveListProducts(null, PRODUCTS)).toEqual([]);
    expect(resolveListProducts({ productIds: [] }, PRODUCTS)).toEqual([]);
  });
});

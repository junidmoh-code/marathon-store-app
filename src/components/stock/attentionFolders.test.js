import { describe, it, expect } from "vitest";
import {
  normaliseFolderName, newFolderRecord, newItemRecord,
  folderList, itemIds, foldersHolding, resolveFolderProducts, NAME_MAX,
} from "./attentionFolders";

describe("normaliseFolderName", () => {
  it("trims, collapses whitespace and bounds the length", () => {
    expect(normaliseFolderName("  Winter   clearance ")).toBe("Winter clearance");
    expect(normaliseFolderName("x".repeat(200))).toHaveLength(NAME_MAX);
  });

  it("returns null for anything unusable, so callers have one empty answer", () => {
    expect(normaliseFolderName("")).toBeNull();
    expect(normaliseFolderName("   ")).toBeNull();
    expect(normaliseFolderName(null)).toBeNull();
    expect(normaliseFolderName(42)).toBeNull();
  });
});

describe("newFolderRecord", () => {
  it("builds a named record stamped with who and when", () => {
    const rec = newFolderRecord({ name: " Reorder Monday ", uid: "u1", displayName: "Junid", nowMs: 1000 });
    expect(rec).toEqual({ name: "Reorder Monday", createdAt: 1000, createdBy: "u1", createdByName: "Junid" });
  });

  it("omits `items` entirely rather than writing an empty object", () => {
    // RTDB drops empty objects — writing {} would be a claim that doesn't survive
    // the round trip. An absent items node already reads as "no items".
    expect("items" in newFolderRecord({ name: "A", uid: "u", displayName: "n", nowMs: 1 })).toBe(false);
  });

  it("refuses a nameless folder", () => {
    expect(() => newFolderRecord({ name: "   ", uid: "u", nowMs: 1 })).toThrow(/needs a name/i);
  });

  it("tolerates a missing user without dropping the record", () => {
    const rec = newFolderRecord({ name: "A", nowMs: 5 });
    expect(rec.createdBy).toBeNull();
    expect(rec.createdByName).toBeNull();
  });
});

describe("newItemRecord", () => {
  it("stamps when and who", () => {
    expect(newItemRecord({ uid: "u1", nowMs: 7 })).toEqual({ addedAt: 7, addedBy: "u1" });
    expect(newItemRecord({ nowMs: 7 }).addedBy).toBeNull();
  });
});

describe("folderList", () => {
  const RAW = {
    f1: { name: "Older", createdAt: 100, items: { p1: { addedAt: 1 }, p2: { addedAt: 2 } } },
    f2: { name: "Newer", createdAt: 200, items: { p3: { addedAt: 3 } } },
    f3: { name: "Empty", createdAt: 150 },
  };

  it("lists newest first with an item count", () => {
    expect(folderList(RAW).map((f) => [f.id, f.name, f.count])).toEqual([
      ["f2", "Newer", 1], ["f3", "Empty", 0], ["f1", "Older", 2],
    ]);
  });

  it("survives malformed records instead of taking the panel down", () => {
    const list = folderList({ bad: { createdAt: "nope", items: "not-an-object" } });
    expect(list[0].name).toBe("Untitled folder");
    expect(list[0].count).toBe(0);
    expect(list[0].createdAt).toBe(0);
    expect(folderList(null)).toEqual([]);
    expect(folderList("x")).toEqual([]);
  });

  it("reads item ids off a folder", () => {
    expect(itemIds(RAW.f1).sort()).toEqual(["p1", "p2"]);
    expect(itemIds(RAW.f3)).toEqual([]);
    expect(itemIds(null)).toEqual([]);
  });
});

describe("foldersHolding", () => {
  it("reports every folder already containing the product", () => {
    const list = folderList({
      a: { name: "A", createdAt: 1, items: { p1: {} } },
      b: { name: "B", createdAt: 2, items: { p1: {}, p2: {} } },
      c: { name: "C", createdAt: 3, items: { p9: {} } },
    });
    expect(Array.from(foldersHolding(list, "p1")).sort()).toEqual(["a", "b"]);
    expect(foldersHolding(list, "nope").size).toBe(0);
    expect(foldersHolding(null, "p1").size).toBe(0);
  });
});

describe("resolveFolderProducts", () => {
  const PRODUCTS = { p1: { id: "p1", name: "Nike Air Max", photoUrl: "u1" } };

  it("resolves against the catalogue and keeps the added order", () => {
    const [f] = folderList({ f1: { name: "F", createdAt: 1, items: { p1: {} } } });
    expect(resolveFolderProducts(f, PRODUCTS)).toEqual([
      { id: "p1", product: PRODUCTS.p1, missing: false, name: "Nike Air Max", photo: "u1" },
    ]);
  });

  it("keeps a product that has left the catalogue, flagged rather than dropped", () => {
    // Silently shrinking a folder would hide that something was deleted.
    const [f] = folderList({ f1: { name: "F", createdAt: 1, items: { gone: {} } } });
    const [row] = resolveFolderProducts(f, PRODUCTS);
    expect(row).toMatchObject({ id: "gone", missing: true, product: null });
  });

  it("handles an empty or absent folder", () => {
    expect(resolveFolderProducts(null, PRODUCTS)).toEqual([]);
    expect(resolveFolderProducts({ productIds: [] }, PRODUCTS)).toEqual([]);
  });
});

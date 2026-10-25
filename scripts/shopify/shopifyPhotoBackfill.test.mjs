import { describe, it, expect } from "vitest";
import {
  parseBackfillSnapshot, hamming, dhashFromGrey, linkVerdict, pictureVerdict, sharedPictureConflicts, batchCheck, copyPathFor,
  SAME_MAX, DIFFERENT_MIN, shopifySized,
} from "./shopifyPhotoBackfill.mjs";

const GID = "gid://shopify/Product/9";
const shop = (over = {}) => ({ id: GID, title: "Textured knit runner in black", image: { url: "https://cdn.shopify.com/a.jpg" }, ...over });

describe("parseBackfillSnapshot", () => {
  it("reads id, title and the featured image; a product with no image has image null", () => {
    const m = parseBackfillSnapshot([
      JSON.stringify({ id: GID, title: "T", status: "ACTIVE", featuredMedia: { id: "m", image: { url: "u", width: 1, height: 2 } } }),
      JSON.stringify({ id: "gid://shopify/Product/10", title: "U", status: "DRAFT", featuredMedia: null }),
    ].join("\n"));
    expect(m.get(GID).image).toEqual({ url: "u", width: 1, height: 2 });
    expect(m.get("gid://shopify/Product/10").image).toBe(null);
  });
});

describe("dHash + hamming", () => {
  it("one bit per left/right step; identical pictures are 0 apart", () => {
    const ramp = Uint8Array.from({ length: 72 }, (_, i) => i % 9 * 10);          // brighter to the right → all 0
    const fall = Uint8Array.from({ length: 72 }, (_, i) => 90 - (i % 9) * 10);   // darker to the right → all 1
    expect(dhashFromGrey(ramp)).toBe("0000000000000000");
    expect(dhashFromGrey(fall)).toBe("ffffffffffffffff");
    expect(hamming("0000000000000000", "ffffffffffffffff")).toBe(64);
    expect(hamming("00000000000000ff", "0000000000000000")).toBe(8);
    expect(hamming("x", "0000000000000000")).toBe(null);
  });
  it("the verdict bands: same / uncertain / differs; no app photo → replace", () => {
    const a = "0000000000000000";
    expect(pictureVerdict(a, a).action).toBe("same");
    expect(pictureVerdict(a, "00000000000000ff").action).toBe(SAME_MAX >= 8 ? "same" : "skip");
    expect(pictureVerdict(a, "0000000000000fff")).toMatchObject({ action: "skip", code: "uncertain" }); // 12
    expect(pictureVerdict(a, "000000000000ffff")).toMatchObject({ action: "replace", code: "differs" }); // 16
    expect(pictureVerdict(a, null)).toMatchObject({ action: "replace", code: "app-has-none" });
    expect(pictureVerdict(null, a).action).toBe("skip");
    expect(DIFFERENT_MIN).toBeGreaterThan(SAME_MAX);
  });
});

describe("linkVerdict — matched by Shopify product id, and certainly the same product", () => {
  const product = { id: "p1", name: "Nike Alphafly Black White", photoUrl: "x" };
  it("goes when the claim and the map agree and the Shopify title IS the listing name", () => {
    expect(linkVerdict({ pid: "p1", gid: GID, mappedGid: GID, product, node: { cleanName: "Textured knit runner in black" }, shop: shop() })).toEqual({ go: true });
  });
  it("refuses a claim/map disagreement, a title that is not the listing name, a merged record, no image", () => {
    expect(linkVerdict({ pid: "p1", gid: GID, mappedGid: "gid://shopify/Product/8", product, node: { cleanName: "Textured knit runner in black" }, shop: shop() }).code).toBe("map-mismatch");
    expect(linkVerdict({ pid: "p1", gid: GID, mappedGid: GID, product, node: { cleanName: "Something else" }, shop: shop() }).code).toBe("title-mismatch");
    expect(linkVerdict({ pid: "p1", gid: GID, mappedGid: GID, product: { ...product, mergedInto: "p2" }, node: { cleanName: "x" }, shop: shop() }).code).toBe("merged");
    expect(linkVerdict({ pid: "p1", gid: GID, mappedGid: GID, product, node: {}, shop: shop({ image: null }) }).code).toBe("no-shopify-image");
  });
});

describe("twins — one Shopify picture for two app products goes to neither", () => {
  it("near-identical hashes on two pids are both dropped", () => {
    const drop = sharedPictureConflicts([
      { pid: "a", shopHash: "0000000000000000" }, { pid: "b", shopHash: "0000000000000001" }, { pid: "c", shopHash: "ffffffffffffffff" },
    ]);
    expect([...drop].sort()).toEqual(["a", "b"]);
  });
});

describe("the check after a batch", () => {
  const entry = { pid: "p1", gid: GID, oldUrl: "old", newUrl: "new", shopHash: "0000000000000000" };
  it("clean when the copy is Shopify's picture, the old photo is in history and the link stands", () => {
    expect(batchCheck({ entry, now: { photoUrl: "new", history: { url: "old" }, copyHash: "0000000000000001", mappedGid: GID, claimPid: "p1" } })).toEqual([]);
  });
  it("names a wrong picture, a lost old photo and a moved link", () => {
    const bad = batchCheck({ entry, now: { photoUrl: "other", history: null, copyHash: "ffffffffffffffff", mappedGid: "x", claimPid: "p2" } });
    expect(bad.length).toBe(4);
  });
  it("copies live in OUR bucket under the product's folder", () => {
    expect(copyPathFor("p1", 5, "png")).toBe("products/p1/shopify_backfill/5.png");
    expect(shopifySized("https://cdn.shopify.com/a.jpg?v=1", 256)).toBe("https://cdn.shopify.com/a.jpg?v=1&width=256");
  });
});

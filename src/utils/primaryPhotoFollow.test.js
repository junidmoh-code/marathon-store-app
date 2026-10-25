import { describe, it, expect } from "vitest";
import { shopifyImagesOn, followItems, SHOPIFY_IMAGES_FROM_MS } from "./primaryPhotoFollow.js";

const U = (n) => `https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/products%2Fp1%2Fshopify%2F${n}.jpg?alt=media&token=t`;
const item = (n, type = "photo") => ({ id: `i${n}`, type, url: U(n) });

describe("the switch — catalogue freeze until 28 Oct", () => {
  it("off before 28 Oct 00:00 SAST, on from it; a config date moves it; shopifyImagesOff wins", () => {
    expect(SHOPIFY_IMAGES_FROM_MS).toBe(Date.parse("2026-10-27T22:00:00Z"));
    expect(shopifyImagesOn(SHOPIFY_IMAGES_FROM_MS - 1, null)).toBe(false);
    expect(shopifyImagesOn(SHOPIFY_IMAGES_FROM_MS, null)).toBe(true);
    expect(shopifyImagesOn(SHOPIFY_IMAGES_FROM_MS, { shopifyImagesOff: true })).toBe(false);
    expect(shopifyImagesOn(100, { shopifyImagesFrom: 50 })).toBe(true);
  });
});

describe("followItems — the listing's first photo becomes the app's primary", () => {
  it("a new photo takes the old primary's place; videos and extras stay where they are", () => {
    const out = followItems({ media: [item(1), item(2), item(3, "video")] }, U(9));
    expect(out.map((m) => m.url)).toEqual([U(9), U(2), U(3)]);
    expect(out[0]).toMatchObject({ type: "photo", source: "app" });
  });
  it("a photo already in the list is moved to the front instead", () => {
    expect(followItems({ media: [item(1), item(2)] }, U(2)).map((m) => m.url)).toEqual([U(2), U(1)]);
  });
  it("nothing to do: already first, no own list, a removed photo", () => {
    expect(followItems({ media: [item(1)] }, U(1))).toBeNull();
    expect(followItems({ state: "live" }, U(9))).toBeNull();
    expect(followItems(null, U(9))).toBeNull();
    expect(followItems({ media: [item(1)] }, null)).toBeNull();
  });
});

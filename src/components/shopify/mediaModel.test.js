import { describe, it, expect } from "vitest";
import {
  APP_STORAGE_PREFIX, resolveMediaList, normalizeMediaItems, photoUrlsOf, mediaListProblem,
  shopifyVideoProblem, lazyPhotoItem, mergePhotosIntoMedia, storedMediaKey, mediaPushSig,
  MAX_PUBLISH_MEDIA, SHOPIFY_VIDEO_MAX_BYTES,
} from "./publishShared.js";
import { mediaMutator, appendMediaMutator, photosMutator } from "./publishMutators.js";
import { moveItem, makePrimary, removeItem, replaceItem } from "./mediaEdits.js";
import { rtdbRoundTrip } from "./rtdbRoundTrip.testutil.js";

const U = (n) => `${APP_STORAGE_PREFIX}products%2Fp1%2Fshopify%2F${n}.jpg?alt=media&token=t`;
const V = (n) => `${APP_STORAGE_PREFIX}products%2Fp1%2Fmedia%2F${n}.mp4?alt=media&token=t`;
const SHA = (c) => c.repeat(64);
const photo = (n, extra = {}) => ({ id: `mp${n}`, type: "photo", url: U(n), ...extra });
const video = (n, extra = {}) => ({ id: `mv${n}`, type: "video", url: V(n), posterUrl: U(`poster${n}`),
                                   bytes: 50_000_000, mime: "video/mp4", durationMs: 30_000, width: 1080, height: 1920, ...extra });
const ctx = { now: 1_790_000_000_000, uid: "junid" };
// A mutator's committed node, as the server would hand it back.
const commit = (out) => { expect(out.refusal).toBeUndefined(); return rtdbRoundTrip(out.next); };

describe("the lazy read — no backfill", () => {
  it("a product with only its record photo reads as a one-photo list and writes nothing", () => {
    const product = { photoUrl: U("photo") };
    const r = resolveMediaList(null, product);
    expect(r.source).toBe("record");
    expect(r.items).toEqual([lazyPhotoItem(U("photo"), "record")]);
    // Deterministic ids: the browser and the reconciler name it the same way.
    expect(resolveMediaList(undefined, product).items[0].id).toBe(r.items[0].id);
  });
  it("an old photos-only node reads as its photos, in order", () => {
    const r = resolveMediaList({ photos: [U("a"), U("b")] }, { photoUrl: U("x") });
    expect(r.source).toBe("photos");
    expect(photoUrlsOf(r.items)).toEqual([U("a"), U("b")]);
  });
});

describe("multi-photo + video add", () => {
  it("appends photos and a video to the CURRENT server list and keeps photos as the projection", () => {
    let node = { state: "awaiting" };
    const product = { photoUrl: U("photo") };
    node = commit(appendMediaMutator(node, { items: [photo(1, { sha256: SHA("a") })], product }, ctx));
    node = commit(appendMediaMutator(node, { items: [photo(2, { sha256: SHA("b") })], product }, ctx));
    node = commit(appendMediaMutator(node, { items: [video(1, { sha256: SHA("c") })], product }, ctx));
    const { items, source } = resolveMediaList(node, product);
    expect(source).toBe("media");
    expect(items.map((m) => m.type)).toEqual(["photo", "photo", "photo", "video"]);
    expect(items[0].url).toBe(U("photo")); // the record photo stays primary
    expect(node.photos).toEqual([U("photo"), U(1), U(2)]);
    expect(node.updatedAt).toBe(ctx.now);
  });
  it("refuses the same file twice (by hash) without touching the list", () => {
    const node = { state: "awaiting", media: [photo(1, { sha256: SHA("a") })], photos: [U(1)] };
    const out = appendMediaMutator(node, { items: [photo(9, { sha256: SHA("a") })] }, ctx);
    expect(out.refusal).toMatch(/already/);
  });
  it("has no cap below Shopify's own (250)", () => {
    const many = Array.from({ length: MAX_PUBLISH_MEDIA }, (_, i) => photo(i));
    expect(mediaListProblem(many)).toBeNull();
    expect(mediaListProblem([...many, photo("x")])).toMatch(/250/);
  });
});

describe("position 0 is always a photo", () => {
  it("the store refuses a list with a video first", () => {
    expect(mediaListProblem([video(1), photo(1)])).toMatch(/first item must be a photo/);
    const out = mediaMutator({ state: "awaiting" }, { media: [video(1), photo(1)], basisKey: storedMediaKey({}) }, ctx);
    expect(out.refusal).toMatch(/first item must be a photo/);
  });
  it("a video can never be appended as the first item", () => {
    const out = appendMediaMutator({ state: "awaiting" }, { items: [video(1)], product: {} }, ctx);
    expect(out.refusal).toMatch(/photo first/);
  });
  it("the strip's edits cannot express it: moves, make-primary and removals that would put a video first are null", () => {
    const list = [photo(1), video(1), photo(2)];
    expect(moveItem(list, 1, -1)).toBeNull();        // the video can't move to 0
    expect(moveItem(list, 0, 1)).toBeNull();         // nor can the primary move behind it
    expect(makePrimary(list, 1)).toBeNull();         // no Make primary for a video
    expect(makePrimary(list, 2).map((m) => m.id)).toEqual(["mp2", "mp1", "mv1"]);
    // Removing the primary when a video is next: the next PHOTO becomes primary.
    expect(removeItem(list, 0).map((m) => m.id)).toEqual(["mp2", "mv1"]);
    // The last photo can't go.
    expect(removeItem([photo(1), video(1)], 0)).toBeNull();
    expect(replaceItem(list, U(1), video(9))).toBeNull();
  });
});

describe("removing every extra — with the real database's empty-array deletes", () => {
  it("down to one photo: the list survives the round trip, nothing stale is left", () => {
    let node = rtdbRoundTrip({ state: "awaiting", media: [photo(1), photo(2), video(1)], photos: [U(1), U(2)] });
    let items = resolveMediaList(node, null).items;
    while (items.length > 1) {
      const next = removeItem(items, items.length - 1);
      node = commit(mediaMutator(node, { media: next, basisKey: storedMediaKey(node) }, ctx));
      items = resolveMediaList(node, null).items;
    }
    expect(items.map((m) => m.id)).toEqual(["mp1"]);
    expect(node.media).toHaveLength(1);
    expect(node.photos).toEqual([U(1)]);
    // An empty mediaShopify map written by the reconciler would simply vanish:
    expect(rtdbRoundTrip({ ...node, mediaShopify: {} }).mediaShopify).toBeUndefined();
  });
  it("a list that came back with a HOLE (object shape) still reads in order", () => {
    const holed = rtdbRoundTrip({ media: { 0: photo(1), 2: video(1), 5: photo(2) } });
    expect(Array.isArray(holed.media)).toBe(false); // sparse → object, like RTDB
    expect(normalizeMediaItems(holed.media).map((m) => m.id)).toEqual(["mp1", "mv1", "mp2"]);
  });
});

describe("optimistic concurrency", () => {
  it("an edit computed from a stale screen is refused", () => {
    const seen = { state: "awaiting", media: [photo(1), photo(2)], photos: [U(1), U(2)] };
    const server = { ...seen, media: [photo(1), photo(2), photo(3)], photos: [U(1), U(2), U(3)] };
    const out = mediaMutator(server, { media: [photo(2), photo(1)], basisKey: storedMediaKey(seen) }, ctx);
    expect(out.refusal).toMatch(/another session/);
  });
  it("edits are allowed while the listing is ON (the reconciler carries them)", () => {
    const on = { state: "live", liveState: "on", desiredState: "on", media: [photo(1), photo(2)], photos: [U(1), U(2)] };
    const out = mediaMutator(on, { media: [photo(2), photo(1)], basisKey: storedMediaKey(on) }, ctx);
    expect(out.next.photos).toEqual([U(2), U(1)]);
  });
});

describe("a photos-only writer (New Arrivals chain, an old bundle) never strands the media list", () => {
  it("photosMutator keeps videos in place and the first item a photo", () => {
    const base = { state: "awaiting", media: [photo(1), video(1), photo(2)], photos: [U(1), U(2)] };
    const out = photosMutator(base, { photos: [U("gen")], basisPhotos: base.photos }, ctx);
    expect(out.next.media.map((m) => m.type)).toEqual(["photo", "video"]);
    expect(out.next.media[0].url).toBe(U("gen"));
  });
  it("an OLD writer that only rewrote photos is merged on read", () => {
    const node = { media: [photo(1), video(1), photo(2)], photos: [U(2), U(1)] };
    const r = resolveMediaList(node, null);
    expect(r.source).toBe("merged");
    expect(r.items.map((m) => m.id)).toEqual(["mp2", "mv1", "mp1"]);
    expect(mergePhotosIntoMedia([video(1), photo(1)], [U(1)])[0].type).toBe("photo");
  });
});

describe("oversize video: kept, never pushed", () => {
  it("over 1 GB, over 10 minutes, over 4K or an unknown format is named, and leaves the push signature", () => {
    expect(shopifyVideoProblem(video(1, { bytes: SHOPIFY_VIDEO_MAX_BYTES + 1 }))).toMatch(/too large for Shopify/);
    expect(shopifyVideoProblem(video(1, { durationMs: 11 * 60_000 }))).toMatch(/too long/);
    expect(shopifyVideoProblem(video(1, { width: 7680, height: 4320 }))).toMatch(/4K/);
    expect(shopifyVideoProblem(video(1, { mime: "video/x-msvideo" }))).toMatch(/format/);
    expect(shopifyVideoProblem(video(1))).toBeNull();
    const big = video(2, { bytes: 2_000_000_000 });
    expect(mediaPushSig([photo(1), big])).toBe(mediaPushSig([photo(1)]));
    // ...but it stays in the list itself.
    expect(mediaListProblem([photo(1), big])).toBeNull();
  });
});

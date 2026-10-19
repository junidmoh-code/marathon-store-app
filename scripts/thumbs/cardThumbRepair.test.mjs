import { describe, it, expect } from "vitest";
import { thumbVerdict, runRepair, SAME_PICTURE_MAX } from "./cardThumbRepair.mjs";

const B = "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/";
const url = (path) => `${B}${encodeURIComponent(path)}?alt=media&token=t`;
const inBucket = (u) => u.startsWith(B);
const each = async (items, fn) => { for (const i of items) await fn(i); };

describe("thumbVerdict", () => {
  it("no photo / external / missing / recorded source / photo.jpg's own / unknown origin", () => {
    expect(thumbVerdict("a", null, null, inBucket).verdict).toBe("no-photo");
    expect(thumbVerdict("a", "https://cdn.shopify.com/x.jpg", null, inBucket).verdict).toBe("external");
    expect(thumbVerdict("a", url("products/a/shopify/gen.jpg"), null, inBucket).verdict).toBe("missing");
    expect(thumbVerdict("a", url("products/a/shopify/gen.jpg"), { metadata: { thumbSourceObject: "products/a/shopify/gen.jpg" } }, inBucket).verdict).toBe("ok");
    expect(thumbVerdict("a", url("products/a/photo.jpg"), {}, inBucket).verdict).toBe("ok");
    expect(thumbVerdict("a", url("products/a/photo_reframed_x.jpg"), {}, inBucket).verdict).toBe("check");
    // a thumbnail recorded from ANOTHER object is checked, even for photo.jpg
    expect(thumbVerdict("a", url("products/a/photo.jpg"), { metadata: { thumbSourceObject: "products/a/shopify/old.jpg" } }, inBucket).verdict).toBe("check");
  });
});

describe("runRepair", () => {
  const setup = () => {
    const photo = { a: url("products/a/photo_reframed_x.jpg"), b: url("products/b/photo_reframed_y.jpg"), c: url("products/c/shopify/gen.jpg"), d: url("products/d/photo.jpg") };
    const meta = { a: {}, b: {}, d: {} };
    const diffs = { a: 100, b: 2 };
    const log = [];
    const io = { readPhotoUrl: async (p) => photo[p] ?? null, thumbMetaOf: (p) => meta[p] ?? null, inBucket, looksLike: async (p) => diffs[p] };
    const write = { rebuildThumb: async (p, u) => { log.push(["thumb", p, u]); return { ok: true }; }, stamp: async (p) => log.push(["stamp", p]) };
    return { photo, io, write, log };
  };
  it("dry run: classifies and writes nothing", async () => {
    const { io, log } = setup();
    const { counts } = await runRepair(["a", "b", "c", "d"], io, { each });
    expect(counts).toMatchObject({ stale: 1, "same-picture": 1, missing: 1, ok: 1, repaired: 0 });
    expect(log).toEqual([]);
    expect(SAME_PICTURE_MAX).toBeLessThan(100);
  });
  it("commit: the stale and the missing are rebuilt FROM photoUrl, then stamped (thumbnail before the marker); the rest untouched", async () => {
    const { io, write, log, photo } = setup();
    const ledger = [];
    const { counts } = await runRepair(["a", "b", "c", "d"], io, { each, write, onRepaired: async (e) => ledger.push(e.pid) });
    expect(counts.repaired).toBe(2);
    expect(log).toEqual([["thumb", "a", photo.a], ["stamp", "a"], ["thumb", "c", photo.c], ["stamp", "c"]]);
    expect(ledger).toEqual(["a", "c"]);
  });
  it("a thumbnail that cannot be built is NOT stamped (devices would fetch nothing new) and is counted failed", async () => {
    const { io, write, log } = setup();
    write.rebuildThumb = async () => ({ ok: false, reason: "no webp" });
    const { counts } = await runRepair(["a"], io, { each, write });
    expect(counts).toMatchObject({ failed: 1, repaired: 0 });
    expect(log).toEqual([]);
  });
});

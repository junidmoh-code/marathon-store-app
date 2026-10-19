import { describe, it, expect } from "vitest";
import { thumbVerdict, runRepair } from "./cardThumbRepair.mjs";

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
    expect(thumbVerdict("a", url("products/a/photo_reframed_x.jpg"), {}, inBucket).verdict).toBe("unproven");
    // a thumbnail recorded from ANOTHER object is checked, even for photo.jpg
    expect(thumbVerdict("a", url("products/a/photo.jpg"), { metadata: { thumbSourceObject: "products/a/shopify/old.jpg" } }, inBucket).verdict).toBe("unproven");
  });
});

describe("runRepair", () => {
  const setup = () => {
    const photo = { a: url("products/a/photo_reframed_x.jpg"), b: url("products/b/photo_reframed_y.jpg"), c: url("products/c/shopify/gen.jpg"), d: url("products/d/photo.jpg") };
    const meta = { a: {}, b: {}, d: {} };
    const log = [];
    const io = { readPhotoUrl: async (p) => photo[p] ?? null, thumbMetaOf: (p) => meta[p] ?? null, inBucket, looksLike: async () => 2 };
    const write = { rebuildThumb: async (p, u) => { log.push(["thumb", p, u]); return { ok: true }; }, stamp: async (p) => log.push(["stamp", p]) };
    return { photo, io, write, log };
  };
  it("dry run: classifies and writes nothing", async () => {
    const { io, log } = setup();
    const { counts } = await runRepair(["a", "b", "c", "d"], io, { each });
    expect(counts).toMatchObject({ unproven: 2, missing: 1, ok: 1, repaired: 0 });
    expect(log).toEqual([]);
  });
  it("commit: EVERY unproven thumbnail (even one whose pixels look alike) and every missing one is rebuilt FROM photoUrl, then stamped", async () => {
    const { io, write, log, photo } = setup();
    const ledger = [];
    const { counts } = await runRepair(["a", "b", "c", "d"], io, { each, write, onRepaired: async (e) => ledger.push(e.pid) });
    expect(counts.repaired).toBe(3);
    expect(log).toEqual([["thumb", "a", photo.a], ["stamp", "a"], ["thumb", "b", photo.b], ["stamp", "b"], ["thumb", "c", photo.c], ["stamp", "c"]]);
    expect(ledger).toEqual(["a", "b", "c"]);
  });
  it("a thumbnail that cannot be built is NOT stamped (devices would fetch nothing new) and is counted failed", async () => {
    const { io, write, log } = setup();
    write.rebuildThumb = async () => ({ ok: false, reason: "no webp" });
    const { counts } = await runRepair(["a"], io, { each, write });
    expect(counts).toMatchObject({ failed: 1, repaired: 0 });
    expect(log).toEqual([]);
  });
  it("RE-SHOOT DURING THE REPAIR: rebuilt again from the NEW photo before the stamp", async () => {
    const { io, write, log, photo } = setup();
    const fresh = url("products/a/photo_reframed_new.jpg");
    write.rebuildThumb = async (p, u) => { log.push(["thumb", p, u]); photo.a = fresh; return { ok: true }; };
    const { counts } = await runRepair(["a"], io, { each, write });
    expect(counts).toMatchObject({ moved: 1, repaired: 1 });
    expect(log.map((x) => x[2] ?? x[0])).toEqual([url("products/a/photo_reframed_x.jpg"), fresh, "stamp"]);
  });
  it("a product (or photo) gone during the repair is never stamped — no ghost {thumbAt} node", async () => {
    const { io, write, log, photo } = setup();
    write.rebuildThumb = async (p, u) => { log.push(["thumb", p, u]); delete photo.c; return { ok: true }; };
    const { counts } = await runRepair(["c"], io, { each, write });
    expect(counts).toMatchObject({ repaired: 0, failed: 0 });
    expect(log.some((x) => x[0] === "stamp")).toBe(false);
  });
});

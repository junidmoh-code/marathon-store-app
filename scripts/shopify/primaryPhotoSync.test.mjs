import { describe, it, expect } from "vitest";
import { classify, buildOwnersByMd5, runSync, rollbackEntry, ownerPidOf } from "./primaryPhotoSync.mjs";

const B = "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/";
const url = (path, t = "t") => `${B}${encodeURIComponent(path)}?alt=media&token=${t}`;
const staff = (pid) => url(`products/${pid}/photo.jpg`);
const pub = (pid, n) => url(`products/${pid}/shopify/${n}.jpg`);

// A fake RTDB that behaves like the real one where it matters: null deletes
// the child, and an object left with no children (an emptied array too) is
// removed from its parent.
function fakeDb(init) {
  const root = structuredClone(init);
  const prune = (o) => {
    if (!o || typeof o !== "object") return o;
    for (const k of Object.keys(o)) {
      o[k] = prune(o[k]);
      if (o[k] == null || (typeof o[k] === "object" && Object.keys(o[k]).length === 0)) delete o[k];
    }
    return o;
  };
  const get = (path) => path.split("/").reduce((o, k) => (o == null ? undefined : o[k]), root);
  return {
    root,
    get,
    update(path, patch) {
      const parts = path.split("/");
      let o = root;
      for (const k of parts) { o[k] ??= {}; o = o[k]; }
      for (const [k, v] of Object.entries(patch)) o[k] = v === null ? undefined : structuredClone(v);
      prune(root);
    },
  };
}

function io(db, md5ByPath, objects = []) {
  const pathOf = (u) => { const m = /\/o\/([^?]+)/.exec(u); return m ? decodeURIComponent(m[1]) : null; };
  const md5Calls = [];
  return {
    md5Calls,
    readNode: async (pid) => ({ media: db.get(`shopify_publish/${pid}/media`) ?? null, photos: db.get(`shopify_publish/${pid}/photos`) ?? null }),
    readProduct: async (pid) => {
      const p = db.get(`products/${pid}`);
      return { exists: !!p, photoUrl: p?.photoUrl ?? null, photoUrlOriginal: p?.photoUrlOriginal ?? null, photoSource: p?.photoSource ?? null };
    },
    md5Of: async (u) => { md5Calls.push(u); return md5ByPath[pathOf(u)] ?? null; },
    ownersByMd5: buildOwnersByMd5(objects.length ? objects : Object.entries(md5ByPath).map(([name, md5Hash]) => ({ name, md5Hash }))),
  };
}
const writeDeps = (db, log = []) => ({
  now: () => 1_790_000_000_000,
  rebuildThumb: async (pid, u) => { log.push(["thumb", pid, u]); return { ok: true }; },
  writeProduct: async (pid, patch) => { log.push(["write", pid]); db.update(`products/${pid}`, patch); },
});

describe("classify", () => {
  const owners = buildOwnersByMd5([{ name: "products/p2/photo.jpg", md5Hash: "SHARED" }, { name: "products/p1/thumb_300.webp", md5Hash: "T" }]);
  const md5 = (m) => (u) => m[u] ?? null;
  it("no product / no own list / same URL / same md5 / replace", () => {
    expect(classify({ pid: "p1", exists: false }).verdict).toBe("no-product");
    expect(classify({ pid: "p1", exists: true, node: { state: "live" }, product: { photoUrl: staff("p1") }, md5: md5({}), ownersByMd5: owners }).verdict).toBe("no-shopify-primary");
    expect(classify({ pid: "p1", exists: true, node: { photos: [staff("p1")] }, product: { photoUrl: staff("p1") }, md5: md5({}), ownersByMd5: owners })).toMatchObject({ verdict: "matching", by: "url" });
    expect(classify({ pid: "p1", exists: true, node: { photos: [pub("p1", "a")] }, product: { photoUrl: staff("p1") },
                      md5: md5({ [pub("p1", "a")]: "X", [staff("p1")]: "X" }), ownersByMd5: owners })).toMatchObject({ verdict: "matching", by: "md5" });
    expect(classify({ pid: "p1", exists: true, node: { photos: [pub("p1", "a")] }, product: { photoUrl: staff("p1") },
                      md5: md5({ [pub("p1", "a")]: "X", [staff("p1")]: "Y" }), ownersByMd5: owners }).verdict).toBe("replace");
  });
  it("SHARED: the primary's content is another product's photo, or the object lives in another product's folder", () => {
    expect(classify({ pid: "p1", exists: true, node: { photos: [pub("p1", "a")] }, product: { photoUrl: staff("p1") },
                      md5: md5({ [pub("p1", "a")]: "SHARED" }), ownersByMd5: owners })).toMatchObject({ verdict: "shared", others: ["p2"] });
    expect(classify({ pid: "p1", exists: true, node: { photos: [pub("p9", "a")] }, product: { photoUrl: staff("p1") },
                      md5: md5({ [pub("p9", "a")]: "Z" }), ownersByMd5: owners })).toMatchObject({ verdict: "shared", others: ["p9"] });
  });
  it("a primary whose object is gone from the bucket is never synced", () => {
    expect(classify({ pid: "p1", exists: true, node: { photos: [pub("p1", "gone")] }, product: { photoUrl: staff("p1") },
                      md5: md5({}), ownersByMd5: owners }).verdict).toBe("primary-missing");
  });
  it("thumbnails never count as a product's photo", () => {
    expect(ownerPidOf("products/p1/thumb_300.webp")).toBe("p1");
    expect(ownerPidOf("products/_intake/009605100/p1792064556733.jpg")).toBe("p1792064556733");
    expect(ownerPidOf("products/_other/x.jpg")).toBeNull();
    const o = buildOwnersByMd5([{ name: "products/_intake/c/p1.jpg", md5Hash: "I" }, { name: "products/p1/photo.jpg", md5Hash: "I" }]);
    expect([...o.get("I")]).toEqual(["p1"]); // its own intake copy is not "another product"
    expect(owners.get("T")).toBeUndefined();
  });
});

describe("runSync — the backfill, through the ONE write", () => {
  const seed = () => fakeDb({
    shopify_publish: {
      a: { media: [{ id: "m1", type: "photo", url: pub("a", "1") }], photos: [pub("a", "1")] },   // replace
      b: { photos: [staff("b")] },                                                                // matching (url)
      c: { state: "live" },                                                                       // no own list
      d: { photos: [pub("d", "1")] },                                                             // product gone
      e: { photos: [pub("e", "1")] },                                                             // shared with f
    },
    products: {
      a: { name: "A", photoUrl: staff("a"), styleCodeNormalised: "AAA" },
      b: { name: "B", photoUrl: staff("b") },
      c: { name: "C", photoUrl: staff("c") },
      e: { name: "E", photoUrl: staff("e") },
      f: { name: "F", photoUrl: staff("f") },
    },
  });
  const md5s = { "products/a/photo.jpg": "A0", "products/a/shopify/1.jpg": "A1", "products/b/photo.jpg": "B0",
                 "products/c/photo.jpg": "C0", "products/d/shopify/1.jpg": "D1", "products/e/photo.jpg": "E0",
                 "products/e/shopify/1.jpg": "F0", "products/f/photo.jpg": "F0" };

  it("dry run: counts every verdict and writes NOTHING", async () => {
    const db = seed();
    const before = structuredClone(db.root);
    const { counts } = await runSync(["a", "b", "c", "d", "e"], io(db, md5s));
    expect(counts).toMatchObject({ total: 5, replace: 1, matching: 1, "no-shopify-primary": 1, "no-product": 1, shared: 1, replaced: 0, failed: 0 });
    expect(db.root).toEqual(before);
  });
  it("commit: the replaced product gets the core's patch (photoUrl, staff original, photoSource), thumbnail first; the ledger gets its before-state; nothing else moves", async () => {
    const db = seed();
    const log = [], ledger = [];
    const { counts } = await runSync(["a", "b", "c", "d", "e"], io(db, md5s), { write: writeDeps(db, log), onReplaced: async (e) => ledger.push(e) });
    expect(counts).toMatchObject({ replaced: 1, failed: 0 });
    expect(db.get("products/a")).toEqual({ name: "A", styleCodeNormalised: "AAA", photoUrl: pub("a", "1"), photoUrlOriginal: staff("a"),
                                           photoSource: { from: "shopify_publish", at: 1_790_000_000_000 } });
    expect(log).toEqual([["thumb", "a", pub("a", "1")], ["write", "a"]]);
    expect(db.get("products/d")).toBeUndefined(); // a gone product is never given a record
    expect(db.get("products/e/photoUrl")).toBe(staff("e")); // shared: skipped
    expect(ledger).toEqual([expect.objectContaining({ pid: "a", oldPhotoUrl: staff("a"), oldPath: "products/a/photo.jpg",
                                                      oldPhotoUrlOriginal: null, newPhotoUrl: pub("a", "1"), newPath: "products/a/shopify/1.jpg" })]);
  });
  it("IDEMPOTENT: a rerun finds the synced product matching and writes nothing", async () => {
    const db = seed();
    await runSync(["a"], io(db, md5s), { write: writeDeps(db) });
    const log = [];
    const { counts } = await runSync(["a"], io(db, md5s), { write: writeDeps(db, log) });
    expect(counts).toMatchObject({ matching: 1, replace: 0, replaced: 0 });
    expect(log).toEqual([]);
  });
  it("a failed product write is counted and the run goes on", async () => {
    const db = seed();
    db.root.shopify_publish.g = { photos: [pub("g", "1")] };
    db.root.products.g = { photoUrl: staff("g") };
    const w = { ...writeDeps(db), writeProduct: async (pid, patch) => { if (pid === "a") throw new Error("denied"); db.update(`products/${pid}`, patch); } };
    const { counts } = await runSync(["a", "g"], io(db, { ...md5s, "products/g/shopify/1.jpg": "G1", "products/g/photo.jpg": "G0" }), { write: w, concurrency: 1 });
    expect(counts).toMatchObject({ replace: 2, replaced: 1, failed: 1 });
    expect(db.get("products/g/photoUrl")).toBe(pub("g", "1"));
  });
});

describe("rollbackEntry", () => {
  it("restores the before-state; fields the sync created are DELETED (RTDB null), not left behind", async () => {
    const db = fakeDb({ shopify_publish: { a: { photos: [pub("a", "1")] } }, products: { a: { name: "A", photoUrl: staff("a") } } });
    const ledger = [];
    await runSync(["a"], io(db, { "products/a/photo.jpg": "A0", "products/a/shopify/1.jpg": "A1" }), { write: writeDeps(db), onReplaced: async (e) => ledger.push(e) });
    const x = io(db, {});
    const r = await rollbackEntry(ledger[0], { readProduct: x.readProduct, writeProduct: async (pid, p) => db.update(`products/${pid}`, p), apply: true });
    expect(r.ok).toBe(true);
    expect(db.get("products/a")).toEqual({ name: "A", photoUrl: staff("a") });
  });
  it("REFUSES when the app photo changed since the sync, and a dry run writes nothing", async () => {
    const db = fakeDb({ products: { a: { photoUrl: pub("a", "later") } } });
    const x = io(db, {});
    const writes = [];
    const entry = { pid: "a", oldPhotoUrl: staff("a"), newPhotoUrl: pub("a", "1") };
    const r = await rollbackEntry(entry, { readProduct: x.readProduct, writeProduct: async (...a) => writes.push(a), apply: true });
    expect(r).toMatchObject({ ok: false, refused: expect.stringMatching(/changed since the sync/) });
    db.root.products.a.photoUrl = pub("a", "1");
    const dry = await rollbackEntry(entry, { readProduct: x.readProduct, writeProduct: async (...a) => writes.push(a) });
    expect(dry).toMatchObject({ ok: true, dryRun: true });
    expect(writes).toEqual([]);
  });
  it("REFUSES when photoUrlOriginal or photoSource changed since the sync, whatever the key order RTDB returns", async () => {
    const entry = { pid: "a", oldPhotoUrl: staff("a"), newPhotoUrl: pub("a", "1"),
                    patch: { photoUrl: pub("a", "1"), photoUrlOriginal: staff("a"), photoSource: { from: "shopify_publish", at: 5 } } };
    const synced = { photoUrl: pub("a", "1"), photoUrlOriginal: staff("a"), photoSource: { at: 5, from: "shopify_publish" } };
    const run = (product) => rollbackEntry(entry, { readProduct: io(fakeDb({ products: { a: product } }), {}).readProduct, writeProduct: async () => {} });
    expect(await run(synced)).toMatchObject({ ok: true });
    expect(await run({ ...synced, photoUrlOriginal: staff("b") })).toMatchObject({ ok: false, refused: expect.stringMatching(/photoUrlOriginal has changed/) });
    expect(await run({ ...synced, photoSource: { at: 9, from: "shopify_publish" } })).toMatchObject({ ok: false, refused: expect.stringMatching(/photoSource has changed/) });
  });
  it("THUMBNAIL: rebuilt from the old photo before photoUrl moves back; removed (before the write) when the rebuild fails or there is no old photo", async () => {
    for (const [oldPhotoUrl, rebuilt, want] of [[staff("a"), true, ["thumb", "write"]], [staff("a"), false, ["thumb", "remove", "write"]], [null, true, ["remove", "write"]]]) {
      const db = fakeDb({ products: { a: { photoUrl: pub("a", "1") } } });
      const log = [];
      const r = await rollbackEntry({ pid: "a", oldPhotoUrl, newPhotoUrl: pub("a", "1") }, {
        readProduct: io(db, {}).readProduct, apply: true,
        rebuildThumb: async () => { log.push("thumb"); return { ok: rebuilt }; },
        removeThumb: async () => { log.push("remove"); },
        writeProduct: async () => { log.push("write"); },
      });
      expect(log).toEqual(want);
      expect(r.thumb).toBe(!!oldPhotoUrl && rebuilt);
    }
  });
});

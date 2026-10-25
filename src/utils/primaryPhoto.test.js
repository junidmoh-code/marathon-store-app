import { describe, it, expect } from "vitest";
import {
  primaryPhotoUrl, primaryThumbUrl, storagePathOfUrl, photoHistoryEntries, primaryPhotoPatch, undoTarget, undoPhotoPatch,
} from "./primaryPhoto.js";
import { setPrimaryPhoto, undoPrimaryPhoto } from "./setPrimaryPhoto.js";

const B = "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/";
const url = (path, tok = "t1") => `${B}${encodeURIComponent(path)}?alt=media&token=${tok}`;
const STAFF = url("products/p1/photo.jpg");
const SHOP = url("products/p1/shopify/a.jpg");

describe("primaryPhotoUrl — the one field", () => {
  it("is photoUrl, else a legacy `photo` that is a real image URL, else null", () => {
    expect(primaryPhotoUrl({ photoUrl: STAFF, photo: "👟" })).toBe(STAFF);
    expect(primaryPhotoUrl({ photo: "https://x/y.jpg" })).toBe("https://x/y.jpg");
    expect(primaryPhotoUrl({ photo: "👟" })).toBe(null);
    expect(primaryPhotoUrl(null)).toBe(null);
  });
});

describe("primaryThumbUrl — list screens", () => {
  it("points at the product's own thumb_300.webp, tagged by the photo marker", () => {
    const t = primaryThumbUrl({ id: "p1", photoUrl: SHOP });
    expect(storagePathOfUrl(t)).toBe("products/p1/thumb_300.webp");
    expect(t).toMatch(/alt=media&v=[0-9a-z]+$/);
    // A new photo → a new URL, so no cache can answer with the old picture.
    expect(primaryThumbUrl({ id: "p1", photoUrl: STAFF })).not.toBe(t);
  });
  it("is null for a photo that lives in ANOTHER product's folder (never a stranger's thumbnail)", () => {
    expect(primaryThumbUrl({ id: "p1", photoUrl: url("products/p2/photo.jpg") })).toBe(null);
    expect(primaryThumbUrl({ id: "p1", photoUrl: "https://cdn.shopify.com/x.jpg" })).toBe(null);
    expect(primaryThumbUrl({ id: "p1" })).toBe(null);
    expect(primaryThumbUrl({ photoUrl: STAFF })).toBe(null); // no id → no thumb
  });
});

describe("history + patch", () => {
  it("records the replaced photo under an epoch-ms key and never deletes anything", () => {
    const patch = primaryPhotoPatch("p1", { photoUrl: STAFF }, SHOP, { at: 1000, by: "u1", source: "edit" });
    expect(patch).toEqual({
      photoUrl: SHOP, photoSource: { from: "edit", at: 1000 },
      "photoHistory/1000": { url: STAFF, at: 1000, by: "u1", source: "edit", replacedWith: SHOP },
    });
  });
  it("no change → null; no clock → null; removal records the photo removed", () => {
    expect(primaryPhotoPatch("p1", { photoUrl: STAFF }, STAFF, { at: 1, source: "edit" })).toBe(null);
    expect(primaryPhotoPatch("p1", { photoUrl: STAFF }, SHOP, { at: null, source: "edit" })).toBe(null);
    expect(primaryPhotoPatch("p1", { photoUrl: STAFF }, null, { at: 5, source: "edit" })["photoHistory/5"].url).toBe(STAFF);
  });
  it("undo restores the newest photo not already undone, and is itself undoable", () => {
    const p = { photoUrl: SHOP, photoHistory: {
      1000: { url: STAFF, at: 1000, replacedWith: SHOP }, 900: { url: url("products/p1/old.jpg"), at: 900 },
    } };
    expect(photoHistoryEntries(p).map((e) => e.key)).toEqual(["1000", "900"]);
    expect(undoTarget(p).url).toBe(STAFF);
    const u = undoPhotoPatch("p1", p, { at: 2000, by: "u" });
    expect(u.patch.photoUrl).toBe(STAFF);
    expect(u.patch["photoHistory/2000"]).toMatchObject({ url: SHOP, source: "undo", replacedWith: STAFF });
    expect(u.patch["photoHistory/1000/undoneAt"]).toBe(2000);
    // After the undo, the next undo brings SHOP back (the 2000 entry), not the older 900 one.
    const after = { photoUrl: STAFF, photoHistory: { ...p.photoHistory, 1000: { ...p.photoHistory[1000], undoneAt: 2000 }, 2000: u.patch["photoHistory/2000"] } };
    expect(undoTarget(after).url).toBe(SHOP);
    expect(undoPhotoPatch("p1", { photoUrl: STAFF }, { at: 3 })).toBe(null); // nothing to undo
  });
});

// ── setPrimaryPhoto against a fake record that applies update() the way RTDB does ──
function world(product) {
  const rec = JSON.parse(JSON.stringify(product));
  const log = [];
  const setPath = (obj, path, v) => {
    const parts = path.split("/"); let o = obj;
    for (const k of parts.slice(0, -1)) { o[k] = o[k] && typeof o[k] === "object" ? o[k] : {}; o = o[k]; }
    if (v === null) delete o[parts.at(-1)]; else o[parts.at(-1)] = v;
  };
  const deps = {
    now: () => 5000,
    readProduct: async () => ({ photoUrl: rec.photoUrl ?? null, photo: rec.photo ?? null, photoHistory: rec.photoHistory ?? null }),
    archiveObject: async (pid, path, at) => { log.push(["archive", path]); return url(`products/${pid}/history/${at}.jpg`, "a"); },
    rebuildThumb: async (pid, u) => { log.push(["thumb", u]); return { ok: true }; },
    removeThumb: async () => { log.push(["rmthumb"]); },
    writeProduct: async (pid, patch) => { log.push(["write"]); for (const [k, v] of Object.entries(patch)) setPath(rec, k, v); },
  };
  return { rec, log, deps };
}

describe("setPrimaryPhoto — the one write", () => {
  it("a re-shoot over photo.jpg archives the object FIRST, re-points history at the copy, thumb before write", async () => {
    const w = world({ photoUrl: STAFF, photoHistory: { 100: { url: STAFF, at: 100 } } });
    const NEW = url("products/p1/photo.jpg", "t2");
    const r = await setPrimaryPhoto("p1", { product: {}, produce: async () => { w.log.push(["upload"]); return NEW; }, overwrites: "products/p1/photo.jpg", source: "edit", by: "u" }, w.deps);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(w.log.map((l) => l[0])).toEqual(["archive", "upload", "thumb", "write"]);
    const copy = url("products/p1/history/5000.jpg", "a");
    expect(w.rec.photoUrl).toBe(NEW);
    expect(w.rec.photoHistory[5000]).toMatchObject({ url: copy, replacedWith: NEW, source: "edit" });
    expect(w.rec.photoHistory[100].url).toBe(copy); // the older pointer at photo.jpg now finds the old picture
  });
  it("refuses to overwrite when the archive fails — nothing uploaded, nothing written", async () => {
    const w = world({ photoUrl: STAFF });
    w.deps.archiveObject = async () => { throw new Error("denied"); };
    let uploaded = false;
    const r = await setPrimaryPhoto("p1", { product: {}, produce: async () => { uploaded = true; return "x"; }, overwrites: "products/p1/photo.jpg", source: "edit" }, w.deps);
    expect(r.ok).toBe(false);
    expect(uploaded).toBe(false);
    expect(w.rec.photoUrl).toBe(STAFF);
  });
  it("a failed write puts the old thumbnail back", async () => {
    const w = world({ photoUrl: STAFF });
    w.deps.writeProduct = async () => { throw new Error("rules"); };
    const r = await setPrimaryPhoto("p1", { product: {}, newUrl: SHOP, source: "ai_studio" }, w.deps);
    expect(r.ok).toBe(false);
    expect(w.log).toEqual([["thumb", SHOP], ["thumb", STAFF]]);
  });
  it("removing the photo writes first, then drops the stale thumbnail", async () => {
    const w = world({ photoUrl: STAFF });
    await setPrimaryPhoto("p1", { product: {}, newUrl: null, source: "edit" }, w.deps);
    expect(w.log.map((l) => l[0])).toEqual(["write", "rmthumb"]);
    expect(w.rec.photoUrl).toBeUndefined();
    expect(w.rec.photoHistory[5000].url).toBe(STAFF);
  });
  it("same content (md5) is no change", async () => {
    const w = world({ photoUrl: STAFF });
    w.deps.md5Of = async () => "same";
    expect((await setPrimaryPhoto("p1", { product: {}, newUrl: SHOP, source: "edit" }, w.deps)).reason).toBe("same-content");
  });
  it("undo restores the previous photo with its thumbnail", async () => {
    const w = world({ photoUrl: SHOP, photoHistory: { 1000: { url: STAFF, at: 1000 } } });
    const r = await undoPrimaryPhoto("p1", { product: {} }, w.deps);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(w.rec.photoUrl).toBe(STAFF);
    expect(w.log[0]).toEqual(["thumb", STAFF]);
    expect(w.rec.photoHistory[1000].undoneAt).toBe(5000);
    expect(w.rec.photoHistory[5000].url).toBe(SHOP);
  });
});

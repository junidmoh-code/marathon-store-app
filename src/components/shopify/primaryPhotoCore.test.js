import { describe, it, expect } from "vitest";
import { appPhotoPatch, setShopifyPrimaryPhoto, storedPrimaryOf, isStaffPhoto, PHOTO_SOURCE_FROM } from "./primaryPhotoCore.js";

const B = "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/";
const staff = `${B}products%2Fp1%2Fphoto.jpg?alt=media&token=a`;
const pub = (n) => `${B}products%2Fp1%2Fshopify%2F${n}.jpg?alt=media&token=b`;
const legacy = `${B}legacy%2Fp1.jpg?alt=media&token=c`;

function fakeDeps({ md5 = {}, failWrite = false } = {}) {
  const log = [];
  return {
    log,
    now: () => 1_790_000_000_000,
    md5Of: async (u) => md5[u] ?? null,
    rebuildThumb: async (pid, url) => { log.push(["thumb", pid, url]); return { ok: true }; },
    writeProduct: async (pid, patch) => {
      if (failWrite) throw new Error("PERMISSION_DENIED");
      log.push(["write", pid, patch]);
    },
  };
}

describe("appPhotoPatch — the /products child patch", () => {
  it("a changed primary writes photoUrl, keeps the STAFF photo as the original, and stamps photoSource", () => {
    expect(appPhotoPatch("p1", { photoUrl: staff, styleCodeNormalised: "X" }, staff, pub("new"), { at: 5 })).toEqual({
      photoUrl: pub("new"), photoUrlOriginal: staff, photoSource: { from: PHOTO_SOURCE_FROM, at: 5 },
    });
  });
  it("an original already kept is never overwritten by a swap between publishing photos", () => {
    expect(appPhotoPatch("p1", { photoUrl: pub("a"), photoUrlOriginal: staff }, pub("a"), pub("b"), { at: 5 }))
      .toEqual({ photoUrl: pub("b"), photoSource: { from: PHOTO_SOURCE_FROM, at: 5 } });
  });
  it("a re-shoot after a swap replaces the kept original with the photo the product shows now", () => {
    const reshot = `${B}products%2Fp1%2Fphoto.jpg?alt=media&token=z`;
    expect(appPhotoPatch("p1", { photoUrl: reshot, photoUrlOriginal: staff }, null, pub("b")).photoUrlOriginal).toBe(reshot);
  });
  it("an older record's photo stored elsewhere is kept as the original — never lost", () => {
    expect(appPhotoPatch("p1", { photoUrl: legacy }, null, pub("b")).photoUrlOriginal).toBe(legacy);
  });
  it("a publishing photo is never recorded as the original", () => {
    expect(appPhotoPatch("p1", { photoUrl: pub("a") }, null, pub("b"))).toEqual({ photoUrl: pub("b") });
  });
  it("no change: same primary, the app already shows it, no primary", () => {
    expect(appPhotoPatch("p1", { photoUrl: staff }, staff, staff)).toBeNull();
    expect(appPhotoPatch("p1", { photoUrl: pub("a") }, null, pub("a"))).toBeNull();
    expect(appPhotoPatch("p1", { photoUrl: staff }, staff, null)).toBeNull();
  });
  it("EMPTY-PID GUARD: no product id → no patch, never a path at the products root", () => {
    for (const bad of ["", null, undefined, "a/b", "p1.x"]) expect(appPhotoPatch(bad, { photoUrl: staff }, staff, pub("x"))).toBeNull();
  });
  it("isStaffPhoto reads the object path from any bucket's download URL", () => {
    expect(isStaffPhoto("p1", staff)).toBe(true);
    expect(isStaffPhoto("p1", "https://firebasestorage.googleapis.com/v0/b/other/o/products%2Fp1%2Fphoto.jpg?x")).toBe(true);
    expect(isStaffPhoto("p2", staff)).toBe(false);
    expect(isStaffPhoto("p1", pub("a"))).toBe(false);
  });
});

describe("setShopifyPrimaryPhoto — THE one write", () => {
  it("rebuilds the till thumbnail BEFORE photoUrl moves (photoUrl is the mirror's content marker)", async () => {
    const d = fakeDeps();
    const r = await setShopifyPrimaryPhoto("p1", { product: { photoUrl: staff }, oldPrimary: staff, newPrimary: pub("n") }, d);
    expect(r).toMatchObject({ ok: true, changed: true, thumb: true });
    expect(d.log.map((x) => x[0])).toEqual(["thumb", "write"]);
    expect(d.log[1]).toEqual(["write", "p1", { photoUrl: pub("n"), photoUrlOriginal: staff,
                                                photoSource: { from: "shopify_publish", at: 1_790_000_000_000 } }]);
  });
  it("SAME CONTENT, DIFFERENT URL: equal Storage md5 → nothing written, nothing rebuilt", async () => {
    const d = fakeDeps({ md5: { [staff]: "abc==", [pub("n")]: "abc==" } });
    const r = await setShopifyPrimaryPhoto("p1", { product: { photoUrl: staff }, newPrimary: pub("n") }, d);
    expect(r).toEqual({ ok: true, changed: false, reason: "same-content" });
    expect(d.log).toEqual([]);
  });
  it("different md5, or an md5 that cannot be read, still writes", async () => {
    const d = fakeDeps({ md5: { [staff]: "abc==", [pub("n")]: "zzz==" } });
    expect((await setShopifyPrimaryPhoto("p1", { product: { photoUrl: staff }, newPrimary: pub("n") }, d)).changed).toBe(true);
    const d2 = fakeDeps({ md5: { [pub("n")]: "abc==" } });
    expect((await setShopifyPrimaryPhoto("p1", { product: { photoUrl: legacy }, newPrimary: pub("n") }, d2)).changed).toBe(true);
  });
  it("an async now() (the chain's server clock) still stamps photoSource", async () => {
    const d = { ...fakeDeps(), now: async () => 42 };
    const r = await setShopifyPrimaryPhoto("p1", { product: { photoUrl: staff }, newPrimary: pub("n") }, d);
    expect(r.patch.photoSource).toEqual({ from: "shopify_publish", at: 42 });
  });
  it("STALE SNAPSHOT: the original is decided from the record as stored now (a re-shoot on another device)", async () => {
    const reshot = `${B}products%2Fp1%2Fphoto.jpg?alt=media&token=z`;
    const d = { ...fakeDeps(), readProduct: async () => ({ photoUrl: reshot, photoUrlOriginal: null }) };
    const r = await setShopifyPrimaryPhoto("p1", { product: { photoUrl: pub("old") }, newPrimary: pub("n") }, d);
    expect(r.patch.photoUrlOriginal).toBe(reshot);
    const d2 = { ...fakeDeps(), readProduct: async () => ({ photoUrl: pub("n") }) };
    expect(await setShopifyPrimaryPhoto("p1", { product: { photoUrl: staff }, newPrimary: pub("n") }, d2)).toMatchObject({ changed: false, reason: "same-url" });
  });
  it("a refused product write is a sentence, never a throw", async () => {
    const r = await setShopifyPrimaryPhoto("p1", { product: { photoUrl: staff }, newPrimary: pub("n") }, fakeDeps({ failWrite: true }));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/app photo could not be changed \(PERMISSION_DENIED\)/);
  });
  it("REFUSED WRITE AFTER THE THUMBNAIL: the old photo's thumbnail is rebuilt, never left showing the new one", async () => {
    const d = fakeDeps({ failWrite: true });
    d.removeThumb = async (pid) => d.log.push(["remove", pid]);
    const r = await setShopifyPrimaryPhoto("p1", { product: { photoUrl: staff }, newPrimary: pub("n") }, d);
    expect(r).toMatchObject({ ok: false, changed: false, thumb: true });
    expect(d.log).toEqual([["thumb", "p1", pub("n")], ["thumb", "p1", staff]]);
  });
  it("…and when the old one cannot be rebuilt (or there is none), the thumbnail is removed", async () => {
    for (const product of [{ photoUrl: staff }, {}]) {
      const d = fakeDeps({ failWrite: true });
      d.rebuildThumb = async (pid, url) => { d.log.push(["thumb", pid, url]); return { ok: url === pub("n") }; };
      d.removeThumb = async (pid) => d.log.push(["remove", pid]);
      await setShopifyPrimaryPhoto("p1", { product, newPrimary: pub("n") }, d);
      expect(d.log.at(-1)).toEqual(["remove", "p1"]);
    }
  });
  it("a thumbnail failure never blocks the photo", async () => {
    const d = { ...fakeDeps(), rebuildThumb: async () => { throw new Error("no webp"); } };
    const r = await setShopifyPrimaryPhoto("p1", { product: { photoUrl: staff }, newPrimary: pub("n") }, d);
    expect(r).toMatchObject({ ok: true, changed: true, thumb: false });
  });
});

describe("storedPrimaryOf — the node's OWN primary", () => {
  it("media list first photo; photos list; none when the node never stored a list", () => {
    expect(storedPrimaryOf({ media: [{ id: "v", type: "video", url: pub("v") }, { id: "a", type: "photo", url: pub("a") }], photos: [pub("a")] })).toBe(pub("a"));
    expect(storedPrimaryOf({ photos: [pub("b"), pub("c")] })).toBe(pub("b"));
    expect(storedPrimaryOf({ state: "live" })).toBeNull();
    expect(storedPrimaryOf(null)).toBeNull();
  });
  it("a photos-only writer that changed the order wins (the merged read)", () => {
    const media = [{ id: "a", type: "photo", url: pub("a") }, { id: "b", type: "photo", url: pub("b") }];
    expect(storedPrimaryOf({ media, photos: [pub("b"), pub("a")] })).toBe(pub("b"));
  });
});

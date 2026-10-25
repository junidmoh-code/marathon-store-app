import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { metaReadyFirstPhoto } from "./metaReadyCreate.mjs";
import { metaReadyOn, SHOPIFY_IMAGES_FROM_MS } from "../../src/utils/primaryPhotoFollow.js";

const P = "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/products%2Fp1%2Fphoto.jpg?alt=media&token=t";
const M = "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/products%2Fp1%2Fmeta%2F5.jpg?alt=media&token=m";
function db(tree) {
  const at = (p) => p.split("/").reduce((o, k) => (o == null ? undefined : o[k]), tree);
  return { ref: (p) => ({ get: async () => ({ val: () => at(p) ?? null }) }) };
}
const AFTER = SHOPIFY_IMAGES_FROM_MS + 1;

describe("metaReadyOn — NEW products only, from 28 Oct", () => {
  it("off before, on from, its own off switch", () => {
    expect(metaReadyOn(SHOPIFY_IMAGES_FROM_MS - 1, null)).toBe(false);
    expect(metaReadyOn(SHOPIFY_IMAGES_FROM_MS, null)).toBe(true);
    expect(metaReadyOn(AFTER, { metaReadyOff: true })).toBe(false);
  });
});

describe("metaReadyFirstPhoto", () => {
  const tree = () => ({ config: {}, products: { p1: { photoUrl: P, photoMeta: { url: M, sourceUrl: P, version: 1 } } } });
  const deps = { ensure: true };
  it("the Meta-ready file for a list that leads with the primary, on or after the switch", async () => {
    // ensureMetaReady sees the pointer already made → no image work in the test.
    expect(await metaReadyFirstPhoto({ db: db(tree()), nowMs: AFTER, pid: "p1", firstUrl: P, deps: { db: db(tree()) } })).toBe(M);
  });
  it("null before 28 Oct, when the list leads with another photo, or when the version is stale", async () => {
    expect(await metaReadyFirstPhoto({ db: db(tree()), nowMs: SHOPIFY_IMAGES_FROM_MS - 1, pid: "p1", firstUrl: P, deps })).toBeNull();
    expect(await metaReadyFirstPhoto({ db: db(tree()), nowMs: AFTER, pid: "p1", firstUrl: "https://other", deps })).toBeNull();
    const stale = tree(); stale.products.p1.photoMeta.sourceUrl = "https://older";
    expect(await metaReadyFirstPhoto({ db: db(stale), nowMs: AFTER, pid: "p1", firstUrl: P, deps: { db: db(stale), bucket: { file: () => ({ download: async () => { throw new Error("no"); } }) }, sharp: null } })).toBeNull();
  });
});

describe("reconcile.mjs uses it only on a fresh CREATE (pinned by source)", () => {
  const SRC = readFileSync(new URL("./reconcile.mjs", import.meta.url), "utf8");
  it("both media paths ask only when createdNow", () => {
    expect(SRC.match(/createdNow\n?\s*\?\s*await metaReadyFirstPhoto\(/g)?.length).toBe(2);
    expect(SRC).toMatch(/await db\.ref\(`shopify_sync\/\$\{pid\}`\)\.update\(\{ mediaFingerprint: planFp, mediaCount: mediaPlan\.length \}\)/); // the reviewed set's own fingerprint
  });
});

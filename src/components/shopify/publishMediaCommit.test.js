import { describe, it, expect, vi, beforeEach } from "vitest";

let storeAnswer = null;
vi.mock("./shopifyPublishStore", () => ({
  setPublishMedia: async (pid, node, media) => storeAnswer ?? { ok: true, node: { ...(node || {}), media } },
  appendPublishMedia: async (pid, node, items) => storeAnswer ?? { ok: true, node: { ...(node || {}), media: [...((node || {}).media || []), ...items] } },
}));
const { commitPublishMedia } = await import("./publishMediaCommit.js");

const B = "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/";
const staff = `${B}products%2Fp1%2Fphoto.jpg?alt=media&token=a`;
const pub = (n) => `${B}products%2Fp1%2Fshopify%2F${n}.jpg?alt=media&token=b`;
const ph = (n) => ({ id: `m${n}`, type: "photo", url: pub(n) });
const product = { id: "p1", photoUrl: staff };

let writes, failFirst;
const deps = {
  now: () => 7, md5Of: async () => null, rebuildThumb: async () => ({ ok: true }),
  writeProduct: async (pid, patch) => {
    if (failFirst-- > 0) throw new Error("offline");
    writes.push([pid, patch]);
  },
};
beforeEach(() => { storeAnswer = null; writes = []; failFirst = 0; });

describe("commitPublishMedia — every list write, the app photo follows the primary", () => {
  it("a first list that puts a new photo first → the app photo follows (the record's photo was the old primary)", async () => {
    const { res, app } = await commitPublishMedia(product, null, "set", [ph("a"), { id: "s", type: "photo", url: staff }], deps);
    expect(res.ok).toBe(true);
    expect(app.changed).toBe(true);
    expect(writes).toEqual([["p1", { photoUrl: pub("a"), photoUrlOriginal: staff, photoSource: { from: "shopify_publish", at: 7 },
                                     "photoHistory/7": { url: staff, at: 7, by: null, source: "shopify_publish", replacedWith: pub("a") } }]]);
  });
  it("an append BEHIND the primary (another photo) never touches the app photo", async () => {
    const { app } = await commitPublishMedia({ id: "p1", photoUrl: pub("a") }, { media: [ph("a")] }, "append", [ph("b")], deps);
    expect(app).toEqual({ ok: true, changed: false });
    expect(writes).toEqual([]);
  });
  it("a refused list write writes nothing to the product", async () => {
    storeAnswer = { ok: false, message: "changed in another session" };
    const { res, app } = await commitPublishMedia(product, { media: [ph("a")] }, "set", [ph("b"), ph("a")], deps);
    expect(res.ok).toBe(false);
    expect(app).toBeNull();
    expect(writes).toEqual([]);
  });
  it("one retry when the product write fails — the list is already saved", async () => {
    failFirst = 1;
    const { app } = await commitPublishMedia(product, { media: [ph("a")] }, "set", [ph("b"), ph("a")], deps);
    expect(app.ok).toBe(true);
    expect(writes.length).toBe(1);
  });
});

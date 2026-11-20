// bfThumb (21 Nov 2026): the card's list thumbnails — only product photos in our bucket, one per photo version.
const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { _internals: t } = require("../blackFriday/thumbs.js");

const url = (path, token = "tok1") => `https://firebasestorage.googleapis.com/v0/b/${t.BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;

test("only a product photo in the app's bucket is thumbnailed; a new download token is a new thumbnail", () => {
  const a = t.sourceOf(url("products/p1/black_friday/gen_1.jpg"));
  assert.equal(a.path, "products/p1/black_friday/gen_1.jpg");
  assert.match(a.thumbPath, /^products\/p1\/card_thumbs\/[0-9a-z]+_w360\.webp$/);
  assert.notEqual(t.sourceOf(url("products/p1/black_friday/gen_1.jpg", "tok2")).thumbPath, a.thumbPath);
  for (const bad of [
    "https://evil.example/v0/b/x/o/products%2Fp1%2Fa.jpg", url("eftProofs/p1/a.jpg"), url("products/p1/../x/a.jpg"), url("products/p1/card_thumbs/a.webp"),
    url("products/p1/a.json"), `https://firebasestorage.googleapis.com/v0/b/other-bucket/o/products%2Fp1%2Fa.jpg`, "not a url",
  ]) assert.equal(t.sourceOf(bad), null, bad);
});

test("the thumbnail is made once (360 px WebP, the right way up) and then reused", async () => {
  const files = new Map([["products/p1/photo.jpg", await sharp({ create: { width: 3000, height: 4000, channels: 3, background: "#a52" } }).jpeg().toBuffer()]]);
  let downloads = 0;
  const bucket = { file: (p) => ({ exists: async () => [files.has(p)], download: async () => { downloads++; return [files.get(p)]; }, save: async (b) => { files.set(p, b); } }) };
  const src = t.sourceOf(url("products/p1/photo.jpg"));
  await t.ensureThumb(src, { bucket, sharp });
  const m = await sharp(files.get(src.thumbPath)).metadata();
  assert.deepEqual([m.format, m.width, m.height], ["webp", 360, 480]);
  await t.ensureThumb(src, { bucket, sharp });
  assert.equal(downloads, 1, "kept, never made twice");
});

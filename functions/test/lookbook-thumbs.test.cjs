// ─── THE PANEL'S CLEAN PRODUCT SHOTS: ORDER, CACHE, CEILING ──────────────────
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { resolveThumb } = require("../lookbook/thumbs.cjs");
const { engines, THUMB_PATH } = require("../lookbook/engines.cjs");
const { FakeRtdb } = require("./fixtures/rtdb-fake.cjs");
const lookbook = require("../lib/social-lookbook.cjs");

const PHOTO = { buffer: Buffer.from("shop-photo"), contentType: "image/jpeg" };
const ROW = { pid: "p1", slot: "hat", displayName: "Hugo boss beanie red", studio: false, photoUrl: "https://x/p1.jpg" };

function fakeDeps(over = {}) {
  const calls = { gen: 0, write: 0, cut: [] };
  const d = {
    calls,
    cutout: async (buf) => { calls.cut.push(String(buf)); return { png: Buffer.from(`cut:${buf}`), method: "fake" }; },
    readThumbCache: async () => null,
    writeThumbCache: async () => { calls.write++; },
    claimThumbUnit: async () => ({ ok: true }),
    generateThumb: async () => { calls.gen++; return { buffer: Buffer.from("clean-shot"), costUSD: 0.0336, engine: "flash-lite" }; },
    inlineImagePart: (b, t) => ({ inline_data: { mime_type: t, data: b.toString("base64") } }),
    ...over,
  };
  return d;
}

describe("resolveThumb", () => {
  test("a studio photo is used as it is: nothing read from the cache, nothing generated", async () => {
    const d = fakeDeps({ readThumbCache: async () => { throw new Error("must not read"); } });
    const t = await resolveThumb({ ...ROW, studio: true }, PHOTO, d);
    assert.equal(t.source, "studio");
    assert.equal(d.calls.gen, 0);
    assert.deepEqual(d.calls.cut, ["shop-photo"]);
  });

  test("a cached shot is used: never generated again, never cut again", async () => {
    const d = fakeDeps({ readThumbCache: async () => ({ png: Buffer.from("cached") }) });
    const t = await resolveThumb(ROW, PHOTO, d);
    assert.equal(t.source, "cache");
    assert.equal(String(t.cutout.png), "cached");
    assert.equal(d.calls.gen, 0);
    assert.equal(d.calls.cut.length, 0);
    assert.equal(t.costUSD, 0);
  });

  test("no cache: generated from the shop photo as the reference, cut out, cached, costed", async () => {
    let sent = null;
    const d = fakeDeps({ generateThumb: async (parts) => { sent = parts; return { buffer: Buffer.from("clean-shot"), costUSD: 0.0336, engine: "flash-lite" }; } });
    const t = await resolveThumb(ROW, PHOTO, d);
    assert.equal(t.source, "generated");
    assert.equal(t.costUSD, 0.0336);
    assert.match(sent[0].text, /no hand, no person, no hanger/);
    assert.match(sent[0].text, /Pure white seamless background/);
    assert.equal(Buffer.from(sent[2].inline_data.data, "base64").toString(), "shop-photo");
    assert.deepEqual(d.calls.cut, ["clean-shot"]);
    assert.equal(d.calls.write, 1);
  });

  test("the day's ceiling: no generation, the shop photo cut out", async () => {
    const d = fakeDeps({ claimThumbUnit: async () => ({ ok: false }) });
    const t = await resolveThumb(ROW, PHOTO, d);
    assert.equal(t.source, "photo");
    assert.equal(d.calls.gen, 0);
    assert.deepEqual(d.calls.cut, ["shop-photo"]);
  });

  test("a generation error or a shot that will not cut out falls back to the shop photo; nothing cached", async () => {
    const boom = fakeDeps({ generateThumb: async () => { throw new Error("HTTP 400"); } });
    assert.equal((await resolveThumb(ROW, PHOTO, boom)).source, "photo");
    assert.equal(boom.calls.write, 0);
    const blank = fakeDeps({ cutout: async (buf) => (String(buf) === "clean-shot" ? { png: null, tried: ["x"] } : { png: Buffer.from("ok"), method: "fake" }) });
    const t = await resolveThumb(ROW, PHOTO, blank);
    assert.equal(t.source, "photo");
    assert.equal(t.costUSD, 0.0336, "the spend is still counted");
    assert.equal(blank.calls.write, 0);
  });

  test("a cache write that fails still draws the shot", async () => {
    const d = fakeDeps({ writeThumbCache: async () => { throw new Error("storage down"); } });
    assert.equal((await resolveThumb(ROW, PHOTO, d)).source, "generated");
  });

  test("no picture at all: cutout null, so makeLookbook skips the product", async () => {
    const d = fakeDeps({ claimThumbUnit: async () => ({ ok: false }), cutout: async () => ({ png: null, tried: ["imgly:0.01/0e"] }) });
    const t = await resolveThumb(ROW, PHOTO, d);
    assert.equal(t.cutout, null);
  });
});

// A Storage bucket in memory.
function fakeBucket() {
  const files = new Map();
  return {
    name: "b", files,
    file: (path) => ({
      name: path,
      exists: async () => [files.has(path)],
      download: async () => { if (!files.has(path)) throw new Error("No such object"); return [files.get(path)]; },
      save: async (buf) => { files.set(path, buf); },
    }),
  };
}

describe("engines: the thumbnail cache and its ceiling", () => {
  const make = (db, bucket) => engines({ db, bucket, saDate: "2026-10-19", geminiApiKey: "k", anthropicApiKey: "a", visionModel: "m" });

  test("write then read: Storage file + RTDB pointer under the social namespace", async () => {
    const db = new FakeRtdb({}), bucket = fakeBucket();
    const e = make(db, bucket);
    assert.equal(await e.readThumbCache("p1"), null);
    await e.writeThumbCache("p1", Buffer.from("png"), { engine: "flash-lite", costUSD: 0.0336, method: "imgly", src: "s" });
    assert.ok(bucket.files.has("aiStudio/social/lookbook/thumbs/p1.png"));
    const ptr = (await db.ref("social_lookbook/thumbs/p1").once("value")).val();
    assert.equal(ptr.path, THUMB_PATH("p1"));
    assert.equal(ptr.engine, "flash-lite");
    assert.match(ptr.url, /alt=media&token=/);
    assert.equal(String((await e.readThumbCache("p1")).png), "png");
  });

  test("a file whose pointer was lost is still found, and the pointer is put back", async () => {
    const db = new FakeRtdb({}), bucket = fakeBucket();
    bucket.files.set(THUMB_PATH("p2"), Buffer.from("orphan"));
    const e = make(db, bucket);
    assert.equal(String((await e.readThumbCache("p2")).png), "orphan");
    assert.equal((await db.ref("social_lookbook/thumbs/p2").once("value")).val().path, THUMB_PATH("p2"));
  });

  test("a pointer outside the thumbs folder is never followed", async () => {
    const db = new FakeRtdb({ social_lookbook: { thumbs: { p3: { path: "products/p3/photo.jpg" } } } }), bucket = fakeBucket();
    bucket.files.set("products/p3/photo.jpg", Buffer.from("not-a-thumb"));
    bucket.files.set(THUMB_PATH("p3"), Buffer.from("thumb"));
    assert.equal(String((await make(db, bucket).readThumbCache("p3")).png), "thumb");
  });

  test("an unsafe pid is refused on both sides", async () => {
    const bucket = fakeBucket();
    bucket.files.set("aiStudio/social/lookbook/thumbs/../x.png", Buffer.from("planted"));
    const e = make(new FakeRtdb({}), bucket);
    assert.equal(await e.readThumbCache("../x"), null);
    await assert.rejects(e.writeThumbCache("a/b", Buffer.from("x")), /unusable pid/);
  });

  test(`the ceiling: ${lookbook.THUMBS_PER_DAY} a day on social_lookbook/thumbBudget/{date}, never the hero counter`, async () => {
    const db = new FakeRtdb({});
    const e = make(db, fakeBucket());
    for (let i = 0; i < lookbook.THUMBS_PER_DAY; i++) assert.equal((await e.claimThumbUnit()).ok, true);
    assert.equal((await e.claimThumbUnit()).ok, false);
    assert.equal((await db.ref("social_lookbook/thumbBudget/2026-10-19").once("value")).val(), lookbook.THUMBS_PER_DAY);
    assert.equal((await db.ref("social_generation_budget").once("value")).val(), null);
  });

  test("the character reference is read only from its own folder", async () => {
    const bucket = fakeBucket();
    bucket.files.set("aiStudio/social/lookbook/model/ref-1.jpg", Buffer.from("face"));
    const ok = make(new FakeRtdb({ social_lookbook: { model: { path: "aiStudio/social/lookbook/model/ref-1.jpg" } } }), bucket);
    assert.equal(String((await ok.readModelRef()).buffer), "face");
    const bad = make(new FakeRtdb({ social_lookbook: { model: { path: "products/x.jpg" } } }), bucket);
    assert.equal(await bad.readModelRef(), null);
    assert.equal(await make(new FakeRtdb({}), bucket).readModelRef(), null);
  });
});

describe("resolveThumb — architect review of #750", () => {
  test("a paid shot that does not cut out is marked failed; a marked product is never generated again", async () => {
    const marked = [];
    const d = fakeDeps({
      cutout: async (buf) => (String(buf) === "clean-shot" ? { png: null, tried: ["imgly:0.95/4e"] } : { png: Buffer.from("ok"), method: "fake" }),
      markThumbFailed: async (pid, meta) => { marked.push([pid, meta.costUSD]); },
    });
    assert.equal((await resolveThumb(ROW, PHOTO, d)).source, "photo");
    assert.deepEqual(marked, [["p1", 0.0336]]);
    const again = fakeDeps({ readThumbCache: async () => ({ failed: true }) });
    const t = await resolveThumb(ROW, PHOTO, again);
    assert.equal(t.source, "photo");
    assert.equal(again.calls.gen, 0);
  });

  test("after the thumbnail deadline nothing is generated", async () => {
    const d = fakeDeps({ thumbDeadlineMs: Date.now() - 1 });
    const t = await resolveThumb(ROW, PHOTO, d);
    assert.equal(t.source, "photo");
    assert.equal(d.calls.gen, 0);
  });

  test("engines: a failed marker reads as failed, not as a cache miss", async () => {
    const db = new FakeRtdb({});
    const e = engines({ db, bucket: fakeBucket(), saDate: "2026-10-19" });
    await e.markThumbFailed("p9", { engine: "flash-lite", costUSD: 0.04, tried: ["x"] });
    assert.deepEqual(await e.readThumbCache("p9"), { failed: true });
  });
});

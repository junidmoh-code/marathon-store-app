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

  test("the house model: refused until Junid approves; then the rotation's next man, only from the models folder", async () => {
    const bucket = fakeBucket();
    const P = (slot, n) => `aiStudio/social/lookbook/models/${slot}-1-${n}.jpg`;
    for (const slot of ["black", "white", "coloured"]) for (const n of [1, 2]) bucket.files.set(P(slot, n), Buffer.from(`${slot}${n}`));
    const node = (slot, picked = null) => ({ decideBy: 1, picked, candidates: { 1: { path: P(slot, 1), score: 9 }, 2: { path: P(slot, 2), score: 8 } } });
    const picked = { black: node("black", "2"), white: node("white", "1"), coloured: node("coloured", "1") };
    // Not approved: nothing, even with all three picked.
    const none = await make(new FakeRtdb({ social_lookbook: { models: picked } }), bucket).readHouseModel();
    assert.equal(none.ok, false);
    assert.match(none.reason, /not approved/);
    // Approved: the rotation after "black" is "white", his picked face.
    const ok = await make(new FakeRtdb({ social_lookbook: { models: picked, modelsApproval: { approved: true }, modelRotation: { last: "black" } } }), bucket).readHouseModel();
    assert.equal(ok.slot, "white");
    assert.equal(String(ok.ref.buffer), "white1");
    assert.match(ok.model.description, /white South African/);
    // The proof samples: an unpicked model stands in with his best-scoring face, never approved.
    const proof = await make(new FakeRtdb({ social_lookbook: { models: { coloured: node("coloured") } } }), bucket).readHouseModel({ slot: "coloured", allowUnapproved: true });
    assert.equal(proof.provisional, true);
    assert.equal(String(proof.ref.buffer), "coloured1");
    // The rejected man's folder is nobody's reference.
    const stray = { black: { decideBy: 1, picked: "1", candidates: { 1: { path: "aiStudio/social/lookbook/rejected/2026-10-30/house-2.jpg", score: 10 } } } };
    assert.equal((await make(new FakeRtdb({ social_lookbook: { models: stray } }), bucket).readHouseModel({ slot: "black", allowUnapproved: true })).ok, false);
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

describe("resolveThumb — spec review of #750", () => {
  test("a cache that cannot be read is not a miss: nothing is generated", async () => {
    const d = fakeDeps({ readThumbCache: async () => { throw new Error("storage 503"); } });
    const t = await resolveThumb(ROW, PHOTO, d);
    assert.equal(t.source, "photo");
    assert.equal(d.calls.gen, 0);
  });
});

describe("engines — CodeRabbit on #750: a changed source photo is a miss", () => {
  test("same source: hit; a different source: miss; no recorded source: hit; a failed marker for an old photo: miss", async () => {
    const db = new FakeRtdb({}), bucket = fakeBucket();
    const e = engines({ db, bucket, saDate: "2026-10-19" });
    await e.writeThumbCache("p1", Buffer.from("png"), { src: "https://x/old.jpg" });
    assert.equal(String((await e.readThumbCache("p1", "https://x/old.jpg")).png), "png");
    assert.equal(await e.readThumbCache("p1", "https://x/new.jpg"), null);
    bucket.files.set(THUMB_PATH("p2"), Buffer.from("repaired"));
    await db.ref("social_lookbook/thumbs/p2").set({ path: THUMB_PATH("p2"), repaired: true });
    assert.equal(String((await e.readThumbCache("p2", "https://x/any.jpg")).png), "repaired");
    await e.markThumbFailed("p3", { src: "https://x/old.jpg" });
    assert.deepEqual(await e.readThumbCache("p3", "https://x/old.jpg"), { failed: true });
    assert.equal(await e.readThumbCache("p3", "https://x/new.jpg"), null);
  });

  test("resolveThumb asks the cache about THIS photo", async () => {
    let asked = null;
    const d = fakeDeps({ readThumbCache: async (pid, src) => { asked = [pid, src]; return { png: Buffer.from("c") }; } });
    await resolveThumb(ROW, PHOTO, d);
    assert.deepEqual(asked, ["p1", "https://x/p1.jpg"]);
  });
});

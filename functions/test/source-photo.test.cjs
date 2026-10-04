// THE PRODUCT'S CURRENT PHOTO — never a copy kept on the queue item.
// Change a product's photo in admin → the card's "Original", the photo Gemini
// is given and the original the chain keeps all follow it. An approved
// generated photo is untouched.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const core = require("../newArrivals/core.cjs");
const sp = require("../newArrivals/sourcePhoto.cjs");
const { _internals: na } = require("../newArrivals/newArrivals.js");
const { _internals: studio } = require("../newArrivals/studio.js");

const PID = "p1791099990000";
const NOW = 1_791_100_000_000;
// A staff photo always lives at products/{pid}/photo.jpg; a re-shoot gets a new token.
const staff = (token, pid = PID) => `https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/products%2F${pid}%2Fphoto.jpg?alt=media&token=${token}`;
const generated = (n) => `https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/products%2F${PID}%2Fnew_arrivals%2Fgen_${n}.jpg?alt=media&token=g${n}`;
const OLD = staff("old"), NEW = staff("new");

test("currentSourceUrl: the staff photo when that is the product's photo; the kept original under an approved generated photo", () => {
  assert.equal(sp.currentSourceUrl(PID, { photoUrl: NEW }, { originalUrl: OLD }), NEW, "the item's old copy never wins");
  assert.equal(sp.currentSourceUrl(PID, { photoUrl: generated(1), photoUrlOriginal: OLD }), OLD, "approved generated photo: the source is the original it replaced");
  // Re-shot AFTER an approval: photoUrl is a staff photo again — the kept original is out of date.
  assert.equal(sp.currentSourceUrl(PID, { photoUrl: NEW, photoUrlOriginal: OLD }), NEW);
  // An older record (photo stored elsewhere, nothing approved): its photo.
  assert.equal(sp.currentSourceUrl(PID, { photoUrl: "https://x/legacy.jpg" }, { originalUrl: OLD }), "https://x/legacy.jpg");
  // No photo on the product at all: the item's copy is the last resort.
  assert.equal(sp.currentSourceUrl(PID, {}, { originalUrl: OLD }), OLD);
  assert.equal(sp.currentSourceUrl(PID, null, null), null);
  // Another product's photo.jpg is not this product's staff photo.
  assert.equal(sp.isStaffPhoto(PID, staff("t", "p1700000000000")), false);
  assert.equal(sp.isStaffPhoto(PID, "not a url"), false);
});

test("generationIsStale: by the source it recorded, else by when the photo was replaced", () => {
  assert.equal(sp.generationIsStale({ at: 10, sourceUrl: OLD }, { sourceUrl: NEW }), true);
  // An overwrite can keep the same address: the replacement's time still says so.
  assert.equal(sp.generationIsStale({ at: 10, sourceUrl: NEW }, { sourceUrl: NEW, photoUpdatedAt: 10 + sp.CLOCK_SLACK_MS + 1 }), true);
  assert.equal(sp.generationIsStale({ at: 100, sourceUrl: NEW }, { sourceUrl: NEW, photoUpdatedAt: 99 }), false);
  assert.equal(sp.generationIsStale({ at: 10 }, { sourceUrl: NEW, photoUpdatedAt: 10 + sp.CLOCK_SLACK_MS + 1 }), true);
  assert.equal(sp.generationIsStale({ at: 100 }, { sourceUrl: NEW, photoUpdatedAt: 99 }), false);
  // Two clocks stamp these: a stamp only seconds "after" the generation is clock skew, not a re-shoot.
  assert.equal(sp.generationIsStale({ at: 1_000_000 }, { sourceUrl: NEW, photoUpdatedAt: 1_030_000 }), false);
  assert.equal(sp.generationIsStale({ at: 1_000_000, sourceUrl: NEW }, { sourceUrl: NEW, photoUpdatedAt: 1_000_000 + sp.CLOCK_SLACK_MS }), false);
  assert.equal(sp.generationIsStale({ at: 10 }, { sourceUrl: NEW }), false);
  assert.equal(sp.generationIsStale(null, { sourceUrl: NEW }), false);
});

const world = ({ item = {}, product = {} } = {}) => makeFakeDb({
  locations: { hub1: { name: "Hub 1" } },
  products: { [PID]: { name: "Nike AF1", categoryKey: "sneakers", category: "Footwear", photoUrl: OLD, stockPrice: 500, sizes: ["7"], ...product } },
  new_arrivals: {
    items: { [PID]: Object.fromEntries(Object.entries({ pid: PID, status: "new", enqueuedAt: 5, statusAt: 5, name: "Nike AF1", categoryKey: "sneakers", originalUrl: OLD, ...item }).filter(([, v]) => v !== undefined)) },
    by_status: { [item.status || "new"]: { [PID]: 5 } },
  },
});
const listed = async (db, tab = "new") => (await na.listTab(db, tab, { limit: 30, group: tab === "new" ? "sneakers" : null })).items[0];

test("ADMIN CHANGES THE PHOTO → the card shows the new one (the item still holds the old copy)", async () => {
  const db = world();
  assert.equal((await listed(db)).sourceUrl, OLD);
  // Staff re-shoot in admin: the same write the product page makes.
  await db.ref(`products/${PID}`).update({ photoUrl: NEW, photoUpdatedAt: NOW, photoSourceUrl: null });
  const it = await listed(db);
  assert.equal(it.sourceUrl, NEW);
  assert.equal(it.originalUrl, OLD, "the stale copy is still on the item — and no longer decides anything");
  assert.equal(it.product.photoUrl, NEW);
});

test("a new upload puts NO photo on the item: there is nothing to go stale", () => {
  assert.equal("originalUrl" in core.buildItem(PID, { name: "x", photoUrl: OLD, categoryKey: "sneakers" }, NOW), false);
});

test("no card action re-pins a photo: approve, select, love, skip, restore, method and reject leave no photo copy behind", async () => {
  const gens = { g1: { url: generated(1), at: 10, code: "G-0001" }, g2: { url: generated(2), at: 20, code: "G-0002" } };
  const db = world({ item: { status: "ready", originalUrl: undefined, currentGen: "g2", generatedUrl: generated(2), generations: gens } });
  await na.select(db, { pid: PID, genId: "g1" }, "junid", NOW);
  await na.love(db, { pid: PID, genId: "g1", loved: true }, "junid", NOW);
  await na.setMethod(db, { pid: PID, method: "split" }, NOW);
  await na.reject(db, { pid: PID, reason: "blurry" }, "junid", NOW);
  await na.skip(db, { pids: [PID] }, "junid", NOW);
  await na.restore(db, { pids: [PID] }, "junid", NOW);
  await na.approve(db, { pids: [PID], genId: "g1" }, "junid", NOW + 1);
  await db.ref(`products/${PID}`).update({ photoUrl: NEW, photoUpdatedAt: NOW + 5 });   // re-shot after the approval
  const item = (await db.ref(`new_arrivals/items/${PID}`).once()).val();
  assert.equal(item.originalUrl, undefined);
  assert.equal(item.status, "approved");
  // Junid's approved GENERATED photo is exactly what the chain will post.
  assert.equal(item.generatedUrl, generated(1));
  const done = await listed(db, "done");
  assert.equal(done.generatedUrl, generated(1));
  assert.equal(done.sourceUrl, NEW);
});

test("an APPROVED generated photo that became the product's photo: the card's Original is the staff photo it replaced, the photo shown is the generated one", async () => {
  const db = world({
    product: { photoUrl: generated(7), photoUrlOriginal: OLD },
    item: { status: "done", originalUrl: OLD, currentGen: "g7", generatedUrl: generated(7), generations: { g7: { url: generated(7), at: 70, sourceUrl: OLD } }, approvedAt: 80 },
  });
  const it = await listed(db, "done");
  assert.equal(it.sourceUrl, OLD);
  assert.equal(it.generatedUrl, generated(7));
  assert.equal(it.product.photoUrl, generated(7));
  assert.equal(it.sourceChanged, undefined);
});

test("a photo generated from the OLD product photo is flagged once the product's photo changes — by its recorded source, or by time for older ones", async () => {
  const withSource = world({ item: { status: "ready", currentGen: "g1", generatedUrl: generated(1), generations: { g1: { url: generated(1), at: 10, sourceUrl: OLD } } } });
  assert.equal((await listed(withSource)).sourceChanged, undefined);
  await withSource.ref(`products/${PID}`).update({ photoUrl: NEW, photoUpdatedAt: NOW });
  assert.equal((await listed(withSource)).sourceChanged, true);
  // An older generation (no recorded source): the photo's replacement time decides.
  const older = world({ product: { photoUrl: NEW, photoUpdatedAt: NOW }, item: { status: "ready", currentGen: "g2", generatedUrl: generated(2), generations: { g1: { url: generated(1), at: 10 }, g2: { url: generated(2), at: 20 } } } });
  const o = await listed(older);
  assert.equal(o.sourceChanged, true);
  // Every out-of-date generation is named, so the card can refuse "Use this one" on each.
  assert.deepEqual(o.staleGens.sort(), ["g1", "g2"]);
  const fresh = world({ product: { photoUrl: NEW, photoUpdatedAt: 50 }, item: { status: "ready", currentGen: "g1", generatedUrl: generated(1), generations: { g1: { url: generated(1), at: 60 } } } });
  assert.equal((await listed(fresh)).sourceChanged, undefined);
});

// ── the generator starts from the current photo ─────────────────────────────
const jpeg = (w, h, c) => sharp({ create: { width: w, height: h, channels: 3, background: c } }).jpeg().toBuffer();
async function studioDeps(fetched) {
  const plate = { buffer: await jpeg(543, 724, "#888"), width: 543, height: 724, file: "fence-single.png" };
  let clock = NOW;
  return {
    now: () => (clock += 1000),
    bucket: { name: "b", file: () => ({ save: async () => {} }) },
    fetchBytes: async (url) => { fetched.push(url); return { buffer: await jpeg(400, 500, "#a52") }; },
    assets: { loadPlate: async () => plate, loadReference: async () => null, libraryBox: async () => null, loadExamples: async () => [] },
    fx: async () => ({ rate: 17.5 }),
    image: async (model, parts, cfg) => ({ buffer: await jpeg(1536, 2048, "#777"), mime: "image/jpeg", thoughts: null, thoughtImages: 0, drafts: [], request: { imageConfig: cfg },
      usage: { promptTokenCount: 9000, candidatesTokenCount: 1200, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }] }, requestMs: 1 }),
  };
}

test("GENERATE uses the product's current photo — not the item's old copy — records it on the generation, and pins nothing", async () => {
  const db = world({ product: { photoUrl: NEW, photoUpdatedAt: NOW - 5, categoryKey: "hoodies", category: "Clothing" }, item: { categoryKey: "hoodies" } });
  const fetched = [];
  const out = await studio.studioGenerate(db, { pid: PID }, "junid", await studioDeps(fetched));
  assert.deepEqual(fetched, [NEW]);
  const item = (await db.ref(`new_arrivals/items/${PID}`).once()).val();
  assert.equal(item.generations[out.genId].sourceUrl, NEW);
  assert.equal(item.originalUrl, OLD, "the old copy is neither used nor re-written");
  assert.equal(out.item.sourceUrl, NEW, "the card gets the current photo back with the result");
  assert.equal(out.item.sourceChanged, undefined);
  // An item with NO copy (every item queued from now on) gets none from a Generate either.
  const clean = world({ product: { photoUrl: NEW, categoryKey: "hoodies", category: "Clothing" }, item: { categoryKey: "hoodies", originalUrl: undefined } });
  await studio.studioGenerate(clean, { pid: PID }, "junid", await studioDeps([]));
  assert.equal((await clean.ref(`new_arrivals/items/${PID}/originalUrl`).once()).val(), null);
});

test("a GENERATED photo is never taken for the source — not from the product's photo, its kept original, nor the item's copy", () => {
  assert.equal(sp.isGeneratedPhoto(generated(3)), true);
  assert.equal(sp.isGeneratedPhoto(OLD), false);
  assert.equal(sp.currentSourceUrl(PID, { photoUrl: generated(3) }, { originalUrl: OLD }), OLD);
  assert.equal(sp.currentSourceUrl(PID, { photoUrl: generated(3) }, { originalUrl: generated(2) }), null);
  assert.equal(sp.currentSourceUrl(PID, { photoUrl: generated(3), photoUrlOriginal: generated(2) }, null), null);
});

test("REGENERATE after an approval made a generated photo the product's photo: it starts from the kept staff original, never from the generated photo", async () => {
  const db = world({
    product: { photoUrl: generated(7), photoUrlOriginal: OLD, categoryKey: "hoodies", category: "Clothing" },
    item: { status: "ready", categoryKey: "hoodies", originalUrl: undefined, currentGen: "g7", generatedUrl: generated(7), generations: { g7: { url: generated(7), at: 70 } } },
  });
  const fetched = [];
  await studio.studioGenerate(db, { pid: PID }, "junid", await studioDeps(fetched));
  assert.deepEqual(fetched, [OLD]);
});

test("a photo made from the OLD product photo cannot be approved once the product's photo has changed — Regenerate first; nothing is logged", async () => {
  const gens = { g1: { url: generated(1), at: 10, sourceUrl: OLD } };
  const db = world({ item: { status: "ready", currentGen: "g1", generatedUrl: generated(1), generations: gens } });
  await db.ref(`products/${PID}`).update({ photoUrl: NEW, photoUpdatedAt: NOW });
  const out = await na.approve(db, { pids: [PID] }, "junid", NOW + 1);
  assert.deepEqual(out.approved, []);
  assert.match(out.skipped[0].why, /the product's photo was changed after this photo was made — tap Regenerate first/);
  assert.equal((await db.ref(`new_arrivals/items/${PID}/status`).once()).val(), "ready");
  assert.equal((await db.ref(core.DECISIONS).once()).val(), null);
  // The same photo kept at the same address but replaced later (photoUpdatedAt) is refused too.
  const same = world({ product: { photoUpdatedAt: NOW }, item: { status: "ready", currentGen: "g1", generatedUrl: generated(1), generations: { g1: { url: generated(1), at: 10, sourceUrl: OLD } } } });
  assert.deepEqual((await na.approve(same, { pids: [PID] }, "junid", NOW)).approved, []);
  // A photo made from the CURRENT product photo is approved as before.
  const ok = world({ product: { photoUrl: NEW, photoUpdatedAt: 5 }, item: { status: "ready", currentGen: "g1", generatedUrl: generated(1), generations: { g1: { url: generated(1), at: 10, sourceUrl: NEW } } } });
  assert.deepEqual((await na.approve(ok, { pids: [PID] }, "junid", NOW)).approved, [PID]);
});

test("the photo was replaced WHILE Gemini was working: the result that comes back already says the photo is out of date", async () => {
  const db = world({ product: { photoUrl: OLD, categoryKey: "hoodies", category: "Clothing" }, item: { categoryKey: "hoodies" } });
  const fetched = [];
  const deps = await studioDeps(fetched);
  const image = deps.image;
  deps.image = async (...a) => { await db.ref(`products/${PID}`).update({ photoUrl: NEW, photoUpdatedAt: NOW + 10_000_000 }); return image(...a); };
  const out = await studio.studioGenerate(db, { pid: PID }, "junid", deps);
  assert.equal(out.item.sourceUrl, NEW);
  assert.equal(out.item.sourceChanged, true);
});

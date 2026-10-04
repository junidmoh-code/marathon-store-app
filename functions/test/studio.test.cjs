// The photo studio callable against the fake RTDB: one tap = one Gemini call,
// progress streamed, the photo kept with its code, its real cost and its log;
// a failure gives the item back; a second tap while one runs is refused.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const core = require("../newArrivals/core.cjs");
const { _internals: studio } = require("../newArrivals/studio.js");

const NOW = 1_791_100_000_000;
const PID = "p1791099990000";
const jpeg = (w, h, colour) => sharp({ create: { width: w, height: h, channels: 3, background: colour } }).jpeg().toBuffer();

async function world({ item = {}, product = {} } = {}) {
  const db = makeFakeDb({
    products: { [PID]: { name: "Grey Fleece Hoodie", categoryKey: "hoodies", photoUrl: "https://x/orig.jpg", stockPrice: 300, ...product } },
    new_arrivals: {
      genSeq: 80,
      items: { [PID]: { pid: PID, status: "new", enqueuedAt: 5, statusAt: 5, name: "Grey Fleece Hoodie", categoryKey: "hoodies", originalUrl: "https://x/orig.jpg", ...item } },
      by_status: { [item.status || "new"]: { [PID]: 5 } },
    },
  });
  const uploads = [];
  const saved = [];
  const plate = { buffer: await jpeg(543, 724, "#888"), width: 543, height: 724, file: "fence-single.png" };
  let clock = NOW;
  const calls = [];
  const deps = {
    now: () => (clock += 1000),
    bucket: {
      name: "b",
      file: (p) => ({ save: async (buf, opts) => { (p.endsWith(".json") ? saved : uploads).push({ path: p, bytes: buf.length, opts }); } }),
    },
    fetchBytes: async (url) => { calls.push(["fetch", url]); return { buffer: await jpeg(400, 500, "#a52") }; },
    assets: {
      loadPlate: async () => plate,
      loadReference: async () => null,
      libraryBox: async () => null,
    },
    fx: async () => ({ rate: 17.5, day: "2026-10-04", source: "test" }),
    image: async (model, parts, imageConfig, opts) => {
      calls.push(["image", model, imageConfig, parts]);
      await opts.onEvent({ type: "thought", text: "Placing the hoodie on the fence." });
      await opts.onEvent({ type: "draft", n: 1, draft: { data: (await jpeg(300, 400, "#333")).toString("base64"), mime: "image/jpeg" } });
      return {
        buffer: await jpeg(1536, 2048, "#777"), mime: "image/jpeg", text: "", thoughts: "Placing the hoodie on the fence.", thoughtImages: 1, drafts: [],
        request: { responseModalities: ["IMAGE", "TEXT"], imageConfig, thinkingConfig: { includeThoughts: true } },
        usage: { promptTokenCount: 9000, candidatesTokenCount: 1200, thoughtsTokenCount: 300, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }] },
        requestMs: 42_000, thoughtsUnsupported: null,
      };
    },
  };
  return { db, deps, uploads, saved, calls };
}
const itemOf = async (db) => (await db.ref(`${core.ITEMS}/${PID}`).once()).val();

test("one tap: Gemini is called once, progress is streamed, the photo lands on the item with code, cost and log", async () => {
  const w = await world();
  const events = [];
  const out = await studio.studioGenerate(w.db, { pid: PID }, "junid", w.deps, (ev) => events.push(ev));
  assert.equal(out.ok, true);
  assert.equal(out.code, "G-0081");
  // ONE image call, on the locked model, size and the plate's nearest aspect.
  const image = w.calls.filter((c) => c[0] === "image");
  assert.equal(image.length, 1);
  assert.equal(image[0][1], "gemini-3-pro-image");
  assert.deepEqual(image[0][2], { aspectRatio: "3:4", imageSize: "2K" });
  // Generated from the ORIGINAL staff photo.
  assert.deepEqual(w.calls.filter((c) => c[0] === "fetch").map((c) => c[1]), ["https://x/orig.jpg"]);
  // The card saw the thought and the draft while it worked.
  assert.ok(events.some((e) => e.type === "thought" && /hoodie/.test(e.text)));
  const draft = events.find((e) => e.type === "draft");
  assert.match(draft.url, /-draft-1\.jpg/);
  assert.ok(events.findIndex((e) => e.type === "thought") < events.findIndex((e) => e.type === "status" && /Finishing/.test(e.text)));

  const item = await itemOf(w.db);
  assert.equal(item.status, "ready");
  assert.equal(item.generateRequest, undefined);
  const gen = item.generations[out.genId];
  assert.equal(item.currentGen, out.genId);
  assert.equal(item.generatedUrl, gen.url);
  assert.equal(gen.code, "G-0081");
  assert.equal(gen.model, "gemini-3-pro-image");
  assert.equal(gen.method, "full");
  assert.equal(gen.verdict, undefined, "a manual photo carries no verdict");
  assert.equal(item.verdict, undefined);
  assert.equal(item.naming.status, "pending");
  // REAL cost, from the usage: (9000×2 + (80+300)×12 + 1120×120) / 1e6 USD at R17.50.
  assert.equal(gen.costEstimated, false);
  assert.equal(gen.costUsd, 0.157);
  assert.equal(gen.costZar, 2.75);
  assert.equal(gen.usdZar, 17.5);
  // The index moved with the item; the ledger row says "generate".
  assert.equal((await w.db.ref(`${core.BY_STATUS}/ready/${PID}`).once()).val(), 5);
  assert.equal((await w.db.ref(`${core.BY_STATUS}/new/${PID}`).once()).val(), null);
  const decisions = Object.values((await w.db.ref(core.DECISIONS).once()).val());
  assert.deepEqual(decisions.map((d) => d.action), ["generate"]);
  // The learning log: RTDB without the prompt text, the stored record with it.
  const log = (await w.db.ref(`${core.GENLOG}/G-0081`).once()).val();
  assert.equal(log.promptText, undefined);
  assert.match(log.promptSha, /^[0-9a-f]{64}$/);
  assert.equal(log.thoughts, "Placing the hoodie on the fence.");
  assert.equal(log.drafts.length, 1);
  assert.equal(log.inputs.map((i) => i.role).join(","), "plate,layoutDiagram,source");
  assert.equal(w.saved.length, 1);
  assert.match(w.saved[0].path, /\.genlog\.json$/);
  // What the card gets back never carries the log's heavy fields.
  assert.equal(out.item.generations[out.genId].promptText, undefined);
  assert.equal(out.costZar, 2.75);
});

test("regenerate keeps every earlier photo and makes the new one the main photo", async () => {
  const w = await world({ item: { status: "ready", currentGen: "g1", generatedUrl: "https://x/g1.jpg", generations: { g1: { url: "https://x/g1.jpg", at: 1, code: "G-0007", loved: true } }, approvedAt: 9 } });
  const out = await studio.studioGenerate(w.db, { pid: PID }, "junid", w.deps);
  const item = await itemOf(w.db);
  assert.deepEqual(Object.keys(item.generations).sort(), ["g1", out.genId].sort());
  assert.equal(item.generations.g1.loved, true);
  assert.equal(item.currentGen, out.genId);
  assert.equal(item.approvedAt, undefined, "a new lap needs its own Approve");
  assert.equal(item.generations[out.genId].reason, "regenerate");
  const decisions = Object.values((await w.db.ref(core.DECISIONS).once()).val());
  assert.deepEqual(decisions.map((d) => d.action), ["regenerate"]);
});

test("a second tap while a photo is being made is refused — and Gemini is not called", async () => {
  const w = await world({ item: { generateRequest: { at: NOW - 60_000, by: "junid", studio: true } } });
  await assert.rejects(studio.studioGenerate(w.db, { pid: PID }, "junid", w.deps), /already being made/);
  assert.equal(w.calls.filter((c) => c[0] === "image").length, 0);
});

test("a request left by a run that died no longer blocks a tap", async () => {
  const w = await world({ item: { generateRequest: { at: NOW - core.REQUEST_STALE_MS - 60_000, by: "junid", studio: true } } });
  const out = await studio.studioGenerate(w.db, { pid: PID }, "junid", w.deps);
  assert.equal(out.ok, true);
});

test("a failed generation gives the item back with a plain note and nothing else changed", async () => {
  const w = await world({ item: { status: "ready", currentGen: "g1", generatedUrl: "https://x/g1.jpg", generations: { g1: { url: "https://x/g1.jpg", at: 1 } } } });
  w.deps.image = async () => { const e = new Error("Gemini gemini-3-pro-image 503: The model is overloaded"); e.status = 503; throw e; };
  await assert.rejects(studio.studioGenerate(w.db, { pid: PID }, "junid", w.deps), /busy — tap Generate again/);
  const item = await itemOf(w.db);
  assert.equal(item.generateRequest, undefined);
  assert.equal(item.status, "ready");
  assert.equal(item.currentGen, "g1");
  assert.equal(item.lastAttempt.failed, true);
  assert.equal((await w.db.ref(`${core.ROOT}/genSeq`).once()).val(), 80, "no code is spent on a failure");
  assert.equal((await w.db.ref(core.DECISIONS).once()).val(), null);
});

test("an item on the Done tab is never regenerated", async () => {
  const w = await world({ item: { status: "approved" } });
  await assert.rejects(studio.studioGenerate(w.db, { pid: PID }, "junid", w.deps), /not on the New tab/);
  assert.equal(w.calls.length, 0);
});

test("no usage from the API: the cost is the marked estimate, never R0", async () => {
  const w = await world();
  const image = w.deps.image;
  w.deps.image = async (...a) => ({ ...(await image(...a)), usage: null });
  const out = await studio.studioGenerate(w.db, { pid: PID }, "junid", w.deps);
  const gen = (await itemOf(w.db)).generations[out.genId];
  assert.equal(gen.costEstimated, true);
  assert.ok(gen.costZar > 0);
});

test("a category with no plate is refused before any Gemini call", async () => {
  const w = await world({ product: { categoryKey: "perfume" }, item: { categoryKey: "perfume" } });
  await assert.rejects(studio.studioGenerate(w.db, { pid: PID }, "junid", w.deps), /no background/);
  assert.equal(w.calls.filter((c) => c[0] === "image").length, 0);
  assert.equal((await itemOf(w.db)).generateRequest, undefined);
});

// ── A PAID PHOTO IS NEVER LOST; A LATE ONE NEVER CHANGES WHAT JUNID DECIDED ──
const STATS = `${core.ROOT}/stats`;

test("the spend is counted with the photo: real rand added to the total, nothing to the estimated part", async () => {
  const w = await world();
  await studio.studioGenerate(w.db, { pid: PID }, "junid", w.deps);
  const stats = (await w.db.ref(STATS).once()).val();
  assert.deepEqual(stats.totalSpentZar, { ".sv": { increment: 2.75 } });
  assert.deepEqual(stats.generations, { ".sv": { increment: 1 } });
  assert.equal(stats.estimatedPartZar, undefined);
});

test("usage without the image's own token count is NOT priced as real (it would be ten times too low)", async () => {
  const w = await world();
  const image = w.deps.image;
  w.deps.image = async (...a) => ({ ...(await image(...a)), usage: { promptTokenCount: 9000, candidatesTokenCount: 1200 } });
  const out = await studio.studioGenerate(w.db, { pid: PID }, "junid", w.deps);
  const gen = (await itemOf(w.db)).generations[out.genId];
  assert.equal(gen.costEstimated, true);
  assert.ok(gen.costZar > 2, "the list-price estimate of a 2K image");
  assert.deepEqual((await w.db.ref(`${STATS}/estimatedPartZar`).once()).val(), { ".sv": { increment: gen.costZar } });
});

test("the day's rate could not be read: the configured rate is used and the photo says so", async () => {
  const w = await world();
  w.deps.fx = async () => { throw new Error("offline"); };
  const out = await studio.studioGenerate(w.db, { pid: PID }, "junid", w.deps);
  const gen = (await itemOf(w.db)).generations[out.genId];
  assert.equal(gen.usdZarFallback, true);
  assert.equal(gen.usdZar, 18);
});

test("a storage hiccup after Gemini answered is retried — the paid photo lands", async () => {
  const w = await world();
  let fails = 2;
  const file = w.deps.bucket.file;
  w.deps.bucket.file = (p) => {
    const f = file(p);
    return { save: async (...a) => { if (/\/gen_\d+\.jpg$/.test(p) && fails-- > 0) throw new Error("503 backend error"); return f.save(...a); } };
  };
  const out = await studio.studioGenerate(w.db, { pid: PID }, "junid", w.deps);
  assert.equal(out.ok, true);
  assert.equal(w.calls.filter((c) => c[0] === "image").length, 1, "Gemini is never called again for it");
  assert.equal((await itemOf(w.db)).currentGen, out.genId);
});

test("storage down for good after Gemini answered: Junid is told it was charged, the item is given back, Gemini was called once", async () => {
  const w = await world();
  const file = w.deps.bucket.file;
  w.deps.bucket.file = (p) => (/\/gen_\d+\.jpg$/.test(p) ? { save: async () => { throw new Error("503 backend error"); } } : file(p));
  await assert.rejects(studio.studioGenerate(w.db, { pid: PID }, "junid", w.deps), /made but could not be stored — it was charged/);
  assert.equal(w.calls.filter((c) => c[0] === "image").length, 1);
  const item = await itemOf(w.db);
  assert.equal(item.generateRequest, undefined);
  assert.match(item.lastAttempt.reason, /charged/);
});

test("a failed regenerate leaves the item EXACTLY as it was: name, approval lap and rejection untouched", async () => {
  const before = { status: "rejected", currentGen: "g1", generatedUrl: "https://x/g1.jpg", generations: { g1: { url: "https://x/g1.jpg", at: 1 } },
    suggestedName: "Fleece hoodie in grey", rejection: { code: "junid", reason: "colour off" }, destinations: { shopify: { at: 3 } } };
  const w = await world({ item: before });
  w.deps.image = async () => { const e = new Error("Gemini gemini-3-pro-image 500: internal"); e.status = 500; throw e; };
  await assert.rejects(studio.studioGenerate(w.db, { pid: PID }, "junid", w.deps), /could not be made — tap Generate again/);
  const item = await itemOf(w.db);
  for (const k of Object.keys(before)) assert.deepEqual(item[k], before[k], k);
  assert.equal(item.lastAttempt.reason, "the photo could not be made — tap Generate again", "a fixed sentence: no upstream text reaches the card");
});

test("skipped while its photo was being made: the photo is only ADDED — the item stays skipped, nothing is named or shown", async () => {
  const w = await world();
  const image = w.deps.image;
  w.deps.image = async (...a) => {
    const cur = await itemOf(w.db);
    const next = { ...cur, status: "skipped", skippedFrom: "new" };
    delete next.generateRequest;
    await w.db.ref(`${core.ITEMS}/${PID}`).set(next);
    return image(...a);
  };
  const out = await studio.studioGenerate(w.db, { pid: PID }, "junid", w.deps);
  assert.equal(out.addedOnly, true);
  const item = await itemOf(w.db);
  assert.equal(item.status, "skipped");
  assert.ok(item.generations[out.genId].url, "the paid photo is kept");
  assert.equal(item.currentGen, undefined);
  assert.equal(item.generatedUrl, undefined);
  assert.equal(item.naming, undefined);
});

test("JUNID'S APPROVE IS FINAL: a run that outlives its claim never replaces the photo he approved", async () => {
  const w = await world({ item: { status: "ready", currentGen: "g1", generatedUrl: "https://x/g1.jpg", generations: { g1: { url: "https://x/g1.jpg", at: 1 } }, suggestedName: "Approved name" } });
  const image = w.deps.image;
  w.deps.image = async (...a) => {
    // Meanwhile (the claim went stale) Junid approved the photo he was looking at.
    const cur = await itemOf(w.db);
    const next = { ...cur, status: "approved", approvedAt: NOW + 5, approvedBy: "junid" };
    delete next.generateRequest;
    await w.db.ref(`${core.ITEMS}/${PID}`).set(next);
    return image(...a);
  };
  const out = await studio.studioGenerate(w.db, { pid: PID }, "junid", w.deps);
  const item = await itemOf(w.db);
  assert.equal(item.status, "approved");
  assert.equal(item.approvedAt, NOW + 5);
  assert.equal(item.currentGen, "g1");
  assert.equal(item.generatedUrl, "https://x/g1.jpg", "the chain publishes generatedUrl: it is still the approved photo");
  assert.equal(item.suggestedName, "Approved name");
  assert.ok(item.generations[out.genId].url);
  assert.equal(out.addedOnly, true);
});

test("a second run's claim is never cleared by the first run landing", async () => {
  const w = await world();
  const image = w.deps.image;
  const other = { at: NOW + 999_999, by: "junid", studio: true };
  w.deps.image = async (...a) => { await w.db.ref(`${core.ITEMS}/${PID}/generateRequest`).set(other); return image(...a); };
  const out = await studio.studioGenerate(w.db, { pid: PID }, "junid", w.deps);
  const item = await itemOf(w.db);
  assert.deepEqual(item.generateRequest, other);
  assert.ok(item.generations[out.genId].url);
  assert.equal(item.currentGen, undefined);
});

test("photos are fetched only from the app's own storage, over https, with no redirect followed", async () => {
  const seen = [];
  const fetchImpl = async (u, init) => { seen.push([String(u), init.redirect]); return { ok: true, headers: { get: () => "10" }, arrayBuffer: async () => new ArrayBuffer(10) }; };
  await assert.rejects(studio.fetchBytes("http://firebasestorage.googleapis.com/a", { fetchImpl }), /own storage/);
  await assert.rejects(studio.fetchBytes("https://169.254.169.254/computeMetadata/v1/", { fetchImpl }), /own storage/);
  await assert.rejects(studio.fetchBytes("https://evil.example/firebasestorage.googleapis.com/a", { fetchImpl }), /own storage/);
  await assert.rejects(studio.fetchBytes("not a url", { fetchImpl }), /not a web address/);
  assert.equal(seen.length, 0);
  assert.equal((await studio.fetchBytes("https://firebasestorage.googleapis.com/v0/b/x/o/p.jpg?alt=media", { fetchImpl })).buffer.length, 10);
  assert.deepEqual(seen.map((s) => s[1]), ["error"]);
  await assert.rejects(studio.fetchBytes("https://storage.googleapis.com/x", { fetchImpl: async () => ({ ok: true, headers: { get: () => String(41 * 1024 * 1024) }, arrayBuffer: async () => new ArrayBuffer(1) }) }), /too large/);
});

test("a failing run never clears a request that is not its own", async () => {
  const w = await world();
  const other = { at: NOW + 999_999, by: "junid", studio: true };
  w.deps.image = async () => { await w.db.ref(`${core.ITEMS}/${PID}/generateRequest`).set(other); const e = new Error("500"); e.status = 500; throw e; };
  await assert.rejects(studio.studioGenerate(w.db, { pid: PID }, "junid", w.deps), /could not be made/);
  const item = await itemOf(w.db);
  assert.deepEqual(item.generateRequest, other);
  assert.equal(item.lastAttempt, undefined, "the other run's item is not marked failed");
});

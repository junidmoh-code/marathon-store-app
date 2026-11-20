// ONE SHARED GENERATOR (Junid, 20 Nov 2026). Every in-app Generate — New
// Arrivals' newArrivalsStudio and Black Friday's bfGenerate — must make its
// photo with the SAME function (studio.mjs generate), the SAME model, the SAME
// prompt, the SAME size and the SAME composition and finishing. This file fails
// the moment any Generate path drifts from that, and pins the restored request
// to the last-good New Arrivals photos (4 Oct 2026, G-0101 and G-0119).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sharp = require("sharp");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { _internals: na } = require("../newArrivals/studio.js");
const bf = require("../blackFriday/generate.js")._internals;
const generation = require("../newArrivals/studio/config/generation.json");
const spec = require("../newArrivals/studio/config/layout-spec.json");
const lastGood = require("./fixtures/last-good-na-requests.json");
const { CONDITION_CLAUSE } = require("../lib/photo-prompt.cjs");

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const jpeg = (w, h, colour) => sharp({ create: { width: w, height: h, channels: 3, background: colour } }).jpeg().toBuffer();
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const PID = "p1791099990000";

/** The same product, plate, reference, source photo and model answer for both cards. */
async function shared() {
  const plate = { buffer: await jpeg(543, 724, "#888"), width: 543, height: 724, file: "fence-single.png" };
  const shoePlate = { buffer: await jpeg(543, 724, "#999"), width: 543, height: 724, file: "footwear-plate.png" };
  const reference = { buffer: await jpeg(300, 400, "#444"), width: 300, height: 400, file: "footwear-reference.png" };
  const source = await jpeg(400, 500, "#a52");
  const answer = await jpeg(1792, 2400, "#357");
  return { plate, shoePlate, reference, source, answer };
}

function recorder(calls, answer) {
  return async (model, parts, imageConfig) => {
    calls.push({ model, imageConfig, texts: parts.filter((p) => p.text).map((p) => p.text), images: parts.filter((p) => !p.text).map((p) => sha(JSON.stringify(p))) });
    return { buffer: answer, mime: "image/jpeg", usage: { promptTokenCount: 9000, candidatesTokenCount: 2000, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 2000 }] }, request: { imageConfig } };
  };
}

function assetsFor(s, kind) {
  return {
    loadPlate: async (k) => (k === "footwear" ? s.shoePlate : s.plate),
    loadReference: async (k) => (k === "footwear" ? s.reference : null),
    loadPlateFile: async (f) => (f === "footwear-plate.png" ? s.shoePlate : s.plate),
    libraryBox: async () => null,
    loadExamples: async () => [],
    _kind: kind,
  };
}

async function runNewArrivals(product, s) {
  const db = makeFakeDb({
    products: { [PID]: { photoUrl: "https://x/orig.jpg", stockPrice: 300, ...product } },
    new_arrivals: { genSeq: 1, items: { [PID]: { pid: PID, status: "new", enqueuedAt: 5, statusAt: 5, name: product.name, categoryKey: product.categoryKey, originalUrl: "https://x/orig.jpg" } }, by_status: { new: { [PID]: 5 } } },
  });
  const calls = [], uploads = [];
  let clock = 1_791_100_000_000;
  await na.studioGenerate(db, { pid: PID }, "junid", {
    now: () => (clock += 1000),
    bucket: { name: "b", file: (p) => ({ save: async (buf) => { uploads.push({ path: p, buf }); } }) },
    fetchBytes: async () => ({ buffer: s.source }),
    assets: assetsFor(s),
    fx: async () => ({ rate: 18 }),
    image: recorder(calls, s.answer),
  });
  return { calls, master: uploads.find((u) => /\/gen_\d+\.(jpg|png)$/.test(u.path)) };
}

async function runBlackFriday(product, kind, s) {
  const db = makeFakeDb({
    products: { [PID]: { photoUrl: "https://x/orig.jpg", stockPrice: 300, ...product } },
    bf_campaign_2026: { items: { main: { [PID]: { name: product.name, price: 300, qty: 40, kind, photo: "https://x/orig.jpg" } } } },
  });
  const calls = [], uploads = [];
  let clock = 1_791_100_000_000;
  await bf.bfGenerate(db, { pid: PID }, "junid", {
    now: () => (clock += 1000),
    bucket: { name: "b", file: (p) => ({ save: async (buf) => { uploads.push({ path: p, buf }); } }) },
    fetchBytes: async () => ({ buffer: s.source }),
    assets: assetsFor(s),
    fx: async () => ({ rate: 18 }),
    image: recorder(calls, s.answer),
  });
  return { calls, master: uploads.find((u) => /\/gen_\d+\.(jpg|png)$/.test(u.path)) };
}

for (const [label, product, kind] of [
  ["footwear (soccer boots, a brand)", { name: "Adidas F50 Elite Laceless Blue/Lime Soccer Boots", categoryKey: "soccer-boots", brand: "Adidas" }, "sneakers"],
  ["footwear (slides)", { name: "Diesel Big D Slide Navy White", categoryKey: "slides", brand: "Diesel" }, "sneakers"],
  ["clothing (one garment)", { name: "Grey Fleece Hoodie", categoryKey: "hoodies" }, "clothing"],
  ["clothing (a two-piece set)", { name: "Tracksuit Black", categoryKey: "tracksuits" }, "clothing"],
]) {
  test(`SAME REQUEST, SAME PHOTO — ${label}: New Arrivals and Black Friday send the model the identical request and keep the identical master`, async () => {
    const s = await shared();
    const a = await runNewArrivals(product, s);
    const b = await runBlackFriday(product, kind, s);
    assert.equal(a.calls.length, 1); assert.equal(b.calls.length, 1);
    assert.equal(b.calls[0].model, a.calls[0].model, "the same model");
    assert.equal(a.calls[0].model, generation.imageModel);
    assert.deepEqual(b.calls[0].imageConfig, a.calls[0].imageConfig, "the same size and aspect");
    assert.equal(a.calls[0].imageConfig.imageSize, generation.imageSize);
    assert.deepEqual(b.calls[0].texts, a.calls[0].texts, "the same prompt and labels, word for word");
    assert.deepEqual(b.calls[0].images, a.calls[0].images, "the same images (plate, reference, layout diagram, product), in the same order");
    assert.ok(a.master && b.master, "both kept a photo");
    assert.equal(sha(b.master.buf), sha(a.master.buf), "the same finishing, byte for byte");
    assert.match(a.master.path, /\/new_arrivals\/gen_\d+\.jpg$/);
    assert.match(b.master.path, /\/black_friday\/gen_\d+\.jpg$/);
    const m = await sharp(b.master.buf).metadata();
    assert.deepEqual([m.format, m.width, m.height], ["jpeg", 1792, 2389], "the master at the model's full resolution (cropped to the plate's 3:4), JPEG — never the plate's 543 px");
  });
}

test("SAME SIZE AND FINISHING for a kind with no New Arrivals plate (caps, perfume …): the shared generator's model, size and master", async () => {
  const s = await shared();
  const b = await runBlackFriday({ name: "Cap C", categoryKey: "caps-beanies" }, "headwear", s);
  assert.equal(b.calls[0].model, generation.imageModel);
  assert.equal(b.calls[0].imageConfig.imageSize, generation.imageSize);
  const { toMaster } = await import("../newArrivals/studio/compose.mjs");
  assert.equal(sha(b.master.buf), sha(await toMaster(s.answer, s.plate)), "the one finishing step");
});

test("THE LAST-GOOD PROMPTS are rebuilt byte for byte (G-0101 footwear, G-0119 clothing — 4 Oct 2026)", async () => {
  const { studioPrompt } = await import("../newArrivals/studio/prompt.mjs");
  const { placementText } = await import("../newArrivals/studio/compose.mjs");
  for (const g of [lastGood.g0101, lastGood.g0119]) {
    const { kind, categoryKey, productName, boxMode } = g.args;
    const p = studioPrompt({ kind, categoryKey, productName, boxMode, conditionClause: CONDITION_CLAUSE, placement: placementText(kind, spec[kind]), layers: generation.layers });
    assert.equal(p.text, g.promptText, `${g.code}: the prompt drifted from the last-good one`);
    assert.equal(`${p.version}`, g.promptVersion.match(/\((.*)\)$/)[1]);
    assert.equal(g.model, generation.imageModel, `${g.code}: the same model`);
  }
  // The last-good footwear reference is the one sent again.
  const { ROLES } = await import("../newArrivals/studio/compose.mjs");
  assert.equal(ROLES.footwear.reference, lastGood.g0101.inputs.find((i) => i.role === "reference").file);
  assert.equal(ROLES.footwear.plate, lastGood.g0101.inputs.find((i) => i.role === "plate").file);
  assert.equal(ROLES.single.plate, lastGood.g0119.inputs.find((i) => i.role === "plate").file);
  assert.equal(ROLES.single.reference, null, "G-0119 was sent no reference");
  assert.deepEqual(lastGood.g0101.inputs.map((i) => i.role), ["plate", "reference", "layoutDiagram", "source", "box"]);
});

test("THE COMPOSITION is Gemini's own (the last-good setup): no plate-lock cut-and-paste; the settings are the restored ones", () => {
  assert.equal(generation.imageModel, "gemini-3-pro-image");
  assert.equal(generation.imageSize, "4K");
  assert.equal(generation.footwearCorrection, false, "the 5 Oct plate lock pasted the shoe small and the box floating");
  assert.equal(generation.defaultMethod, "full");
  assert.equal(generation.finish, "master-jpeg-q92");
});

test("NO GENERATE PATH HAS ITS OWN MODEL, PROMPT, SIZE OR FINISHING: both callables call studio.generate; nothing else picks a model, a size or encodes the photo", () => {
  const bfSrc = read("blackFriday/generate.js");
  const naSrc = read("newArrivals/studio.js");
  for (const [name, src] of [["blackFriday/generate.js", bfSrc], ["newArrivals/studio.js", naSrc]]) {
    assert.match(src, /studio\.generate\(\{/, `${name} calls the shared generator`);
    assert.doesNotMatch(src, /studio\.generateOne\(|generateOther\(/, `${name} never bypasses studio.generate`);
    assert.doesNotMatch(src, /imageSize\s*:\s*["'`]|["'`][124]K["'`]/, `${name} names no image size of its own`);
    const code = src.split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n"); // comments may name an engine
    assert.doesNotMatch(code, /["'`][^"'`\n]*(gemini-[0-9][^"'`\n]*image|flash-image|gpt-image)[^"'`\n]*["'`]/, `${name} names no image model of its own`);
    assert.doesNotMatch(src, /\.jpeg\(|\.png\(|\.webp\(|toCanvas|toMaster|deps\.finish|finish: async/, `${name} has no finishing step of its own`);
  }
  assert.doesNotMatch(bfSrc, /promptFor\(|textPart\(|imagePart\(/, "Black Friday builds no prompt of its own");
  assert.match(bfSrc, /generation: e\.generation/);
  assert.match(naSrc, /generation: deps\.generation \|\| generation/);
  const studioSrc = read("newArrivals/studio/studio.mjs");
  assert.doesNotMatch(studioSrc, /imageSize\s*:\s*["'`]/, "the shared generator takes its size from generation.json");
  assert.doesNotMatch(studioSrc, /deps\.finish|deps\.lossless|toCanvas\(/, "no caller-supplied or plate-sized finishing");
  assert.equal((studioSrc.match(/await toMaster\(/g) || []).length, 2, "generateOne and generateOther both finish with toMaster");
  assert.equal((studioSrc.match(/imageSize: generation\.imageSize/g) || []).length, 2, "generateOne and generateOther both ask generation.imageSize");
});

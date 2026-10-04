// THE SPLIT METHOD: Gemini makes the product on plain grey; code cuts it out,
// places it on Junid's plate at the measured layout and adds a soft shadow.
// Synthetic images: a coloured product on the light-grey background, with the
// soft shadow and slight gradient a real studio photo has.
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createRequire } from "node:module";
import { cutOut, greyMatte, toeDirection } from "../newArrivals/studio/cutout.mjs";
import { classifyFootwear, composeOnPlate, trimPng } from "../newArrivals/studio/place.mjs";
import { splitGenerate, cutProblem, COVERAGE_MIN } from "../newArrivals/studio/split.mjs";
import { SPLIT_PROMPT_VERSION } from "../newArrivals/studio/split-prompts.mjs";

const require = createRequire(import.meta.url);
const spec = require("../newArrivals/studio/config/layout-spec.json");
const GREY = "#DEDEDE";
const svg = (w, h, body) => Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E2E2E2"/><stop offset="1" stop-color="#D8D8D8"/></linearGradient><filter id="b"><feGaussianBlur stdDeviation="14"/></filter></defs><rect width="${w}" height="${h}" fill="url(#g)"/>${body}</svg>`);
const png = (w, h, body) => sharp(svg(w, h, body)).png().toBuffer();
// A red "shoe" (a wedge, toe to the right) with a soft shadow under it, and optionally its orange box.
const shoeOnGrey = ({ box = false } = {}) => png(1200, 900,
  `<ellipse cx="520" cy="655" rx="330" ry="26" fill="#9a9a9a" filter="url(#b)"/>
   <path d="M 200 640 L 200 470 Q 330 430 470 470 L 760 560 Q 850 590 850 640 Z" fill="#c0261d"/>
   ${box ? '<rect x="900" y="330" width="240" height="310" fill="#e08a1e"/>' : ""}`);
const garmentOnGrey = (fill = "#1d3f8a") => png(900, 1200, `<path d="M 300 150 L 600 150 L 760 330 L 660 420 L 620 370 L 620 1050 L 280 1050 L 280 370 L 240 420 L 140 330 Z" fill="${fill}"/>`);
const plateOf = async (w, h) => ({ buffer: await sharp({ create: { width: w, height: h, channels: 3, background: "#404448" } }).jpeg().toBuffer(), width: w, height: h, file: "plate" });

test("the grey is flooded away from the edges — through the soft shadow and the gradient — and the product is kept whole", async () => {
  const cut = await cutOut(await shoeOnGrey(), { pieces: 2 });
  assert.equal(cut.pieces.length, 1, "the shadow is not a piece");
  const p = cut.pieces[0];
  // The wedge: 650 wide, ~210 tall — within a few pixels of what was drawn.
  assert.ok(Math.abs(p.width - 650) <= 12 && Math.abs(p.height - 210) <= 14, `${p.width}×${p.height}`);
  assert.ok(cut.coverage > COVERAGE_MIN && cut.coverage < 0.2);
  assert.equal(cutProblem(cut), null);
  assert.equal(toeDirection(p), "right");
});

test("a shoe and its box are two pieces: the more rectangular one is the box", async () => {
  const cut = await cutOut(await shoeOnGrey({ box: true }), { pieces: 2 });
  assert.equal(cut.pieces.length, 2);
  const c = classifyFootwear(cut.pieces);
  assert.ok(c.packaging && c.packaging.fill > 0.9);
  assert.ok(c.shoe.width > c.shoe.height);
  assert.equal(c.pair, false);
});

test("a product the colour of the background cannot be cut out — the split method says so instead of placing a mess", async () => {
  const cut = await cutOut(await garmentOnGrey(GREY), { pieces: 1 });
  assert.match(cutProblem(cut), /could not be told apart|almost nothing was left/);
  // A white garment on the grey is far enough from it to be cut cleanly.
  const white = await cutOut(await garmentOnGrey("#FFFFFF"), { pieces: 1 });
  assert.equal(cutProblem(white), null);
  assert.ok(white.pieces[0].height > 880 && white.pieces[0].height < 920);
});

test("the matte never eats a coloured product that touches the picture's edge", async () => {
  const buf = await png(600, 600, '<rect x="0" y="200" width="300" height="200" fill="#1d8a3f"/>');
  const { data, info } = await sharp(await greyMatte(buf)).raw().toBuffer({ resolveWithObject: true });
  const alphaAt = (x, y) => data[(y * info.width + x) * 4 + 3];
  assert.equal(alphaAt(100, 300), 255);
  assert.equal(alphaAt(500, 100), 0);
});

test("placement: the shoe's heel, toe and sole land on the measured layout; the box sits in the rail slot; the plate is untouched elsewhere", async () => {
  const cut = await cutOut(await shoeOnGrey({ box: true }), { pieces: 2 });
  const c = classifyFootwear(cut.pieces);
  const plate = await plateOf(1086, 1448);
  const out = await composeOnPlate({ kind: "footwear", plate, spec: spec.footwear, packagingAt: "rail", parts: { shoe: await trimPng(c.shoe), box: await trimPng(c.packaging) } });
  const near = (a, b, tol = 0.004) => Math.abs(a - b) <= tol;
  assert.ok(near(out.placed.shoe.left, spec.footwear.shoe.heelX) && near(out.placed.shoe.right, spec.footwear.shoe.toeX) && near(out.placed.shoe.bottom, spec.footwear.shoe.soleY), JSON.stringify(out.placed.shoe));
  // The box: inside the measured rail slot, centred on it.
  const b = out.placed.box, s = spec.footwear.box;
  assert.ok(b.left >= s.left - 0.004 && b.right <= s.right + 0.004 && b.top >= s.top - 0.004 && b.bottom <= s.bottom + 0.004, JSON.stringify(b));
  assert.ok(near((b.left + b.right) / 2, (s.left + s.right) / 2, 0.006));
  // The result is the plate's own size, and a corner far from the product is still the plate's colour.
  const m = await sharp(out.buffer).metadata();
  assert.deepEqual([m.width, m.height], [1086, 1448]);
  const px = await sharp(out.buffer).extract({ left: 5, top: 5, width: 1, height: 1 }).raw().toBuffer();
  assert.ok(Math.abs(px[0] - 0x40) <= 3 && Math.abs(px[1] - 0x44) <= 3 && Math.abs(px[2] - 0x48) <= 3);
  // A soft shadow was added under the shoe: just below the sole the plate is darker than the plate.
  const under = await sharp(out.buffer).extract({ left: Math.round(0.5 * 1086), top: Math.round(spec.footwear.shoe.soleY * 1448) + 3, width: 1, height: 1 }).raw().toBuffer();
  assert.ok(under[0] < 0x40 - 4, `shadow under the sole: ${under[0]}`);
});

// ── the whole split generation, with a fake Gemini ───────────────────────────
async function run({ kind, image, product = {}, libraryBoxPng = null, boxMode = "none", box = null }) {
  const uploads = [];
  const events = [];
  const plate = await plateOf(1086, 1448);
  const calls = [];
  const res = await splitGenerate({
    item: { pid: "p1791099990000", name: "Thing" }, product, genId: "g1", kind, orig: await sharp({ create: { width: 300, height: 300, channels: 3, background: "#777" } }).jpeg().toBuffer(),
    originalUrl: "https://x/o.jpg", box, boxMode, boxFrom: box ? { url: "https://x/box.jpg" } : null, brand: "nike", libraryBoxPng, say: (e) => events.push(e),
    deps: {
      loadPlate: async () => plate, spec, generation: { imageModel: "gemini-3-pro-image", imageSize: "2K" }, conditionClause: "C".repeat(250),
      now: (() => { let t = 1000; return () => (t += 1); })(),
      upload: async (path, buf, mime) => { uploads.push({ path, bytes: buf.length, mime }); return { path, url: `https://s/${path}` }; },
      image: async (model, parts, imageConfig, opts) => {
        calls.push({ model, parts, imageConfig });
        await opts.onEvent({ type: "thought", text: "A clean product on grey." });
        return { buffer: image, mime: "image/png", thoughts: "A clean product on grey.", thoughtImages: 0, usage: { promptTokenCount: 10 }, request: { imageConfig }, requestMs: 5 };
      },
    },
  });
  return { res, uploads, events, calls };
}

test("split, one garment: ONE call for the product alone (no plate sent); the placed photo is the generation; Gemini's own photo is kept beside it", async () => {
  const { res, uploads, events, calls } = await run({ kind: "single", image: await garmentOnGrey() });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "gemini-3-pro-image");
  assert.deepEqual(calls[0].imageConfig, { aspectRatio: "3:4", imageSize: "2K" });
  // The prompt, the garment photo label and the garment photo — nothing of the plate.
  assert.equal(calls[0].parts.length, 3);
  assert.match(calls[0].parts[0].text, /light-grey studio background/);
  assert.equal(res.method, "split");
  assert.equal(res.promptVersion, `${SPLIT_PROMPT_VERSION} (split)`);
  assert.equal(res.note, undefined);
  assert.match(res.generated.path, /gen_\d+\.jpg$/);
  assert.deepEqual(uploads.map((u) => (/-product\.jpg$/.test(u.path) ? "product" : "placed")), ["product", "placed"]);
  assert.match(res.trace.split.productImage.path, /-product\.jpg$/);
  assert.ok(res.trace.split.placed.garment);
  assert.ok(events.some((e) => e.type === "status" && /Placing it on your backdrop/.test(e.text)));
  assert.ok(res.measurements && "background" in res.measurements);
});

test("split, a shoe with no box in the photo: the brand's library box is placed by code on the rail — never sent to Gemini", async () => {
  const lib = await sharp({ create: { width: 400, height: 260, channels: 4, background: "#e85d04" } }).png().toBuffer();
  const { res, calls } = await run({ kind: "footwear", image: await shoeOnGrey(), libraryBoxPng: lib, product: { brand: "Nike" } });
  assert.equal(calls[0].parts.length, 3, "only the prompt and the shoe photo");
  assert.equal(res.box.mode, "library");
  assert.ok(res.trace.split.placed.box, "the box is on the rail");
  assert.equal(res.trace.split.toe, "right");
});

test("split, a shoe with its own box photo: Gemini is shown the box and keeps it; code puts it on the rail", async () => {
  const boxPhoto = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#e08a1e" } }).jpeg().toBuffer();
  const { res, calls } = await run({ kind: "footwear", image: await shoeOnGrey({ box: true }), boxMode: "own", box: boxPhoto });
  assert.equal(calls[0].parts.length, 5);
  assert.equal(calls[0].parts[3].text, "BOX PHOTO — this shoe's own box:");
  assert.equal(res.box.mode, "own");
  assert.equal(res.packaging, "kept");
});

test("split that cannot place the product keeps Gemini's photo (it is paid for) and says so in plain words", async () => {
  const { res, uploads } = await run({ kind: "single", image: await garmentOnGrey(GREY) });
  assert.equal(uploads.length, 1);
  assert.match(res.generated.path, /-product\.jpg$/);
  assert.match(res.note, /^Split could not place this one — .* try Full Gemini for this item\.$/);
  assert.equal(res.method, "split");
});

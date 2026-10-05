// THE FOOTWEAR PLATE LOCK (Junid, 5 Oct): in the final footwear photo everything
// except the shoe and its box is the ONE fixed plate, pixel for pixel; the shoe
// and box are lifted from Gemini's photo, scaled uniformly to the layout measured
// from G-0102 and placed by code.
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createRequire } from "node:module";
import { correctFootwear, layoutFrom } from "../newArrivals/studio/correct.mjs";
import { liftFromPlate, soleLine, fillHoles, label, stripFromOutside } from "../newArrivals/studio/lift.mjs";
import { placementText, ROLES } from "../newArrivals/studio/compose.mjs";

const require = createRequire(import.meta.url);
const spec = require("../newArrivals/studio/config/layout-spec.json").footwear;
const gen = require("../newArrivals/studio/config/generation.json");
const plates = require("../newArrivals/studio/config/plates.lock.json");
const W = 1086, H = 1448;

// A stand-in for Junid's plate: light mesh, three black rails, a white pedestal with a black front panel.
const scene = ({ pedestal = "#e9e9e6", mark = "", shift = 0, extra = "", mesh = "#3a3a3a", wall = "#cfcfcf", cell = 14 } = {}) => `
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs><pattern id="m" width="${cell}" height="${cell}" patternUnits="userSpaceOnUse"><rect width="${cell}" height="${cell}" fill="${wall}"/><path d="M0 0L${cell} ${cell}M${cell} 0L0 ${cell}" stroke="${mesh}" stroke-width="2.4"/></pattern></defs>
  <rect width="${W}" height="${H}" fill="url(#m)"/>
  ${[0.2, 0.5, 0.8].map((x) => `<rect x="${x * W - 24}" y="0" width="48" height="${H}" fill="#0b0b0b"/>`).join("")}
  <rect x="${132 + shift}" y="${934 + shift}" width="848" height="250" rx="60" fill="${pedestal}"/>
  <rect x="${231 + shift}" y="${1099 + shift}" width="627" height="70" fill="#050505"/>
  ${mark}${extra}
</svg>`;
const png = (svg) => sharp(Buffer.from(svg)).png().toBuffer();
const shoe = (fill, { x = 300, w = 420, y = 880, h = 150 } = {}) => `<path d="M${x} ${y + h} L${x} ${y + h * 0.55} Q${x + w * 0.2} ${y} ${x + w * 0.45} ${y + h * 0.25} L${x + w} ${y + h * 0.7} L${x + w} ${y + h} Z" fill="${fill}"/><rect x="${x + 4}" y="${y + h}" width="${w - 8}" height="3" fill="#6f6f6f"/>`;
const box = (fill, { x = 400, y = 250, w = 280, h = 180 } = {}) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;

let plate;
test.before(async () => { plate = { buffer: await png(scene()), width: W, height: H }; });

const raw = (buf) => sharp(buf).removeAlpha().raw().toBuffer();
/** The largest difference between two finished photos outside the given rectangles (fractions), each widened by `pad` px. */
async function worstOutside(a, b, rects, pad = 56) {
  const [ra, rb] = await Promise.all([raw(a), raw(b)]);
  let worst = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (rects.some((r) => x >= r.left * W - pad && x <= r.right * W + pad && y >= r.top * H - pad && y <= r.bottom * H + pad)) continue;
    const i = 3 * (y * W + x);
    worst = Math.max(worst, Math.abs(ra[i] - rb[i]), Math.abs(ra[i + 1] - rb[i + 1]), Math.abs(ra[i + 2] - rb[i + 2]));
  }
  return worst;
}

test("THREE corrected photos share ONE background: outside the shoe, box and shadow they are identical, pixel for pixel — whatever Gemini did to the pedestal", async () => {
  // Three "Gemini" photos: a worn pedestal with a dark mark; a brighter one; a clean one — different shoes and boxes, differently placed and sized.
  const photos = await Promise.all([
    png(scene({ pedestal: "#dedbd4", mark: `<ellipse cx="190" cy="1150" rx="38" ry="16" fill="#3b3b3b"/>`, extra: shoe("#c8102e") + box("#1f4fd8") })),
    png(scene({ pedestal: "#f4f4f2", extra: shoe("#1e8e3e", { x: 380, w: 300, y: 930, h: 100 }) + box("#f2a900", { x: 330, y: 150, w: 420, h: 300 }) })),
    png(scene({ extra: shoe("#6a1b9a", { x: 250, w: 520, y: 820, h: 210 }) + box("#00838f", { x: 430, y: 300, w: 220, h: 130 }) })),
  ]);
  const out = [];
  for (const photoBuf of photos) out.push(await correctFootwear({ photoBuf, plate, spec }));
  for (const o of out) assert.equal(o.problem, undefined, o.problem);
  const rects = out.flatMap((o) => [o.placed.shoe, o.placed.box]);
  assert.equal(await worstOutside(out[0].buffer, out[1].buffer, rects), 0);
  assert.equal(await worstOutside(out[0].buffer, out[2].buffer, rects), 0);
  assert.equal(await worstOutside(out[1].buffer, out[2].buffer, rects), 0);
  // …and that shared background IS the plate (as a JPEG of the same quality): the dark mark is gone.
  const plain = await sharp(plate.buffer).removeAlpha().jpeg({ quality: 93 }).toBuffer();
  assert.equal(await worstOutside(out[0].buffer, plain, rects), 0);
});

test("every shoe lands at the SAME measured place and size, scaled uniformly: heel, toe and sole line from the layout; the box centred in its place", async () => {
  for (const args of [{ x: 380, w: 300, y: 930, h: 100 }, { x: 250, w: 520, y: 880, h: 150 }]) {
    const o = await correctFootwear({ photoBuf: await png(scene({ extra: shoe("#c8102e", args) + box("#1f4fd8") })), plate, spec });
    assert.equal(o.problem, undefined, o.problem);
    assert.ok(Math.abs(o.placed.shoe.left - spec.shoe.heelX) < 0.004 && Math.abs(o.placed.shoe.right - spec.shoe.toeX) < 0.004, JSON.stringify(o.placed.shoe));
    assert.ok(Math.abs(o.placed.shoe.bottom - spec.shoe.soleY) < 0.004);
    // Uniform: the placed shoe keeps the proportions it had in Gemini's photo (never stretched).
    const aspect = (o.found.shoe.right - o.found.shoe.left) / (o.found.shoe.bottom - o.found.shoe.top);
    const placedAspect = (o.placed.shoe.right - o.placed.shoe.left) / (o.placed.shoe.bottom - o.placed.shoe.top);
    assert.ok(Math.abs(placedAspect - aspect) / aspect < 0.08, `${placedAspect} vs ${aspect}`);
    assert.ok(Math.abs((o.placed.box.left + o.placed.box.right) / 2 - spec.box.centreX) < 0.004);
    assert.ok(o.placed.box.left >= spec.box.left - 0.004 && o.placed.box.right <= spec.box.right + 0.004 && o.placed.box.top >= spec.box.top - 0.004 && o.placed.box.bottom <= spec.box.bottom + 0.004);
  }
});

test("the shoe's own pixels are copied, not recoloured: its colour in the result is the colour Gemini gave it", async () => {
  const o = await correctFootwear({ photoBuf: await png(scene({ extra: shoe("#c8102e") + box("#1f4fd8") })), plate, spec });
  const px = await raw(o.buffer);
  const at = (fx, fy) => { const i = 3 * (Math.round(fy * H) * W + Math.round(fx * W)); return [px[i], px[i + 1], px[i + 2]]; };
  const s = at((spec.shoe.heelX + spec.shoe.toeX) / 2, spec.shoe.soleY - 0.02);
  assert.ok(Math.abs(s[0] - 0xc8) < 14 && s[1] < 60 && s[2] < 80, `shoe ${s}`);
  const b = at(spec.box.centreX, spec.box.centreY);
  assert.ok(b[2] > 180 && b[0] < 70, `box ${b}`);
});

test("no box in Gemini's photo: none is placed, and the shoe is still corrected", async () => {
  const o = await correctFootwear({ photoBuf: await png(scene({ extra: shoe("#c8102e") })), plate, spec });
  assert.equal(o.problem, undefined, o.problem);
  assert.equal(o.placed.box, undefined);
  assert.equal(o.found.box, null);
});

test("it REFUSES rather than guess: no pedestal panel; no shoe; a colourless shoe on a redrawn backdrop", async () => {
  const noPanel = await png(scene({ extra: `<rect x="100" y="900" width="900" height="420" fill="#f1f1ee"/>` + shoe("#c8102e") }));
  assert.match((await correctFootwear({ photoBuf: noPanel, plate, spec })).problem, /pedestal/);
  assert.match((await correctFootwear({ photoBuf: plate.buffer, plate, spec })).problem, /nothing could be told apart|no shoe/);
  // Gemini redrew the whole wall (darker and soft, as it does): a WHITE shoe cannot be trusted from the photo alone…
  const wall = await sharp(await png(scene({ mesh: "#222", wall: "#7d7d7d", cell: 20 }))).blur(2.2).png().toBuffer();
  const redrawn = (fill) => sharp(wall).composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${shoe(fill)}</svg>`) }]).png().toBuffer();
  assert.match((await correctFootwear({ photoBuf: await redrawn("#f6f6f6"), plate, spec })).problem, /no colour/);
  // …a COLOURED one can.
  const ok = await correctFootwear({ photoBuf: await redrawn("#c8102e"), plate, spec });
  assert.equal(ok.problem, undefined, ok.problem);
  assert.match(ok.how, /photo alone/);
});

test("a WHITE shoe on the white pedestal is lifted whole when Gemini kept the backdrop (the G-0102 case)", async () => {
  const o = await liftFromPlate(await png(scene({ pedestal: "#f0f0ee", extra: shoe("#fbfbfb") + box("#0d0d0d") })), plate);
  assert.equal(o.problem, undefined, o.problem);
  assert.match(o.how, /against the plate/);
  // Found where it was drawn (x 300–720, y 880–1033), not cut short and not widened by the pedestal.
  assert.ok(Math.abs(o.found.shoe.left - 300 / W) < 0.012 && Math.abs(o.found.shoe.right - 720 / W) < 0.012, JSON.stringify(o.found.shoe));
  assert.ok(Math.abs(o.found.shoe.bottom - 1033 / H) < 0.008 && Math.abs(o.found.shoe.top - 880 / H) < 0.03, JSON.stringify(o.found.shoe));
  // A black box in front of a black rail is one whole rectangle.
  assert.ok(Math.abs(o.found.box.left - 400 / W) < 0.01 && Math.abs(o.found.box.right - 680 / W) < 0.01, JSON.stringify(o.found.box));
});

test("the sole line is read from the photo's own pedestal: above the panel, and higher where a shoe stands", async () => {
  const photo = await sharp(await png(scene({ extra: shoe("#c8102e") }))).removeAlpha().blur(1.2).raw().toBuffer();
  const line = soleLine(photo, W, H);
  assert.ok(Math.abs(line.panelTop - 1099) <= 2);
  assert.ok(Math.abs(line[500] - 1033) <= 4, `under the shoe: ${line[500]}`);
  assert.ok(Math.abs(line[860] - 934) <= 6, `beside the shoe, the pedestal's back rim: ${line[860]}`);
  assert.equal(soleLine(await sharp(await png(scene({ extra: `<rect x="100" y="900" width="900" height="420" fill="#f1f1ee"/>` }))).removeAlpha().raw().toBuffer(), W, H), null);
});

test("the small tools: holes are filled, groups are labelled, a soft rim is peeled only from outside", () => {
  const m = Uint8Array.from([0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
  assert.equal(fillHoles(m, 5, 5)[12], 1);
  assert.equal(label(m, 5, 5).comps.length, 1);
  const soft = new Uint8Array(25); soft[6] = 1; soft[12] = 1;
  const peeled = stripFromOutside(fillHoles(m, 5, 5), soft, 5, 5);
  assert.equal(peeled[6], 0, "the rim pixel is reached from outside");
  assert.equal(peeled[12], 1, "an inner soft pixel behind a wall stays");
});

test("THE LAYOUT is G-0102's, on the real plate — and its numbers are said outright in the footwear prompt", () => {
  assert.match(spec.measuredFrom, /^G-0102/);
  assert.equal(spec.plateSha, plates["footwear-plate.png"].sha256);
  const ped = { left: spec.pedestal.left, right: spec.pedestal.right, frontEdgeY: spec.pedestal.frontEdgeY, backRimY: spec.pedestal.topY, canvasW: W, canvasH: H };
  const again = layoutFrom({ shoe: { left: spec.shoe.heelX, right: spec.shoe.toeX, top: spec.shoe.topY, bottom: spec.shoe.soleY }, box: spec.box }, ped);
  // The stored figures are the ones the measurement gives (to a rounding step).
  const near = (a, b) => Math.abs(a - b) <= 0.004;
  assert.ok(near(again.measured.shoeLengthOfPedestalWidth, spec.measured.shoeLengthOfPedestalWidth), `${again.measured.shoeLengthOfPedestalWidth}`);
  assert.ok(near(again.measured.soleAbovePedestalFrontEdge, spec.measured.soleAbovePedestalFrontEdge));
  assert.ok(near(again.measured.heelFromPedestalLeft, spec.measured.heelFromPedestalLeft) && near(again.measured.toeFromPedestalRight, spec.measured.toeFromPedestalRight));
  assert.ok(near(again.measured.boxWidthOfFrame, spec.measured.boxWidthOfFrame) && near(again.measured.boxHeightOfFrame, spec.measured.boxHeightOfFrame));
  assert.ok(near(again.measured.boxToPedestalGap, spec.measured.boxToPedestalGap) && near(again.measured.boxToShoeGap, spec.measured.boxToShoeGap));
  // The sole stands ON the pedestal's top surface, forward: between its back rim and its front edge, near the front.
  assert.ok(spec.shoe.soleY > spec.pedestal.topY && spec.shoe.soleY < spec.pedestal.frontEdgeY);
  const text = placementText("footwear", spec);
  for (const said of ["heel at x=20.6%", "toe tip at x=77.2%", "y=72%", "72.4% of the pedestal's width", "8.5% of the frame", "13.1%", "only 2.1% of the frame behind its front edge", "x=49.9%, y=30.1%", "never wider than 34.3%", "never taller than 39.8%", "ends 14.5% of the frame above the pedestal", "never touching it"]) assert.ok(text.includes(said), said);
  // With no box the box sentence is not said.
  assert.ok(!placementText("footwear", { ...spec, box: undefined }).includes("THE BOX"));
});

test("G-0102 is the footwear reference, locked; the correction is switched on", () => {
  assert.equal(ROLES.footwear.reference, "footwear-reference-g0102.jpg");
  assert.match(plates["footwear-reference-g0102.jpg"].sha256, /^[0-9a-f]{64}$/);
  assert.equal(require("../newArrivals/studio/config/baseline.lock.json").footwearLayout.referenceSha256, plates["footwear-reference-g0102.jpg"].sha256);
  assert.equal(gen.footwearCorrection, true);
});

test("a shoe joined to the box above it is NOT cut as one piece; a shoe too tall for the layout, or one that would run into the box, is refused", async () => {
  // The boot's top touches the box: one shape, taller than it is long.
  const joined = await png(scene({ extra: shoe("#c8102e", { x: 330, w: 400, y: 700, h: 330 }) + `<rect x="380" y="520" width="300" height="330" fill="#c8102e"/>` }));
  assert.match((await correctFootwear({ photoBuf: joined, plate, spec })).problem, /told apart/);
  // A stand-in lift: a shoe far taller than long cannot be fitted under the box at half the layout's length.
  const piece = (w, h, fill) => sharp({ create: { width: w, height: h, channels: 4, background: fill } }).png().toBuffer();
  const tall = async () => ({ shoe: await piece(200, 900, "#c8102e"), box: await piece(300, 200, "#1f4fd8"), found: { shoe: { left: 0.3, top: 0.2, right: 0.5, bottom: 0.7 }, box: { left: 0.3, top: 0.05, right: 0.6, bottom: 0.19 } }, how: "test" });
  assert.match((await correctFootwear({ photoBuf: plate.buffer, plate, spec, lift: tall })).problem, /too tall/);
  // With no room at all under the box, the shoe would run into it: refused, never drawn over the box.
  const squeezed = { ...spec, box: { ...spec.box, top: 0.3, bottom: 0.75 } };
  const boot = async () => ({ shoe: await piece(600, 500, "#c8102e"), box: await piece(300, 600, "#1f4fd8"), found: { shoe: { left: 0.2, top: 0.4, right: 0.7, bottom: 0.7 }, box: null }, how: "test" });
  assert.match((await correctFootwear({ photoBuf: plate.buffer, plate, spec: squeezed, lift: boot })).problem, /overlap the box|too tall/);
});

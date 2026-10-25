// meta-ready.cjs — square, product ~80%, background edge to edge, no white frame.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { plan, whiteFrame, makeMetaReady } = require("../lib/meta-ready.cjs");

let sharp = null;
try { sharp = require("sharp"); } catch { try { sharp = require(path.join(__dirname, "../../node_modules/sharp")); } catch { /* skipped below */ } }

// A W×H RGB raster: white frame `f` px, grey studio background, a dark product box.
function studio(W, H, f, box) {
  const px = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    let c = [255, 255, 255];
    if (x >= f && x < W - f && y >= f && y < H - f) c = [150, 160, 170];
    if (x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1) c = [20, 30, 40];
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
  }
  return px;
}

test("a white frame is found and cut, on every side", () => {
  const px = studio(200, 300, 20, { x0: 80, y0: 120, x1: 120, y1: 180 });
  assert.deepEqual(whiteFrame(px, 200, 300), { t: 20, b: 20, l: 20, r: 20 });
});

test("the plan: frame cut, product box → square of side box/0.8, centred, background colour fill", () => {
  const px = studio(200, 300, 20, { x0: 60, y0: 100, x1: 140, y1: 200 }); // product 80×100
  const p = plan({ px, w: 200, h: 300 }, 200, 300);
  assert.deepEqual(p.inner, { left: 22, top: 22, width: 156, height: 256 });   // frame + its 2px seam
  assert.equal(p.side, 125);                 // 100 / 0.8
  assert.equal(p.fill.mode, "colour");
  assert.deepEqual(p.fill.colour, { r: 150, g: 160, b: 170 });   // the studio grey — never the white frame
  assert.equal(p.found, true);
  // The window fits inside the inner image here, so nothing is extended.
  assert.deepEqual(p.pad, { left: 0, top: 0, right: 0, bottom: 0 });
});

test("a product wider than its photo is extended past the edges, not shrunk", () => {
  const px = studio(200, 100, 0, { x0: 5, y0: 20, x1: 195, y1: 80 });   // wide product, tight crop
  const p = plan({ px, w: 200, h: 100 }, 200, 100);
  assert.equal(p.side, 238);                 // 190 / 0.8
  assert.ok(p.pad.top > 0 && p.pad.bottom > 0 && p.pad.left > 0 && p.pad.right > 0);
});

test("a scene (non-uniform background) is mirrored outwards, not filled with a flat colour", () => {
  const W = 120, H = 160, px = new Uint8Array(W * H * 3);
  for (let i = 0; i < px.length; i++) px[i] = (i * 37) % 256;     // noisy scene
  assert.equal(plan({ px, w: W, h: H }, W, H).fill.mode, "mirror");
});

test("end to end with sharp: 1080² JPEG, no white left on the edges of a framed studio shot", { skip: !sharp && "sharp not installed here" }, async () => {
  const W = 600, H = 900;
  const raw = Buffer.from(studio(W, H, 60, { x0: 220, y0: 330, x1: 380, y1: 570 }));
  const jpg = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg().toBuffer();
  const { buffer, info } = await makeMetaReady(sharp, jpg);
  assert.equal(info.width, 1080); assert.equal(info.height, 1080);
  const { data, info: oi } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  assert.equal(oi.width, 1080); assert.equal(oi.height, 1080);
  // Every edge pixel is the studio grey, not white.
  for (const [x, y] of [[0, 0], [1079, 0], [0, 1079], [1079, 1079], [540, 0], [0, 540], [1079, 540], [540, 1079]]) {
    const i = (y * 1080 + x) * oi.channels;
    assert.ok(Math.abs(data[i] - 150) < 12 && Math.abs(data[i + 2] - 170) < 12, `edge (${x},${y}) is ${data[i]},${data[i + 1]},${data[i + 2]}`);
  }
  // The product's longer side is ~80% of the frame.
  let top = -1, bottom = -1;
  for (let y = 0; y < 1080; y++) { const i = (y * 1080 + 540) * oi.channels; if (data[i] < 80) { if (top < 0) top = y; bottom = y; } }
  const share = (bottom - top + 1) / 1080;
  assert.ok(share > 0.76 && share < 0.84, `product fills ${share.toFixed(3)}`);
});

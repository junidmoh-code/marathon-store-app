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

test("a product tight in a landscape photo: the square runs past the photo and is extended with the backdrop colour", () => {
  // A 140×80 ellipse (a product has a rounded top, not a ruler-straight one) on a 200×100 grey studio.
  const px = studio(200, 100, 0, { x0: 0, y0: 0, x1: 0, y1: 0 });
  for (let y = 0; y < 100; y++) for (let x = 0; x < 200; x++) {
    if (((x - 100) / 70) ** 2 + ((y - 50) / 40) ** 2 <= 1) { const i = (y * 200 + x) * 3; px[i] = 20; px[i + 1] = 30; px[i + 2] = 40; }
  }
  const p = plan({ px, w: 200, h: 100 }, 200, 100);
  assert.deepEqual(p.frame, { t: 0, b: 0, l: 0, r: 0 });                  // a backdrop is never cut as a frame
  assert.ok(Math.abs(p.side - 175) <= 3, `side ${p.side}`);              // ~140 / 0.8
  assert.ok(p.pad.top > 0 && p.pad.bottom > 0);
  assert.deepEqual(p.fill, { mode: "colour", colour: { r: 150, g: 160, b: 170 } });
});

test("a product on plain white is NOT a framed photo: white is its backdrop, filled edge to edge", () => {
  const W = 200, H = 260, px = new Uint8Array(W * H * 3).fill(255);
  for (let y = 80; y < 180; y++) for (let x = 60; x < 140; x++) { const i = (y * W + x) * 3; px[i] = 30; px[i + 1] = 60; px[i + 2] = 200; }
  const p = plan({ px, w: W, h: H }, W, H);
  assert.deepEqual(p.frame, { t: 0, b: 0, l: 0, r: 0 });
  assert.equal(p.side, 125);
  assert.equal(p.fill.mode, "colour");
});

test("a screenshot's dark border is cut like a white one", () => {
  const W = 200, H = 300, px = new Uint8Array(W * H * 3).fill(18);   // dark UI
  for (let y = 30; y < 270; y++) for (let x = 20; x < 180; x++) { const i = (y * W + x) * 3; px[i] = 150; px[i + 1] = 160; px[i + 2] = 170; }
  for (let y = 120; y < 200; y++) for (let x = 70; x < 130; x++) { const i = (y * W + x) * 3; px[i] = 240; px[i + 1] = 20; px[i + 2] = 20; }
  assert.deepEqual(whiteFrame(px, W, H), { t: 30, b: 30, l: 20, r: 20 });
});

test("a scene (non-flat backdrop) is CUT to a square inside the photo — never extended, so no seams", () => {
  const W = 120, H = 160, px = new Uint8Array(W * H * 3);
  for (let i = 0; i < px.length; i++) px[i] = (i * 37) % 256;     // noisy scene
  const p = plan({ px, w: W, h: H }, W, H);
  assert.equal(p.fill.mode, "cut");
  assert.deepEqual(p.pad, { left: 0, top: 0, right: 0, bottom: 0 });
  assert.equal(p.crop.width, p.crop.height);
  assert.ok(p.crop.width <= 120);
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

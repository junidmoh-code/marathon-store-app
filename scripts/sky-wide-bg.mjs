#!/usr/bin/env node
// ─── THE DESKTOP SKY = THE PHONE SKY, WIDENED (Junid, 12 Nov) ────────────────
// Junid: "the exact same background" on the computer as on the phone. The phone
// shows public/assets/sky-clear-phone.jpg (851x1849) WHOLE: deep blue at the top
// (rgb 7,108,228) running to pale at the bottom (101,183,252), clouds on the
// left and right edges. A landscape screen cannot show a portrait photo whole
// without cropping it to a band (the last attempt) or distorting it.
//
// So the photo is widened to 16:10 at its full height, keeping every pixel's
// row: its left half stays at the left edge, its right half at the right edge
// (the phone's clouds where the phone has them), and the middle is the photo's
// own clear centre column (median of x 380..470 per row, smoothed over 9 rows so
// JPEG noise does not band) stretched sideways, with a 90px feather where they
// meet. Top to bottom the desktop therefore walks the phone's exact blues. No
// overlay, tint or gradient is drawn over the page — this is the photo file.
// Deterministic and local: re-running writes the same file.
//   node scripts/sky-wide-bg.mjs
import sharp from "sharp";

const SRC = "public/assets/sky-clear-phone.jpg";
const OUT = "public/assets/sky-clear-wide.jpg";
const OUT_W = 1702, OUT_H = 1064;
const COL0 = 380, COL1 = 470, FEATHER = 90, SMOOTH = 4;

const { data, info } = await sharp(SRC).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: w, height: h } = info;
if (w !== 851 || h !== 1849) throw new Error(`expected ${SRC} at 851x1849, got ${w}x${h}`);
const px = (x, y, c) => data[(y * w + x) * 3 + c];

// Per-row median of the clear centre, then a small vertical box blur.
const med = new Float32Array(h * 3);
const tmp = [];
for (let y = 0; y < h; y++) for (let c = 0; c < 3; c++) {
  tmp.length = 0;
  for (let x = COL0; x < COL1; x++) tmp.push(px(x, y, c));
  tmp.sort((a, b) => a - b);
  med[y * 3 + c] = tmp[tmp.length >> 1];
}
const col = new Float32Array(h * 3);
for (let y = 0; y < h; y++) for (let c = 0; c < 3; c++) {
  let s = 0, n = 0;
  for (let k = -SMOOTH; k <= SMOOTH; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += med[yy * 3 + c]; n++; } }
  col[y * 3 + c] = s / n;
}

const W = Math.round(h * 1.6), half = w >> 1;
const out = Buffer.alloc(W * h * 3);
for (let y = 0; y < h; y++) for (let x = 0; x < W; x++) {
  let srcX = -1, a = 0;
  if (x < half) { srcX = x; a = x >= half - FEATHER ? (half - x) / FEATHER : 1; }
  else if (x >= W - half) { const i = x - (W - half); srcX = w - half + i; a = i < FEATHER ? i / FEATHER : 1; }
  for (let c = 0; c < 3; c++) {
    const fill = col[y * 3 + c];
    const v = srcX >= 0 ? px(srcX, y, c) * a + fill * (1 - a) : fill;
    out[(y * W + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(v)));
  }
}
await sharp(out, { raw: { width: W, height: h, channels: 3 } })
  .resize(OUT_W, OUT_H, { kernel: "lanczos3" })
  .jpeg({ quality: 88, mozjpeg: true })
  .toFile(OUT);
console.log(`${OUT}: ${SRC} widened to ${W}x${h} (edges kept, clear centre column between), ${OUT_W}x${OUT_H}`);

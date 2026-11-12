#!/usr/bin/env node
// ─── THE DESKTOP SKY = A CROP OF THE PHONE SKY (Junid, 12 Nov) ───────────────
// Junid prefers the phone's blue. The phone shows public/assets/sky-clear-phone.jpg
// (851x1849) whole; the desktop showed a different photo (sky-clear.jpg), paler
// in the middle (mean rgb 46,167,253 vs the phone's 41,144,248). This cuts a
// 16:10 band out of the PHONE photo — full width, rows 380..912, the deep open
// sky with the phone's clouds on the right — and upsizes it (Lanczos) to
// 1702x1064 for wide screens. Same pixels, same blues; nothing is drawn over it.
// Deterministic and local: re-running writes the same file.
//   node scripts/sky-wide-bg.mjs
import sharp from "sharp";

const SRC = "public/assets/sky-clear-phone.jpg";
const OUT = "public/assets/sky-clear-wide.jpg";
const TOP = 380;                       // first source row of the band
const W = 851, H = Math.round(W / 1.6); // 532 rows: a 16:10 band

const meta = await sharp(SRC).metadata();
if (meta.width !== W) throw new Error(`expected ${SRC} to be ${W}px wide, got ${meta.width}`);
await sharp(SRC)
  .extract({ left: 0, top: TOP, width: W, height: H })
  .resize(W * 2, H * 2, { kernel: "lanczos3" })
  .jpeg({ quality: 86, mozjpeg: true })
  .toFile(OUT);
console.log(`${OUT}: rows ${TOP}..${TOP + H} of ${SRC}, ${W * 2}x${H * 2}`);

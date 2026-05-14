// One-time PWA icon generator.
// Re-run with `node scripts/generate-icons.mjs` whenever the source image
// changes. The source is a square SVG letter mark (black bg, blue M) at
// public/icons/icon-source.svg — swap that file (or repoint SOURCE) when
// a proper brand logo is available.

import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE   = resolve(__dirname, "../public/icons/icon-source.png");
const OUT_DIR  = resolve(__dirname, "../public/icons");
mkdirSync(OUT_DIR, { recursive: true });

// Center-crop a square out of the source, then resize to the requested edge.
async function squareIcon(size, outFile) {
  const meta = await sharp(SOURCE).metadata();
  const edge = Math.min(meta.width, meta.height);
  const left = Math.round((meta.width  - edge) / 2);
  const top  = Math.round((meta.height - edge) / 2);
  await sharp(SOURCE)
    .extract({ left, top, width: edge, height: edge })
    .resize(size, size, { fit: "cover" })
    .png()
    .toFile(resolve(OUT_DIR, outFile));
}

// Maskable: scale the icon to ~80% on a black background so the safe-area
// circle the OS may apply doesn't clip the brand.
async function maskableIcon(size, outFile) {
  const inner = Math.round(size * 0.8);
  const meta = await sharp(SOURCE).metadata();
  const edge = Math.min(meta.width, meta.height);
  const left = Math.round((meta.width  - edge) / 2);
  const top  = Math.round((meta.height - edge) / 2);
  const innerBuf = await sharp(SOURCE)
    .extract({ left, top, width: edge, height: edge })
    .resize(inner, inner, { fit: "cover" })
    .png()
    .toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } }
  })
    .composite([{ input: innerBuf, left: Math.round((size - inner) / 2), top: Math.round((size - inner) / 2) }])
    .png()
    .toFile(resolve(OUT_DIR, outFile));
}

await squareIcon(192, "icon-192.png");
await squareIcon(512, "icon-512.png");
await squareIcon(180, "icon-180-apple.png");
await maskableIcon(192, "icon-192-maskable.png");
await maskableIcon(512, "icon-512-maskable.png");
console.log("Generated 5 icons in", OUT_DIR);

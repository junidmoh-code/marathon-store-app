// ── Fence background texture — extracted from a real product photograph ─────
// Every product on this shop is shot against the same dark diamond expanded-
// metal mesh. The storefront's site-wide background is a tileable crop of
// THAT mesh, not an invented graphic, so the background and the products are
// literally the same surface.
//
// Source: scripts/shopify/assets/fence-source.png — a fence-only crop from a
// real catalogue photo shoot (no product in frame), checked in so this script
// reproduces the exact shipped asset without depending on a one-off file.
//
// Pipeline, in order:
//   1. Extract a fixed region sized to ~8 mesh repeats (found once, by
//      autocorrelating a horizontal scanline — see estimatePitch below — and
//      hardcoded here since the source photo never changes).
//   2. Grayscale, then negate — the wire is dark and the gap is light in the
//      source photo; a dark-theme background needs the opposite: the wire as
//      the (faint) highlight, the gap as the (darker) field.
//   3. A ROUND TRIP THROUGH A PNG BUFFER between negate() and linear() is
//      REQUIRED, not decorative. Chaining .negate().linear(...) in one sharp
//      pipeline with no intermediate encode produced wrong output on this
//      install (sharp 0.34.5 / libvips) — verified by sampling raw pixels at
//      each stage. Splitting the pipeline at a PNG buffer boundary fixed it.
//      If you simplify this file, keep that boundary or re-verify pixel
//      values before shipping.
//   4. linear() compresses the range into a narrow dark band so the result
//      reads as "dark theme background", not "inverted photo".
//   5. A touch of blur softens photographic grain and hides the one visible
//      seam where the crop wraps.
//
//   node scripts/shopify/fence-texture.mjs [output-dir]
//
// Writes fence-tile-mono.png and fence-tile-mono.webp (~13KB) to the output
// dir (default: theme/assets — the shipped location). Nothing is read from or
// written to Shopify or RTDB; this is a pure local image transform.
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "assets", "fence-source.png");
const OUT_DIR = process.argv[2] || path.join(__dirname, "..", "..", "theme", "assets");

// Found once against SRC by autocorrelating a horizontal scanline; the source
// image is fixed (checked in), so this is a constant, not a live computation.
const TILE = { left: 314, top: 810, width: 448, height: 448 };

async function main() {
  const negated = await sharp(SRC)
    .extract(TILE)
    .grayscale()
    .negate()
    .png()
    .toBuffer();

  const outPng = path.join(OUT_DIR, "fence-tile-mono.png");
  const outWebp = path.join(OUT_DIR, "fence-tile-mono.webp");

  await sharp(negated)
    .linear(0.1116, 15.5) // compress into a narrow dark band (~15-42 of 255)
    .blur(0.5)
    .png({ compressionLevel: 9 })
    .toFile(outPng);

  await sharp(outPng).webp({ quality: 82 }).toFile(outWebp);

  console.log(`wrote ${outPng}`);
  console.log(`wrote ${outWebp}`);
}

main();

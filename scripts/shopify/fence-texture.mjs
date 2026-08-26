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
// Writes fence-tile-mono.{png,webp} (legacy, no longer referenced by the
// theme) and fence-tile-color.{png,webp} — the shipped background asset as of
// the fence-fixed-background revision — to the output dir (default:
// theme/assets). Nothing is read from or written to Shopify or RTDB; this is
// a pure local image transform.
//
// COLOR, NOT INVERTED. The mono pipeline above grayscaled and negated the
// crop so the wire read as a highlight — a deliberate abstraction, but the
// owner asked for the literal photograph's own colourway (dark wire, its real
// mid-grey field) as the background, just dimmed enough to sit behind body
// copy. So fence-tile-color skips grayscale/negate entirely: same crop,
// `linear()` scales the WHOLE image down toward black in place (a<1, tiny b)
// rather than remapping which end is light, which is what "dim a photo"
// means and "invert a photo" does not. Contrast between wire and field is
// preserved in the same direction as the source photo.
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

  const monoPng = path.join(OUT_DIR, "fence-tile-mono.png");
  const monoWebp = path.join(OUT_DIR, "fence-tile-mono.webp");

  await sharp(negated)
    .linear(0.1116, 15.5) // compress into a narrow dark band (~15-42 of 255)
    .blur(0.5)
    .png({ compressionLevel: 9 })
    .toFile(monoPng);

  await sharp(monoPng).webp({ quality: 82 }).toFile(monoWebp);

  console.log(`wrote ${monoPng}`);
  console.log(`wrote ${monoWebp}`);

  // The crop is bimodal, not uniformly bright: the wire is a thin ~5% of
  // pixels sitting at grayscale ~21/255, the field is the other ~95% sitting
  // at a median of ~218/255 (measured by histogram, not guessed). a=0.289,
  // b=1.93 maps wire 21 -> ~8/255 (stays near-black, so the pattern still
  // reads as a wire grid) and field 218 -> ~65/255 (dark enough to be a
  // "dark theme" surface, bright enough that the diamond pattern is plainly
  // visible rather than a flat near-black square — the owner explicitly
  // wants the fence photo to read as the dominant visual, not a wash that
  // nearly hides it). Earlier passes at a=0.22 (field ~40/255) and heavier
  // CSS gradient washes on top of it were both too dark to read as a photo
  // at all — see the CSS's `.mc-fence-bg` comment for the wash side of this.
  const colorPng = path.join(OUT_DIR, "fence-tile-color.png");
  const colorWebp = path.join(OUT_DIR, "fence-tile-color.webp");

  await sharp(SRC)
    .extract(TILE)
    .linear(0.289, 1.93)
    .blur(0.4) // softens grain and hides the crop's wrap seam
    .png({ compressionLevel: 9 })
    .toFile(colorPng);

  await sharp(colorPng).webp({ quality: 82 }).toFile(colorWebp);

  console.log(`wrote ${colorPng}`);
  console.log(`wrote ${colorWebp}`);
}

main();

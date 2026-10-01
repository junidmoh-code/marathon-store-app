// ─── THE PHOTOGRAPH, MEASURED, WITH THE TYPE COMPOSITED OVER IT ──────────────
// The sharp half of the design layer: fit the model's photograph to its canvas,
// measure it, composite social-design.cjs's SVG over it — and, for a story that
// also goes on the feed, render the SAME design a second time at 1080x1350.
//
// Lifted out of functions/index.js so it runs without Firebase: the unit tests
// and scripts/social/proof-safe-zone.mjs call exactly the code the generator
// calls, rather than a copy of it. See docs/SOCIAL-SAFE-ZONE.md.
"use strict";

const socialDesign = require("./social-design.cjs");

// 1080×1350 is Instagram's 4:5 portrait, and it is also inside TikTok's photo
// ceiling (each image must fit within 1080×1920). A story or a reel is 9:16.
const SOCIAL_W = 1080, SOCIAL_H = 1350;
const SOCIAL_VERTICAL_W = 1080, SOCIAL_VERTICAL_H = 1920;

// Fit the generated scene to its canvas. Best-effort — on a sharp failure the
// raw output is kept rather than the post being lost.
//
// ── A FEED CARD FITS INSIDE; A VERTICAL CANVAS IS EXACT ─────────────────────
// The feed card still fits "inside" and never crops: a 4:5 generation with
// four products spaced across it keeps every one.
//
// A story or reel is COVERED to exactly 1080x1920. Its layout is authored
// against a band that has to line up with the feed's 4:5 frame to the pixel
// (y 285..1635), and "inside" routinely produced 1072x1920 — the NOCTA post
// was — which scaled the design and shifted that band. The model is asked for
// 9:16, so the cover trims well under 1% of the photograph.
async function normalizeSocialImage(buffer, fallbackMime, format = "feed") {
  try {
    const sharp = require("sharp");
    const out = socialDesign.isVertical(format)
      ? await sharp(buffer)
        .resize(SOCIAL_VERTICAL_W, SOCIAL_VERTICAL_H, { fit: "cover", position: "centre" })
        .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
        .toBuffer()
      : await sharp(buffer)
        .resize(SOCIAL_W, SOCIAL_H, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
        .toBuffer();
    return { buffer: out, mime: "image/jpeg" };
  } catch (e) {
    console.warn("normalizeSocialImage failed, using raw output:", e && e.message);
    return { buffer, mime: fallbackMime || "image/jpeg" };
  }
}

// ── MEASURE THE PHOTOGRAPH SO THE LAYOUT CAN ANSWER TO IT ────────────────────
// Mean luminance says whether type must be light or dark. Standard deviation
// says whether a region is EMPTY: flat tone is negative space, high variance is
// product. Those two numbers per edge are all social-design.cjs needs.
async function measureEdges(buffer) {
  try {
    const sharp = require("sharp");
    const meta = await sharp(buffer).metadata();
    const w = meta.width || SOCIAL_W, h = meta.height || SOCIAL_H;
    const third = Math.max(1, Math.floor(w / 3));
    // ── extract() IS NOT HONOURED BY stats() ───────────────────────────────
    // sharp's stats() reads the SOURCE image and ignores pipeline operations
    // before it, so `sharp(buf).extract(region).stats()` returns the stats of
    // the WHOLE image. The region must be MATERIALISED first, or every region
    // returns the same numbers and the layout is fixed while looking measured.
    const region = async (left, top, width, height) => {
      const cut = await sharp(buffer).extract({ left, top, width, height }).toBuffer();
      const st = await sharp(cut).greyscale().stats();
      const ch = st.channels[0];
      return { mean: ch.mean, stdev: ch.stdev };
    };
    const half = Math.max(1, Math.floor(h / 2));
    const [left, right, lTop, lBot, rTop, rBot] = await Promise.all([
      region(0, 0, third, h),
      region(w - third, 0, third, h),
      // Each column also measured in halves: a column can average flat while a
      // product sits low in it, which is how the first render put the total
      // block over a perfume box.
      region(0, 0, third, half),
      region(0, h - half, third, half),
      region(w - third, 0, third, half),
      region(w - third, h - half, third, half),
    ]);
    return {
      left: { ...left, top: lTop, bottom: lBot },
      right: { ...right, top: rTop, bottom: rBot },
    };
  } catch (e) {
    // A measurement failure must not lose a paid image. social-design falls
    // back to a sensible default side and light ink when the numbers are absent.
    console.warn("measureEdges failed, layout will use defaults:", e && e.message);
    return {};
  }
}

/**
 * The central 4:5 window of a vertical photograph: the rows the feed shows.
 * For an exact 1080x1920 canvas this is y 285..1635.
 */
function feedWindow(width, height) {
  const cropH = Math.min(height, Math.round(width * SOCIAL_H / SOCIAL_W));
  return { left: 0, top: Math.max(0, Math.round((height - cropH) / 2)), width, height: cropH };
}

// ── COMPOSITE THE TYPE ───────────────────────────────────────────────────────
// The model produced a photograph with negative space and NO lettering. Every
// name, every price and the outfit total are placed here, as real text, from
// the product records — summed in code, never by a model.
//
// Best-effort: a failure keeps the photograph rather than losing a generation
// that has already been paid for.
//
// `alsoFeed` (a story that will be twinned onto the feed) adds a SECOND render
// of the same layout onto the same photograph's central 4:5 rows. It is its own
// try: a feed render that fails leaves the story designed and returns no `feed`,
// and the caller then does not twin — it never falls back to posting the
// 1080x1920 file to the feed, which is the crop this exists to end.
//
// @returns { buffer, designed, named?, width, height, reason?,
//            feed?: { buffer, width, height }, feedReason? }
async function compositeSocialDesign(buffer, { products, kind, format = "feed", alsoFeed = false }) {
  let width, height;
  try {
    const rows = socialDesign.sellableRows(products || []);
    if (!rows.length) return { buffer, designed: false, reason: "no product carried a usable price" };
    const sharp = require("sharp");
    const edges = await measureEdges(buffer);
    // The overlay must match the photograph's ACTUAL size: sharp refuses an
    // overlay bigger than its base.
    const meta = await sharp(buffer).metadata();
    const canvas = socialDesign.canvasFor(format);
    width = meta.width || canvas.w;
    height = meta.height || canvas.h;
    const svg = socialDesign.buildOverlay({ products, edges, kind, format, width, height });
    const out = await sharp(buffer)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
      .toBuffer();
    const result = { buffer: out, designed: true, named: rows.length, width, height };

    if (alsoFeed && socialDesign.isVertical(format)) {
      try {
        const win = feedWindow(width, height);
        const bare = await sharp(buffer).extract(win).toBuffer();
        const feedSvg = socialDesign.buildOverlay({
          products, edges, kind, format, surface: "feed", width: win.width, height: win.height,
        });
        const feedBuf = await sharp(bare)
          .composite([{ input: Buffer.from(feedSvg), top: 0, left: 0 }])
          .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
          .toBuffer();
        result.feed = { buffer: feedBuf, width: win.width, height: win.height };
      } catch (e) {
        console.warn("compositeSocialDesign: the feed render failed, the story is unaffected:", e && e.message);
        result.feedReason = String(e && e.message);
      }
    }
    return result;
  } catch (e) {
    console.warn("compositeSocialDesign failed, keeping the bare photograph:", e && e.message);
    return { buffer, designed: false, reason: String(e && e.message), width, height };
  }
}

module.exports = {
  normalizeSocialImage, measureEdges, compositeSocialDesign, feedWindow,
  SOCIAL_W, SOCIAL_H, SOCIAL_VERTICAL_W, SOCIAL_VERTICAL_H,
};

// ─── THE PANEL'S PRODUCT PICTURES: CLEAN SHOTS, MADE ONCE PER PRODUCT ────────
// Owner review of sample 01 (2026-10-18): the panel showed crops of the shop's
// own photos — a hand holding the beanie, a hanger on the jeans, a shoebox
// under the shoe. Each product is now shown as a clean product shot, chosen in
// this order:
//
//   1. studio    the product's approved New Arrivals studio photo (already a
//                clean shot on plain grey): cut out, nothing generated.
//   2. cache     a clean shot made for an earlier poster:
//                social_lookbook/thumbs/{pid} → aiStudio/social/lookbook/
//                thumbs/{pid}.png, already background-removed. Reused on every
//                poster after it; a thumbnail that exists is NEVER made again.
//   3. generated the product's own photo sent as the reference to Flash
//                (gemini-3.1-flash-image, the cheapest image model here that
//                takes a reference image), on pure white, cut out, then cached.
//                Its own daily ceiling (THUMBS_PER_DAY), never the hero cap.
//   4. photo     the old way: the shop photo, cut out. Only when 3 could not
//                run (ceiling, model error) or did not cut out cleanly.
//
// A product none of these can draw is not drawn: makeLookbook picks the next
// one in its slot, as before.
"use strict";

const lookbook = require("../lib/social-lookbook.cjs");

/**
 * @param row    a resolved lookbook row ({ pid, slot, displayName, studio })
 * @param photo  { buffer, contentType }: the row's approved photo, downloaded
 * @param deps   { cutout(buf) → { png, method },
 *                 readThumbCache?(pid) → { png } | null,
 *                 writeThumbCache?(pid, png, meta) → Promise,
 *                 claimThumbUnit?() → { ok },
 *                 generateThumb?(parts) → { buffer, mime, costUSD, engine },
 *                 inlineImagePart(buffer, contentType) → part,
 *                 log?(msg) }
 * @returns { cutout: { png, method } | null, source, costUSD }
 */
async function resolveThumb(row, photo, deps) {
  const log = deps.log || (() => {});
  let costUSD = 0;

  if (row.studio) {
    const c = await deps.cutout(photo.buffer);
    return { cutout: c && c.png ? c : null, source: "studio", costUSD, tried: c && c.tried };
  }

  if (deps.readThumbCache) {
    try {
      const hit = await deps.readThumbCache(row.pid);
      if (hit && hit.png) return { cutout: { png: hit.png, method: "cache" }, source: "cache", costUSD };
    } catch (e) { log(`lookbook: thumbnail cache read for ${row.pid} failed (${e && e.message})`); }
  }

  if (deps.generateThumb && deps.claimThumbUnit) {
    let unit = { ok: false };
    try { unit = await deps.claimThumbUnit(); } catch { unit = { ok: false }; }
    if (!unit.ok) {
      log(`lookbook: no thumbnail generation left today (${lookbook.THUMBS_PER_DAY}) — ${row.pid} uses its shop photo`);
    } else {
      try {
        const gen = await deps.generateThumb([
          { text: lookbook.buildThumbPrompt(row) },
          { text: `REFERENCE — ${row.displayName}. Reproduce exactly this product:` },
          deps.inlineImagePart(photo.buffer, photo.contentType || "image/jpeg"),
        ]);
        costUSD += gen.costUSD || 0;
        const c = await deps.cutout(gen.buffer);
        if (c && c.png) {
          if (deps.writeThumbCache) {
            try {
              await deps.writeThumbCache(row.pid, c.png, { engine: gen.engine || null, costUSD: gen.costUSD || 0, method: c.method, src: row.photoUrl || null });
            } catch (e) { log(`lookbook: thumbnail for ${row.pid} made but not cached (${e && e.message})`); }
          }
          return { cutout: c, source: "generated", costUSD };
        }
        log(`lookbook: generated thumbnail for ${row.pid} did not cut out (${(c && c.tried || []).join(", ")}) — using its shop photo`);
      } catch (e) {
        log(`lookbook: thumbnail generation for ${row.pid} failed (${String(e && e.message).slice(0, 120)}) — using its shop photo`);
      }
    }
  }

  const c = await deps.cutout(photo.buffer);
  return { cutout: c && c.png ? c : null, source: "photo", costUSD, tried: c && c.tried };
}

module.exports = { resolveThumb };

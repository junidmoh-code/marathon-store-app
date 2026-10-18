// ─── TV BACKGROUNDS — the Workshop's writes ──────────────────────────────────
// Upload, remove, day tags, ordering and the thumbnail backfill for the "TV
// background" section of the TV Ad card. Every Storage and RTDB call goes
// through an injected `io`, so the rules these writes must keep are unit-tested
// (tvBackgroundOps.test.js) without Firebase:
//   - photos are files in Storage; RTDB gets metadata only (never image bytes);
//   - every upload is a NEW path (a fresh push id), never an overwrite, so the
//     year-long immutable cache header can never serve a stale photo;
//   - a removal deletes the photo AND its thumbnail from Storage before the
//     metadata, so a failed delete leaves the photo listed to retry, not an
//     orphan file nobody can see;
//   - timestamps come from serverNowMs (io.nowMs), not the device clock;
//   - "every day" is written as null, never as [] (RTDB drops empty arrays).
//
// io = {
//   newId(): string                                  // RTDB push id
//   putFile(path, blob): Promise<url>                // upload + download URL
//   deleteFile(path): Promise<void>                  // ok if already gone
//   getFile(path): Promise<Blob>
//   update(relPath, patch): Promise<void>            // under TV_BACKGROUNDS_PATH
//   remove(relPath): Promise<void>
//   nowMs(): number
//   who(): string
//   encode(blob|file, maxEdge, quality): Promise<Blob>  // resize to JPEG
// }
import { TV_BACKGROUNDS_STORAGE_DIR, TV_BG_MAX_EDGE, TV_BG_THUMB_EDGE } from "./tvBackgrounds";

export const FULL_QUALITY = 0.8;
export const THUMB_QUALITY = 0.72;

export const fullPathFor = (id) => `${TV_BACKGROUNDS_STORAGE_DIR}/${id}.jpg`;
export const thumbPathFor = (id) => `${TV_BACKGROUNDS_STORAGE_DIR}/${id}_thumb.jpg`;

/** Upload one photo: full (1920 long edge) + thumb (320), then its metadata. Returns the new id. */
export async function uploadTvBackground(io, file, { orderBase } = {}) {
  const id = io.newId();
  const [full, thumb] = await Promise.all([
    io.encode(file, TV_BG_MAX_EDGE, FULL_QUALITY),
    io.encode(file, TV_BG_THUMB_EDGE, THUMB_QUALITY),
  ]);
  const path = fullPathFor(id);
  const thumbPath = thumbPathFor(id);
  const url = await io.putFile(path, full);
  const thumbUrl = await io.putFile(thumbPath, thumb);
  const now = io.nowMs();
  await io.update(`photos/${id}`, {
    url, path, thumbUrl, thumbPath,
    name: String(file?.name || "").slice(0, 80),
    uploadedAt: now, addedAt: now, addedBy: io.who(),
    order: Number.isFinite(orderBase) ? orderBase : now,
    enabled: true,
    // no `days` → every day
  });
  return id;
}

/** Remove a photo: Storage objects first (full + thumb), then the metadata. */
export async function removeTvBackground(io, photo, { wasDefault = false } = {}) {
  for (const p of [photo.path, photo.thumbPath]) {
    if (!p) continue;
    try { await io.deleteFile(p); }
    catch (err) { if (err?.code !== "storage/object-not-found") throw err; }
  }
  await io.remove(`photos/${photo.id}`);
  if (wasDefault) await io.update("", { defaultId: "", updatedAt: io.nowMs(), updatedBy: io.who() });
}

/** Write a photo's day list; null = every day. */
export function setTvBackgroundDays(io, id, days) {
  return io.update(`photos/${id}`, { days: days && days.length ? days : null });
}

/** Swap two photos' places in the rotation (one multi-path write). */
export function swapTvBackgroundOrder(io, a, b) {
  return io.update("", {
    [`photos/${a.id}/order`]: b.order,
    [`photos/${b.id}/order`]: a.order === b.order ? a.order + 1 : a.order,
  });
}

/**
 * Photos uploaded before thumbnails existed: make a 320 px thumb from the full
 * photo once, store it beside it, and record it — after which the Workshop grid
 * never loads that full-size photo again. Returns the ids it filled.
 */
export async function backfillThumbs(io, photos, { log = console } = {}) {
  const done = [];
  for (const p of photos) {
    if (p.thumbUrl || !p.path) continue;
    try {
      const blob = await io.getFile(p.path);
      const thumb = await io.encode(blob, TV_BG_THUMB_EDGE, THUMB_QUALITY);
      const thumbPath = thumbPathFor(p.id);
      const thumbUrl = await io.putFile(thumbPath, thumb);
      await io.update(`photos/${p.id}`, { thumbUrl, thumbPath });
      done.push(p.id);
    } catch (err) {
      log.warn?.(`TV backgrounds: no thumbnail for ${p.id} yet:`, err?.message || err);
    }
  }
  return done;
}

/** Long-edge resize to JPEG in the browser (no upscaling). */
export async function encodeJpeg(fileOrBlob, maxEdge, quality) {
  const bmp = await createImageBitmap(fileOrBlob);
  const s = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s));
  const h = Math.max(1, Math.round(bmp.height * s));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not read that photo."))), "image/jpeg", quality));
}

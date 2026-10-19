// ─── REPAIR: every card thumbnail shows the product's CURRENT photo ──────────
// The logic of scripts/thumbs/repair-card-thumbs.mjs, legs injected for tests.
//
// What it repairs (measured 19 Oct 2026, 5,335 products with a photo):
//   195  thumbnail is the OLD staff photo.jpg while photoUrl is a reframed
//        photo (the 3 Sep marathon-pos-app scripts/thumbs/generate.mjs run
//        built every thumbnail from photo.jpg)
//   134  photoUrl is a publishing/AI photo and there is NO thumbnail
//    83  photoUrl is photo.jpg and there is no thumbnail
// A repaired product is stamped thumbAt (serverNowMs): it is part of the
// offline mirror's content marker, so every device fetches the new thumbnail.
// photoUpdatedAt is NOT touched — it means "a human uploaded a photo" to New
// Arrivals and to the Recent uploads list.
import { objectPathOf } from "../../src/components/shopify/primaryPhotoCore.js";

/** Mean absolute difference of two equal-length greyscale signatures (0–255). */
export const signatureDiff = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
};
// Same picture re-encoded scores ≤ ~3; a different photo of the shoe ≥ ~60.
export const SAME_PICTURE_MAX = 12;

/**
 * One product → { pid, verdict, path? } with verdict:
 *   "no-photo" | "external" (photoUrl not in our bucket — nothing to build from)
 *   "ok"       (thumbnail recorded as made from this photo, or photo.jpg's own)
 *   "missing"  (no thumbnail)
 *   "check"    (a thumbnail of unknown origin for a photo that is not photo.jpg:
 *               compare pixels)
 */
export function thumbVerdict(pid, photoUrl, thumbMeta, inBucket) {
  if (!photoUrl) return { pid, verdict: "no-photo" };
  if (!inBucket(photoUrl)) return { pid, verdict: "external" };
  const path = objectPathOf(photoUrl);
  if (!thumbMeta) return { pid, verdict: "missing", path };
  const from = thumbMeta.metadata?.thumbSourceObject || null;
  if (from === path) return { pid, verdict: "ok", path };
  if (path === `products/${pid}/photo.jpg` && !from) return { pid, verdict: "ok", path };
  return { pid, verdict: "check", path };
}

/**
 * The whole repair over `pids`.
 *   io: { readPhotoUrl(pid), thumbMetaOf(pid), inBucket(url), looksLike(pid, path) → diff }
 *   write: null (dry run) or { rebuildThumb(pid, url) → {ok}, stamp(pid) }
 * → { counts, rows }
 */
export async function runRepair(pids, io, { write = null, onRepaired = async () => {}, log = () => {}, each }) {
  const counts = { total: pids.length, "no-photo": 0, external: 0, ok: 0, missing: 0, stale: 0, "same-picture": 0, repaired: 0, failed: 0 };
  const rows = [];
  await each(pids, async (pid) => {
    let row;
    try {
      const photoUrl = await io.readPhotoUrl(pid);
      row = thumbVerdict(pid, photoUrl, io.thumbMetaOf(pid), io.inBucket);
      if (row.verdict === "check") {
        row.diff = await io.looksLike(pid, row.path);
        row.verdict = row.diff <= SAME_PICTURE_MAX ? "same-picture" : "stale";
      }
      counts[row.verdict] += 1;
      if (write && (row.verdict === "missing" || row.verdict === "stale")) {
        const t = await write.rebuildThumb(pid, photoUrl);
        if (!t?.ok) { counts.failed += 1; row.result = `thumbnail not built: ${t?.reason || "unknown"}`; }
        else {
          await write.stamp(pid);
          counts.repaired += 1;
          row.result = "repaired";
          await onRepaired({ pid, verdict: row.verdict, path: row.path, diff: row.diff ?? null });
        }
      }
    } catch (e) {
      row = { pid, verdict: "error", message: String(e?.message || e) };
      counts.failed += 1;
    }
    rows.push(row);
    log(row);
  });
  return { counts, rows };
}

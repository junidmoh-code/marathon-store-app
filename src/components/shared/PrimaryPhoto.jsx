// ─── <PrimaryPhoto> — the product's ONE photo, at the size the screen needs ──
// Every list or grid that shows a product picture renders this (or, for a
// screen that only holds a URL string, passes `productId` with it). It reads
// the one field (primaryPhoto.primaryPhotoUrl) and, at list size, the 300px
// till thumbnail of that same photo instead of the ~110–800 KB original:
//
//   1. this device's offline mirror, when it holds the thumbnail (no network);
//   2. else the thumbnail URL (primaryThumbUrl — only when it is provably of
//      THIS photo; see primaryPhoto.js);
//   3. else, or when that thumbnail is missing (404), the full photo.
//
// size="full" is for a detail or zoom view: the original, never a thumbnail.
// `snapshot` is a URL saved on an order/line when it was written; it is used
// only when there is no live product to read — the live primary wins, so an
// old order shows the product's photo as it is now.
import { useState } from "react";
import { primaryPhotoUrl, primaryThumbUrl } from "../../utils/primaryPhoto";
import { useMirroredPhotoSrc } from "../../offline/useMirroredPhotoSrc";

export function primaryPhotoSources(product, { productId = product?.id, snapshot = null, size = "thumb" } = {}) {
  const live = primaryPhotoUrl(product);
  const full = live || (typeof snapshot === "string" && snapshot ? snapshot : null);
  const thumb = size === "thumb" && live ? primaryThumbUrl(product, productId) : null;
  return { full, thumb };
}

export function PrimaryPhoto({ product, productId = product?.id, snapshot = null, size = "thumb", fallback = null, alt = "", onError, ...img }) {
  const { full, thumb } = primaryPhotoSources(product, { productId, snapshot, size });
  const mirrored = useMirroredPhotoSrc(size === "thumb" ? productId : null, full);
  // Remember which URL failed, so a re-render with a NEW photo starts fresh.
  const [failed, setFailed] = useState(null);
  if (!full) return fallback;
  const thumbOk = thumb && failed !== thumb;
  const src = (mirrored && mirrored !== full ? mirrored : null) || (thumbOk ? thumb : full);
  return (
    <img
      src={src} alt={alt} loading="lazy" decoding="async" {...img}
      onError={(e) => {
        if (src === thumb) { setFailed(thumb); return; }   // no thumbnail yet → the full photo
        onError?.(e);
      }}
    />
  );
}

export default PrimaryPhoto;

// ─── HIGH-RESOLUTION PRODUCT PHOTO ───────────────────────────────────────────
//
// Lifted out of SneakerWall.jsx (2026-10-20) when the wall went behind the
// preview switch: the classic order grid's cards draw the same full-resolution
// photo the wall's tiles did, and must not need the wall's module to do it.

import { useState } from "react";
import { MirroredImg } from "../../offline/MirroredImg.jsx";

// THE URL A TILE DRAWS: the product's own photoUrl, which is exactly what
// the lightbox opens (productPhotos(p)[0]). Never the mirror's 300px
// thumbnail — that is the round-3 defect this replaces. Pure, for the test.
export function tilePhotoSrc(p) {
  return typeof p?.photoUrl === "string" && p.photoUrl ? p.photoUrl : null;
}

// A product photo at full resolution, with the device's cached thumbnail as
// the offline fallback: original → (load fails) mirrored thumbnail → (that
// fails too) `fallback`. Lazy and async-decoded, so the wall's sixty
// originals load as they scroll in, not all at once.
export function HiResPhoto({ p, fallback = null, onLoad, alt = "", ...rest }) {
  const src = tilePhotoSrc(p);
  // The fallback stage belongs to ONE url: a new photo starts at the original
  // again, whether or not the caller keys this component.
  const [st, setSt] = useState({ src, stage: "full" });
  const stage = st.src === src ? st.stage : "full";
  const setStage = (s) => setSt({ src, stage: s });
  if (!src || stage === "none") return fallback;
  if (stage === "thumb") {
    return <MirroredImg productId={p.id} src={src} alt={alt} draggable={false} loading="lazy" decoding="async"
                        onLoad={onLoad} onError={() => setStage("none")} {...rest} />;
  }
  return <img src={src} alt={alt} draggable={false} loading="lazy" decoding="async"
              onLoad={onLoad} onError={() => setStage("thumb")} {...rest} />;
}


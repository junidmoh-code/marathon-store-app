// ─── OFFLINE MIRROR — an <img> that prefers the local thumbnail ──────────────
//
// A drop-in for `<img src={product.photoUrl} … />` on every surface that
// renders a product at LIST or GRID size. Give it the product id and it serves
// the mirrored 300px thumbnail when this device holds one; otherwise it hands
// back the exact `src` it was given and behaves as the plain <img> it replaces.
//
// WHY THIS IS THE WHOLE SAVING ON THE IMAGE SIDE. Today every one of these
// renders fetches `products/{id}/photo.jpg` — 108.8 KB on average, measured
// across 5,345 objects — from Storage, on every grid, every scroll, every
// device, for ever. The mirrored thumbnail is 21.0 KB and is downloaded once
// per device. A browse screen showing forty products goes from 4.4 MB to zero.
//
// IT NEVER FETCHES. Reading is a pure `cache.match`, so putting this on a
// render path cannot put a photo on the wire. A miss — mirror off, leg not
// primed yet, no thumbnail generated for this product, Cache Storage
// unavailable — returns the network url unchanged, which is exactly what the
// site did before.
//
// NOT FOR A FULL-SIZE VIEW. 300px is right for a card and wrong for a product
// detail or a label preview; those keep the original, which photoCache's
// fetchFullPhoto caches on demand, once, when someone actually opens it.

import { useMirroredPhotoSrc } from "./useMirroredPhotoSrc";

export function MirroredImg({ productId, src, ...rest }) {
  const resolved = useMirroredPhotoSrc(productId, src);
  return <img src={resolved ?? src} {...rest} />;
}

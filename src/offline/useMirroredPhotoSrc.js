// ─── OFFLINE MIRROR — the READ side of the photo cache ───────────────────────
//
// Ported from marathon-pos-app/src/products/useMirroredPhotoSrc.js.
//
// WITHOUT THIS FILE THE PHOTO MIRROR IS WRITE-ONLY. The photos leg downloads
// 111 MB of thumbnails per device and nothing renders from them; every grid
// goes on fetching the ~109 KB original from Storage exactly as before. That
// is what this branch shipped until a spec review pointed at it: the leg was
// pure cost. (Fable-vs-spec review, PR #618.)
//
// Read-side hook for the photo-mirror cache (src/offline/photoCache.js). A
// cache HIT swaps in a local object URL; a MISS (mirror off, not yet primed,
// Cache API unavailable, thumbnail never generated) returns the network
// `photoUrl` unchanged — so every existing render site keeps working exactly
// as it does today when the mirror is off or hasn't reached this product yet.
// Never fetches anything itself: reading is a pure `cache.match`, so this
// hook can never be the thing that puts a photo on the wire during a sale.

import { useEffect, useState } from "react";
import { isPhotoCacheApiAvailable, openPhotoCache, readCachedPhotoUrl } from "./photoCache";
import { offlineMirrorEnabled } from "./killSwitch";

let sharedCachePromise = null;
function getSharedCache() {
  // ── OFF MEANS OFF ────────────────────────────────────────────────────────
  // Without this, a device with the mirror OFF still opened Cache Storage and
  // ran a match() on every single product image it rendered. The output was
  // right — nothing is cached, so it fell through to the network url — but it
  // is work on a render path that did not happen before, and it opens a
  // handle on a store the device is not using. "With the flag off the app is
  // what it was" has to be true of the render path too, not just the engine.
  if (!offlineMirrorEnabled()) return null;
  if (!isPhotoCacheApiAvailable()) return null;
  if (!sharedCachePromise) {
    sharedCachePromise = openPhotoCache().catch((err) => {
      // A memoized REJECTED promise would poison every future call for the
      // rest of the session (a transient Cache Storage error would otherwise
      // degrade photo mirroring to network-only forever) — clear the memo so
      // the next render's call retries instead of reusing a dead promise.
      sharedCachePromise = null;
      throw err;
    });
  }
  return sharedCachePromise;
}

export function useMirroredPhotoSrc(productId, photoUrl) {
  // { key, url } for the cache hit that matches the CURRENT (productId,
  // photoUrl) pair, or null when there is none yet (miss, still looking, or
  // the pair just changed). Keying on both means a stale line's blob URL is
  // never shown against a different product.
  const [cached, setCached] = useState(null);
  const key = `${productId ?? ""}|${photoUrl ?? ""}`;

  // Reset synchronously when the identity changes — React's documented
  // "adjusting state during rendering" escape hatch, not a setState-in-effect
  // cascade: this is render-time, and Effects below never call setState
  // outside an async callback.
  if (cached !== null && cached.key !== key) setCached(null);

  // Release the object URL once it stops being the one in use.
  useEffect(() => {
    if (!cached?.url) return undefined;
    const url = cached.url;
    return () => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } };
  }, [cached]);

  useEffect(() => {
    let cancelled = false;
    // A falsy photoUrl means THIS product currently has no photo (readPhotoUrl
    // already collapsed every "no value" case to null). The Cache Storage
    // entry is keyed only by productId, with no content-marker check on read
    // — so if a prior sync pass cached a thumbnail before the photo was
    // removed, and the low-priority photos leg hasn't caught up yet, a lookup
    // here would resurrect that stale blob instead of correctly rendering "no
    // photo." Skipping the lookup entirely when there is no current network
    // photo is the one case worth refusing outright; a REPLACED (still
    // non-null) photoUrl is a milder, self-healing staleness window bounded
    // by the photos leg's own re-priming cadence.
    if (!photoUrl) return undefined;
    const cachePromise = getSharedCache();
    if (!productId || !cachePromise) return undefined;

    cachePromise.then(async (cache) => {
      if (!cache || cancelled) return;
      const url = await readCachedPhotoUrl(cache, productId);
      if (!url) return;
      // The effect was cleaned up (identity changed, unmount) WHILE the
      // lookup was in flight. readCachedPhotoUrl already minted an object
      // URL via createObjectURL before this line — discarding it here
      // without revoking would leak it (an untracked, never-freed blob) for
      // the life of the document, since nothing else references this URL.
      if (cancelled) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } return; }
      setCached({ key, url });
    }).catch(() => {});

    return () => { cancelled = true; };
  }, [key, productId, photoUrl]);

  return cached?.key === key ? cached.url : (photoUrl || null);
}

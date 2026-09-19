// ─── THE BOOT-TIME CACHE CLEAR, WITH ONE EXCEPTION ───────────────────────────
//
// main.jsx clears Cache Storage on every boot. That predates the offline
// mirror and it is still right for everything the rolled-back service worker
// left behind — but the photo mirror now keeps 111 MB of thumbnails there,
// downloaded once per device, and clearing them on every load would have the
// photos leg re-downloading the catalogue for ever. The exact opposite of the
// point of the whole exercise.
//
// It restores nothing of the 2026-05-09 failure: that was a fetch-intercepting
// service worker. This is a cache the page fills and reads by hand, with no
// worker and no interception, and deleting it deliberately is what the
// mirror's own "delete the offline copy" action does.
//
// WHY THIS IS A FUNCTION AND NOT A LINE IN main.jsx. It was a line, pinned by
// a test that matched main.jsx's SOURCE TEXT. A mutation audit left every
// asserted substring byte-identical and changed the value the promise resolved
// to, so the spared name was null, the filter kept nothing, and every cache
// including the photo mirror was deleted on every boot — with both pins green.
// A behaviour needs a behavioural test, so here is a behaviour.
// (Opus test audit, PR #618.)

import { PHOTO_CACHE_NAME } from "./photoCache";

/**
 * Delete every cache except the photo mirror's.
 *
 * `cacheStorage` is injected so this is testable without a browser; production
 * passes nothing and gets the global. Returns the names actually deleted.
 */
export async function clearCachesExceptPhotos({ cacheStorage } = {}) {
  const store = cacheStorage ?? (typeof caches !== "undefined" ? caches : null);
  if (!store || !store.keys) return [];
  let keys;
  try { keys = await store.keys(); } catch { return []; }
  const doomed = keys.filter((k) => k !== PHOTO_CACHE_NAME);
  await Promise.all(doomed.map((k) => Promise.resolve(store.delete(k)).catch(() => {})));
  return doomed;
}

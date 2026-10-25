// ─── SETTING THE PRIMARY PHOTO — the ONE write (Junid, 25 Oct 2026) ──────────
// "Replacing a photo anywhere (publisher card, studio, any edit screen) sets
// the primary photo, so it changes everywhere at once. Add an 'undo photo'
// button that restores the previous one."
//
// Every app-side change of /products/{pid}/photoUrl goes through
// setPrimaryPhoto (or undoPrimaryPhoto): the product edit screen's re-shoot
// and remove, the AI Studio approve, the Shopify backfill. The Shopify
// publisher's list keeps its own entry point (primaryPhotoCore
// .setShopifyPrimaryPhoto), which writes the same history through
// primaryPhoto.primaryPhotoPatch. primaryPhotoWriteGuard.test.js fails on a
// new writer of photoUrl that bypasses both.
//
// ORDER, and why:
//   1. archive  — a re-shoot overwrites products/{pid}/photo.jpg IN PLACE, so
//                 that object is copied to products/{pid}/history/{at}.jpg
//                 FIRST, and every pointer at it — the current photo, older
//                 history entries — is moved to the copy. No archive, no
//                 overwrite.
//   2. produce  — the new photo's URL (an upload, or a URL already in Storage)
//   3. thumb    — the till thumbnail is rebuilt BEFORE photoUrl moves:
//                 photoUrl is the offline mirror's content marker, and a device
//                 that sees the new marker while the old thumbnail still stands
//                 caches the old picture as current for ever (#769).
//   4. write    — one update() of child keys (never set(): styleCodeNormalised
//                 is immutable under the rules and must never be rewritten).
//   5. after    — best-effort follow-ups (none may fail the change).
//
// Never throws. Pure: the Firebase legs are injected `deps`:
//   now()                       → serverNowMs (or a promise of it)
//   readProduct(pid)            → { photoUrl, photo, photoHistory } as stored NOW
//   archiveObject(pid, path, at) → the URL of the archived copy of that
//                                  object, or null when it does not exist
//   rebuildThumb(pid, url)      → { ok } (best-effort)
//   removeThumb(pid)            → (best-effort)
//   writeProduct(pid, patch)    → update() of /products/{pid} child keys
//   md5Of(url)?                 → Storage md5, to skip a same-content swap
//   after(pid, { newUrl, source })? → follow-ups (best-effort)
import { primaryPhotoPatch, primaryPhotoUrl, undoPhotoPatch, photoHistoryEntries, storagePathOfUrl, PHOTO_HISTORY_KEY } from "./primaryPhoto.js";

async function nowOf(deps) {
  try { const t = Math.round(Number(await deps.now())); return Number.isFinite(t) && t > 0 ? t : null; }
  catch { return null; }
}

async function fresh(pid, product, deps) {
  if (typeof deps.readProduct !== "function") return product || {};
  try {
    const f = await deps.readProduct(pid);
    return f ? { ...product, photoUrl: f.photoUrl ?? null, photo: f.photo ?? product?.photo ?? null, photoHistory: f.photoHistory ?? null } : product || {};
  } catch { return product || {}; }
}

async function restoreThumb(pid, url, deps) {
  if (url) { try { if ((await deps.rebuildThumb(pid, url))?.ok) return; } catch { /* fall through */ } }
  if (typeof deps.removeThumb === "function") { try { await deps.removeThumb(pid); } catch { /* best-effort */ } }
}

/**
 * pid, {
 *   product,             render-time snapshot (re-read before deciding)
 *   newUrl | produce(),  the new primary (null = remove the photo), or an
 *                        async step that uploads it and returns its URL
 *   overwrites,          the Storage path produce() writes over (a re-shoot:
 *                        products/{pid}/photo.jpg) — copied out first
 *   source, by, extra    see primaryPhotoPatch
 * }
 * → { ok, changed, reason?, patch?, message? }
 */
export async function setPrimaryPhoto(pid, { product, newUrl, produce = null, overwrites = null, source, by = null, extra = {} }, deps) {
  const at = await nowOf(deps);
  if (!at) return { ok: false, changed: false, message: "The server clock could not be read — nothing was changed." };
  const cur = await fresh(pid, product, deps);
  const current = primaryPhotoUrl(cur);

  // The object about to be overwritten, copied out — and every pointer at it.
  let archivedCopy = null;
  const repoint = {};
  if (overwrites) {
    try { archivedCopy = await deps.archiveObject(pid, overwrites, at); }
    catch (e) { return { ok: false, changed: false, message: `The current photo could not be kept in the photo history, so it was not replaced (${String(e?.message || e)}).` }; }
    if (archivedCopy) {
      for (const e of photoHistoryEntries(cur)) {
        if (storagePathOfUrl(e.url) === overwrites) repoint[`${PHOTO_HISTORY_KEY}/${e.key}/url`] = archivedCopy;
      }
    }
  }
  const archived = archivedCopy && current && storagePathOfUrl(current) === overwrites ? archivedCopy : null;
  let next = newUrl ?? null;
  if (typeof produce === "function") {
    try { next = await produce(); } catch (e) {
      return { ok: false, changed: false, message: `The new photo could not be saved (${String(e?.message || e)}).` };
    }
  }
  const base = primaryPhotoPatch(pid, cur, next, { at, by, source, archived, extra });
  if (!base) return { ok: true, changed: false, reason: "no-change" };
  const patch = { ...repoint, ...base };

  if (current && next && !archived && typeof deps.md5Of === "function") {
    const [a, b] = await Promise.all([current, next].map(async (u) => { try { return (await deps.md5Of(u)) || null; } catch { return null; } }));
    if (a && b && a === b) return { ok: true, changed: false, reason: "same-content" };
  }

  let thumb = null;
  if (next && typeof deps.rebuildThumb === "function") {
    try { thumb = await deps.rebuildThumb(pid, next); } catch (e) { thumb = { ok: false }; }
  }
  try {
    await deps.writeProduct(pid, patch);
  } catch (e) {
    if (thumb?.ok) await restoreThumb(pid, archived || current, deps);
    return { ok: false, changed: false, patch, message: `The photo could not be changed (${String(e?.message || e)}).` };
  }
  // A removed photo: the stale thumbnail goes AFTER the record says "no photo".
  if (!next && typeof deps.removeThumb === "function") { try { await deps.removeThumb(pid); } catch { /* best-effort */ } }
  if (typeof deps.after === "function") { try { await deps.after(pid, { newUrl: next, source }); } catch { /* best-effort */ } }
  return { ok: true, changed: true, patch, thumb: !!thumb?.ok };
}

/** Undo the last photo change: the previous primary comes back (and this swap goes to history). */
export async function undoPrimaryPhoto(pid, { product, by = null }, deps) {
  const at = await nowOf(deps);
  if (!at) return { ok: false, changed: false, message: "The server clock could not be read — nothing was changed." };
  const cur = await fresh(pid, product, deps);
  const u = undoPhotoPatch(pid, cur, { at, by });
  if (!u) return { ok: true, changed: false, reason: "nothing-to-undo" };
  const current = primaryPhotoUrl(cur);
  let thumb = null;
  if (typeof deps.rebuildThumb === "function") {
    try { thumb = await deps.rebuildThumb(pid, u.restored.url); } catch { thumb = { ok: false }; }
  }
  try {
    await deps.writeProduct(pid, u.patch);
  } catch (e) {
    if (thumb?.ok) await restoreThumb(pid, current, deps);
    return { ok: false, changed: false, message: `The photo could not be restored (${String(e?.message || e)}).` };
  }
  if (typeof deps.after === "function") { try { await deps.after(pid, { newUrl: u.restored.url, source: "undo" }); } catch { /* best-effort */ } }
  return { ok: true, changed: true, patch: u.patch, restored: u.restored };
}

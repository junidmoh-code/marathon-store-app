// ─── TILE PHOTOS ON THE DEVICE (Junid's recording, 27 Nov 2026) ──────────────
//
// The order screen's cards draw each product's FULL photo (Junid's standing
// rule: tiles are full resolution). Until now every card fetched it from
// Storage when it mounted and nothing kept it, so a shop on a bad line waited
// for the same pictures on every visit. This file keeps them on the device:
//
//   • Cache Storage, filled and read FROM THE PAGE — no service worker. This
//     app's one service worker caused the iOS zero-data incident and has been
//     gone ever since (src/update/updateChecker.js, src/offline/photoCache.js
//     say so); the photo mirror already works this way and so does this.
//   • One entry per PRODUCT, carrying the photo URL it holds in a header. A
//     re-shot photo has a new URL (new token / new file), misses, and its put
//     replaces the old picture in the same slot — never two copies.
//   • A byte budget with oldest-written-first eviction, a guard on the
//     device's whole origin quota, and the quota recovery (clearPhotoCache)
//     drops this cache too. Pure re-downloadable images: never data.
//   • A tiny blurred placeholder per product (a ~24px JPEG made on the device
//     from the full photo, once) kept in the index, so a card can draw it on
//     its FIRST render with no read at all.
//   • Off when the offline mirror is off for this device (killSwitch): "with
//     the flag off the app is what it was" — plain <img> from Storage.
//   • No RTDB: only Storage photo bytes, which the cards download anyway.
//
// FETCHING NEEDS CORS. A page cannot read a cross-origin photo's bytes without
// the bucket's CORS allowing the page's origin (storage-cors-backup-*.json:
// marathon-club.web.app and localhost are allowed; preview channels are not).
// When the read is refused, this module says so once and the cards fall back
// to a plain <img> — exactly what they did before — for the rest of the
// session.

import { offlineMirrorEnabled } from "./killSwitch";
import { getMirrorDbHandle } from "./mirrorDbHandle";

export const TILE_CACHE_NAME = "marathon-store-tile-photos-v1";
// The index (and the placeholders) live in the mirror DB's meta store under
// the "photoCache." prefix, which a data-schema bump never purges (db.js).
export const TILE_INDEX_META_KEY = "photoCache.tiles";
// Marathon PE sneakers alone are ~1,500 photos at a 108.8 KB mean ≈ 160 MB;
// 300 MB holds that with room for the other shops' lists.
export const TILE_CACHE_BYTE_BUDGET = 300 * 1024 * 1024;
let budget = TILE_CACHE_BYTE_BUDGET;
// Above this share of the origin's quota, stop growing (the data legs and the
// thumbnail mirror share it and matter more).
export const TILE_QUOTA_SAFETY_RATIO = 0.8;
export const TINY_EDGE = 24;
const MEMO_MAX = 120;            // decoded object URLs kept for instant remounts
const INDEX_WRITE_MS = 4000;     // the index is written back at most this often
const CORS_STRIKES = 3;          // refused reads in a row, none succeeded → stop

const keyUrl = (id) => `https://marathon-store-mirror.local/tiles/${encodeURIComponent(id)}`;
export const tileRequest = (id) => new Request(keyUrl(id));

// ── state ───────────────────────────────────────────────────────────────────
let cachePromise = null;
let index = null;                // { [productId]: { src, bytes, at, tiny?, w?, h? } }
let indexPromise = null;
let indexDirty = false;
let writeTimer = null;
let fetchAllowed = true;
let corsStrikes = 0;
let anySuccess = false;
const memo = new Map();          // productId → { src, url }   (insertion order = LRU)
const inflight = new Map();      // src → Promise<string|null>
const listeners = new Set();
const pendingWrites = new Set();

export function tileCacheEnabled() {
  return typeof caches !== "undefined" && offlineMirrorEnabled();
}
export function tileFetchAllowed() { return fetchAllowed; }

function openCache() {
  if (!cachePromise) cachePromise = caches.open(TILE_CACHE_NAME).catch((e) => { cachePromise = null; throw e; });
  return cachePromise;
}

/** The index, loaded once per session (one IndexedDB read). */
export function loadTileIndex() {
  if (index) return Promise.resolve(index);
  if (!indexPromise) {
    indexPromise = getMirrorDbHandle()
      .then((db) => db.getMeta(TILE_INDEX_META_KEY))
      .then((v) => { index = v && typeof v === "object" ? v : {}; return index; })
      .catch(() => { index = {}; return index; })
      .finally(() => { listeners.forEach((f) => f()); });
  }
  return indexPromise;
}
/** Synchronous view of the index (null until loaded). */
export function tileIndexNow() { return index; }
export function onTileIndex(f) { listeners.add(f); return () => listeners.delete(f); }

function scheduleIndexWrite() {
  indexDirty = true;
  if (writeTimer) return;
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    if (!indexDirty || !index) return;
    indexDirty = false;
    try { const db = await getMirrorDbHandle(); await db.setMeta(TILE_INDEX_META_KEY, index); } catch { /* best effort */ }
  }, INDEX_WRITE_MS);
}

function remember(id, src, url) {
  const old = memo.get(id);
  if (old && old.url !== url) { try { URL.revokeObjectURL(old.url); } catch { /* */ } }
  memo.delete(id);
  memo.set(id, { src, url });
  while (memo.size > MEMO_MAX) {
    const [k, v] = memo.entries().next().value;
    memo.delete(k);
    try { URL.revokeObjectURL(v.url); } catch { /* */ }
  }
}
/** An object URL for this product's photo already in memory, or null. */
export function memoTileUrl(id, src) {
  const m = memo.get(id);
  if (!m || m.src !== src) return null;
  memo.delete(id); memo.set(id, m);   // touch
  return m.url;
}
/** Is this exact photo held on the device (per the index)? */
export function isTileHeld(id, src) {
  return !!(index && index[id] && index[id].src === src && index[id].bytes > 0);
}
export function tinyFor(id, src) {
  const e = index && index[id];
  return e && e.src === src && e.tiny ? e : null;
}

/** Read the held photo (zero network). Null on a miss or a different URL. */
export async function readTile(id, src) {
  if (!tileCacheEnabled() || !id || !src) return null;
  const hit = memoTileUrl(id, src);
  if (hit) return hit;
  try {
    const cache = await openCache();
    const res = await cache.match(tileRequest(id));
    if (!res || res.headers.get("x-tile-src") !== src) return null;
    const url = URL.createObjectURL(await res.blob());
    remember(id, src, url);
    return url;
  } catch { return null; }
}

async function underQuota(bytes) {
  try {
    if (!navigator.storage?.estimate) return true;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return !quota || (usage + bytes) / quota < TILE_QUOTA_SAFETY_RATIO;
  } catch { return true; }
}

async function evictUntil(cache, room) {
  const entries = Object.entries(index).filter(([, v]) => v.bytes > 0).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
  let total = entries.reduce((s, [, v]) => s + v.bytes, 0);
  for (const [id, v] of entries) {
    if (total + room <= budget) break;
    try { await cache.delete(tileRequest(id)); } catch { /* */ }
    total -= v.bytes;
    // keep the placeholder: it is tiny and still the right picture
    index[id] = { ...v, bytes: 0 };
  }
}

// A ~24px JPEG of the photo, as an SVG carrying the FULL photo's pixel size and
// its own blur: drawn where the photo will be, it takes exactly the photo's box
// (same intrinsic size, so the same max-width/max-height scaling) — no jump
// when the photo fades in.
export function tinySvg(entry) {
  const { tiny, w, h } = entry;
  const sd = Math.max(w, h) / 40;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<filter id="b" x="0" y="0" width="1" height="1"><feGaussianBlur stdDeviation="${sd}" edgeMode="duplicate"/></filter>` +
    `<image href="${tiny}" width="${w}" height="${h}" preserveAspectRatio="none" filter="url(#b)"/></svg>`);
}

async function makeTiny(blob) {
  try {
    if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
    const bmp = await createImageBitmap(blob);
    const { width: w, height: h } = bmp;
    const s = TINY_EDGE / Math.max(w, h);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return { tiny: c.toDataURL("image/jpeg", 0.6), w, h };
  } catch { return null; }
}

/**
 * Get this product's photo onto the device: from memory, from Cache Storage,
 * or from the network (then kept). Resolves to an object URL, or null when the
 * page may not read it (CORS) or the fetch failed — the caller then falls back
 * to a plain <img src>. `priority`: "high" for the first visible rows, "low"
 * for prefetch. One download per URL however many callers ask at once.
 */
let highInFlight = 0;
const highWaiters = [];
const HIGH_FIRST_MAX_MS = 1500;
/** Resolves once no first-screen ("high") download is in flight. */
export function whenFirstScreenLoaded() { return highClear(); }
function highClear() {
  if (highInFlight === 0) return Promise.resolve();
  return new Promise((r) => { highWaiters.push(r); setTimeout(r, HIGH_FIRST_MAX_MS); });
}

export function getTile(id, src, { priority = "auto", keep = true } = {}) {
  if (!tileCacheEnabled() || !id || !src) return Promise.resolve(null);
  const hit = memoTileUrl(id, src);
  if (hit) return Promise.resolve(hit);
  const k = `${id}|${src}`;
  if (inflight.has(k)) return inflight.get(k);
  const p = (async () => {
    // The display path waits on nothing but the photo: the cache read, else
    // the download. The index load and the cache write happen beside it.
    const held = await readTile(id, src);
    if (held) return held;
    if (!fetchAllowed) return null;
    // The first screen first: a download that is not "high" waits until the
    // high ones have landed (or HIGH_FIRST_MAX_MS), so on a thin line the
    // photos in view are not sharing it with the forty below them.
    if (priority === "high") highInFlight++;
    else await highClear();
    let blob;
    try {
      const res = await fetch(src, { mode: "cors", credentials: "omit", priority });
      if (!res.ok) return null;
      blob = await res.blob();
      anySuccess = true; corsStrikes = 0;
    } catch {
      // A refused cross-origin read and a dropped connection look the same
      // here. Only refusals with the browser online, and never after one has
      // worked this session, count towards turning fetching off.
      if (!anySuccess && (typeof navigator === "undefined" || navigator.onLine !== false) && ++corsStrikes >= CORS_STRIKES) fetchAllowed = false;
      return null;
    } finally {
      if (priority === "high" && --highInFlight === 0) { const w = highWaiters.splice(0); w.forEach((f) => f()); }
    }
    const url = URL.createObjectURL(blob);
    remember(id, src, url);
    if (keep) { const w = keepTile(id, src, blob).finally(() => pendingWrites.delete(w)); pendingWrites.add(w); }
    return url;
  })().finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

async function keepTile(id, src, blob) {
  try {
    await loadTileIndex();
    const bytes = blob.size || 0;
    if (!bytes || bytes > budget || !(await underQuota(bytes))) return;
    const cache = await openCache();
    await evictUntil(cache, bytes);
    await cache.put(tileRequest(id), new Response(blob, { headers: { "Content-Type": blob.type || "image/jpeg", "x-tile-src": src } }));
    const prev = index[id];
    const tiny = prev && prev.src === src && prev.tiny ? { tiny: prev.tiny, w: prev.w, h: prev.h } : await makeTiny(blob);
    index[id] = { src, bytes, at: Date.now(), ...(tiny || {}) };
    scheduleIndexWrite();
  } catch (e) {
    if (e?.name === "QuotaExceededError") { try { await clearTileCache(); } catch { /* */ } }
  }
}

/** Bytes and entries this device holds (for the report / the status card). */
export function tileCacheStats() {
  const v = Object.values(index || {});
  return { entries: v.filter((e) => e.bytes > 0).length, bytes: v.reduce((s, e) => s + (e.bytes || 0), 0), placeholders: v.filter((e) => e.tiny).length };
}

/** Drop everything (the quota recovery and the settings "clear" both call this). */
export async function clearTileCache() {
  let cleared = false;
  try { if (typeof caches !== "undefined") cleared = (await caches.delete(TILE_CACHE_NAME)) === true; } catch { /* */ }
  cachePromise = null;
  index = {};
  memo.forEach((v) => { try { URL.revokeObjectURL(v.url); } catch { /* */ } });
  memo.clear();
  try { const db = await getMirrorDbHandle(); await db.setMeta(TILE_INDEX_META_KEY, {}); } catch { cleared = false; }
  return cleared;
}

export function _setTileBudgetForTests(b) { budget = b ?? TILE_CACHE_BYTE_BUDGET; }
/** Resolves when this product's background cache write has finished (tests). */
export function _flushTileWritesForTests() { return Promise.all([...pendingWrites]); }
export function _resetTileCacheForTests() {
  cachePromise = null; index = null; indexPromise = null; indexDirty = false;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null; fetchAllowed = true; corsStrikes = 0; anySuccess = false; highInFlight = 0; highWaiters.length = 0;
  memo.clear(); inflight.clear(); listeners.clear(); pendingWrites.clear(); budget = TILE_CACHE_BYTE_BUDGET;
}

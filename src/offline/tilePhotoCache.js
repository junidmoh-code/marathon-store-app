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
const MEMO_MAX = 120;            // object URLs kept for instant remounts (unheld ones only are revoked)
const INDEX_WRITE_MS = 4000;     // the index is written back at most this often
const CORS_STRIKES = 3;          // refused reads in a row, none succeeded → stop
const CORS_REARM_MS = 10 * 60 * 1000;   // a "refused" verdict is re-tried after this, or on `online`
// Slow 3G moves ~50 KB/s: a 110 KB photo sharing the line with three others
// can honestly take 10-20 s, so the abort is only for a dead request.
export const FETCH_TIMEOUT_MS = 60 * 1000;
// Downloads for cards on screen, at once (prefetch has its own four). On a thin
// line fewer at a time means the first photos land sooner instead of all of
// them landing late together.
export const DISPLAY_CONCURRENCY = 4;

const keyUrl = (id) => `https://marathon-store-mirror.local/tiles/${encodeURIComponent(id)}`;
export const tileRequest = (id) => new Request(keyUrl(id));

// ── state ───────────────────────────────────────────────────────────────────
let cachePromise = null;
let index = null;                // { [productId]: { src, bytes, at, tiny?, w?, h? } }
let indexPromise = null;
let indexDirty = false;
let writeTimer = null;
let fetchAllowed = true;
let refusedAt = 0;
let corsStrikes = 0;
let anySuccess = false;
let wiredFlush = false;
// productId → { src, url, refs }. A card showing the URL holds a ref
// (retainTile / releaseTile); only an UNHELD URL is ever revoked, so a mounted
// <img> never loses its picture (architect review).
const memo = new Map();
const inflight = new Map();      // `${id}|${src}` → { p, upgraded }
const listeners = new Set();
const pendingWrites = new Set();

export function tileCacheEnabled() {
  return typeof caches !== "undefined" && offlineMirrorEnabled();
}
export function tileFetchAllowed() {
  if (!fetchAllowed && Date.now() - refusedAt > CORS_REARM_MS) { fetchAllowed = true; corsStrikes = 0; }
  return fetchAllowed;
}

function openCache() {
  if (!cachePromise) cachePromise = caches.open(TILE_CACHE_NAME).catch((e) => { cachePromise = null; throw e; });
  return cachePromise;
}

function wireFlush() {
  if (wiredFlush || typeof document === "undefined" || typeof window === "undefined") return;
  wiredFlush = true;
  // The index is written on a timer; a tab hidden or closed before it fires
  // must not lose what it learned (architect review).
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushIndex(); });
  window.addEventListener("pagehide", () => flushIndex());
  // A refused verdict made on a line that was really down is re-tried when it returns.
  window.addEventListener("online", () => { fetchAllowed = true; corsStrikes = 0; });
}

/** The index, loaded once per session (one IndexedDB read), reconciled once
 *  against what Cache Storage really holds (keys only, no bodies). */
export function loadTileIndex() {
  if (index) return Promise.resolve(index);
  if (!indexPromise) {
    wireFlush();
    indexPromise = getMirrorDbHandle()
      .then((db) => db.getMeta(TILE_INDEX_META_KEY))
      .then(async (v) => {
        const next = v && typeof v === "object" ? { ...v } : {};
        try {
          const held = new Set((await (await openCache()).keys()).map((r) => r.url));
          for (const [id, e] of Object.entries(next)) if (e.bytes > 0 && !held.has(keyUrl(id))) next[id] = { ...e, bytes: 0 };
        } catch { /* no reconcile this session */ }
        index = next;
        return index;
      })
      .catch(() => { index = {}; return index; })
      .finally(() => { listeners.forEach((f) => f()); });
  }
  return indexPromise;
}
/** Synchronous view of the index (null until loaded). */
export function tileIndexNow() { return index; }
export function onTileIndex(f) { listeners.add(f); return () => listeners.delete(f); }

// Merge on write: another tab may have written since this one loaded, so each
// entry keeps whichever copy is newer (by `at`).
async function flushIndex() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (!indexDirty || !index) return;
  indexDirty = false;
  try {
    const db = await getMirrorDbHandle();
    const cur = (await db.getMeta(TILE_INDEX_META_KEY)) || {};
    const merged = { ...cur };
    for (const [id, e] of Object.entries(index)) if (!merged[id] || (merged[id].at || 0) <= (e.at || 0)) merged[id] = e;
    index = merged;
    await db.setMeta(TILE_INDEX_META_KEY, merged);
  } catch { indexDirty = true; }
}
function scheduleIndexWrite() {
  indexDirty = true;
  if (writeTimer) return;
  writeTimer = setTimeout(() => { writeTimer = null; flushIndex(); }, INDEX_WRITE_MS);
}

function revokeUnheld() {
  if (memo.size <= MEMO_MAX) return;
  for (const [k, v] of memo) {
    if (memo.size <= MEMO_MAX) break;
    if (v.refs > 0) continue;
    memo.delete(k);
    try { URL.revokeObjectURL(v.url); } catch { /* */ }
  }
}
function remember(id, src, url) {
  const old = memo.get(id);
  if (old && old.url !== url && old.refs === 0) { try { URL.revokeObjectURL(old.url); } catch { /* */ } }
  memo.delete(id);
  memo.set(id, { src, url, refs: 0 });
  revokeUnheld();
}
/** An object URL for this product's photo already in memory, or null. */
export function memoTileUrl(id, src) {
  const m = memo.get(id);
  if (!m || m.src !== src) return null;
  memo.delete(id); memo.set(id, m);   // touch
  return m.url;
}
/** A card shows `url` (from getTile / memoTileUrl): keep it alive until released. */
export function retainTile(id, url) {
  const m = memo.get(id);
  if (m && m.url === url) m.refs += 1;
}
export function releaseTile(id, url) {
  const m = memo.get(id);
  if (m && m.url === url && m.refs > 0) { m.refs -= 1; if (m.refs === 0) revokeUnheld(); }
}
/** Is this exact photo held on the device (per the index)? */
export function isTileHeld(id, src) {
  return !!(index && index[id] && index[id].src === src && index[id].bytes > 0);
}
export function tinyFor(id, src) {
  const e = index && index[id];
  return e && e.src === src && e.tiny ? e : null;
}

async function matchHeld(id, src) {
  const cache = await openCache();
  const res = await cache.match(tileRequest(id));
  return res && res.headers.get("x-tile-src") === src ? res : null;
}

/** Read the held photo (zero network). Null on a miss or a different URL. */
export async function readTile(id, src) {
  if (!tileCacheEnabled() || !id || !src) return null;
  const hit = memoTileUrl(id, src);
  if (hit) return hit;
  try {
    const res = await matchHeld(id, src);
    if (!res) return null;
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

// Make room for `room` bytes for product `forId`; the slot being replaced does
// not count (it is overwritten), so a re-shot photo does not over-evict.
async function evictUntil(cache, room, forId) {
  const entries = Object.entries(index).filter(([id, v]) => v.bytes > 0 && id !== forId).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
  let total = entries.reduce((s, [, v]) => s + v.bytes, 0);
  for (const [id, v] of entries) {
    if (total + room <= budget) break;
    try { await cache.delete(tileRequest(id)); } catch { /* */ }
    total -= v.bytes;
    // keep the placeholder: it is tiny and still the right picture
    index[id] = { ...v, bytes: 0, at: Date.now() };
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

// The placeholder only needs the photo's ASPECT: the card caps the photo's box
// far below its pixel size, so an SVG of the same aspect scales to the same
// box. So the decoder is asked for the 24px picture directly (off the main
// thread, no full-size bitmap where resizeWidth is supported), and the SVG is
// given a 1000px long edge in that aspect.
async function makeTiny(blob) {
  try {
    if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
    const bmp = await createImageBitmap(blob, { resizeWidth: TINY_EDGE, resizeQuality: "low" });
    const s = TINY_EDGE / Math.max(bmp.width, bmp.height);   // 1 when resizeWidth was honoured
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const long = Math.max(bmp.width, bmp.height);
    const w = Math.round((bmp.width / long) * 1000), h = Math.round((bmp.height / long) * 1000);
    bmp.close?.();
    return { tiny: c.toDataURL("image/jpeg", 0.6), w, h };
  } catch { return null; }
}

let highInFlight = 0;
const highWaiters = [];
// Nothing else starts while first-screen photos are downloading — capped, in
// case one hangs (the fetch timeout ends it anyway).
const HIGH_FIRST_MAX_MS = 30 * 1000;
/** Resolves once no first-screen ("high") download is in flight. */
export function whenFirstScreenLoaded() { return highClear(); }
function highClear() {
  if (highInFlight === 0) return Promise.resolve();
  return new Promise((r) => { highWaiters.push(r); setTimeout(r, HIGH_FIRST_MAX_MS); });
}

// A small priority queue in front of the display downloads: "high" (the first
// screen) jumps ahead; at most DISPLAY_CONCURRENCY run at once.
let displayRunning = 0;
const displayQueue = [];
function displaySlot(high) {
  if (displayRunning < DISPLAY_CONCURRENCY) { displayRunning++; return Promise.resolve(); }
  return new Promise((r) => { if (high) displayQueue.unshift(r); else displayQueue.push(r); });
}
function displayDone() {
  const next = displayQueue.shift();
  if (next) next(); else displayRunning--;
}

async function download(src, priority) {
  const ac = typeof AbortController === "function" ? new AbortController() : null;
  const t = ac ? setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS) : null;
  try {
    const res = await fetch(src, { mode: "cors", credentials: "omit", priority, ...(ac ? { signal: ac.signal } : {}) });
    if (!res.ok) return null;
    const blob = await res.blob();
    anySuccess = true; corsStrikes = 0;
    return blob;
  } catch (e) {
    // A refused cross-origin read is a TypeError with the browser online;
    // a timeout (AbortError) or an offline browser is the line, not CORS,
    // and never counts. Re-armed after CORS_REARM_MS or on `online`.
    const aborted = e?.name === "AbortError";
    if (!aborted && !anySuccess && (typeof navigator === "undefined" || navigator.onLine !== false) && ++corsStrikes >= CORS_STRIKES) {
      fetchAllowed = false; refusedAt = Date.now();
    }
    return null;
  } finally { if (t) clearTimeout(t); }
}

/**
 * Get this product's photo onto the device: from memory, from Cache Storage,
 * or from the network (then kept). Resolves to an object URL, or null when the
 * page may not read it (CORS), the download failed or timed out — the caller
 * then falls back to a plain <img src>. `priority`: "high" for the first
 * visible rows. One download per photo however many callers ask at once.
 * `warm: true` (prefetch): bytes to Cache Storage only — no object URL, no
 * memory held; resolves true/false.
 */
export function getTile(id, src, { priority = "auto", keep = true, warm = false } = {}) {
  if (!tileCacheEnabled() || !id || !src) return Promise.resolve(warm ? false : null);
  if (!warm) { const hit = memoTileUrl(id, src); if (hit) return Promise.resolve(hit); }
  const k = `${id}|${src}`;
  const running = inflight.get(k);
  if (running) {
    // A card in view joining a prefetch still queued behind the first screen
    // lifts it out of that wait (architect review: priority inversion).
    if (priority === "high" || !warm) running.upgraded = true;
    return running.p.then((r) => (warm ? !!r : typeof r === "string" ? r : readTile(id, src)));
  }
  const entry = { upgraded: priority === "high", p: null };
  entry.p = (async () => {
    // The display path waits on nothing but the photo: the cache check, else
    // the download. The index load and the cache write happen beside it.
    if (warm) {
      if (isTileHeld(id, src)) return true;
      try { if (await matchHeld(id, src)) return true; } catch { /* fetch it */ }
    } else {
      const held = await readTile(id, src);
      if (held) return held;
    }
    if (!tileFetchAllowed()) return warm ? false : null;
    // The first screen first: anything not "high" waits until the high ones
    // have landed (or HIGH_FIRST_MAX_MS) unless a card in view has joined it.
    const high = priority === "high";
    if (high) highInFlight++;
    else if (!entry.upgraded) await highClear();
    let blob;
    const queued = !warm;                  // prefetch has its own four
    try {
      if (queued) await displaySlot(high || entry.upgraded);
      try { blob = await download(src, entry.upgraded && !high ? "auto" : priority); }
      finally { if (queued) displayDone(); }
    } finally { if (high && --highInFlight === 0) { const w = highWaiters.splice(0); w.forEach((f) => f()); } }
    if (!blob) return warm ? false : null;
    if (keep) { const w = keepTile(id, src, blob).finally(() => pendingWrites.delete(w)); pendingWrites.add(w); }
    if (warm) return true;
    const url = URL.createObjectURL(blob);
    remember(id, src, url);
    return url;
  })().finally(() => inflight.delete(k));
  inflight.set(k, entry);
  return entry.p;
}

async function keepTile(id, src, blob) {
  try {
    await loadTileIndex();
    const bytes = blob.size || 0;
    if (!bytes || bytes > budget || !(await underQuota(bytes))) return;
    const cache = await openCache();
    await evictUntil(cache, bytes, id);
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
  indexDirty = false;
  // Unheld URLs go now; one a card still shows goes when the card lets it go.
  for (const [k, v] of memo) if (v.refs === 0) { memo.delete(k); try { URL.revokeObjectURL(v.url); } catch { /* */ } }
  try { const db = await getMirrorDbHandle(); await db.setMeta(TILE_INDEX_META_KEY, {}); } catch { cleared = false; }
  return cleared;
}

export function _setTileBudgetForTests(b) { budget = b ?? TILE_CACHE_BYTE_BUDGET; }
/** Resolves when every background cache write has finished (tests). */
export function _flushTileWritesForTests() { return Promise.all([...pendingWrites]).then(() => flushIndex()); }
export function _resetTileCacheForTests() {
  cachePromise = null; index = null; indexPromise = null; indexDirty = false;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null; fetchAllowed = true; refusedAt = 0; corsStrikes = 0; anySuccess = false; highInFlight = 0; highWaiters.length = 0;
  displayRunning = 0; displayQueue.length = 0;
  memo.clear(); inflight.clear(); listeners.clear(); pendingWrites.clear(); budget = TILE_CACHE_BYTE_BUDGET;
}

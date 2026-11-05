// ─── GENERATED WALL TILES (staff only) ───────────────────────────────────────
//
// marathon-photo-studio/wall.py regenerates every sneaker photo as a clean,
// style-consistent studio tile (1200×1200 transparent PNG: shoe facing right,
// 80% of the width, one baseline, a soft shadow) and checks each against its
// original (CLIP similarity, dominant colour, silhouette). Only tiles that
// pass, or that the owner approved on the review page, are listed in ONE
// manifest beside the product photos:
//
//   products/_studio/wall-manifest.json   { tiles: { <productId>: { v } } }
//
// A product in the manifest draws products/<id>/studio-wall.png on the wall;
// every other product draws its original exactly as before. Nothing reads or
// writes RTDB for this. The tile URL is built HERE from a fixed template (the
// manifest's own `url` field is ignored), so the manifest can only ever point
// at a product's own studio-wall.png in our bucket. `v` busts the hour-long
// Storage cache when a tile is regenerated.

import { useSyncExternalStore } from "react";

const BUCKET = "marathon-club.firebasestorage.app";
const BASE = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/`;
export const WALL_MANIFEST_URL = `${BASE}products%2F_studio%2Fwall-manifest.json?alt=media`;
const TTL_MS = 10 * 60 * 1000;          // a new tile reaches an open wall within ~10 min
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

let manifest = null;       // { tiles: {...} } once loaded; stays null if it never loads (originals everywhere)
let loadedAt = 0;
let failedAt = 0;          // last failed load: retries are rate-limited (no fetch storm while offline)
let lastJson = "";
let inflight = null;
let timer = null;          // ONE refresh timer for the whole app, started by the first subscriber
const subs = new Set();
const emit = () => subs.forEach((f) => f());
const RETRY_MS = 60 * 1000;

// The generated tile for a product, or null. Pure, for the tests.
export function generatedTileSrc(p, m = manifest) {
  const id = p?.id;
  if (typeof id !== "string" || !SAFE_ID.test(id)) return null;
  const t = m?.tiles && Object.prototype.hasOwnProperty.call(m.tiles, id) ? m.tiles[id] : null;
  if (!t || typeof t !== "object") return null;
  const v = typeof t.v === "string" || typeof t.v === "number" ? String(t.v) : "";
  return `${BASE}products%2F${id}%2Fstudio-wall.png?alt=media${v ? `&v=${encodeURIComponent(v)}` : ""}`;
}

// What the popup and the lightbox show, in order: the generated tile first,
// then the product's own photos (original first). Without a tile: unchanged.
export function wallPhotoList(p, originals, m = manifest) {
  const g = generatedTileSrc(p, m);
  const list = Array.isArray(originals) ? originals.filter(Boolean) : [];
  return g ? [g, ...list.filter((u) => u !== g)] : list;
}

export function loadWallManifest(fetchImpl = typeof fetch === "function" ? fetch : null, now = Date.now()) {
  if (!fetchImpl) return Promise.resolve(manifest);
  if (inflight) return inflight;
  if (manifest && now - loadedAt < TTL_MS) return Promise.resolve(manifest);
  if (failedAt && now - failedAt < RETRY_MS) return Promise.resolve(manifest);
  inflight = Promise.resolve()
    .then(() => fetchImpl(WALL_MANIFEST_URL, { cache: "no-cache" }))
    .then((r) => (r && r.ok ? r.json() : null))
    .then((j) => {
      if (j && typeof j === "object" && j.tiles && typeof j.tiles === "object") {
        loadedAt = now; failedAt = 0;
        const s = JSON.stringify(j.tiles);
        if (s !== lastJson) { lastJson = s; manifest = { tiles: j.tiles }; emit(); }   // unchanged: no re-render
      } else failedAt = now;
      return manifest;
    })
    .catch(() => { failedAt = now; return manifest; })   // offline / missing: keep what we had, originals otherwise
    .finally(() => { inflight = null; });
  return inflight;
}

function subscribe(f) {
  subs.add(f);
  if (!timer) { loadWallManifest(); timer = setInterval(() => loadWallManifest(), TTL_MS); }
  return () => { subs.delete(f); if (!subs.size && timer) { clearInterval(timer); timer = null; } };
}
const noSubscribe = () => () => {};

// The manifest for a component. `enabled` false (not on the wall): no fetch, no timer, always null.
// All subscribers share one load and one refresh timer.
export function useWallManifest(enabled = true) {
  return useSyncExternalStore(enabled ? subscribe : noSubscribe, () => (enabled ? manifest : null), () => null);
}

// Tests only.
export function __setWallManifestForTest(m) { manifest = m; lastJson = m ? JSON.stringify(m.tiles) : ""; loadedAt = m ? Date.now() : 0; failedAt = 0; inflight = null; emit(); }
export function __wallTimerForTest() { return { timer: !!timer, subs: subs.size }; }

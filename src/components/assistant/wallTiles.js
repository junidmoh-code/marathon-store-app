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

import { useEffect, useSyncExternalStore } from "react";

const BUCKET = "marathon-club.firebasestorage.app";
const BASE = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/`;
export const WALL_MANIFEST_URL = `${BASE}products%2F_studio%2Fwall-manifest.json?alt=media`;
const TTL_MS = 10 * 60 * 1000;          // a new tile reaches an open wall within ~10 min
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

let manifest = null;       // { tiles: {...} } once loaded; stays null if it never loads (originals everywhere)
let loadedAt = 0;
let inflight = null;
const subs = new Set();
const emit = () => subs.forEach((f) => f());

// The generated tile for a product, or null. Pure, for the tests.
export function generatedTileSrc(p, m = manifest) {
  const id = p?.id;
  if (typeof id !== "string" || !SAFE_ID.test(id)) return null;
  const t = m?.tiles?.[id];
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
  inflight = Promise.resolve()
    .then(() => fetchImpl(WALL_MANIFEST_URL, { cache: "no-cache" }))
    .then((r) => (r && r.ok ? r.json() : null))
    .then((j) => {
      if (j && typeof j === "object" && j.tiles && typeof j.tiles === "object") { manifest = { tiles: j.tiles }; loadedAt = now; emit(); }
      return manifest;
    })
    .catch(() => manifest)                // offline / missing manifest: keep what we had, originals otherwise
    .finally(() => { inflight = null; });
  return inflight;
}

// The manifest for a component; loads it on first use and refreshes it when stale.
export function useWallManifest() {
  const m = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => manifest, () => null);
  useEffect(() => {
    loadWallManifest();
    const t = setInterval(() => loadWallManifest(), TTL_MS);
    return () => clearInterval(t);
  }, []);
  return m;
}

// Tests only.
export function __setWallManifestForTest(m) { manifest = m; loadedAt = m ? Date.now() : 0; inflight = null; emit(); }

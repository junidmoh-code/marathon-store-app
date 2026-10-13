// ─── TV BACKGROUNDS — shared read contract ────────────────────────────────────
// One small node, /settings/tvBackgrounds, written by the "TV background"
// section of the TV Ad card and read by the queue board:
//   { photos: { <id>: { url, path, name, addedAt, addedBy } },
//     mode: "default" | "rotate", defaultId, rotateSeconds, updatedAt, updatedBy }
// "default" holds one photo; "rotate" walks every photo in upload order. The
// rotation slot comes from SERVER time, so every TV in the store shows the same
// photo at the same moment. Reads fail OPEN to the photo built into the app —
// a missing or broken node never blanks the board.
import { useEffect, useState } from "react";
import { onValue, ref } from "firebase/database";
import { database } from "../firebase";

export const TV_BACKGROUNDS_PATH = "settings/tvBackgrounds";
export const TV_BACKGROUNDS_STORAGE_DIR = "products/tv-backgrounds";
export const DEFAULT_ROTATE_SECONDS = 5 * 60;
export const MIN_ROTATE_SECONDS = 10;
export const MAX_TV_BACKGROUNDS = 12;

export function normalizeTvBackgrounds(v) {
  const raw = v && typeof v === "object" ? v : {};
  const photos = Object.entries(raw.photos && typeof raw.photos === "object" ? raw.photos : {})
    .filter(([, p]) => p && typeof p.url === "string" && p.url)
    .map(([id, p]) => ({ id, url: p.url, path: p.path || "", name: p.name || "", addedAt: Number(p.addedAt) || 0 }))
    .sort((a, b) => a.addedAt - b.addedAt || a.id.localeCompare(b.id));
  const rotateSeconds = Math.max(MIN_ROTATE_SECONDS, Math.round(Number(raw.rotateSeconds) || DEFAULT_ROTATE_SECONDS));
  return {
    photos,
    mode: raw.mode === "rotate" ? "rotate" : "default",
    defaultId: typeof raw.defaultId === "string" ? raw.defaultId : "",
    rotateSeconds,
    updatedAt: raw.updatedAt || null,
    updatedBy: raw.updatedBy || null,
  };
}

// The photo on screen now: { id, url } or null (= the built-in wall).
//  default → the chosen photo; if it was removed, the first one.
//  rotate  → slot = floor(now / rotateSeconds) over the photos in upload order.
export function pickTvBackground(cfg, nowMs) {
  const photos = cfg?.photos || [];
  if (photos.length === 0) return null;
  if (cfg.mode === "rotate" && photos.length > 1 && Number.isFinite(nowMs)) {
    const slot = Math.floor(nowMs / (cfg.rotateSeconds * 1000));
    return photos[((slot % photos.length) + photos.length) % photos.length];
  }
  return photos.find((p) => p.id === cfg.defaultId) || photos[0];
}

export function useTvBackgrounds() {
  const [cfg, setCfg] = useState(null);
  useEffect(() => {
    const unsub = onValue(
      ref(database, TV_BACKGROUNDS_PATH),
      (snap) => setCfg(normalizeTvBackgrounds(snap.val())),
      () => setCfg(normalizeTvBackgrounds(null)),
    );
    return () => unsub();
  }, []);
  return cfg;
}

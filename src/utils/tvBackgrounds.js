// ─── TV BACKGROUNDS — shared read contract ────────────────────────────────────
// One small node, /settings/tvBackgrounds, written by the "TV background"
// section of the TV Ad card and read by the queue board:
//   { photos: { <id>: { url, path, thumbUrl, thumbPath, name, days, order,
//                       enabled, uploadedAt, addedAt, addedBy } },
//     mode: "default" | "rotate", defaultId, rotateSeconds, updatedAt, updatedBy }
// The photos themselves are JPEGs in Storage (products/tv-backgrounds/); this
// node only ever holds their metadata, so the board's listener stays tiny no
// matter how many photos there are. There is no cap on how many.
//
// DAYS. `days` is a list of weekdays 0–6 (0 = Sunday, JS getDay order). Absent
// or empty = every day. The board shows TODAY's pool: the photos tagged for
// today if there are any, otherwise the every-day photos. "Today" is the day in
// Africa/Johannesburg, whatever clock or time zone the TV itself is set to.
//
// "default" holds one photo (falling back to the first of today's pool when the
// default isn't in it); "rotate" walks today's pool in Workshop order. The
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
export const TV_BG_MAX_EDGE = 1920;   // full photo, long edge
export const TV_BG_THUMB_EDGE = 320;  // Workshop thumbnail, long edge

// Workshop chip order (Mon first) → JS weekday number.
export const WEEK_DAYS = [
  { day: 1, label: "Mon" }, { day: 2, label: "Tue" }, { day: 3, label: "Wed" },
  { day: 4, label: "Thu" }, { day: 5, label: "Fri" }, { day: 6, label: "Sat" },
  { day: 0, label: "Sun" },
];

// South Africa has kept UTC+2 with no daylight saving since 1944, so the
// Johannesburg weekday is the UTC weekday of (now + 2 h) — exact, and the same
// answer on a TV whose own clock zone is set to anything at all.
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;
export function johannesburgDay(nowMs) {
  return new Date(nowMs + SAST_OFFSET_MS).getUTCDay();
}

// RTDB hands an array back as an array, or (after a hand edit) as an object
// with numeric keys; accept both, keep 0–6 only, sorted and unique.
export function normalizeDays(v) {
  const list = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : [];
  const out = new Set();
  for (const x of list) {
    const n = Number(x);
    if (Number.isInteger(n) && n >= 0 && n <= 6) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** Is this photo on for weekday `day`? (no days = every day) */
export function photoShowsOn(photo, day) {
  return !photo.days?.length || photo.days.includes(day);
}

/**
 * Toggle one weekday on a photo's day list. Returns the value to WRITE:
 * null for "every day" (so the node holds nothing), else the sorted list.
 * Switching off the last day is refused (returns `undefined`) — an empty list
 * would read as every day, the opposite of what the tap meant.
 */
export function toggleDay(days, day) {
  const cur = days?.length ? new Set(days) : new Set([0, 1, 2, 3, 4, 5, 6]);
  if (cur.has(day)) {
    if (cur.size === 1) return undefined;
    cur.delete(day);
  } else {
    cur.add(day);
  }
  return cur.size === 7 ? null : [...cur].sort((a, b) => a - b);
}

export function normalizeTvBackgrounds(v) {
  const raw = v && typeof v === "object" ? v : {};
  const photos = Object.entries(raw.photos && typeof raw.photos === "object" ? raw.photos : {})
    // A data: URL would mean image bytes in the database — never drawn.
    .filter(([, p]) => p && typeof p.url === "string" && p.url && !p.url.startsWith("data:"))
    .map(([id, p]) => {
      const uploadedAt = Number(p.uploadedAt) || Number(p.addedAt) || 0;
      const order = Number.isFinite(Number(p.order)) && p.order !== null && p.order !== "" ? Number(p.order) : uploadedAt;
      return {
        id, url: p.url, path: p.path || "",
        thumbUrl: typeof p.thumbUrl === "string" ? p.thumbUrl : "",
        thumbPath: typeof p.thumbPath === "string" ? p.thumbPath : "",
        name: p.name || "",
        days: normalizeDays(p.days),
        order, uploadedAt, addedAt: uploadedAt,
        enabled: p.enabled !== false,
      };
    })
    .sort((a, b) => a.order - b.order || a.uploadedAt - b.uploadedAt || a.id.localeCompare(b.id));
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

/**
 * The rotation for one weekday, in Workshop order: the photos tagged for that
 * day if there are any, else the every-day photos. Switched-off photos never.
 */
export function photosForDay(cfg, day) {
  const on = (cfg?.photos || []).filter((p) => p.enabled !== false);
  const tagged = on.filter((p) => p.days?.length && p.days.includes(day));
  return tagged.length ? tagged : on.filter((p) => !p.days?.length);
}

// The photo on screen now: { id, url, … } or null (= the built-in wall).
//  default → the chosen photo if it is in today's pool, else the pool's first.
//  rotate  → slot = floor(now / rotateSeconds) over today's pool.
export function pickTvBackground(cfg, nowMs) {
  if (!Number.isFinite(nowMs)) return null;
  const pool = photosForDay(cfg, johannesburgDay(nowMs));
  if (pool.length === 0) return null;
  if (cfg.mode === "rotate" && pool.length > 1) {
    const slot = Math.floor(nowMs / (cfg.rotateSeconds * 1000));
    return pool[((slot % pool.length) + pool.length) % pool.length];
  }
  return pool.find((p) => p.id === cfg.defaultId) || pool[0];
}

// Scoped to /settings/tvBackgrounds and nothing wider: a new upload reaches the
// board as a few hundred bytes of metadata, never as a photo re-download.
export function useTvBackgrounds() {
  const [cfg, setCfg] = useState(null);
  useEffect(() => {
    const unsub = onValue(
      ref(database, TV_BACKGROUNDS_PATH),
      (snap) => setCfg(normalizeTvBackgrounds(snap.val())),
      // A read error is NOT "no photos": the board falls back to its built-in
      // wall, but nothing may prune its photo cache on the strength of it.
      () => setCfg({ ...normalizeTvBackgrounds(null), readFailed: true }),
    );
    return () => unsub();
  }, []);
  return cfg;
}

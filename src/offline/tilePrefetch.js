// ─── TILE PHOTO PREFETCH (Junid's recording, 27 Nov 2026) ────────────────────
//
// Fetches the order grid's full photos ahead of the person, into the device
// cache (tilePhotoCache.js), so a scroll on a bad line finds them already here:
//   1. the rows just below the photo window first,
//   2. then the rest of the current shop + division list, in order,
// at most MAX_CONCURRENT at a time, at low fetch priority, one batch per idle
// slot. It PAUSES while the list is scrolling (and SCROLL_QUIET_MS after) and
// while the tab is hidden. On a save-data connection or 2g / slow-2g it does
// nothing beyond the window (the grid narrows its window to one screen there),
// so a shop on a crawl only ever pays for what is on screen and one screen on.
// Storage bytes only — no RTDB.

import { getTile, isTileHeld, loadTileIndex, tileCacheEnabled, tileFetchAllowed, whenFirstScreenLoaded } from "./tilePhotoCache";

export const MAX_CONCURRENT = 4;
export const SCROLL_QUIET_MS = 600;
export const FIRST_SCREEN_GRACE_MS = 800;

let queue = [];
let running = 0;
let quietUntil = 0;
let timer = null;
let listening = false;
let plan = 0;          // the current plan; pump waits until ITS first-screen wait is over
let readyPlan = -1;

/** save-data or a 2g-class connection: no fetching beyond the window. */
export function slowConnection(nav = typeof navigator === "undefined" ? null : navigator) {
  const c = nav?.connection;
  return !!(c && (c.saveData || c.effectiveType === "2g" || c.effectiveType === "slow-2g"));
}

const idle = (f) => (typeof requestIdleCallback === "function" ? requestIdleCallback(f, { timeout: 1500 }) : setTimeout(f, 50));

function later(ms) {
  if (timer) return;
  timer = setTimeout(() => { timer = null; pump(); }, ms);
}

function pump() {
  if (!queue.length || readyPlan !== plan) return;
  if (!tileCacheEnabled() || !tileFetchAllowed()) { queue = []; return; }
  if (typeof document !== "undefined" && document.hidden) return;   // visibilitychange resumes
  const wait = quietUntil - Date.now();
  if (wait > 0) { later(wait + 20); return; }
  while (running < MAX_CONCURRENT && queue.length) {
    const it = queue.shift();
    if (isTileHeld(it.id, it.src)) continue;
    running++;
    // warm: bytes to the device only — no object URL, nothing held in memory.
    getTile(it.id, it.src, { priority: "low", warm: true }).finally(() => { running--; idle(pump); });
  }
}

/**
 * Replace the plan. `ahead`: the rows just below the window, nearest first;
 * `rest`: everything else in the list, in order. On a slow connection both are
 * ignored.
 */
export function setTilePrefetchPlan({ ahead = [], rest = [] }) {
  if (!listening && typeof document !== "undefined") {
    listening = true;
    document.addEventListener("visibilitychange", () => { if (!document.hidden) pump(); });
  }
  if (slowConnection() || !tileCacheEnabled()) { queue = []; return; }
  const seen = new Set();
  queue = [...ahead, ...rest].filter((it) => it && it.id && it.src && !seen.has(it.id) && seen.add(it.id));
  // Never in the first screen's way: wait for its photos, then a beat, then
  // the index (one IndexedDB read), then start.
  const mine = ++plan;
  whenFirstScreenLoaded().then(() => new Promise((r) => setTimeout(r, FIRST_SCREEN_GRACE_MS)))
    .then(() => loadTileIndex()).then(() => { if (mine === plan) { readyPlan = mine; idle(pump); } });
}

/** The list moved: hold prefetch until it has been still for SCROLL_QUIET_MS. */
export function noteTileScroll() { quietUntil = Date.now() + SCROLL_QUIET_MS; }

export function _tilePrefetchStateForTests() { return { queue: queue.slice(), running, quietUntil }; }
export function _resetTilePrefetchForTests() { queue = []; running = 0; quietUntil = 0; if (timer) clearTimeout(timer); timer = null; plan = 0; readyPlan = -1; }

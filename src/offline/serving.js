// ─── OFFLINE MIRROR — "is this device serving from the local copy?", NOW ─────
//
// WHY THIS HAS TO BE SYNCHRONOUS, AND WHY IT IS IN localStorage.
//
// A hook decides on its FIRST RENDER whether to open a live onValue. Opening
// one costs the whole node — 4.7 MB for /products — and closing it a moment
// later does not refund that. So "is the mirror serving this leg" cannot be an
// answer that arrives asynchronously: by the time it arrives, the money is
// spent. It has to be knowable in the same tick as the first render, before
// IndexedDB has been opened and before bootstrap has run.
//
// localStorage is the only synchronous per-device store a browser offers, and
// what is kept here is a HINT, not data: the list of leg names this device was
// serving from the mirror the last time it checked. Every hook that acts on it
// falls back to a live read the moment the local read cannot actually answer,
// so a stale or wrong hint costs one extra check and never a blank screen.
//
// It is deliberately NOT the source of truth. The truth is health.js, read
// from IndexedDB, and it is what every actual read is gated on.

import { offlineMirrorEnabled } from "./mirrorFlag";

export const SERVING_KEY = "marathon-store.offlineMirror.serving";

let cache = null;     // parsed hint, per tab, invalidated on write
const listeners = new Set();

function read() {
  if (cache) return cache;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(SERVING_KEY) : null;
    const parsed = raw ? JSON.parse(raw) : null;
    cache = Array.isArray(parsed?.legs) ? new Set(parsed.legs) : new Set();
  } catch {
    cache = new Set();
  }
  return cache;
}

/** Synchronous, and safe to call in a render. */
export function isLegServing(legName) {
  if (!legName || !offlineMirrorEnabled()) return false;
  return read().has(legName);
}

export function servingKeyFor(legNames) {
  // A stable string, so useSyncExternalStore can compare by value rather than
  // allocating a new Set on every call and re-rendering for ever.
  return legNames.map((l) => (isLegServing(l) ? "1" : "0")).join("");
}

export function setServingLegs(legNames) {
  const next = [...new Set(legNames ?? [])].sort();
  const before = [...read()].sort().join(",");
  if (before === next.join(",")) return false;
  cache = new Set(next);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(SERVING_KEY, JSON.stringify({ legs: next, at: Date.now() }));
    }
  } catch { /* private mode: the hint is per-tab only, which still works */ }
  for (const l of listeners) l();
  return true;
}

export function clearServing() { return setServingLegs([]); }

export function subscribeServing(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function _resetServingForTests() {
  cache = null;
  listeners.clear();
  try { localStorage?.removeItem(SERVING_KEY); } catch { /* ignore */ }
}

// ─── "IS WHAT I AM LOOKING AT CURRENT?" AFTER COMING BACK (27 Nov 2026) ──────
//
// A device serving from its local copy is current as of the last time its
// mirror read the change feed — normally under a minute ago. After the phone
// has been in a pocket, or the page was thrown away and restored, that read
// can be minutes or hours old until the first catch-up pass lands (a few
// seconds). Showing those rows exactly as if they were live would be a lie of
// omission, so for that window the app shows a small "Updating…" marker.
//
// Two things put the marker up:
//   1. a serving mirror whose last good feed read is older than RESUME_SAFE_MS
//      (or has not happened yet this page), and
//   2. any screen showing a saved copy (resumeCopy.js) while it waits for the
//      live answer — setSavedShowing(key, true/false).
//
// Nothing here blocks an action: every stock move and request change already
// re-reads live inside its own get/transaction before it writes.

import { useEffect, useState } from "react";

export const RESUME_SAFE_MS = 2 * 60 * 1000;
const RECHECK_MS = 5 * 1000;

let feedOkAt = null;
const saved = new Set();
const subs = new Set();
const emit = () => { for (const fn of [...subs]) { try { fn(); } catch { /* a subscriber's bug */ } } };

/** The mirror read the change feed successfully at `at` (bootstrap.runOnePass). */
export function markMirrorFeedOk(at) { feedOkAt = at; emit(); }
/** The mirror stopped: no read vouches for anything any more. */
export function resetMirrorFreshness() { feedOkAt = null; emit(); }
export function mirrorFeedOkAt() { return feedOkAt; }

export function isMirrorStale(at, nowMs) {
  return at == null || nowMs - at > RESUME_SAFE_MS;
}

/** A screen is (or is no longer) showing a saved copy instead of a live answer. */
export function setSavedShowing(key, on) {
  const had = saved.has(key);
  if (on) saved.add(key); else saved.delete(key);
  if (had !== !!on) emit();
}
export function isSavedShowing() { return saved.size > 0; }

export function subscribeFreshness(fn) { subs.add(fn); return () => subs.delete(fn); }

/**
 * Pure: should the "Updating…" marker show?
 * `serving` — is any mirror leg serving this device right now.
 */
export function resumeUpdating({ serving, feedOkAt: at, nowMs, savedShowing }) {
  if (savedShowing) return true;
  return !!serving && isMirrorStale(at, nowMs);
}

/** React: true while the marker should show. `isServing()` is asked fresh. */
export function useResumeUpdating(isServing) {
  const compute = () => resumeUpdating({
    serving: (() => { try { return !!isServing(); } catch { return false; } })(),
    feedOkAt, nowMs: Date.now(), savedShowing: saved.size > 0,
  });
  const [on, setOn] = useState(compute);
  useEffect(() => {
    const again = () => setOn(compute());
    const off = subscribeFreshness(again);
    const onVis = () => again();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
    const t = setInterval(again, RECHECK_MS);
    again();
    return () => {
      off();
      clearInterval(t);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return on;
}

export function _resetResumeFreshnessForTests() { feedOkAt = null; saved.clear(); subs.clear(); }

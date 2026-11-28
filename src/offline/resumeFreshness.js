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
//      (or has not happened yet this page) WHILE A PASS IS CATCHING IT UP —
//      the engine running a pass for at least PASS_SHOW_AFTER_MS — and
//   2. any screen showing a saved copy (resumeCopy.js) while it waits for the
//      live answer — setSavedShowing(key, true/false).
//
// THE "WHILE A PASS IS RUNNING" HALF (Junid's recording, 27 Nov: the pill
// never went away). Staleness alone kept it up between passes: any pass
// error — one refused or failing leg, a census or a repair problem, with the
// feed itself reading fine — spaces the next pass PASS_BACKOFF_MS (5 min)
// apart, longer than RESUME_SAFE_MS (2 min), so the marker stood for most of
// every cycle with nothing in flight; and a feed that could not be read kept
// it up for good. Now it means what it says: something is updating. When the
// pass ends — read or not — it comes down; a copy that stays stale is the
// status dot's business (MirrorDot), not a spinner's. A pass shorter than
// PASS_SHOW_AFTER_MS never shows it, so the minute-by-minute passes do not
// blink it.
//
// Nothing here blocks an action: every stock move and request change already
// re-reads live inside its own get/transaction before it writes.

import { useEffect, useState } from "react";

export const RESUME_SAFE_MS = 2 * 60 * 1000;
export const PASS_SHOW_AFTER_MS = 600;
const RECHECK_MS = 5 * 1000;

let feedOkAt = null;
const saved = new Set();
const subs = new Set();
const emit = () => { for (const fn of [...subs]) { try { fn(); } catch { /* a subscriber's bug */ } } };

/** The mirror read the change feed successfully at `at` (bootstrap.runOnePass). */
export function markMirrorFeedOk(at) { feedOkAt = at; emit(); }
/** The mirror stopped: no read vouches for anything any more. */
export function resetMirrorFreshness() {
  feedOkAt = null;
  // A pass that hung across a stop must not hand its start time to the next
  // session (architect review).
  passSince = null;
  if (passTimer) { clearTimeout(passTimer); passTimer = null; }
  emit();
}
export function mirrorFeedOkAt() { return feedOkAt; }

let passSince = null;
let passTimer = null;
/** The mirror engine started (true) or finished (false) a pass (bootstrap.tick). */
export function markMirrorPass(on, nowMs = Date.now()) {
  if (passTimer) { clearTimeout(passTimer); passTimer = null; }
  if (on) {
    if (passSince == null) passSince = nowMs;
    // Re-ask once the pass has run long enough to be worth showing.
    passTimer = setTimeout(() => { passTimer = null; emit(); }, PASS_SHOW_AFTER_MS + 20);
  } else {
    passSince = null;
  }
  emit();
}
export function mirrorPassSince() { return passSince; }

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
export function resumeUpdating({ serving, feedOkAt: at, nowMs, savedShowing, passSince: since = null }) {
  if (savedShowing) return true;
  return !!serving && isMirrorStale(at, nowMs) && since != null && nowMs - since >= PASS_SHOW_AFTER_MS;
}

/** React: true while the marker should show. `isServing()` is asked fresh. */
export function useResumeUpdating(isServing) {
  const compute = () => resumeUpdating({
    serving: (() => { try { return !!isServing(); } catch { return false; } })(),
    feedOkAt, nowMs: Date.now(), savedShowing: saved.size > 0, passSince,
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

export function _resetResumeFreshnessForTests() {
  feedOkAt = null; saved.clear(); subs.clear(); passSince = null;
  if (passTimer) { clearTimeout(passTimer); passTimer = null; }
}

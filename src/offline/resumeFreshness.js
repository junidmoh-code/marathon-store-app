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

// ── "UPDATING…" IS NEVER FOREVER (Junid, 27 Nov 2026) ───────────────────────
// Junid's iPhone kept the pill up on the product page for minutes on end. Its
// own health report (mirror_devices/99d6…, 14:24) said why: the change-feed
// read timed out ("did not answer within 8000 ms") and a pass with any error
// waits PASS_BACKOFF_MS (5 min) before the next one — while the pill comes up
// once the last good read is 2 min old. Nothing ever said "this failed", so
// the pill just sat there.
//
// Now the pill has three faces, and the spinning one is bounded:
//   "updating" — a catch-up is under way (asked for the moment the pill goes
//                up, not left to the next scheduled pass);
//   "failed"   — the catch-up reported a failure, or UPDATE_TIMEOUT_MS passed
//                without one landing: "Couldn't update. Tap to retry";
//   "offline"  — the browser or the database socket says there is no line.
// A tap on "failed" runs every registered retry (the mirror's catch-up, a
// reconnect of the socket) and starts a fresh window.
export const UPDATE_TIMEOUT_MS = 20 * 1000;

let feedOkAt = null;
let feedFailedAt = null;
let connected = null;          // null until the socket has spoken
let suspended = false;         // the mirror is idle-suspended (nobody using it)
let updatingSince = null;      // when the current attempt started
const saved = new Set();
const subs = new Set();
const retries = new Set();
const emit = () => { for (const fn of [...subs]) { try { fn(); } catch { /* a subscriber's bug */ } } };

/** The mirror read the change feed successfully at `at` (bootstrap.runOnePass). */
export function markMirrorFeedOk(at) { feedOkAt = at; feedFailedAt = null; emit(); }
/** The mirror tried to read the change feed at `at` and could not. */
export function markMirrorFeedFailed(at) { feedFailedAt = at; emit(); }
/** The mirror stopped: no read vouches for anything any more. */
export function resetMirrorFreshness() { feedOkAt = null; feedFailedAt = null; emit(); }
export function mirrorFeedOkAt() { return feedOkAt; }

/** The database socket is up (true) or has dropped (false). */
export function setDatabaseConnected(on) {
  const next = !!on;
  if (connected === next) return;
  connected = next;
  emit();
}
/** The mirror is idle-suspended: the line is closed on purpose, nobody is
 *  using the device, and the first touch resumes it and catches up. */
export function setMirrorSuspended(on) {
  if (suspended === !!on) return;
  suspended = !!on;
  emit();
}

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
 * Something that can make a stuck catch-up try again. `fn({ manual })` —
 * `manual` is true for a tap on "Couldn't update", false for the automatic
 * catch-up asked for when the pill first goes up. Returns an unregister.
 */
export function registerUpdateRetry(fn) { retries.add(fn); return () => retries.delete(fn); }

function runRetries(manual) {
  for (const fn of [...retries]) {
    try { fn({ manual }); } catch (err) { console.warn("update retry failed:", err?.message ?? err); }
  }
}

/** The tap on "Couldn't update. Tap to retry". */
export function retryUpdate(nowMs = Date.now()) {
  updatingSince = nowMs;
  feedFailedAt = null;
  runRetries(true);
  emit();
}

/**
 * Pure: should the "Updating…" marker show at all?
 * `serving` — is any mirror leg serving this device right now.
 */
export function resumeUpdating({ serving, feedOkAt: at, nowMs, savedShowing }) {
  if (savedShowing) return true;
  return !!serving && isMirrorStale(at, nowMs);
}

/**
 * Pure: which face does the pill show? "hidden" | "updating" | "failed" | "offline".
 */
export function markerState({
  updating, mirrorStale = false, savedShowing = false, offline = false, idle = false,
  since, failedAt = null, nowMs, timeoutMs = UPDATE_TIMEOUT_MS,
}) {
  if (!updating) return "hidden";
  // Idle-suspended with nothing but an aged mirror to report: the line is shut
  // on purpose (goOffline, so the socket reads "dropped" too) and the first
  // touch resumes and catches up. Not an outage, not "updating".
  if (idle && mirrorStale && !savedShowing) return "hidden";
  if (offline) return "offline";
  if (mirrorStale && failedAt != null && since != null && failedAt >= since) return "failed";
  if (since != null && nowMs - since >= timeoutMs) return "failed";
  return "updating";
}

const browserOffline = () => {
  try { return typeof navigator !== "undefined" && navigator.onLine === false; } catch { return false; }
};

/** The pill's state right now; also starts/ends the attempt window and asks
 *  for the automatic catch-up the moment the pill first goes up. */
export function currentMarkerState(isServing, nowMs = Date.now()) {
  const serving = (() => { try { return !!isServing(); } catch { return false; } })();
  const mirrorStale = serving && isMirrorStale(feedOkAt, nowMs);
  const savedShowing = saved.size > 0;
  const updating = resumeUpdating({ serving, feedOkAt, nowMs, savedShowing });
  const offline = browserOffline() || connected === false;
  // The clock runs only while the pill would actually say "Updating…": hidden
  // (idle) or offline time is not time spent failing to update, and coming
  // back from either starts a fresh attempt (Sonnet review, #1021).
  const face = markerState({ updating, mirrorStale, savedShowing, offline, idle: suspended, since: null, nowMs });
  if (face !== "updating") {
    updatingSince = null;
    return face;
  }
  if (updatingSince == null) {
    updatingSince = nowMs;
    // Do not wait for the next scheduled pass (up to 5 min after a failed
    // one): ask for the catch-up now — only when the mirror is what is behind.
    // Deferred so it never runs inside render.
    if (mirrorStale) Promise.resolve().then(() => runRetries(false));
  }
  return markerState({
    updating, mirrorStale, savedShowing, offline, idle: suspended,
    since: updatingSince, failedAt: feedFailedAt, nowMs,
  });
}

/** React: the pill's face, kept current. `isServing()` is asked fresh. */
export function useResumeMarkerState(isServing) {
  const [state, setState] = useState(() => currentMarkerState(isServing));
  useEffect(() => {
    const again = () => setState(currentMarkerState(isServing));
    const off = subscribeFreshness(again);
    const onVis = () => again();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
    if (typeof window !== "undefined") {
      window.addEventListener("online", again);
      window.addEventListener("offline", again);
    }
    // 1 s while the pill is up, so "updating" turns into "failed" on time.
    const t = setInterval(again, 1000);
    again();
    return () => {
      off();
      clearInterval(t);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
      if (typeof window !== "undefined") {
        window.removeEventListener("online", again);
        window.removeEventListener("offline", again);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
}

/** React: true while the marker should show (kept for callers that only ask "is it up?"). */
export function useResumeUpdating(isServing) {
  return useResumeMarkerState(isServing) !== "hidden";
}

export function _resetResumeFreshnessForTests() {
  feedOkAt = null; feedFailedAt = null; connected = null; suspended = false; updatingSince = null;
  saved.clear(); subs.clear(); retries.clear();
}

// ─── THE APP'S SHARED LIVE READS ─────────────────────────────────────────────
//
// The one instance of sharedLiveReadCore wired to the Realtime Database. Every
// hook that would have called `onValue(ref(database, path), …)` in an effect
// calls `subscribeLivePath(path, …)` instead and gets the same snapshots, the
// same error callback and the same unsubscribe — but shares ONE listener per
// path with every other hook, and that listener survives a screen switch.
// See sharedLiveReadCore.js for why, with the measurements.

import { ref, onValue } from "firebase/database";
import { onAuthStateChanged } from "firebase/auth";
import { database, auth } from "../firebase";
import { createSharedLiveReads, LINGER_MS } from "./sharedLiveReadCore";

// ── THE LINGER IS OFF UNDER THE TEST RUNNER, AND ONLY THERE ─────────────────
// A held listener is module state that outlives a component, which is the
// point of it in the app and a leak between two tests in one file: the hook
// tests that predate this (and the offline mirror's, which count onValue calls
// per mount) each mount, assert and unmount, and expect the next test to start
// with nothing subscribed. So the default is "no linger" when Vite's MODE is
// "test", and the linger is exercised by its own tests, which switch it on
// (sharedLiveRead.test.jsx). Every other mode — a production build, the dev
// server — gets LINGER_MS, and lingerMsForMode is pinned by test.
export function lingerMsForMode(mode) {
  return mode === "test" ? 0 : LINGER_MS;
}
let lingerMs = lingerMsForMode(import.meta.env && import.meta.env.MODE);

const shared = createSharedLiveReads({
  listen: (target, onSnap, onErr) => onValue(target, onSnap, onErr),
  lingerMs: () => lingerMs,
});

// ── WHEN A HELD LISTENER IS LET GO EARLY ────────────────────────────────────
// Wired once, on first use, so importing this module in a test or a worker
// touches neither the DOM nor auth.
let wired = false;
let lastUid;
function wire() {
  if (wired) return;
  wired = true;
  try {
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      // Hidden: nobody is about to open another screen. A lingering listener
      // would only be re-sent by every reconnect of a sleeping device.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") shared.releaseIdle();
      });
    }
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("pagehide", () => shared.releaseIdle());
    }
  } catch { /* no DOM — nothing to wire */ }
  try {
    onAuthStateChanged(auth, (user) => {
      const uid = user ? user.uid : null;
      if (lastUid !== undefined && uid !== lastUid) shared.identityChanged();
      lastUid = uid;
    });
  } catch { /* auth not available — the hooks' own auth gates still apply */ }
}

/** onValue(ref(database, path), onSnap, onErr), shared and kept. */
export function subscribeLivePath(path, onSnap, onErr) {
  wire();
  return shared.subscribe(path, () => ref(database, path), onSnap, onErr);
}

/**
 * The same for a QUERY. `key` must name the query completely — the path and
 * every constraint — because two subscribers with the same key share one
 * listener. `makeQuery()` is only called when a listener is actually opened.
 */
export function subscribeLiveQuery(key, makeQuery, onSnap, onErr) {
  wire();
  return shared.subscribe(key, makeQuery, onSnap, onErr);
}

export function releaseIdleLiveReads() { shared.releaseIdle(); }
export function _resetSharedLiveReadsForTests() { shared.reset(); }
export function _setLingerMsForTests(ms) { lingerMs = ms; }
export function _sharedLiveReadStatsForTests() { return shared.stats(); }

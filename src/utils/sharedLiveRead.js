// ─── THE APP'S SHARED LIVE READS ─────────────────────────────────────────────
//
// The one instance of sharedLiveReadCore wired to the Realtime Database. Every
// hook that would have called `onValue(ref(database, path), …)` in an effect
// calls `subscribeLivePath(path, …)` instead and gets the same snapshots, the
// same error callback and the same unsubscribe — but shares ONE listener per
// path with every other hook, and that listener survives a screen switch.
// See sharedLiveReadCore.js for why, with the measurements.

import { ref, onValue } from "firebase/database";
import { database } from "../firebase";
import { createSharedLiveReads, LINGER_MS, SHORT_LINGER_MS } from "./sharedLiveReadCore";
import { onIdentityChange } from "./identityChange";
import { legFor } from "../offline/localReads";
import { isLegServing } from "../offline/serving";

// ── HOW LONG EACH NODE IS HELD, AND ROUGHLY HOW BIG IT IS ───────────────────
//
// Holding a listener for ten minutes only pays for a node that is big and
// changes slowly: the saving is the re-download, the cost is the changes that
// stream meanwhile and the memory. So the long hold is a short list, and
// everything not on it gets the short one — enough for a tab toggle or a
// remount, nothing more.
//
// `bytes` is a HINT for the idle cap (sharedLiveReadCore MAX_IDLE_*), taken
// from the profiler on 10–11 Nov 2026. It is never measured at run time: a
// 15 MB snapshot is not serialised to find out it is 15 MB.
const MB = 1024 * 1024;
// [node, bytes for the node itself, bytes for one direct child (null = small)]
// A SUB-PATH of a long-hold node gets the long hold too: /stock_targets/hub1
// is the same slow data as /stock_targets, read one location at a time.
const LONG = [
  ["refill_requests", 16 * MB, null],
  ["products", 8 * MB, null],
  ["orders", 4 * MB, null],
  ["customers", 2.5 * MB, null],
  ["settings/displayRows", 1.3 * MB, 0.5 * MB],
  ["settings/displaySlots", 0.4 * MB, null],
  ["stock_targets", 3 * MB, 0.5 * MB],
  ["stock", 7 * MB, 1.5 * MB],
];
const SMALL_BYTES = 0.25 * MB;
// A PLACEHOLDER is a path a hook is handed when it has nothing to read
// ("stock/__off__", "stock/__no_source__") so that it never subscribes to a
// whole parent by accident. Nothing is stored there; it is never held.
export const isPlaceholderKey = (key) => String(key).split("?")[0].split("/").some((seg) => /^__.+__$/.test(seg));
export function lingerPolicyFor(key) {
  if (isPlaceholderKey(key)) return { lingerMs: 0, bytes: 0 };
  const path = String(key).split("?")[0];
  const isQuery = String(key).includes("?");
  for (const [node, bytes, childBytes] of LONG) {
    if (path === node) return { lingerMs: LINGER_MS, bytes };
    if (path.startsWith(`${node}/`)) {
      const depth = path.slice(node.length + 1).split("/").length;
      return { lingerMs: LINGER_MS, bytes: !isQuery && depth === 1 && childBytes ? childBytes : SMALL_BYTES };
    }
  }
  return { lingerMs: SHORT_LINGER_MS, bytes: SMALL_BYTES };
}

// ── THE HOLD IS OFF UNDER THE TEST RUNNER, AND ONLY THERE ───────────────────
// A held listener is module state that outlives a component, which is the
// point of it in the app and a leak between two tests in one file: the hook
// tests that predate this (and the offline mirror's, which count onValue calls
// per mount) each mount, assert and unmount, and expect the next test to start
// with nothing subscribed. So nothing is held when Vite's MODE is "test", and
// the hold is exercised by its own tests, which switch it on
// (sharedLiveRead.test.jsx). Every other mode — a production build, the dev
// server — holds by the table above, and holdsInMode is pinned by test.
export function holdsInMode(mode) {
  return mode !== "test";
}
let holding = holdsInMode(import.meta.env && import.meta.env.MODE);

const shared = createSharedLiveReads({
  listen: (target, onSnap, onErr) => onValue(target, onSnap, onErr),
  policy: (key) => (holding ? lingerPolicyFor(key) : { lingerMs: 0, bytes: 0 }),
});

// ── WHEN A HELD LISTENER IS LET GO EARLY ────────────────────────────────────
// Wired once, on first use, so importing this module in a test or a worker
// touches neither the DOM, auth nor the database.
let wired = false;
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
  try { onIdentityChange(() => shared.identityChanged()); } catch { /* the hooks' own auth gates still apply */ }
  wireConnection();
}

// Opened with the hold, so not under the test runner: the hook tests that
// predate this count every onValue call a mount makes, and with nothing held
// there is nothing idle for a dropped connection to release.
let connectionWired = false;
function wireConnection() {
  if (connectionWired || !holding) return;
  connectionWired = true;
  try {
    // ONE tiny listener. When the line drops, what is held for nobody goes:
    // a held listener is re-sent on every reconnect of a sleeping device.
    // Everything in use is left to the SDK, exactly as a bare onValue is.
    // (.info/connected starts false before the first connect — only a TRUE
    // that turns false is a loss.)
    let was = false;
    onValue(ref(database, ".info/connected"), (snap) => {
      const now = snap.val() === true;
      if (was && !now) shared.connectionLost();
      was = now;
    }, () => {});
  } catch { /* no connection state — idle entries still go on hide and by their hold */ }
}

// Has the offline mirror taken this path over? Then the caller unsubscribed
// because it has another source and will not be back: holding the listener
// would only stream changes to nobody.
function mirrorServes(path) {
  try {
    const match = legFor(path);
    return !!(match && isLegServing(match.leg.name));
  } catch { return false; }
}

/** onValue(ref(database, path), onSnap, onErr), shared and kept. */
export function subscribeLivePath(path, onSnap, onErr) {
  wire();
  const stop = shared.subscribe(path, () => ref(database, path), onSnap, onErr);
  return () => stop({ linger: !mirrorServes(path) });
}

/**
 * The same for a QUERY. `key` must name the query completely — the path and
 * every constraint — because two subscribers with the same key share one
 * listener; it starts with the path, then "?". `makeQuery()` is only called
 * when a listener is actually opened.
 */
export function subscribeLiveQuery(key, makeQuery, onSnap, onErr) {
  wire();
  const path = String(key).split("?")[0];
  const stop = shared.subscribe(key, makeQuery, onSnap, onErr);
  return () => stop({ linger: !mirrorServes(path) });
}

/** The key for a one-constraint child query, value escaped so it cannot
 *  collide with another key or another constraint. */
export function childQueryKey(path, child, value) {
  return `${path}?orderByChild=${encodeURIComponent(child)}&equalTo=${encodeURIComponent(String(value))}`;
}

export function releaseIdleLiveReads() { shared.releaseIdle(); }
export function _resetSharedLiveReadsForTests() { shared.reset(); }
export function _setHoldingForTests(on) { holding = !!on; if (wired) wireConnection(); }
export function _connectionLostForTests() { shared.connectionLost(); }
export function _sharedLiveReadStatsForTests() { return shared.stats(); }

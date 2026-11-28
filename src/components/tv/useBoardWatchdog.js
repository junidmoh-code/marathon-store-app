// ─── THE BOARD'S WATCHDOG (TV board, 28 Nov 2026) ────────────────────────────
//
// Nobody touches the store TV, so a board that has stopped showing live
// orders must mend itself. Healthy = the socket is not down AND the orders
// read last answered without an error (boardHealth.js).
//
//   unhealthy WATCHDOG_MS (FIRST_ANSWER_MS if it never had an answer)
//     → reopen the socket (the SDK re-sends every live listen; the order
//       feeds re-open a cancelled one themselves — utils/listenerRetry.js);
//   still unhealthy WATCHDOG_MS later
//     → a full reload to a cache-busting address (index.html is no-cache and
//       there is no service worker: a reload is always the newest build) —
//       ONLY if the site answers right now (a reload with the line down lands
//       on the browser's error page, and the board is gone), at most once per
//       RELOAD_FLOOR_MS per device, and not after MAX_UNRECOVERED_RELOADS
//       reloads in a row that did not mend it (a refusal that is a rule is not
//       fixed by reloading). Both counters live in localStorage, so no loop
//       survives a reload; the count resets the moment the board is healthy.
import { useEffect, useRef } from "react";
import { goOffline, goOnline } from "firebase/database";
import { database } from "../../firebase";
import { RELOAD_COUNT_KEY, RELOAD_KEY, reloadUrl, watchdogStep } from "./boardHealth";

export const WATCHDOG_CHECK_MS = 15 * 1000;
export const REACH_TIMEOUT_MS = 8 * 1000;

const readNum = (key) => {
  try { const v = Number(window.localStorage.getItem(key)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; }
};
const writeNum = (key, v) => { try { window.localStorage.setItem(key, String(v)); } catch { /* the in-memory guards still hold */ } };

/** Does the site answer right now? A tiny no-store fetch of version.json. */
async function siteReachable() {
  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = setTimeout(() => ctl?.abort(), REACH_TIMEOUT_MS);
    try {
      const r = await fetch(`/version.json?_=${Date.now()}`, { cache: "no-store", signal: ctl?.signal });
      return r.ok;
    } finally { clearTimeout(t); }
  } catch { return false; }
}

export const watchdogIo = {
  bounce: () => { try { goOffline(database); goOnline(database); } catch { /* nothing to bounce */ } },
  reload: (url) => { window.location.replace(url); },
  reachable: siteReachable,
  now: () => Date.now(),
};

export function useBoardWatchdog({ healthy, neverAnswered = false, enabled = true }) {
  const healthyRef = useRef(healthy);
  healthyRef.current = healthy;
  const neverRef = useRef(neverAnswered);
  neverRef.current = neverAnswered;
  const since = useRef(watchdogIo.now());   // last moment the board was healthy (or mount / re-enable)
  const bouncedAt = useRef(null);
  const reloadedAt = useRef(null);          // in memory too: the 5-min floor holds if storage fails (CodeRabbit, #1027)
  const busy = useRef(false);
  useEffect(() => {
    // Either way the clock restarts at the change: healthy time never counts
    // toward an outage (CodeRabbit, #1027), and a mended board starts afresh.
    since.current = watchdogIo.now();
    if (!healthy) return;
    bouncedAt.current = null;
    // Mended: the next outage gets its full set of reloads again.
    try { window.localStorage.removeItem(RELOAD_COUNT_KEY); } catch { /* ignore */ }
  }, [healthy]);
  useEffect(() => {
    if (!enabled) return undefined;
    since.current = watchdogIo.now();          // a re-enabled watchdog starts its clock now
    bouncedAt.current = null;
    const t = setInterval(() => {
      if (busy.current) return;
      const nowMs = watchdogIo.now();
      if (healthyRef.current) { since.current = nowMs; bouncedAt.current = null; return; }
      const step = watchdogStep({
        healthy: false, since: since.current, bouncedAt: bouncedAt.current,
        lastReloadAt: Math.max(readNum(RELOAD_KEY) ?? 0, reloadedAt.current ?? 0) || null,
        nowMs, neverAnswered: neverRef.current,
        unrecoveredReloads: readNum(RELOAD_COUNT_KEY) ?? 0,
      });
      if (step === "bounce" || step === "bounce-only") {
        console.warn(step === "bounce"
          ? "TV board watchdog: no live orders — reopening the connection"
          : "TV board watchdog: reloads have not mended the board — reopening the connection only");
        bouncedAt.current = nowMs;
        watchdogIo.bounce();
      } else if (step === "reload") {
        busy.current = true;
        bouncedAt.current = nowMs;              // whatever happens next, not again for another window
        Promise.resolve(watchdogIo.reachable()).then((ok) => {
          if (!ok) { console.warn("TV board watchdog: the site does not answer — not reloading onto an error page"); return; }
          console.warn("TV board watchdog: still no live orders — reloading the board");
          reloadedAt.current = nowMs;
          writeNum(RELOAD_KEY, nowMs);
          writeNum(RELOAD_COUNT_KEY, (readNum(RELOAD_COUNT_KEY) ?? 0) + 1);
          watchdogIo.reload(reloadUrl(window.location, nowMs));
        }).catch(() => {}).finally(() => { busy.current = false; });
      }
    }, WATCHDOG_CHECK_MS);
    return () => clearInterval(t);
  }, [enabled]);
}

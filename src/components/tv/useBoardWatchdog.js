// ─── THE BOARD'S WATCHDOG (TV board, 28 Nov 2026) ────────────────────────────
//
// Nobody touches the store TV, so a board that has stopped showing live
// orders must mend itself. Healthy = the socket is not down AND the orders
// read last answered without an error (boardHealth.js). Unhealthy for
// WATCHDOG_MS → reopen the socket (the SDK re-sends every live listen, and the
// order feeds re-open a cancelled one themselves — utils/listenerRetry.js).
// Still unhealthy WATCHDOG_MS later → a full reload to a cache-busting address
// (index.html is served no-cache and there is no service worker, so a reload
// is always the newest build), at most once per RELOAD_FLOOR_MS per device —
// the time is kept in localStorage, so a reload loop is impossible even
// across reloads.
import { useEffect, useRef } from "react";
import { goOffline, goOnline } from "firebase/database";
import { database } from "../../firebase";
import { RELOAD_KEY, reloadUrl, watchdogStep } from "./boardHealth";

export const WATCHDOG_CHECK_MS = 15 * 1000;

const readStoredReload = () => {
  try { const v = Number(window.localStorage.getItem(RELOAD_KEY)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; }
};

export const watchdogIo = {
  bounce: () => { try { goOffline(database); goOnline(database); } catch { /* nothing to bounce */ } },
  reload: (url) => { window.location.replace(url); },
  now: () => Date.now(),
};

export function useBoardWatchdog({ healthy, enabled = true }) {
  const healthyRef = useRef(healthy);
  healthyRef.current = healthy;
  const since = useRef(watchdogIo.now());   // last moment the board was healthy (or mount)
  const bouncedAt = useRef(null);
  useEffect(() => {
    if (healthy) { since.current = watchdogIo.now(); bouncedAt.current = null; }
  }, [healthy]);
  useEffect(() => {
    if (!enabled) return undefined;
    const t = setInterval(() => {
      const nowMs = watchdogIo.now();
      if (healthyRef.current) { since.current = nowMs; bouncedAt.current = null; return; }
      const step = watchdogStep({
        healthy: false, since: since.current, bouncedAt: bouncedAt.current,
        lastReloadAt: readStoredReload(), nowMs,
      });
      if (step === "bounce") {
        console.warn("TV board watchdog: no live orders for 3 min — reopening the connection");
        bouncedAt.current = nowMs;
        watchdogIo.bounce();
      } else if (step === "reload") {
        console.warn("TV board watchdog: still no live orders — reloading the board");
        try { window.localStorage.setItem(RELOAD_KEY, String(nowMs)); } catch { /* the floor still holds in memory below */ }
        bouncedAt.current = nowMs;        // even if storage failed, not again for another window
        watchdogIo.reload(reloadUrl(window.location, nowMs));
      }
    }, WATCHDOG_CHECK_MS);
    return () => clearInterval(t);
  }, [enabled]);
}

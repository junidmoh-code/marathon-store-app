// ─── IS THE BOARD SHOWING LIVE ORDERS? (TV board, 28 Nov 2026) ───────────────
//
// On 28 Nov the store TV showed 0 in every column for a whole morning with a
// green "System connected": the dot only watched the socket, and the refused
// orders read was swallowed. This is the board's own answer to "are these
// numbers live?", from two facts it already has — the socket (.info/connected)
// and the orders list it is handed (its `error` / `settled` flags) — and the
// watchdog that acts when the answer stays "no".
//
// Pure: everything takes `nowMs` and returns a value, so it is tested without
// a browser, a database or a clock.

export const WATCHDOG_MS = 3 * 60 * 1000;          // no good snapshot this long → act
export const RELOAD_FLOOR_MS = 5 * 60 * 1000;      // never reload faster than this
export const RELOAD_KEY = "marathon.tv.watchdogReloadAt";

/** Did this orders list come from a successful read? */
export function feedAnswered(orders) {
  if (!orders || orders.error) return false;
  // useOrders marks its lists settled; the kiosk hooks hand a plain array once
  // a range has answered (their initial [] is the only unanswered one).
  if (orders.settled === true) return true;
  if (orders.settled === false) return false;
  return orders.answered === true;
}

/**
 * The face of the status line.
 *   "live"      socket up and orders answered      → green "System connected"
 *   "waiting"   socket up, no orders answer yet    → amber "Waiting for orders"
 *   "refused"   the orders read was refused/cancelled → red "Orders not loading"
 *   "offline"   socket down past its grace         → red "Reconnecting"
 *   "booting"   nothing known yet                  → grey "Connecting"
 */
export function boardStatus({ connected, feedError, lastOkAt }) {
  if (connected === false) return "offline";
  if (feedError) return "refused";
  if (connected === true) return lastOkAt != null ? "live" : "waiting";
  return "booting";
}

/**
 * What the watchdog should do now. `since` is when the board last had a good
 * answer (or mounted, if it never has). `bouncedAt` is when it last reopened
 * the socket for this outage (null if not yet). `lastReloadAt` is the stored
 * time of the last watchdog reload on this device.
 *   "none" | "bounce" | "reload"
 */
export function watchdogStep({ healthy, since, bouncedAt, lastReloadAt, nowMs }) {
  if (healthy) return "none";
  if (nowMs - since < WATCHDOG_MS) return "none";
  if (bouncedAt == null) return "bounce";
  if (nowMs - bouncedAt < WATCHDOG_MS) return "none";
  if (lastReloadAt != null && nowMs - lastReloadAt < RELOAD_FLOOR_MS) return "none";
  return "reload";
}

/** The address a watchdog reload goes to: same page, same hash, a cache-busting query. */
export function reloadUrl(loc, nowMs) {
  const params = new URLSearchParams(loc.search || "");
  params.set("_tvr", String(nowMs));
  return `${loc.pathname || "/"}?${params.toString()}${loc.hash || ""}`;
}

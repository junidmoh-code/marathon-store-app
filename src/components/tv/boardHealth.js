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

export const WATCHDOG_MS = 3 * 60 * 1000;          // refused / offline this long → act
// A board that has NEVER had an answer may simply be downloading it: a
// shop-pinned board's first answer is ~4,000 rows (15–30 s on a good line,
// minutes on a bad one). Bouncing it at 3 min would restart that download
// every time and never converge (Sonnet review, #1027).
export const FIRST_ANSWER_MS = 10 * 60 * 1000;
export const RELOAD_FLOOR_MS = 5 * 60 * 1000;      // never reload faster than this
// Reloads that did not mend the board, in a row: past this the watchdog stops
// reloading (it still reopens the socket) until the board is healthy again —
// a refusal that is a RULE is not fixed by reloading (Sonnet review, #1027).
export const MAX_UNRECOVERED_RELOADS = 3;
export const RELOAD_KEY = "marathon.tv.watchdogReloadAt";
export const RELOAD_COUNT_KEY = "marathon.tv.watchdogReloads";
// A refusal must last this long before the line turns red: the first retry
// (3 s) usually mends a passing cancel, and a red flash means nothing.
export const REFUSED_SHOW_MS = 10 * 1000;

/** Did this orders list come from a successful read? */
export function feedAnswered(orders) {
  // A kiosk board with some ranges answering and one refused still shows real
  // rows: it is working (partial), not refused.
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
export function watchdogStep({
  healthy, since, bouncedAt, lastReloadAt, nowMs, neverAnswered = false, unrecoveredReloads = 0,
}) {
  if (healthy) return "none";
  const budget = neverAnswered ? FIRST_ANSWER_MS : WATCHDOG_MS;
  if (nowMs - since < budget) return "none";
  if (bouncedAt == null) return "bounce";
  if (nowMs - bouncedAt < WATCHDOG_MS) return "none";
  if (lastReloadAt != null && nowMs - lastReloadAt < RELOAD_FLOOR_MS) return "none";
  if (unrecoveredReloads >= MAX_UNRECOVERED_RELOADS) return "bounce-only";
  return "reload";
}

/** The address a watchdog reload goes to: same page, same hash, a cache-busting query. */
export function reloadUrl(loc, nowMs) {
  const params = new URLSearchParams(loc.search || "");
  params.set("_tvr", String(nowMs));
  return `${loc.pathname || "/"}?${params.toString()}${loc.hash || ""}`;
}

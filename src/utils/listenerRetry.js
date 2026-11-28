// ─── A CANCELLED LISTENER IS OPENED AGAIN (TV board blank, 28 Nov 2026) ──────
//
// The RTDB SDK never re-opens a listener the server cancelled: one
// permission_denied and that read is dead until the page reloads. On the
// store TV (a shop-pinned staff account on the DISPLAY board) the orders read
// was cancelled at boot and the board sat on 0 in every column all morning,
// with the connection dot green — and every reload hit the same moment again.
//
// So the order feeds re-subscribe after a cancel, on this bounded backoff,
// keeping whatever rows they already had on screen meanwhile. A read that is
// genuinely refused (wrong scope) costs one small refused request a minute; a
// read refused by a passing moment at boot comes back within seconds.
export const LISTENER_RETRY_MS = Object.freeze([3_000, 10_000, 30_000, 60_000]);

/** Delay before re-subscribing after the n-th consecutive cancel (0-based). */
export function listenerRetryDelay(n) {
  const i = Math.max(0, Math.min(LISTENER_RETRY_MS.length - 1, Number(n) || 0));
  return LISTENER_RETRY_MS[i];
}

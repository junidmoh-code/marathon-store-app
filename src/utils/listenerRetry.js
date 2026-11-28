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

/**
 * Several key-range listeners that feed one list (the TV boards). Each range
 * has its OWN listener, backoff and retry: a refused range is re-opened on
 * its own schedule and never tears down — or re-downloads — a range that is
 * answering (Sonnet architect review, #1025). Its last rows stay in `parts`
 * while it is retried.
 *
 *   open(range, i, onSnap, onErr) → unsubscribe
 *   onRows(parts, failing)  every time any range answers (parts[i] = its last
 *                   value; failing = how many ranges are refused right now)
 *   onError(err, i) every cancel, before its retry is scheduled
 *
 * Returns stop(): closes every listener and every pending retry.
 */
export function subscribeRangesWithRetry({
  ranges, open, onRows, onError = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t),
}) {
  const parts = ranges.map(() => null);
  const unsubs = ranges.map(() => null);
  const timers = ranges.map(() => null);
  const tries = ranges.map(() => 0);
  const failed = ranges.map(() => false);
  const failing = () => failed.filter(Boolean).length;
  let stopped = false;
  const start = (i) => {
    if (stopped) return;
    unsubs[i] = open(ranges[i], i, (value) => {
      if (stopped) return;
      tries[i] = 0;
      failed[i] = false;
      parts[i] = value;
      onRows(parts, failing());
    }, (err) => {
      if (stopped) return;
      unsubs[i] = null;          // the SDK has already dropped a cancelled listener
      failed[i] = true;
      try { onError(err, i); } catch { /* a caller's bug must not stop the retry */ }
      const delay = listenerRetryDelay(tries[i]);
      tries[i] += 1;
      timers[i] = setTimer(() => { timers[i] = null; start(i); }, delay);
    });
  };
  ranges.forEach((_, i) => start(i));
  return () => {
    stopped = true;
    for (let i = 0; i < ranges.length; i += 1) {
      if (timers[i] != null) clearTimer(timers[i]);
      if (unsubs[i]) { try { unsubs[i](); } catch { /* gone */ } }
    }
  };
}

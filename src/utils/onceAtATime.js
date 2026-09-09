// ─── ONE TAP IS ONE ACTION ───────────────────────────────────────────────────
// A guard against a second invocation entering an async handler while the first
// is still inside it.
//
// It exists because of a real hole in Add Product (PR #594). The Save button
// disables on a `saving` STATE flag, and that flag was not set until after the
// duplicate gate had awaited its per-location stock reads — real network I/O on
// shop-floor wifi. Through all of it the button stayed live. Two taps ran two
// handlers, both read the same not-yet-updated gate flag, both raised a confirm,
// and an operator who answered both created TWO products for one code: the exact
// failure the duplicate gate exists to prevent, produced by the gate's own
// latency.
//
// A REF, NOT STATE, and that is the whole point. React state updates are
// asynchronous — the second tap arrives before any re-render, so a state flag is
// still false when it reads it. Only a value that changes synchronously, in the
// same tick as the call, can close this window.
//
// The lock is released in a `finally`, so a handler that throws does not wedge
// the button forever. The rejection is re-thrown: swallowing it here would turn
// a failed save into a silent one.

/**
 * Wrap an async function so that a call arriving while a previous one is still
 * running is DROPPED (returns undefined) rather than queued.
 *
 * Dropped, not queued, deliberately: the second tap is the same instruction as
 * the first, not another one. Queueing it would do the work twice, late.
 *
 * @param {Function} fn
 * @returns {Function} the guarded function, plus `.busy()` for tests
 */
export function onceAtATime(fn) {
  let busy = false;
  const guarded = async (...args) => {
    if (busy) return undefined;
    busy = true;
    try {
      return await fn(...args);
    } finally {
      busy = false;
    }
  };
  guarded.busy = () => busy;
  return guarded;
}

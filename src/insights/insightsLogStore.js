// ─── SHARED /insights_log SUBSCRIPTION — the lifecycle, without React ────────
// Extracted from the provider so the three properties that actually matter can
// be unit-tested against a MOCKED SDK rather than inferred from a running app:
//
//   1. ONE open subscription no matter how many consumers retain it.
//   2. LAZY — nothing opens until the first retain().
//   3. RELEASED — closed `releaseDelayMs` after the last release(), and the
//      cached 18.73 MB dropped with it, so a tablet that has navigated away does
//      not hold it on the heap. The delay is what keeps ordinary navigation free.
//
// `open(onData)` is injected: the provider passes the real firebase onValue, the
// tests pass a counter. Timers are injected for the same reason.

export const EMPTY = Object.freeze([]);

export function createInsightsLogStore({
  open,
  releaseDelayMs = 5 * 60 * 1000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  let consumers = 0;
  let closeFn = null;      // non-null ⇒ a subscription is open
  let timer = null;
  let snapshot = EMPTY;
  const listeners = new Set();

  const emit = () => { for (const l of listeners) l(); };

  const cancelPendingRelease = () => {
    if (timer !== null) { clearTimeoutFn(timer); timer = null; }
  };

  const openNow = () => {
    if (closeFn) return;                         // already open — the whole point
    closeFn = open((data) => {
      snapshot = data && data.length ? data : EMPTY;
      emit();
    });
  };

  const closeNow = () => {
    if (!closeFn) return;
    closeFn();
    closeFn = null;
    snapshot = EMPTY;                            // drop the cached log — heap back
    emit();
  };

  return {
    retain() {
      consumers += 1;
      cancelPendingRelease();
      openNow();
    },
    release() {
      consumers = Math.max(0, consumers - 1);
      if (consumers > 0) return;                 // someone else still needs it
      cancelPendingRelease();
      timer = setTimeoutFn(() => {
        timer = null;
        if (consumers === 0) closeNow();
      }, releaseDelayMs);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() { return snapshot; },
    // Test/diagnostic surface only.
    _state() { return { consumers, isOpen: !!closeFn, hasPendingRelease: timer !== null }; },
  };
}

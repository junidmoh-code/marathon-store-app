// ─── OFFLINE MIRROR — connection state ───────────────────────────────────────
//
// Truth comes from RTDB's own `.info/connected`, never navigator.onLine — the
// browser's flag says "some network exists", not "our database answers"
// . ConnectionDot.jsx renders getState(); nothing else may ask navigator.onLine.
//
// `subscribeConnected(cb)` is injected: production passes an onValue binding on
// `.info/connected` (see rtdbAdapter.js), tests pass a hand-cranked emitter.

export function createConnectionTracker({ subscribeConnected, now = Date.now } = {}) {
  let connected = false;
  let since = null;                 // when the current state was entered
  const lastSyncAt = new Map();     // storeName -> ms of last successful sync
  const listeners = new Set();
  let unsubscribe = null;

  const emit = () => { for (const l of listeners) l(); };

  const start = () => {
    if (unsubscribe || typeof subscribeConnected !== "function") return;
    unsubscribe = subscribeConnected((isConnected) => {
      const next = isConnected === true;
      if (next === connected) return;
      connected = next;
      since = now();
      emit();
    });
  };

  return {
    start,
    stop() {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    },
    isConnected() { return connected; },
    // A later pass surfaces this on the hardware page; sync.js stamps it.
    recordSyncSuccess(storeName, at = now()) {
      lastSyncAt.set(storeName, at);
      emit();
    },
    getState() {
      return {
        connected,
        since,
        lastSyncAt: Object.fromEntries(lastSyncAt),
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

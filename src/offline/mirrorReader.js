// ─── OFFLINE MIRROR — the READER's bounded view of the running mirror ────────
//
// main.jsx registers bootstrap's start promise in mirrorRuntime.js, and the
// status dot consults it directly. A READER on a screen path needs
// two things that raw registry does not give it, and neither belongs in a file
// whose whole point is "zero imports, a promise, nothing else":
//
//   1. A BOUND. `getOfflineMirrorRuntime()` hands back the promise bootstrap is
//      still settling — it may be opening IndexedDB. A screen that awaited it unbounded
//      would put the mirror's startup in front of the read it exists to replace. Every reader has a full network path
//      for "no mirror", so timing out into that is always safe; blocking is not.
//   2. One place to ask "is RTDB actually answering?" — `.info/connected` via
//      the tracker the engine already runs, never navigator.onLine
//      (connection.js documents why).
//
// null means "there is no mirror": flag off, the start failed, or it is taking too long. A rejected start resolves to null rather
// than propagating — a mirror failure must never surface as a screen crash.

import { getOfflineMirrorRuntime } from "./mirrorRuntime";

export const RUNTIME_WAIT_MS = 1500;

export function mirrorRuntime({ timeoutMs = RUNTIME_WAIT_MS } = {}) {
  const registered = getOfflineMirrorRuntime();
  if (!registered) return Promise.resolve(null);
  const settled = Promise.resolve(registered).then((rt) => rt ?? null, () => null);
  if (!(timeoutMs > 0)) return settled;
  // The timer is cleared when the handle wins, so a till that searches on every
  // keystroke does not leave a trail of live timeouts behind it.
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([settled, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

// "Is RTDB answering?" With no mirror running we cannot know, and the honest
// answer for a reader is "assume yes and let the network read fail on its own",
// which is exactly the pre-mirror behaviour.
export function mirrorConnected(runtime) {
  if (!runtime?.connection) return true;
  return runtime.connection.isConnected() === true;
}

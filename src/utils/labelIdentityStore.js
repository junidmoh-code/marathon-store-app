// ─── FETCHING THE IDENTITY MAP — once per session, invalidated on register ───
// The map costs one callable round trip over two whole nodes (~150KB). That is
// cheap once and wasteful per screen, so it is held in a module-level promise
// and shared by every surface that asks.
//
// ── "WITH NO RELOAD" IS THE WHOLE POINT ──────────────────────────────────────
// The owner's rule is that a product leaves Leftovers "immediately, in the same
// session, with no reload". A cached map that nothing invalidates would do the
// exact opposite: register a shoe by alias and the list would keep showing it
// until the tab was closed. So `invalidateIdentity()` drops the cache and bumps
// a version counter, and every hook re-fetches on the bump. Registration paths
// call it after a successful write.
//
// FAIL SOFT, ALWAYS. A failed or denied call resolves to an EMPTY map, never a
// rejection the caller has to handle. An empty map means "the two admin-only
// stores told us nothing", which degrades each screen to the style-code field
// alone — the behaviour before this change. The list must never break because
// a read failed.

import { httpsCallable } from "firebase/functions";
import { useEffect, useState } from "react";
import { functions } from "../firebase";

const productIdentityFn = httpsCallable(functions, "productIdentity");

let cached = null;          // Promise<{map}> | null
let version = 0;            // bumped by invalidateIdentity
const listeners = new Set();

export function fetchIdentityMap() {
  if (!cached) {
    cached = productIdentityFn({})
      .then(({ data }) => (data && data.map && typeof data.map === "object" ? data.map : {}))
      .catch((err) => {
        console.warn("productIdentity: could not load the identity map:", err && err.message);
        // Do NOT keep a failed promise cached — the next screen should retry.
        cached = null;
        return {};
      });
  }
  return cached;
}

/** Drop the cache and tell every mounted hook to refetch. */
export function invalidateIdentity() {
  cached = null;
  version += 1;
  for (const fn of [...listeners]) fn(version);
}

/**
 * The map, or {} until it arrives.
 * `ready` distinguishes "not loaded yet" from "loaded and genuinely empty" —
 * Leftovers waits for it before claiming a product is unregistered, because
 * flashing a card and taking it away is worse than a moment's delay.
 */
export function useLabelIdentity() {
  const [state, setState] = useState({ map: {}, ready: false });

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchIdentityMap().then((map) => { if (alive) setState({ map, ready: true }); });
    };
    load();
    const onBump = () => { if (alive) { setState((s) => ({ ...s, ready: false })); load(); } };
    listeners.add(onBump);
    return () => { alive = false; listeners.delete(onBump); };
  }, []);

  return state;
}

/** Test seam — drops the module cache without notifying listeners. */
export function __resetIdentityCacheForTests() {
  cached = null;
  version = 0;
  listeners.clear();
}

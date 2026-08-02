// ─── INSIGHTS LOG PROVIDER — one subscription, ref-counted, released on idle ──
//
// /insights_log is 18.73 MB. It used to be a bare hook (`useInsightsLog`), so
// each of its five consumers opened its OWN whole-node subscription and paid the
// full download again on every screen mount — 2.93 GB/day from the Store
// Assistant alone (docs/insights-log-investigation.md).
//
// This mirrors ProductsProvider (src/products/ProductsProvider.jsx) in shape,
// with one deliberate difference: ProductsProvider subscribes EAGERLY for the
// whole session because the catalogue is small. 18.73 MB of parsed JSON is a very
// different live heap, and these screens run on tablets that are also running the
// till — so this provider is lazy, ref-counted, and RELEASES the subscription
// (and the cached log) ~5 min after the last consumer unmounts.
//
// The lifecycle lives in insightsLogStore.js, framework-free, so the "exactly one
// subscription" property is unit-tested against a mocked SDK rather than counted
// in production.
//
// AUTH-GATED via the `authReady` prop rather than an imported hook: this module
// must not import from App.jsx (circular), and the read is rules-gated on a
// non-anonymous user.

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { onValue, ref } from "firebase/database";
import { database } from "../firebase";
import { InsightsLogContext, EMPTY_LOG } from "./InsightsLogContext";
import { createInsightsLogStore } from "./insightsLogStore";

export const RELEASE_DELAY_MS = 5 * 60 * 1000;

// Local copy of App.jsx's tsMs — same contract (null/NaN → 0) so the newest-first
// ordering is byte-identical to the hook this replaces. Duplicated rather than
// imported to keep this module free of App.jsx.
function tsMsLocal(v) {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : new Date(v).getTime();
  return Number.isNaN(n) ? 0 : n;
}

// The real SDK subscription, in the shape the store expects.
function openInsightsLog(onData) {
  const unsub = onValue(ref(database, "insights_log"), (snap) => {
    const data = snap.val();
    onData(
      data
        ? Object.values(data).filter(Boolean).sort((a, b) => tsMsLocal(b.timestamp) - tsMsLocal(a.timestamp))
        : EMPTY_LOG,
    );
  });
  return unsub;
}

export function InsightsLogProvider({
  authReady,
  children,
  releaseDelayMs = RELEASE_DELAY_MS,
  open = openInsightsLog,
}) {
  const storeRef = useRef(null);
  if (!storeRef.current) storeRef.current = createInsightsLogStore({ open, releaseDelayMs });
  const store = storeRef.current;

  const log = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  // Signed out / auth not ready: consumers may still mount (a screen rendered
  // during sign-in), so retain/release stay no-ops until the read is permitted.
  const retain = useCallback(() => { if (authReady) store.retain(); }, [authReady, store]);
  const release = useCallback(() => { if (authReady) store.release(); }, [authReady, store]);

  // Unmounting the provider (sign-out, app teardown) must not leak the listener.
  // destroy() closes SYNCHRONOUSLY — draining through release() would only arm
  // the 5-minute timer, leaving a subscription open that no consumer can reuse,
  // and a remount inside that window would hold two live subscriptions.
  useEffect(() => () => store.destroy(), [store]);

  const value = useMemo(() => ({ log, retain, release }), [log, retain, release]);
  return <InsightsLogContext.Provider value={value}>{children}</InsightsLogContext.Provider>;
}

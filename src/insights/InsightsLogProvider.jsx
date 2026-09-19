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
import { isLegServing, subscribeServing, servingKeyFor } from "../offline/serving";
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

// The newest-first array the store hands consumers. ONE function, used by
// both sources, so what a screen renders cannot depend on where the rows came
// from.
function shapeLog(data) {
  return data
    ? Object.values(data).filter(Boolean).sort((a, b) => tsMsLocal(b.timestamp) - tsMsLocal(a.timestamp))
    : EMPTY_LOG;
}

// The real SDK subscription, in the shape the store expects.
function openInsightsLog(onData) {
  const unsub = onValue(ref(database, "insights_log"), (snap) => {
    onData(shapeLog(snap.val()));
  });
  return unsub;
}

// ─── THE OFFLINE MIRROR ──────────────────────────────────────────────────────
//
// /insights_log is 35,800,960 bytes and 112,968 entries, measured 2026-09-19,
// and this provider is the single most expensive read in the app. Three
// screens genuinely need ALL of it — the Insights view, the Customers view and
// the customer detail line's "N orders all-time" — so there is no window to
// narrow. What there is, is the fact that the node is APPEND-ONLY, which means
// a device needs it once and then only what is new.
//
// The mirrored source has the SAME lifecycle as the live one: it opens on the
// first retain(), it closes on release, and closing drops the rows so a tablet
// that has navigated away is not holding 112,968 parsed records on the heap.
// That matters as much here as the bytes do — the whole reason this provider
// is lazy and ref-counted is the live heap, and reading from IndexedDB does
// nothing about that on its own.
//
// It re-reads when the mirror's insights leg moves, which is how a screen left
// open all day still sees today's entries.
function openMirroredInsightsLog(onData) {
  let closed = false;
  let unsubSignal = null;

  const reload = async () => {
    try {
      const [{ getMirrorDbHandle }, { readWholeLeg, MISS }] = await Promise.all([
        import("../offline/mirrorDbHandle"),
        import("../offline/localReads"),
      ]);
      const data = await readWholeLeg(await getMirrorDbHandle(), "insights");
      if (closed) return;
      // MISS means the local copy cannot say — not that the log is empty. An
      // empty array here would show every all-time figure in the app as zero.
      if (data === MISS) return;
      onData(shapeLog(data));
    } catch (err) {
      console.warn("offline mirror: local /insights_log read failed:", err);
    }
  };

  (async () => {
    const { subscribeMirror, legVersion } = await import("../offline/mirrorSignal");
    if (closed) return;
    let seen = legVersion("insights");
    unsubSignal = subscribeMirror(() => {
      const v = legVersion("insights");
      if (v === seen) return;
      seen = v;
      reload();
    });
  })();

  reload();

  return () => {
    closed = true;
    if (unsubSignal) unsubSignal();
  };
}

export function InsightsLogProvider({
  authReady,
  children,
  releaseDelayMs = RELEASE_DELAY_MS,
  open = null,
}) {
  // Which source, decided SYNCHRONOUSLY on the first render — see
  // src/offline/serving.js. An asynchronous decision would mean opening the
  // 35.8 MB subscription first and closing it a moment later, which does not
  // refund anything.
  const serving = useSyncExternalStore(
    subscribeServing,
    () => servingKeyFor(["insights"]),
    () => servingKeyFor(["insights"]),
  );
  const chosen = open ?? (isLegServing("insights") ? openMirroredInsightsLog : openInsightsLog);

  // ── THE STORE IS BUILT IN RENDER, AND TORN DOWN IN AN EFFECT ─────────────
  // Creating it lazily in render is the pattern this provider already used and
  // is safe: createInsightsLogStore opens nothing until the first retain().
  // DESTROYING one is different — destroy() closes a live subscription — and
  // doing that in the render body breaks React's purity contract: a render
  // that is thrown away (a concurrent re-render, StrictMode's double pass)
  // would have already closed a subscription the surviving render still
  // depends on. So the swap is decided in render and the OLD store is
  // destroyed in an effect, after the commit that stopped using it.
  // (Sonnet architect review, PR #618.)
  const storeRef = useRef(null);
  const sourceRef = useRef(null);
  const retiredRef = useRef([]);
  if (!storeRef.current || sourceRef.current !== chosen) {
    if (storeRef.current) retiredRef.current.push(storeRef.current);
    storeRef.current = createInsightsLogStore({ open: chosen, releaseDelayMs });
    sourceRef.current = chosen;
  }
  const store = storeRef.current;
  void serving;

  useEffect(() => {
    if (retiredRef.current.length === 0) return;
    const retired = retiredRef.current;
    retiredRef.current = [];
    for (const old of retired) {
      try { old.destroy(); } catch { /* a teardown must never break a render */ }
    }
  });

  const log = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  // Signed out / auth not ready: consumers may still mount (a screen rendered
  // during sign-in), so retain/release stay no-ops until the read is permitted.
  const retain = useCallback(() => { if (authReady) store.retain(); }, [authReady, store]);
  const release = useCallback(() => { if (authReady) store.release(); }, [authReady, store]);

  // AUTHORIZATION LOST (sign-out) — close NOW and drop the cached log.
  // Gating retain/release alone only stops FUTURE calls: an already-open listener
  // would keep streaming /insights_log, and 18.73 MB of it would stay on the heap,
  // after the read is no longer permitted. A pending 5-minute release timer would
  // likewise still be armed. destroy() cancels the timer, unsubscribes, clears the
  // snapshot and notifies consumers — synchronously.
  useEffect(() => {
    if (!authReady) store.destroy();
  }, [authReady, store]);

  // Unmounting the provider (app teardown) must not leak the listener either.
  // Draining through release() would only arm the 5-minute timer, leaving a
  // subscription open that no consumer can reuse — and a remount inside that
  // window would hold two live subscriptions.
  useEffect(() => () => store.destroy(), [store]);

  const value = useMemo(() => ({ log, retain, release }), [log, retain, release]);
  return <InsightsLogContext.Provider value={value}>{children}</InsightsLogContext.Provider>;
}

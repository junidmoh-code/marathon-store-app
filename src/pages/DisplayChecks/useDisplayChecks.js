// ─── DISPLAY CHECKS — TODAY FEED DATA HOOKS (PR 5, read-only) ─────────────────
// The first staff-facing READER of the module. Two live RTDB subscriptions per
// store, both auth-gated and both quiet on the pre-rules permission-denied state
// (the displayChecks* paths still have no database.rules.json entry while the
// module is dark — a denied read is expected, not a crash). Mirrors the layby
// module's useKeyedNode pattern (src/components/layby/useLayby.js).
//
//   • active index   /displayChecks_active/{store}     held + open + tombstones
//   • today day node /displayChecks/{store}/{saDate}   completed archive
//
// This hook returns the RAW arrays + a `ready` flag; the pure reducer
// (feedModel.deriveFeed) turns them into the three sections. NOTHING here writes
// — confirmation (the write path) is PR 7.

import { useEffect, useState } from "react";
import { ref, onValue } from "firebase/database";
import { onAuthStateChanged } from "firebase/auth";
import { database, auth } from "../../firebase";
import { saDateString } from "../../utils/serverTime";

// Local mirror of App.jsx's useAuthReady — RTDB rejects reads before sign-in and
// will not auto-retry on a permission error, so every listener gates on this.
function useAuthReady() {
  const [ready, setReady] = useState(() => !!auth.currentUser);
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => setReady(!!user));
    return () => unsub();
  }, []);
  return ready;
}

// Subscribe to a keyed node → array of values carrying their node key. `enabled`
// lets the caller stand the listener down (e.g. no store selected). Returns
// { items, ready, error } — `ready` flips true once the first snapshot OR a read
// error has resolved, so the UI can tell "loading" from settled. `error` holds
// the failure code when the read was DENIED/failed, so the caller can surface
// "unavailable" instead of silently rendering an empty feed as "all clear"
// (CodeRabbit: a masked permission/rules failure reads as completed work — the
// exact silent-wrong a compliance feed must not do).
function useKeyedNode(path, enabled) {
  const authReady = useAuthReady();
  // State is KEYED BY PATH: it records which path it belongs to. A store switch
  // (super-admin toggle) or the SA-midnight day-node rollover changes `path`;
  // the reset runs in a passive effect AFTER render, so without keying we'd
  // render the PREVIOUS store's checks (or yesterday's completions) for one
  // commit — a cross-store data bleed in a compliance feed (CodeRabbit). The
  // synchronous guard below suppresses that stale frame.
  const [state, setState] = useState({ path: null, items: [], ready: false, error: null });
  useEffect(() => {
    setState({ path, items: [], ready: false, error: null });
    if (!authReady || !enabled || !path) return;
    const node = ref(database, path);
    const unsub = onValue(
      node,
      (snap) => {
        const data = snap.val();
        const arr = data && typeof data === "object"
          ? Object.entries(data).filter(([, v]) => v && typeof v === "object").map(([key, v]) => ({ key, ...v }))
          : [];
        setState({ path, items: arr, ready: true, error: null });
      },
      (err) => {
        // A denied/failed read is NOT an empty feed — surface it. (Permission-
        // denied is expected while the displayChecks* paths are pre-rules, but
        // an empty feed and an unreadable feed must look different to staff.)
        console.warn(`Display Checks read error on /${path}:`, err?.code || err);
        setState({ path, items: [], ready: true, error: err?.code || "read-error" });
      }
    );
    return () => unsub();
  }, [authReady, enabled, path]);
  // Synchronous stale-suppression: if the state we hold belongs to a DIFFERENT
  // path than the one requested this render, we're in the gap between render and
  // the reset effect — report loading, never the old path's items/error.
  if (state.path !== path) return { items: [], ready: false, error: null };
  return { items: state.items, ready: state.ready, error: state.error };
}

// The current SA calendar day, RE-EVALUATED on a timer so it rolls over at SA
// midnight even if the tab is left open with no RTDB traffic overnight (a wall
// display, a forgotten tab). Without this the day-node key is frozen at first
// render and the Confirmed section would keep showing YESTERDAY's completions
// past 00:00 SAST until the next event forced a re-render — a day-boundary
// misattribution in the one module whose whole point is day-boundary
// correctness (Kimi review, PR 5). `override` pins it for tests/preview. State
// only updates when the string actually changes, so the listener resubscribes
// exactly once, at the rollover.
function useSaDate(override) {
  const [day, setDay] = useState(() => override || saDateString());
  useEffect(() => {
    if (override) { setDay(override); return; }
    setDay(saDateString());
    const id = setInterval(() => {
      const d = saDateString();
      setDay((prev) => (prev === d ? prev : d));
    }, 60 * 1000);
    return () => clearInterval(id);
  }, [override]);
  return day;
}

// The Today feed's two raw sources for one store. `saDate` defaults to the
// server's SA calendar day (the same key the trigger writes) but is injectable
// for tests/preview. When `store` is falsy both listeners stand down.
export function useTodayFeedSources(store, saDate) {
  const day = useSaDate(saDate);
  const enabled = !!store;
  const active = useKeyedNode(store ? `displayChecks_active/${store}` : null, enabled);
  const completed = useKeyedNode(store ? `displayChecks/${store}/${day}` : null, enabled);
  return {
    activeItems: active.items,
    completedItems: completed.items,
    ready: active.ready && completed.ready,
    // Either listener failing means the feed can't be trusted as "empty".
    error: active.error || completed.error || null,
    saDate: day,
  };
}

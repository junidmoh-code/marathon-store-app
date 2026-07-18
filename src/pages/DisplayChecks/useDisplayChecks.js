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
// { items, ready } — `ready` flips true once the first snapshot (or a denied
// read) has resolved, so the UI can tell "loading" from "genuinely empty".
function useKeyedNode(path, enabled) {
  const authReady = useAuthReady();
  const [items, setItems] = useState([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    setItems([]);
    if (!authReady || !enabled || !path) return;
    const node = ref(database, path);
    const unsub = onValue(
      node,
      (snap) => {
        const data = snap.val();
        if (!data || typeof data !== "object") { setItems([]); setReady(true); return; }
        const arr = Object.entries(data)
          .filter(([, v]) => v && typeof v === "object")
          .map(([key, v]) => ({ key, ...v }));
        setItems(arr);
        setReady(true);
      },
      (err) => {
        // Permission-denied is the expected pre-rules state. Keep the list empty.
        console.warn(`Display Checks read error on /${path}:`, err?.code || err);
        setItems([]);
        setReady(true);
      }
    );
    return () => unsub();
  }, [authReady, enabled, path]);
  return { items, ready };
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
    saDate: day,
  };
}

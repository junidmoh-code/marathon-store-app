// ─── The Solved history's reads and writes (solvedLog.js is the pure half) ───
// One module, so a test can stand the whole history in for an in-memory one
// without touching the Solve's own database calls.
import { useEffect, useState } from "react";
import { ref, onValue, query, orderByKey, limitToLast, update } from "firebase/database";
import { database } from "../../firebase";
import { SOLVED_ROOT, SOLVED_PAGE, normalizeSolvedEntry, undoneUpdate } from "./solvedLog";

/**
 * The Solved tab's page of history: the newest SOLVED_PAGE rows, live, by key
 * order — "Show older" widens the window by one page. A query on chronological
 * keys needs no index and never reads the whole node.
 */
export function useSolvedLog(enabled = true) {
  const [limit, setLimit] = useState(SOLVED_PAGE);
  const [state, setState] = useState({ entries: [], settled: false, error: null, hasMore: false });
  useEffect(() => {
    if (!enabled) return undefined;
    return onValue(
      query(ref(database, SOLVED_ROOT), orderByKey(), limitToLast(limit)),
      (snap) => {
        const v = snap.val() || {};
        const entries = Object.entries(v).map(([k, r]) => normalizeSolvedEntry(k, r)).filter(Boolean);
        setState({ entries, settled: true, error: null, hasMore: Object.keys(v).length >= limit });
      },
      (err) => setState((s) => ({ ...s, settled: true, error: String(err?.message || err) })),
    );
  }, [enabled, limit]);
  return { ...state, loadMore: () => setLimit((n) => n + SOLVED_PAGE) };
}

/** Save rows [{ key, log }] in ONE multi-path update. Throws on refusal. */
export async function saveSolvedRows(rows) {
  if (!rows?.length) return;
  await update(ref(database), Object.fromEntries(rows.map(({ key, log }) => [`${SOLVED_ROOT}/${key}`, log])));
}

/** Mark one saved row undone. Throws on refusal. */
export async function markSolvedUndone(key, { at, by }) {
  await update(ref(database), undoneUpdate(key, { at, by }));
}

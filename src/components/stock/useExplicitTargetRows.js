// Shared by the Refill Queue and the hub tab badge (App.jsx) so the two read
// the SAME explicit rows and can never disagree about which cells the scan
// owns (Sonnet architect, PR #784).
import { useEffect, useState } from "react";
import { ref, get } from "firebase/database";
import { database } from "../../firebase";

// Explicit /stock_targets rows for the products a sale row names — read by key,
// once per (dest, product), so the policy cap below sees the row an owner set
// exactly as the engine does. A product whose read has not come back yet is
// ABSENT from the map until then, and the cap falls back to the group policy
// meanwhile — never uncapped (over-asking is the failure this guards). A
// FAILED read is not "no row": it stays absent and is retried every 30 s.
// The map is keyed to its destination and dropped when the hub changes.
const EXPLICIT_RETRY_MS = 30000;
export function useExplicitTargetRows(dest, pids) {
  const [state, setState] = useState({ dest, rows: {} });
  const rows = state.dest === dest ? state.rows : {};
  const [attempt, setAttempt] = useState(0);
  const wanted = pids.join("|");
  useEffect(() => {
    let live = true;
    let retry = null;
    const missing = pids.filter((pid) => !(pid in rows));
    if (!dest || missing.length === 0) return undefined;
    Promise.all(missing.map((pid) => get(ref(database, `stock_targets/${dest}/${pid}`))
      .then((snap) => ({ pid, row: snap.val() || null }))
      .catch(() => ({ pid, failed: true }))))
      .then((results) => {
        if (!live) return;
        const got = results.filter((r) => !r.failed);
        if (got.length) setState((cur) => ({ dest, rows: { ...(cur.dest === dest ? cur.rows : {}), ...Object.fromEntries(got.map((r) => [r.pid, r.row])) } }));
        if (got.length < results.length) retry = setTimeout(() => setAttempt((n) => n + 1), EXPLICIT_RETRY_MS);
      });
    return () => { live = false; if (retry) clearTimeout(retry); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dest, wanted, attempt]);
  return rows;
}


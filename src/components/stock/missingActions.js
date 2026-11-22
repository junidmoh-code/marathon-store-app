// ─── MISSING PRODUCTS — THE SMALL WRITES OF THE ONE-TAP SCREEN ───────────────
// Junid, 22 Nov 2026. Three writes the rebuilt screen makes that are not a
// Solve (the Solve itself is the two hooks', unchanged):
//
//   hideProduct / unhideProduct   the Hide control on every card, and the
//                                 toast's Undo of it. One entry in the hidden
//                                 node, built by hiddenProductsCore — the same
//                                 entry the old Hide panel wrote, minus the
//                                 reason step.
//   undoSneakerRequest            the toast's Undo of a sneaker request. It
//                                 CANCELS the requests that one tap raised —
//                                 by id, each as a compare-and-set that stands
//                                 down the moment Central has started on it —
//                                 and takes back only the untouched seeds that
//                                 tap wrote. It creates nothing.
import { ref, update, runTransaction } from "firebase/database";
import { httpsCallable } from "firebase/functions";
import { database, auth, functions } from "../../firebase";
import { serverNowMs, serverNowIso } from "../../utils/serverTime";
import { stampTxn } from "../../device/deviceStamp";
import { HIDDEN_ROOT, hideEntry, unhideUpdate } from "./hiddenProductsCore";
import { firstBatchUndoCancelTxn, SOLVE_UNDONE_REASON } from "./firstBatchCore";
import { undoCellTxn } from "./solveUndo";

export async function hideProduct(pid) {
  try {
    await update(ref(database), { [`${HIDDEN_ROOT}/${pid}`]: hideEntry({ at: serverNowMs(), by: auth.currentUser?.uid }) });
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: `Couldn't hide — nothing changed. (${e?.message || "error"})` };
  }
}

export async function unhideProduct(pid) {
  try {
    await update(ref(database), unhideUpdate([pid]));
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: `Couldn't unhide — nothing changed. (${e?.message || "error"})` };
  }
}

/**
 * Undo one sneaker request tap. `done` is what the tap returned:
 *   { requestIds, seedPaths, seat }.
 * A request Central has already started on (sent units, or no longer open) is
 * left standing, and so is everything that depends on it.
 */
export async function undoSneakerRequest(done) {
  const ids = (done?.requestIds || []).filter(Boolean);
  if (!ids.length) return { ok: false, msg: "Nothing to undo." };
  try {
    const txn = stampTxn(firstBatchUndoCancelTxn({ nowIso: serverNowIso(), uid: auth.currentUser?.uid || null }), "solve-undo");
    const outcomes = await Promise.all(ids.map((id) => runTransaction(ref(database, `refill_requests/${id}`), txn)));
    // A request THIS Undo already cancelled (an earlier attempt that failed
    // later on) is done, not "Central's work" — so a retry goes on to finish.
    const mine = (o) => { const v = o.snapshot?.val?.(); return !!v && v.status === "cancelled" && v.cancelReason === SOLVE_UNDONE_REASON; };
    const stood = outcomes.filter((o) => !o.committed && !mine(o)).length;
    if (stood) {
      return { ok: false, msg: `Central had already started — ${stood} of ${ids.length} request${ids.length === 1 ? "" : "s"} stand${stood === 1 ? "s" : ""}.` };
    }
    // Every request is cancelled: the seeds this tap wrote go too, each only
    // while it is still the untouched seed (a count or an arrival keeps it).
    const paths = done.seedPaths || [];
    const cells = await Promise.all(paths.map((p) => runTransaction(ref(database, p), undoCellTxn)));
    if (done.seat && cells.every((c) => c.committed)) {
      // A seat left behind would let a later Hub 3 cell count as solved: a
      // failed clear is a failed Undo, retryable (the retry skips what is done).
      await httpsCallable(functions, "seatDivisionSolve")({ ...done.seat, clear: true });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, retry: true, msg: `Couldn't undo — retry. (${e?.message || "error"})` };
  }
}

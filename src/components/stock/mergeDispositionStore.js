// ─── READING THE COUNT STATE FOR TWO PRODUCTS — cheaply ──────────────────────
// The merge confirm screen has to state, per location, whether the loser's
// units will be REMOVED or MOVED ACROSS. That needs the per-cell count records
// for exactly two product ids.
//
// THE READ THAT IS NOT ALLOWED: the whole counted node. Hub 1's is a third of a
// megabyte of eight-field records and this app already pays too much for
// whole-node reads (/stock alone is 5.36MB). Opening a merge must not cost
// that.
//
// THE READ THAT IS: the counted node is keyed `{productId}::{sizeKey}`, so a
// RANGED orderByKey query over the "{pid}::" prefix returns exactly one
// product's cells and nothing else. orderByKey needs no index declaration, so
// there is no rules or index change here. Two products × the locations the
// loser actually holds stock at — a handful of tiny reads.
//
// FAIL SOFT. A denied or failed read yields an EMPTY set for that location,
// and an empty set means every cell TRANSFERS (mergeDisposition's rule 3) —
// the behaviour a merge has always had. A read failure can never turn into a
// removal.

import { ref, query, orderByKey, startAt, endAt, get, child } from "firebase/database";
import { database } from "../../firebase";
import { COUNT_SESSIONS_PATH, COUNTED_PATH, countedCellKeys } from "./mergeDisposition";

// RTDB's documented upper-bound sentinel for a string range: the highest
// code point that can appear in a key. "{pid}::" → "{pid}::\uf8ff" therefore
// spans every size key of that product and stops before the next product.
const HIGH = "\uf8ff";

async function countedForProductAt(loc, sessionId, productId) {
  const q = query(
    ref(database, `${COUNTED_PATH}/${loc}/${sessionId}`),
    orderByKey(),
    startAt(`${productId}::`),
    endAt(`${productId}::${HIGH}`),
  );
  const snap = await get(q);
  return snap.val() || {};
}

/**
 * The counted cell keys at every location the loser holds stock at.
 *
 * @param {object} args
 *   locations   the location ids to consider (the loser's, from allStock)
 *   loserId, survivorId
 * @returns {Promise<{ countedByLoc: {[loc]: Set<string>}, failed: string[] }>}
 *   `failed` names the locations whose read did not come back, so the screen
 *   can say so rather than quietly presenting a plan built on silence.
 */
export async function loadCountedFor({ locations = [], loserId, survivorId }) {
  const countedByLoc = {};
  const failed = [];
  let sessions = {};
  try {
    sessions = (await get(child(ref(database), COUNT_SESSIONS_PATH))).val() || {};
  } catch {
    // No sessions readable → nothing is counted → everything transfers.
    for (const loc of locations) countedByLoc[loc] = new Set();
    return { countedByLoc, failed: [...locations] };
  }

  await Promise.all(locations.map(async (loc) => {
    const sessionId = sessions[loc] && sessions[loc].sessionId;
    if (!sessionId) { countedByLoc[loc] = new Set(); return; }
    try {
      const [lNode, sNode] = await Promise.all([
        countedForProductAt(loc, sessionId, loserId),
        countedForProductAt(loc, sessionId, survivorId),
      ]);
      countedByLoc[loc] = new Set([
        ...countedCellKeys(lNode),
        ...countedCellKeys(sNode),
      ]);
    } catch {
      countedByLoc[loc] = new Set();
      failed.push(loc);
    }
  }));

  return { countedByLoc, failed };
}

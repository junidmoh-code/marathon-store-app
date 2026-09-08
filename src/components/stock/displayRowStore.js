// ─── DISPLAY ROWS — the writers ──────────────────────────────────────────────
//
// The ONLY place a display-row plan (displayRowCore.js) is handed to RTDB.
// Every function here is the same three lines: build the plan, refuse if it
// refuses, apply it as ONE multi-path update. The thinking lives in the pure
// module; this file exists so there is exactly one `update(ref(database), …)`
// per operation and nothing can quietly become two writes.
//
// WHY ONE UPDATE MATTERS HERE SPECIFICALLY (clause 2 of the owner spec): a send
// closes the old row, opens the new one and clears the request. Split across
// three writes, a failure between them leaves a wall with two open rows and a
// request that is still asking — which is the exact fault the Duplicate
// Displays tab was built to clean up. RTDB applies a multi-path update
// atomically, so the whole transition lands or none of it does.
//
// ── THE ONE THING THAT IS NOT IN THE ATOMIC UPDATE, AND WHY ──────────────────
// /settings/displaySlots. The slot has a STALENESS FENCE — it is written by a
// transaction that refuses a write older than the record already there
// (displaySlots.js), and that fence is what stops a delayed clear erasing a
// replacement that landed while it was in flight. A multi-path update cannot
// carry a transaction, and flattening the slot into this update would throw the
// fence away and re-open a race four merged PRs closed.
//
// So the slot write stays its own fenced transaction, fired after the rows
// land, best-effort, exactly as it was before this module existed. The rows are
// the ledger and the source of truth for the two tabs; the slot stays the
// current-state mirror every existing reader (offShelf, the shop marker, the
// count card, displayPairCore's replay) is already built on. If the mirror
// write is lost, the rows are still right and the operator is TOLD — the
// warning is returned, never swallowed.

import { ref, get, update } from "firebase/database";
import { database, auth } from "../../firebase";
import { serverNowIso } from "../../utils/serverTime";
import {
  DISPLAY_ROWS_ROOT, storeRowsPath, sendPlan, openRowPlan, closeRowPlan, openRowsFor,
} from "./displayRowCore";
import { setDisplaySlot, clearDisplaySlot } from "./displaySlots";

/** One row id per transition instant. A retried tap in the same millisecond
 *  rewrites the same row instead of minting a second one; a genuine second
 *  send a minute later is a new row, which is correct — it is a new pair. */
export const rowIdFor = (at) => `r${String(at).replace(/[^0-9]/g, "")}`;

const uid = () => auth.currentUser?.uid || null;

/** Every row for one store — the tabs read the whole node through useDisplayRows;
 *  this is for scripts and for a targeted re-read after a write. */
export async function loadStoreRows(store) {
  return (await get(ref(database, storeRowsPath(store)))).val() || {};
}

export async function loadAllRows() {
  return (await get(ref(database, DISPLAY_ROWS_ROOT))).val() || {};
}

async function apply(updates) {
  await update(ref(database), updates);
}

/**
 * CLAUSE 2 — the operator tapped Send and PICKED A SIZE.
 *
 * `size` comes from the operator and from nowhere else. There is no default
 * here, no fallback to the sent size, no "most available". A missing size is a
 * refusal, not an opportunity to guess.
 *
 * `orderPatch` is the caller's own request-clearing patch (the /orders fields
 * that resolve the refill task), carried INTO the same update so the request is
 * cleared by the same write that moves the rows.
 */
export async function sendDisplayRow({ rows, store, productId, productName, size, bookedHub,
                                       orderId = null, orderPatch = null, at = null }) {
  try {
    const when = at || serverNowIso();
    const plan = sendPlan({
      rows, store, productId, productName, size, bookedHub,
      rowId: rowIdFor(when), at: when, by: uid(), orderId, orderPatch, via: "send",
    });
    if (!plan.ok) return { ok: false, message: plan.message };
    await apply(plan.updates);

    // The mirror, fenced, best-effort — and REPORTED when it does not land.
    let warning = null;
    const res = await setDisplaySlot({
      store, productId, productName: productName || "", size: String(size),
      bookedHub: bookedHub || null, source: "display_refill", orderId, at: when,
    });
    if (res && res.ok === false) warning = `The display record is saved, but the count's display slot could not be updated (${res.message || "write failed"}) — retry once.`;
    else if (res && res.superseded) warning = "The display record is saved, but a newer slot write won the race — check the wall record.";
    return { ok: true, rowId: plan.rowId, closed: plan.closed, warning };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

/**
 * The wall walk's ON THE WALL, and the Duplicate tab's "the real size is not
 * listed". `keepOpen` is the difference: a wall walk replaces what the record
 * says, a duplicate-tab addition sits alongside the rows the operator is about
 * to judge.
 */
export async function registerDisplayRow({ rows, store, productId, productName, size, bookedHub,
                                           via = "wall_walk", keepOpen = false, at = null }) {
  try {
    const when = at || serverNowIso();
    const plan = openRowPlan({
      rows, store, productId, productName, size, bookedHub,
      rowId: rowIdFor(when), at: when, by: uid(), via, keepOpen,
    });
    if (!plan.ok) return { ok: false, message: plan.message };
    await apply(plan.updates);
    let warning = null;
    const res = await setDisplaySlot({
      store, productId, productName: productName || "", size: String(size),
      bookedHub: bookedHub || null, source: "registration", at: when,
    });
    if (res && res.ok === false) warning = `The display record is saved, but the count's display slot could not be updated (${res.message || "write failed"}) — retry once.`;
    return { ok: true, rowId: plan.rowId, closed: plan.closed, warning };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

/**
 * Close ONE row — the Duplicate tab's per-size tap, and the manual corrections.
 *
 * THE SLOT IS ONLY CLEARED WHEN THE LAST OPEN ROW GOES. Closing one of three
 * duplicates leaves two pairs claimed on that wall, so tombstoning the slot
 * would tell the count nothing is out there and hand the next counter a
 * discrepancy that is not real — the mirror follows the ledger, it does not
 * lead it. When a row DOES survive, the slot is re-pointed at the survivor's
 * size, because that is what the wall now says.
 */
export async function closeDisplayRow({ rows, row, reason, via = "manual", detail = null, at = null }) {
  try {
    const when = at || serverNowIso();
    const plan = closeRowPlan({ row, at: when, by: uid(), reason, via, detail });
    if (!plan.ok) return { ok: false, message: plan.message };
    await apply(plan.updates);

    const survivors = openRowsFor(rows, row.store, row.productId).filter((r) => r.rowId !== row.rowId);
    let warning = null;
    let res;
    if (survivors.length === 0) {
      res = await clearDisplaySlot({ store: row.store, productId: row.productId, source: "manual", at: when });
    } else {
      const keep = survivors[survivors.length - 1];
      res = await setDisplaySlot({
        store: row.store, productId: row.productId, productName: keep.productName || "",
        size: String(keep.size), bookedHub: keep.bookedHub || null, source: "registration", at: when,
      });
    }
    if (res && res.ok === false) warning = `The display record is closed, but the count's display slot could not be updated (${res.message || "write failed"}) — retry once.`;
    return { ok: true, stockMoved: false, warning };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

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
  DISPLAY_ROWS_ROOT, storeRowsPath, sendPlan, openRowPlan, closeRowPlan, openRowsFor, rowSegment,
} from "./displayRowCore";
import { stockSizeKey } from "../../utils/sizeKey";
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
 * THE ROWS FOR ONE (store, product), READ NOW.
 *
 * Every replacement path used to build its plan from the caller's SUBSCRIPTION
 * snapshot, which can be arbitrarily stale — a tab left open, a slow listener,
 * a device that just woke. A plan built on a stale snapshot closes rows that no
 * longer exist and misses the one that does, which opens a second row beside
 * it. (CodeRabbit.)
 *
 * One keyed read immediately before the plan shrinks that window from "however
 * old the snapshot is" to a single round trip. It does NOT make the write a
 * compare-and-set — RTDB has no cross-path CAS and a multi-path update cannot
 * be a transaction, so a genuinely concurrent second sender can still land a
 * second row. That residual is what the Duplicate Displays tab is for, it is
 * the same window every hand-operated correction card in this app carries, and
 * closing it properly means a server writer plus a rules change, which this
 * work is fenced out of. Stated, not papered over.
 */
async function rowsNow(store, productId) {
  const byRow = (await get(ref(database, `${storeRowsPath(store)}/${rowSegment(productId)}`))).val() || {};
  return { [store]: { [productId]: byRow } };
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
                                       orderId = null, requestedAt = null, orderPatch = null, at = null }) {
  try {
    const when = at || serverNowIso();
    // Freshest truth wins over the caller's snapshot. See rowsNow.
    const live = await rowsNow(store, productId).catch(() => rows);
    const plan = sendPlan({
      rows: live, store, productId, productName, size, bookedHub,
      // `requestedAt` is the ORDER's own instant for the "requested" timeline
      // entry. It was accepted by the caller and by sendPlan and DROPPED right
      // here — not destructured, so never forwarded — which left every timeline
      // reading "requested and sent in the same minute" while three comments
      // said otherwise. The source test that "pinned" it read App.jsx only and
      // was therefore vacuous; the pin now lives on the plan builder, where the
      // value actually lands. (Independent second-brain review.)
      rowId: rowIdFor(when), at: when, by: uid(), orderId, requestedAt, orderPatch, via: "send",
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
    // keepOpen deliberately closes nothing, so it needs no re-read; the
    // replacement path does. See rowsNow.
    const live = keepOpen ? rows : await rowsNow(store, productId).catch(() => rows);
    const plan = openRowPlan({
      rows: live, store, productId, productName, size, bookedHub,
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

    // THE SURVIVORS ARE READ AFTER THE CLOSE, not taken from the caller's
    // snapshot. Deciding "was that the last one?" from a stale map is how a
    // slot gets tombstoned while a row is still open — the count then stops
    // subtracting a pair that is genuinely on a wall. (CodeRabbit.)
    const after = await rowsNow(row.store, row.productId).catch(() => rows);
    const survivors = openRowsFor(after, row.store, row.productId).filter((r) => r.rowId !== row.rowId);
    let warning = null;
    let res;
    if (survivors.length === 0) {
      res = await clearDisplaySlot({ store: row.store, productId: row.productId, source: "manual", at: when });
    } else {
      // The survivor's OWN provenance, not a blanket "registration". The slot's
      // `source` and `orderId` are its audit trail (displaySlots.js's shape
      // note), and rewriting a display_refill slot as a registration throws
      // away which order put that pair on the wall.
      // (Independent second-brain review.)
      const keep = survivors[survivors.length - 1];
      res = await setDisplaySlot({
        store: row.store, productId: row.productId, productName: keep.productName || "",
        size: String(keep.size), bookedHub: keep.bookedHub || null,
        source: keep.openedVia === "send" ? "display_refill" : "registration",
        orderId: keep.requestOrderId || null,
        at: when,
      });
    }
    if (res && res.ok === false) warning = `The display record is closed, but the count's display slot could not be updated (${res.message || "write failed"}) — retry once.`;
    return { ok: true, stockMoved: false, warning };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}


/**
 * A DISPLAY PARTNER ORDER IS A DISPLAY SALE — close the row it describes.
 *
 * When a shop raises a Display Partner request, the pair on its wall is being
 * sold right now; that is the moment this app first learns the display is
 * leaving, and it is why placement already tombstones the display SLOT
 * (App.jsx, `clearDisplaySlot(source: "display_sold")`). The ledger has to
 * follow, or the slot and the rows disagree from the first sale onward.
 *
 * IT DOES ITS OWN KEYED READ rather than taking a subscription. The caller is
 * the ordering screen — the hottest surface in the app — and one small read of
 * `/settings/displayRows/{store}/{productId}` at placement is cheaper than a
 * whole-node listener mounted for every assistant all day.
 *
 * IT CLOSES ONE ROW OR NONE. With a size on the order it takes the open row at
 * that size; without one, or with several candidates, it closes NOTHING and
 * leaves the wall for the Duplicate Displays tab. One sale is one pair, and
 * guessing which of two records it was is the guess this whole feature refuses
 * to make.
 *
 * Best-effort and never thrown: the ORDER is the fact that must not be lost.
 */
export async function closeDisplayRowForPartnerSale({ store, productId, size = null, orderId = null, at = null }) {
  try {
    if (!store || !productId) return { ok: false, message: "Store and product are required." };
    const when = at || serverNowIso();
    const byRow = (await get(ref(database, `${storeRowsPath(store)}/${rowSegment(productId)}`))).val() || {};
    const rows = { [store]: { [productId]: byRow } };
    let open = openRowsFor(rows, store, productId);
    const wantKey = size == null ? null : stockSizeKey(String(size));
    if (wantKey && wantKey !== "_") {
      const exact = open.filter((r) => r.sizeKey === wantKey);
      if (exact.length) open = exact;
    }
    if (open.length !== 1) {
      return { ok: true, closed: null,
        message: open.length === 0 ? "no open display record for this wall" : `${open.length} display records claim this wall — left for a human` };
    }
    const plan = closeRowPlan({ row: open[0], at: when, by: uid(), reason: "sold", via: "partner_order",
                                detail: { reason: "sold", orderId } });
    if (!plan.ok) return { ok: false, message: plan.message };
    await apply(plan.updates);
    return { ok: true, closed: open[0].rowId };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

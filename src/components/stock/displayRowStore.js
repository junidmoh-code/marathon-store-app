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

import { ref, get, update, runTransaction } from "firebase/database";
import { database, auth } from "../../firebase";
import { serverNowIso } from "../../utils/serverTime";
import {
  DISPLAY_ROWS_ROOT, storeRowsPath, sendPlan, openRowPlan, closeRowPlan, openRowsFor, rowSegment, rowSizeText,
  rowPath, rowIsOpen, CLOSE_REASON_TEXT,
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
  const path = storeRowsPath(store);
  // A refused segment yields a NULL path. Interpolating that into a string
  // gives the literal "null" and reads a node that belongs to nobody, which is
  // worse than the collision the refusal replaced. Every use of these path
  // builders checks. (Self-review of the seg() change.)
  if (!path) return {};
  return (await get(ref(database, path))).val() || {};
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
  // KEYED WITH THE SANITISED IDS, because that is what openRowsFor looks up.
  // The first cut read the sanitised PATH and then keyed the returned map with
  // the RAW ids — so for any id carrying an RTDB-illegal character the read
  // succeeded and the lookup missed, `byRow` came back empty, the plan closed
  // nothing and opened a second row beside the live one. That is verbatim the
  // failure openRowsFor's own docstring says its sanitised lookup exists to
  // stop, put back on the other side of the same call.
  // (Adversarial review of the fix round.)
  const st = rowSegment(store), pid = rowSegment(productId);
  // Same rule: refuse rather than build "settings/displayRows/null/null".
  if (!st || !pid) return {};
  const byRow = (await get(ref(database, `${storeRowsPath(store)}/${pid}`))).val() || {};
  return { [st]: { [pid]: byRow } };
}

/** The ledger read that a write DEPENDS ON. A failure is a refusal, not a
 *  shrug: falling back to the caller's snapshot restores the exact staleness
 *  the re-read exists to remove, and does it silently — the operator taps Send,
 *  sees success, and a second row appears on the wall. Every other failure in
 *  this module is reported; this one was swallowed.
 *  (Adversarial review of the fix round.) */
async function rowsNowOrRefuse(store, productId) {
  try {
    return { ok: true, rows: await rowsNow(store, productId) };
  } catch (err) {
    return { ok: false, message: `the display records could not be read (${err?.message || err}) — nothing was changed, try again` };
  }
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
    // Freshest truth wins over the caller's snapshot. See rowsNow.
    const fresh = await rowsNowOrRefuse(store, productId);
    if (!fresh.ok) return { ok: false, message: fresh.message };
    // `when` IS STAMPED AFTER THE READ, not before it. Stamped first, the slot
    // mirror's instant was already one round trip old by the time the write
    // landed, so a legitimate send was that much likelier to lose the staleness
    // fence and come back `superseded`. (Adversarial review of the fix round.)
    const when = at || serverNowIso();
    const plan = sendPlan({
      rows: fresh.rows, store, productId, productName, size, bookedHub,
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
    // keepOpen deliberately closes nothing, so it needs no re-read; the
    // replacement path does. See rowsNow.
    let live = rows;
    if (!keepOpen) {
      const fresh = await rowsNowOrRefuse(store, productId);
      if (!fresh.ok) return { ok: false, message: fresh.message };
      live = fresh.rows;
    }
    const when = at || serverNowIso();   // after the read — see sendDisplayRow
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

    // ── A CLOSE IS A COMPARE-AND-SET, NOT A BLIND FIELD WRITE ──────────────
    //
    // This wrote `status/closedAt/closedBy/closedReason/closedVia/closedRef`
    // unconditionally, from the caller's row object, with no freshness check
    // on the row itself (the re-read below is for the SURVIVORS, and happens
    // after). So a row the till had ALREADY closed could be closed again by an
    // operator whose tab had not caught up — and the second write silently
    // replaced the first's provenance:
    //
    //   10:00  a display pair sells; closeDisplayRowOnSale closes the row
    //          `sold` / `pos_sale`, with the movement id on closedRef.
    //   10:00  the operator's Duplicate tab still shows it open. They tap
    //          close, reason `corrected`.
    //   result the row reads "a human corrected this record", the sale is gone
    //          from it, and the timeline carries both events with the wrong one
    //          winning every field a reader looks at.
    //
    // The row ends closed either way, so no stock and no duplicate follows —
    // but the AUDIT TRAIL IS THE PRODUCT here. A ledger that cannot say whether
    // a pair sold or was corrected off the record is not a ledger.
    //
    // The trigger has always done this properly (`claimClose` only commits on
    // an open row). The client did not, and the two writers are in a genuine
    // race by design: one fires off a till, the other off a tap. So the same
    // rule, on the same shape, from the other side. (CodeRabbit.)
    //
    // WHY ONLY HERE, and not on the SEND's close: sendPlan's close travels in
    // the one atomic multi-path update that also opens the new row and clears
    // the request (clause 2), and a multi-path update cannot carry a
    // transaction. That path plans from a fresh keyed re-read taken moments
    // before, which is the guard it gets. This path had neither.
    const base = rowPath(row.store, row.productId, row.rowId);
    if (!base) return { ok: false, message: `"${row.store}" or "${row.productId}" cannot be an RTDB key, so no display record could be closed.` };
    const claim = await runTransaction(ref(database, base), (cur) => {
      if (!rowIsOpen(cur)) return undefined;                  // already closed — leave every field alone
      const e = `closed_${String(when).replace(/[.#$/[\]\s:]/g, "-")}`;
      return {
        ...cur, status: "closed", closedAt: when, closedBy: uid(),
        closedReason: reason, closedVia: via || null,
        closedRef: (detail && (detail.movementId || detail.orderId || detail.replacedBy)) || null,
        events: { ...(cur.events || {}), [e]: { at: when, what: "closed", by: uid(), detail: detail || { reason } } },
      };
    });
    if (!claim.committed) {
      // Someone got there first. Report what the record actually says rather
      // than a bare failure — the operator's intent (this pair is not on the
      // wall) has been satisfied, just not by them.
      const wonBy = claim.snapshot && claim.snapshot.val();
      const how = wonBy && wonBy.closedReason ? CLOSE_REASON_TEXT[wonBy.closedReason] || wonBy.closedReason : "closed";
      return { ok: true, stockMoved: false, alreadyClosed: true,
        warning: `That display record had already been closed (${how}) — left as it was, so the earlier reason is not overwritten.` };
    }

    // THE SURVIVORS ARE READ AFTER THE CLOSE, not taken from the caller's
    // snapshot. Deciding "was that the last one?" from a stale map is how a
    // slot gets tombstoned while a row is still open — the count then stops
    // subtracting a pair that is genuinely on a wall. (CodeRabbit.)
    //
    // The ROW IS ALREADY CLOSED at this point, so a failed read here cannot be
    // a refusal — it can only leave the mirror unsynced, which is reported.
    const after = await rowsNowOrRefuse(row.store, row.productId);
    if (!after.ok) {
      return { ok: true, stockMoved: false,
        warning: "The display record is closed, but the count's display slot could not be checked — reopen the tab and confirm the wall's record looks right." };
    }
    const survivors = openRowsFor(after.rows, row.store, row.productId).filter((r) => r.rowId !== row.rowId);
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
        // `rowSizeText`, and it decodes — the SAME reason the trigger's mirror
        // carries a fallback, and
        // a worse failure on this side. `openRowsFor`/`rowIsOpen` require a good
        // `sizeKey` and say NOTHING about `size`, so a hand-fixed row, an older
        // shape or a partial write can be open, be the survivor, and carry no
        // size. `String(undefined)` is the NON-EMPTY string "undefined", which
        // setDisplaySlot happily accepts and encodes, writing
        // `sizeKey: "undefined"` into the slot — while the ledger row still says
        // "10". The mirror then represents no row at all, and every reader built
        // on the slot (offShelf, the shop marker, the count card) reads a size
        // that does not exist.
        //
        // The trigger's version of this bug THREW, which is loud. This one is
        // silent, which is worse. sizeKey is present on an open row by
        // definition, so it is the correct stand-in. (CodeRabbit.)
        //
        // AND IT MUST BE DECODED FIRST. A bare `?? keep.sizeKey` writes the
        // RTDB-safe key into the slot's HUMAN `size` field, so a 9.5 display
        // becomes a slot reading "9_5" — permanently, and on every screen that
        // shows a slot size. Swapping the word "undefined" for the string "9_5"
        // is a better bug, not a fixed one.
        // (Adversarial review of PR #585.)
        size: String(rowSizeText(keep)), bookedHub: keep.bookedHub || null,
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
 * IT CLOSES ONE ROW OR NONE, and the rule is worth stating exactly because an
 * earlier docstring described a stricter one than the code:
 *
 *   • a size on the order → the open row AT THAT SIZE, if there is one;
 *   • NO size on the order → the only open row, whatever its size. A Display
 *     Partner request is size-optional by design ("the display pair sold, send
 *     another"), so requiring one would mean most display sales never close.
 *     One open row is one pair, and one sale is one pair; there is nothing to
 *     guess between.
 *   • SEVERAL candidates either way → nothing, and the wall goes to the
 *     Duplicate Displays tab. That is the case with a real choice in it.
 *
 * A size that is present but MALFORMED (blank, whitespace, "Free Size") is a
 * refusal, not a stand-in for "no size" — it would otherwise close a row of
 * some other size.
 *
 * Best-effort and never thrown: the ORDER is the fact that must not be lost.
 */
export async function closeDisplayRowForPartnerSale({ store, productId, size = null, orderId = null, at = null }) {
  try {
    if (!store || !productId) return { ok: false, message: "Store and product are required." };
    const when = at || serverNowIso();
    // An id that cannot be an RTDB key is a REFUSAL, not a quiet "nothing here".
    // rowsNow returns {} for one, which is indistinguishable from a clean wall,
    // and the caller only logs on ok === false. "A refusal is visible" has to
    // hold on this path too. (Adversarial review of the fix round.)
    if (!rowSegment(store) || !rowSegment(productId)) {
      return { ok: false, message: `"${store}" or "${productId}" cannot be an RTDB key, so no display record could be looked up.` };
    }
    const rows = await rowsNow(store, productId);
    let open = openRowsFor(rows, store, productId);
    // ONLY `size == null` MEANS "no size on the order". A supplied size that is
    // blank or encodes to underscores was falling through to the no-size branch,
    // so a partner sale could close the only open row even when that row is a
    // different size — the guess this feature refuses to make, reached by an
    // input nobody checked. (CodeRabbit.)
    let wantKey = null;
    if (size != null) {
      wantKey = stockSizeKey(String(size));
      if (/^_+$/.test(wantKey)) {
        return { ok: true, closed: null, message: "the order's size is unreadable, so no display record was closed" };
      }
    }
    if (wantKey) {
      // A SIZE THAT MATCHES NOTHING IS A REFUSAL, not a fallback to the whole
      // list. `if (exact.length) open = exact;` kept the FULL list on a miss, so
      // an order for size 9 closed the wall's only open row even when that row
      // says size 10 — the record and the shop are contradicting each other,
      // which is exactly the case a human has to look at. The docstring above
      // already promised this; the code did not do it.
      // (Adversarial review.)
      const exact = open.filter((r) => r.sizeKey === wantKey);
      if (!exact.length) {
        return { ok: true, closed: null,
          message: `the wall's display record is a different size to the one that sold — left for the Duplicate Displays tab` };
      }
      open = exact;
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

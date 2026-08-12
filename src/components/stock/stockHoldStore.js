// ─── STOCK HOLD — DATA LAYER ─────────────────────────────────────────────────
// Every read and write of the central→hub held-credit lane, in one file, under
// the same two rules as hubCountStore.js: one-shot get()s in the release
// surfaces (the pick queue keeps its existing live hooks), and NO NEW STOCK
// WRITE PATH — the hold and the release are both ordinary applyMovement calls,
// the release deterministic and therefore idempotent.
//
// ── THE SHAPE ────────────────────────────────────────────────────────────────
//   /settings/stockHold/config = { enabled, delegates: {uid: name|true},
//                                  updatedAt, updatedBy }
//   /settings/stockHold/held/{dest}/{lineId} = {
//     productId, productName, size (RAW), sizeKey, qty, dest,
//     shipmentId ("2026-08-12_1400"), windowLabel ("14:00"),
//     refillId, movementId,            // the fulfil's own movement id = lineId
//     uncounted?,                      // came from a `received` (no source leg)
//     heldAt, heldBy,
//     carriedFrom?, notArrivedAt?, notArrivedBy?,   // partial-arrival history
//   }
//   /settings/stockHold/released/{dest}/{shipmentId}/{lineId} =
//     { ...line, releasedAt, releasedBy, releaseMovementId }
//
// ── WHY THE STOCK PARKS AT stock/in_transit ──────────────────────────────────
// The fulfil's movement runs central → in_transit (the location the manual
// Transfer lane already uses), so the source deducts AT FULFIL (the box has
// left) and the destination credits AT RELEASE (it arrived) — genuinely in
// transit, visible to anything that sums the network. The release is a
// transfer_in in_transit → hub with movementId `rel_{lineId}`: applyMovement's
// idempotency makes a double tap credit NOTHING extra, and its negative floor
// refuses to credit a phantom line whose fulfil never actually parked stock.
//
// ── CRASH WINDOWS, STATED ────────────────────────────────────────────────────
// Fulfil: movement (atomic) → held line → request close. A crash between the
// first two leaves stock parked with no line; the fulfil surface reports it as
// a retryable failure, and the retry replays the movement idempotently and
// writes the line. Release: movement (atomic, idempotent) → ONE update()
// removing the line + archiving it + staling any counted record. A crash
// between them leaves the line held with its movement written; the next
// release replays idempotently and the bookkeeping completes. No ordering
// double-credits and none loses a unit.

import { ref, child, get, update, runTransaction } from "firebase/database";
import { database, auth } from "../../firebase";
import { applyMovement } from "./applyMovement";
import { IN_TRANSIT } from "./locations";
import { serverNowIso, serverNowMs } from "../../utils/serverTime";
import { STOCK_HOLD_ROOT } from "../../config/stockHold";
import { HUB_COUNT_ROOT } from "../../config/hubSneakerCount";
import { cellKey } from "./hubCountCore";

const one = async (path) => (await get(child(ref(database), path))).val();
const safeSeg = (s) => String(s ?? "").replace(/[.#$/\[\]\s]/g, "_");

export const holdConfigPath = () => `${STOCK_HOLD_ROOT}/config`;
export const heldPath = (dest) => `${STOCK_HOLD_ROOT}/held/${safeSeg(dest)}`;
export const heldLinePath = (dest, lineId) => `${heldPath(dest)}/${safeSeg(lineId)}`;
const releasedLinePath = (dest, shipmentId, lineId) =>
  `${STOCK_HOLD_ROOT}/released/${safeSeg(dest)}/${safeSeg(shipmentId)}/${safeSeg(lineId)}`;

export async function loadHoldConfig() {
  return (await one(holdConfigPath())) || null;
}

/** All held lines, every destination → { dest: { lineId: line } }. */
export async function loadHeld() {
  return (await one(`${STOCK_HOLD_ROOT}/held`)) || {};
}

/**
 * File one held line, create-once: the lineId IS the fulfil's movement id, so
 * a retry after a failed bookkeeping write lands on the same key and the FIRST
 * stamp (its shipment included) stands — a box does not change shipment
 * because the retry happened after the window.
 */
export async function recordHeldLine({ dest, lineId, productId, productName = "", size, sizeKey, qty,
                                       refillId = null, shipmentId, windowLabel, uncounted = false }) {
  const user = auth.currentUser;
  const line = {
    productId, productName, size: String(size), sizeKey, qty: Number(qty),
    dest, shipmentId, windowLabel: windowLabel || null,
    refillId, movementId: lineId,
    ...(uncounted ? { uncounted: true } : {}),
    heldAt: serverNowIso(),
    heldBy: user ? user.uid : null,
  };
  try {
    await runTransaction(ref(database, heldLinePath(dest, lineId)), (cur) => (cur === null ? line : undefined));
    return { ok: true };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

/**
 * PARTIAL ARRIVAL: this line was not in the box. It stays HELD (still inbound
 * to the engine, still a real unit in stock/in_transit) and moves to the next
 * shipment, carrying its history so a line that misses two boxes reads as
 * exactly that on the card.
 */
export async function markLineNotArrived({ dest, lineId, toShipment }) {
  if (!toShipment || !toShipment.id) return { ok: false, message: "No next shipment to carry to." };
  const user = auth.currentUser;
  const path = heldLinePath(dest, lineId);
  let line = null;
  try { line = await one(path); } catch (err) { return { ok: false, message: String(err?.message || err) }; }
  if (!line) return { ok: false, message: "This line is no longer held — refresh." };
  try {
    await update(ref(database, path), {
      shipmentId: toShipment.id,
      windowLabel: toShipment.label || null,
      carriedFrom: line.shipmentId || null,
      notArrivedAt: serverNowIso(),
      notArrivedBy: user ? user.uid : null,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

/**
 * RELEASE one shipment: the box arrived and is open. For every line (minus any
 * marked not-arrived by the caller): one idempotent applyMovement transfer_in
 * in_transit → dest, then ONE atomic update() that removes the held line,
 * archives it under released/, and — THE RACE GUARD (owner spec commit 6) —
 * stamps any already-counted record for that cell stale, so the cell
 * resurfaces on the count card showing what changed and when. A cell counted
 * BEFORE the box was shelved would otherwise notarise a number the release
 * just made wrong.
 *
 * Sequential on purpose: tens of lines, each a cheap write, and a mid-flight
 * failure must leave a legible half-state (released lines archived, failed
 * lines still held with the reason reported).
 */
export async function releaseShipment({ dest, shipment, skipLineIds = new Set(), actorRole = "admin" }) {
  const user = auth.currentUser;
  const out = { released: 0, releasedUnits: 0, skipped: 0, carriedAway: 0, staledCells: 0, failures: [] };

  // The count SESSION id, read once — the per-cell records are re-read inside
  // the loop (see below). No session just means nothing to stale.
  let sessionId = null;
  try {
    const session = await one(`${HUB_COUNT_ROOT}/sessions/${safeSeg(dest)}`);
    if (session && session.sessionId) sessionId = session.sessionId;
  } catch { /* staling is best-effort; the release itself must not block on it */ }

  for (const line of shipment.lines) {
    if (skipLineIds.has(line.lineId)) { out.skipped++; continue; }

    // FRESH READ OF THE HELD LINE (CodeRabbit, PR #347): this screen's copy
    // may be stale. Gone → another release already landed it (nothing to do).
    // Moved to a different shipment → someone marked it not-arrived after
    // this render; releasing it here would credit a line the box does NOT
    // contain — skip it, it belongs to the next box.
    let liveLine = null;
    try {
      liveLine = await one(heldLinePath(dest, line.lineId));
    } catch (err) {
      out.failures.push({ lineId: line.lineId, productName: line.productName, reason: `could not re-check the line (${String(err?.message || err)}) — release again to retry` });
      continue;
    }
    if (!liveLine) { out.skipped++; continue; }
    if (liveLine.shipmentId !== shipment.shipmentId) { out.carriedAway++; continue; }

    const relId = `rel_${safeSeg(line.lineId)}`;
    const qty = Number(liveLine.qty) || 1;
    const res = await applyMovement({
      type: "transfer_in",
      productId: liveLine.productId,
      size: liveLine.size,                // RAW size — applyMovement owns the key encoding
      qty,
      from: IN_TRANSIT,
      to: dest,
      actorRole,
      reason: "stock_hold_release",
      movementId: relId,
      link: { refillId: liveLine.refillId || null, holdShipmentId: shipment.shipmentId, holdLineId: line.lineId },
    });
    if (!res.ok) {
      // insufficient_stock here means the fulfil never parked this line's
      // units (a phantom) — refusing is the guard, not a bug. The line stays
      // held and the failure is shown.
      out.failures.push({ lineId: line.lineId, productName: liveLine.productName, reason: res.reason || "write failed" });
      continue;
    }

    const now = serverNowIso();
    const updates = {
      [heldLinePath(dest, line.lineId)]: null,
      [releasedLinePath(dest, shipment.shipmentId, line.lineId)]: {
        ...liveLine,
        releasedAt: now,
        releasedBy: user ? user.uid : null,
        releaseMovementId: relId,
      },
    };
    // The race guard: a counted cell whose stock this release just changed is
    // no longer a settled count. The record is read FRESH here, per line —
    // reading once before the loop left a window where a cell counted during
    // the release was never staled and a wrong count got notarised
    // (CodeRabbit, PR #347). Stamped in the SAME atomic update that retires
    // the line; the count views treat a stale record as "needs
    // re-confirmation" and show the delta and when it landed.
    if (sessionId) {
      const ck = cellKey(liveLine.productId, liveLine.sizeKey);
      const base = `${HUB_COUNT_ROOT}/counted/${safeSeg(dest)}/${sessionId}/${ck}`;
      let rec = null;
      try { rec = await one(base); } catch { /* best-effort — see above */ }
      if (rec && !rec.staleAt) {
        updates[`${base}/staleAt`] = now;
        updates[`${base}/staleDelta`] = qty;
        updates[`${base}/staleMovementId`] = relId;
        out.staledCells++;
      } else if (rec && rec.staleAt) {
        // Already awaiting a recount — accumulate the delta so the card shows
        // the full change since the count.
        updates[`${base}/staleDelta`] = (Number(rec.staleDelta) || 0) + qty;
      }
    }
    try {
      await update(ref(database), updates);
      out.released++;
      out.releasedUnits += qty;
    } catch (err) {
      // The movement committed; the line will replay idempotently next time.
      out.failures.push({ lineId: line.lineId, productName: liveLine.productName,
                          reason: `credited, but the bookkeeping failed (${String(err?.message || err)}) — release again to finish` });
    }
  }
  return out;
}

// ── Config writes (owner-only surfaces) ──────────────────────────────────────

export async function setHoldEnabled(enabled) {
  const user = auth.currentUser;
  try {
    await update(ref(database, holdConfigPath()), {
      enabled: enabled === true,
      updatedAt: serverNowIso(),
      updatedBy: user ? user.uid : null,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

export async function setHoldDelegate(uid, nameOrNull) {
  const user = auth.currentUser;
  try {
    await update(ref(database, holdConfigPath()), {
      [`delegates/${safeSeg(uid)}`]: nameOrNull,
      updatedAt: serverNowIso(),
      updatedBy: user ? user.uid : null,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

// serverNowMs re-exported for the one caller that stamps shipments — keeps the
// fulfil site's import list flat.
export { serverNowMs };

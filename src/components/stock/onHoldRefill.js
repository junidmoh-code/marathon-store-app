// ─── ON HOLD → SIZE REFILL REQUEST (owner redesign 2026-08-08) ────────────────
// Putting a customer order on hold ("Coming Tomorrow") means the source could
// not supply it today — which IS a size refill need at the hub that order
// ships from. This module decides whether that need can be raised as a real
// /refill_requests row, and against which hub.
//
// TWO KINDS OF ON-HOLD, deliberately separated:
//   • The CUSTOMER-facing hold — order status coming_tomorrow, the TV row, the
//     WhatsApp "available tomorrow" message, the warehouse On Hold card. That
//     lifecycle is NOT this module's business and is unchanged.
//   • The SOURCE-facing work item — "send this size to the hub" — which used to
//     live as a card on the Source On Hold tab. THAT is what becomes a refill
//     request here, so it queues with every other ask in the hub's refill tab.
//
// FAIL CLOSED. The hub comes from the order's own routing (placedAtHub, the
// same field dispatch uses), never a guess: if the hub is not hub1/hub2, or
// the order has no productId or size, NO request is raised — the caller keeps
// the hold visible as a held card for a human instead. A request against a
// guessed hub would move real stock to the wrong building.
//
// The request id is DETERMINISTIC — onhold_{saDate}_{orderNumber} — so a
// re-tap of "Schedule for Tomorrow" cannot mint a second ask, and (with the
// caller's create-if-absent guard) cannot resurrect one the source already
// rejected. saDate is in the id because order numbers reset daily.

const VALID_HUBS = new Set(["hub1", "hub2"]);

// ── THE FULL LIFECYCLE, so no ask can go invisible (Kimi review, PR #335) ────
// A hold that raised a request is represented by EXACTLY ONE surface at every
// moment:
//   request OPEN      → the hub refill queue owns it (held card suppressed)
//   request RESOLVED  → the held card RETURNS, carrying the outcome, so a
//                       rejection ("not on the shelf") or an arrival is acted
//                       on rather than silently stranding the customer order
//   hold RELEASED     → the open request is withdrawn (holdReleaseUpdate), so
//                       the queue never asks for stock nobody needs any more
//
// Suppressing the held card unconditionally was the reviewed bug: a rejected
// request left the queue AND the card stayed hidden — the ask existed nowhere.

/** Should this hold render as a held card (true) or is the queue showing it? */
export function heldCardVisible(refillRequestId, statusById, requestsLoaded) {
  if (!refillRequestId) return true;            // never raised a request → held card
  // Requests not loaded yet: keep the card hidden for the moment rather than
  // flashing a duplicate next to its own queue card.
  if (!requestsLoaded) return false;
  const status = statusById?.get ? statusById.get(refillRequestId) : statusById?.[refillRequestId];
  // Open → the queue owns it. Resolved, or the request row is gone entirely →
  // the held card is the only surface left; show it.
  return status !== "open";
}

/**
 * The withdrawal for a released hold. Returns { requestId, patch } when the
 * order is LEAVING coming_tomorrow and carries a raised request — the caller
 * applies it only if the live request is still open (a picker's fulfil wins).
 * cancelReason "hold_released" classifies as "No longer needed" in history;
 * resolvedBy carries the person so it is never credited to the engine.
 */
export function holdReleaseUpdate(order, newStatus, { nowIso, uid = null }) {
  if (newStatus === "coming_tomorrow") return null;      // still held — nothing to release
  if (!order?.onHoldRefillRequestId) return null;        // no request was ever raised
  return {
    requestId: order.onHoldRefillRequestId,
    patch: {
      status: "cancelled",
      resolvedAt: nowIso,
      cancelReason: "hold_released",
      ...(uid ? { resolvedBy: uid } : {}),
    },
  };
}

export function onHoldRefillPlan(order, { nowIso, saDate }) {
  const hub = order?.placedAtHub || order?.hub || null;
  if (!VALID_HUBS.has(hub)) return { ok: false, reason: hub ? `unroutable_hub_${hub}` : "no_hub" };
  if (!order?.productId) return { ok: false, reason: "no_product_id" };
  const size = order?.size;
  if (size == null || String(size).trim() === "") return { ok: false, reason: "no_size" };
  return {
    ok: true,
    hub,
    // Strip RTDB-illegal chars — same guard set stockCellPath enforces.
    requestId: `onhold_${saDate}_${String(order.id)}`.replace(/[.#$/[\]\s:]/g, "_"),
    record: {
      productId: order.productId,
      size: String(size),
      qty: Number(order.qty) || 1,
      requestingLocation: hub,
      status: "open",
      createdAt: nowIso,
      // manual (a person committed to the customer), traceable to the order.
      // source: central — the same supply source every hub refill fulfils from.
      createdFrom: { manual: true, source: "central", via: "on_hold", orderId: String(order.id), orderDate: saDate },
    },
  };
}

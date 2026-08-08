// ─── ON HOLD → SIZE REFILL REQUEST (owner redesign 2026-08-08) ────────────────
// Putting a customer order on hold ("Coming Tomorrow") means the source could
// not supply it today — which IS a size refill need at the hub that order
// ships from. This module decides whether that need can be raised as a real
// /refill_requests row, and against which hub.
//
// TWO KINDS OF ON-HOLD, deliberately separated:
//   • The CUSTOMER-facing hold — order status coming_tomorrow, the TV row, the
//     warehouse On Hold status tab, the customer status page. That lifecycle
//     is NOT this module's business. (The WhatsApp "available tomorrow"
//     message is GONE — owner spec 2026-08-08: no customer notification for
//     holds is sent any more.)
//   • The SOURCE-facing work item — "send this size to the hub" — which
//     becomes an ORDINARY refill request here and queues indistinguishably
//     with every other ask in the hub's refill queue.
//
// FAIL CLOSED. The hub comes from the order's own routing (placedAtHub, the
// same field dispatch uses), never a guess: if the hub is not hub1/hub2, or
// the order has no productId or size, NO request is raised — the order simply
// stays a warehouse On Hold order handled by a human. A request against a
// guessed hub would move real stock to the wrong building.
//
// The request id is DETERMINISTIC — onhold_{saDate}_{orderNumber} — so a
// re-tap of "Schedule for Tomorrow" cannot mint a second ask, and (with the
// caller's create-if-absent guard) cannot resurrect one the source already
// rejected. saDate is in the id because order numbers reset daily.

const VALID_HUBS = new Set(["hub1", "hub2"]);

// ── THE LIFECYCLE (owner spec 2026-08-08 — On Hold is ABOLISHED from the
// refill surface, not relocated) ─────────────────────────────────────────────
//   hold PLACED    → an ordinary /refill_requests row is raised (below) — no
//                    badge, no order number, no customer name in the queue
//   hold RELEASED  → the still-open request is withdrawn (holdReleaseUpdate),
//                    so the queue never asks for stock nobody needs any more
//
// There is NO held card and NO exception row any more. A hold whose request
// resolves without stock is handled on the warehouse orders surface (the On
// Hold status tab), which is customer-facing and outside this module's remit.
// A hold this planner fails closed on simply raises nothing — it remains a
// warehouse order like any other.

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

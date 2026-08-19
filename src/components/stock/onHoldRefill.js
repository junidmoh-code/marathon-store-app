// ─── ON HOLD → SIZE REFILL REQUEST (owner redesign 2026-08-08) ────────────────
// Putting a customer order on hold ("Coming Tomorrow") means the source could
// not supply it today — which IS a size refill need at the hub that order
// ships from. This module decides whether that need can be raised as a real
// /refill_requests row, and against which hub.
//
// TWO KINDS OF ON-HOLD, deliberately separated:
//   • The CUSTOMER-facing hold — order status coming_tomorrow, the TV row, the
//     warehouse On Hold status tab, the customer status page. That lifecycle
//     is NOT this module's business.
//
//   • The SOURCE-facing work item — "send this size to the hub" — which
//     becomes an ORDINARY refill request here and queues indistinguishably
//     with every other ask in the hub's refill queue.
//
// THE CUSTOMER NOTIFICATION (owner reinstatement 2026-08-19) ─────────────────
// The 2026-08-08 spec deleted the hold WhatsApp entirely (the old "available
// tomorrow" message fired the moment a hold was PLACED — a promise made before
// any stock existed). The owner has reinstated it in a different place: the
// customer is told when the stock is PHYSICALLY THERE, i.e. when the hold's
// refill line is FULFILLED, using the now-available copy. Nothing fires at
// hold-placed time any more, and nothing in this queue is time-predicted.
//
// That send needs a link back to the customer that outlives the order: order
// numbers reset daily and /orders is ephemeral, so by the time the hub picks
// the line the order row may be gone or recycled. So the link is STORED ON THE
// REQUEST RECORD, in `holdLink` (see holdCustomerLink below) — customer id,
// name, phone, order reference and the hold-origin flag.
//
// STORED, NEVER RENDERED. holdLink exists for ONE consumer: the server-side
// holdAvailabilityNotify trigger (functions/lib/hold-availability-notify.cjs).
// The refill queue must stay exactly as the owner designed it — a hold line is
// an ORDINARY request row, with no badge, no order number, no customer name and
// no second button. RefillQueue.jsx never reads holdLink, and two pinned gate
// suites keep it that way.
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
// refill surface, not relocated; notification reinstated at FULFIL 2026-08-19)
// ─────────────────────────────────────────────────────────────────────────────
//   hold PLACED    → an ordinary /refill_requests row is raised (below) — no
//                    badge, no order number, no customer name in the queue.
//                    NO message goes out here: nothing has arrived yet.
//   hold FULFILLED → the server trigger sends the now-available WhatsApp,
//                    once, off holdLink. Silent to staff; no UI change.
//   hold RELEASED  → the still-open request is withdrawn (holdReleaseUpdate),
//                    so the queue never asks for stock nobody needs any more
//                    (a withdrawn line notifies nobody — the order's own
//                    status path already messages the customer)
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

/**
 * THE RE-LINK (owner reinstatement 2026-08-19) — stored on the request, shown
 * nowhere.
 *
 * A hold's refill line is picked hours or days after the hold was placed. By
 * then the order number may have been recycled by the daily reset and the
 * /orders row may be gone, so the notifier cannot go looking for the customer:
 * everything it needs must already be on the request record. This is that
 * payload, and it is the ONLY place a hold line differs from any other refill
 * request.
 *
 * notifyOnFulfil is the hold-origin flag the notifier keys on, and it is armed
 * ONLY when a phone is actually present. A hold with no usable number still
 * raises its refill row — the stock need is real and independent of the
 * message — but it can never arm a send that has nowhere to go. Absent /
 * blank / non-string phones all collapse to null here rather than to the string
 * "undefined"; the SEND-side shape check (E.164 normalisation) stays where it
 * has always been, in the outbox producer, which refuses a mangled number
 * outright.
 *
 * Every field is explicitly null-defaulted rather than omitted: RTDB `set()`
 * throws on an undefined leaf, and a half-written link is how a promise gets
 * silently dropped (the non-enforced-save outage, PR #327).
 */
export function holdCustomerLink(order, saDate) {
  const rawPhone = order?.customerPhone;
  const phone = typeof rawPhone === "string" || typeof rawPhone === "number"
    ? String(rawPhone).trim()
    : "";
  const name = typeof order?.customerName === "string" ? order.customerName.trim() : "";
  return {
    orderId: String(order?.id ?? ""),
    orderDate: saDate ?? null,
    customerId: order?.customerId ?? null,
    customerName: name || null,
    customerPhone: phone || null,
    notifyOnFulfil: !!phone,
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
      // The invisible re-link. Read by exactly one consumer — the server-side
      // fulfil notifier — and rendered by none. See the module header.
      holdLink: holdCustomerLink(order, saDate),
    },
  };
}

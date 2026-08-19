// ─── THE GAP — pure decisions, so they can be tested without live RTDB ───────
// Used by scripts/hold-notify-gap-census.mjs. Two questions only: is this
// hold-raised refill row a customer nobody told, and who is that customer?

/**
 * Is this row in the gap?
 *
 * FULFILLED only — the stock reached the hub, so a message was owed. A
 * `cancelled` row (hold released, human ✕, engine withdrawal) owed nothing.
 *
 * `notifiedAt` means the notifier told them. `notifyFailedAt` means the
 * producer refused the number outright and the row carries the reason. An
 * UNRESOLVED claim — notifyClaimedAt with neither — stays IN the gap on
 * purpose: the notifier never takes a claim over, so nobody can say whether
 * that message went out, which is exactly a customer a human should look at.
 */
export function isInGap(request) {
  if (!request || request.status !== "fulfilled") return false;
  const hl = request.holdLink;
  if (hl && (hl.notifiedAt || hl.notifyFailedAt)) return false;
  return true;
}

/**
 * Who is the customer, and how sure are we?
 *
 * holdLink FIRST (CodeRabbit #385). Rows raised from 2026-08-19 carry the
 * contact on the request itself, which is the whole point of the re-link — and
 * the /insights_log "tomorrow" event is a SEPARATE write from request creation
 * in App.jsx, so a failed or missing log write must not make the census report
 * NO-CONTACT for someone whose number is sitting right there on the row.
 * The log is the fallback, and the only source for the pre-re-link era.
 */
export function resolveContact(request, insightEvent) {
  const hl = (request && request.holdLink) || {};
  const e = insightEvent || {};
  const phone = hl.customerPhone || e.customerPhone || null;
  const name = hl.customerName || e.customerName || null;
  return {
    customerName: name,
    customerPhone: phone,
    // Which source actually answered — a census that cannot say where a number
    // came from cannot be audited against either node.
    contactSource: hl.customerPhone ? "holdLink" : (e.customerPhone ? "insights_log" : null),
  };
}

/** One report row. `removedAt` is the window edge; see the census header. */
export function gapRow(requestId, request, insightEvent, removedAt) {
  const r = request || {};
  const e = insightEvent || {};
  const contact = resolveContact(r, e);
  return {
    requestId,
    orderNumber: r.createdFrom?.orderId ?? r.holdLink?.orderId ?? e.orderNumber ?? null,
    saDate: r.createdFrom?.orderDate ?? r.holdLink?.orderDate ?? null,
    hub: r.requestingLocation ?? null,
    customerId: r.holdLink?.customerId ?? null,
    ...contact,
    productId: r.productId ?? null,
    productName: e.productName ?? null,
    size: r.size ?? null,
    qty: r.qty ?? null,
    raisedAt: r.createdAt ?? null,
    fulfilledAt: r.resolvedAt ?? null,
    // A row raised before the removal COMMIT may have had its message sent by
    // the still-live old bundle — flagged, not dropped.
    beforeRemovalCommit: !!(r.createdAt && removedAt && r.createdAt < removedAt),
    customerResolved: !!contact.customerPhone,
    // An earlier notifier run claimed this and never recorded the outcome.
    unresolvedClaim: !!(r.holdLink && r.holdLink.notifyClaimedAt),
  };
}

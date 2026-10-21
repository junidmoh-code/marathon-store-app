// ── Does a hub's "Mark as Sent" move stock for this /orders record? ──────────
// A WEBSITE order (channel "online", written by the Mac mini's poller for a
// website line routed to a hub) never does: its single stock deduction is the
// POS Pack, from the hub that sent the unit. Moving it here as well — a
// transfer_out for clothing — would deduct the same unit twice.
// → a reason string when dispatch must skip the movement, else null.
export function dispatchSkipsStock(order) {
  return order && order.channel === "online" ? "online_order_deducts_at_pack" : null;
}

// ── Courier booking — the seam, not the feature ─────────────────────────────
// Out of scope (2026-10-21): waybills are handwritten and the Pack step has an
// optional tracking-number field. When a courier is chosen, this is the ONE
// function that changes: it gets the packed order and returns the booking
// (provider, waybill, label) to record on order.shipping. Everything that
// calls it already runs it after the pack sale and before the Shopify
// fulfilment, which is where a booking has to happen.
export async function bookShipment(_order) {
  return { skipped: true };
}

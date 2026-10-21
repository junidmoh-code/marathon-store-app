// ── Courier booking — Courier Guy (docs/COURIER-GUY.md) ──────────────────────
// bookShipment(order, deps) is scripts/shipping/bookShipment.mjs: dormant
// until /config/shipping/live is the boolean true — until then it prices the
// parcel, logs the exact payload it would send and returns {skipped, dryRun}.
export { bookShipment, readLive, estimateForOrder, estimateSig } from "../../shipping/bookShipment.mjs";

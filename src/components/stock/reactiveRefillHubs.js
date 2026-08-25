// ─── WHICH HUBS TAKE REACTIVE REFILL LINES ───────────────────────────────────
// (Owner order 2026-08-25, Hub 1 single-path decision.)
//
// HUB 1 IS ENGINE-ONLY: the per-size sneaker policy scan is the ONLY thing
// that raises a request from Central for hub1. No sale-driven row, no on-hold
// "Coming Tomorrow" line, no Missing Sneakers pick — a hub1 cell refills when
// the scan sees it at its reorder point, and nothing else asks on its behalf.
// Hub 2 keeps every reactive lane exactly as it was.
//
// One constant, imported by every reactive writer, so "which hubs react"
// can never drift between the on-hold planner, the Missing Sneakers buttons
// and the sale-driven queue rows. Removing a hub here silences its reactive
// lanes ONLY — open rows already written complete normally, and the engine's
// own requests are untouched (they are not "reactive").
export const REACTIVE_REFILL_HUBS = Object.freeze(["hub2"]);

export function isReactiveRefillHub(hub) {
  return REACTIVE_REFILL_HUBS.includes(hub);
}

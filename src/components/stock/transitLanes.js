// ─── TRANSIT LANES — the building map and the one routing question ────────────
// locations.js deliberately exposes NO routing logic (any location may transfer
// to any other). This module is the ONE exception, answering a single question:
// does a transfer physically cross a building boundary? Cross-building sends
// from Central's building go two-step (transfer_out → in_transit, then
// transfer_in on receive at the destination); everything else keeps today's
// instant one-step move — those call sites are untouched code paths.
//
// Building map confirmed by Junid 2026-07-19:
//   Building A (Central's): central, studio, base
//   Building B:             marathon-pe, trophy, hub1, hub2
//   Building C:             marathon-pine, hub3
//
// `studio` and `base` were merged into `central` and DEACTIVATED on 2026-07-26
// (see locations.js). They are deliberately LEFT IN this map: all three were
// building A, so their presence changes no lane decision (A→A is never transit),
// and a historical movement re-examined later still resolves to the right
// building. Nothing to remove.
//
// T1 SCOPE — OUTBOUND ONLY (deliberate, not an oversight): transit applies to
// A→B and A→C. Reverse cross-building moves (B→A excess returns, order-return
// reversals) keep their existing instant flows for now; widening to "any
// cross-building move" is a one-line change to TRANSIT_ORIGIN_BUILDINGS when
// that call is made (phase T4 revisit).
//
// An UNMAPPED location id (a future hub added to /locations but not here)
// resolves to instant — the safe default: it can never strand stock in
// in_transit with no receiver expecting it. Add new ids to BUILDING when they
// gain a physical home.

export const BUILDING = {
  central: "A",
  studio: "A",
  base: "A",
  "marathon-pe": "B",
  trophy: "B",
  hub1: "B",
  hub2: "B",
  "marathon-pine": "C",
  hub3: "C",
};

// Buildings whose OUTBOUND cross-building sends go in-transit (T1: A only).
const TRANSIT_ORIGIN_BUILDINGS = new Set(["A"]);

export function buildingOf(locationId) {
  return BUILDING[locationId] || null;
}

// The gate every send site asks. True → two-step (in_transit hop + /transfers
// doc + receive step); false → today's instant paired write, unchanged.
export function isTransitLane(from, to) {
  const a = buildingOf(from);
  const b = buildingOf(to);
  if (!a || !b || a === b) return false;
  return TRANSIT_ORIGIN_BUILDINGS.has(a);
}

// A dispatched transfer unreceived for longer than this is flagged stale on the
// Health dashboard (lanes are same-day drives; hours, not days).
export const STALE_TRANSIT_HOURS = 4;

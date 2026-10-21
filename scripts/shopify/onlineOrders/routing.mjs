// ── Where each website-order line comes from — PURE ─────────────────────────
// Decided ONCE, when the order arrives (and again only if Junid sends a line
// back with Resolve). The order is fixed by the owner spec of 2026-10-21:
//
//   footwear / slides → hub1 if it has the size, else hub2         "pick"
//   anything else     → marathon-pe, then trophy                    "display"
//                     → then hub2                                   "pick"
//   nowhere           → { locationId: null, status: "no_stock" }
//
// Shops hold no sneaker stock, so footwear never routes to a shop; hub3 is the
// Concrete division and never used here. Footwear that neither hub holds is
// no_stock rather than a pick sent to a hub with nothing on the shelf — the
// pick could only come back "not found", a round trip that tells Junid
// nothing he does not already know.
//
// "Has it" means LIVE units at the location minus units other website orders
// already hold there (/online_reservations rows' `locs`), minus what earlier
// lines of THIS order took. The caller computes `available`; this module only
// decides.
//
// A QUANTITY IS SPLIT, NEVER A LINE: qty 2 with one unit at PE becomes two
// lines — PE ×1, then the next location ×1. One line always names one place,
// because one line is one feed entry, one person, one "Handed over".

export const FOOTWEAR_ROUTE = Object.freeze([
  Object.freeze({ locationId: "hub1", status: "pick" }),
  Object.freeze({ locationId: "hub2", status: "pick" }),
]);

export const OTHER_ROUTE = Object.freeze([
  Object.freeze({ locationId: "marathon-pe", status: "display" }),
  Object.freeze({ locationId: "trophy", status: "display" }),
  Object.freeze({ locationId: "hub2", status: "pick" }),
]);

/** Every location routing may read, so the caller reads exactly these cells. */
export const ROUTED_LOCATIONS = Object.freeze(["hub1", "hub2", "marathon-pe", "trophy"]);

export function routeFor(isFootwear) {
  return isFootwear ? FOOTWEAR_ROUTE : OTHER_ROUTE;
}

const units = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : 0);

/**
 * Split one line's quantity across the route.
 *   qty        units ordered (a positive integer)
 *   isFootwear footwear or slides
 *   available  { [locationId]: units free there } — anything absent is 0
 * → [{ qty, locationId, status }] in route order, quantities summing to qty.
 */
export function routeLine({ qty, isFootwear, available = {} }) {
  let remaining = units(qty);
  const pieces = [];
  if (remaining === 0) return pieces;
  for (const step of routeFor(isFootwear)) {
    const take = Math.min(remaining, units(available[step.locationId]));
    if (take > 0) {
      pieces.push({ qty: take, locationId: step.locationId, status: step.status });
      remaining -= take;
    }
    if (remaining === 0) return pieces;
  }
  pieces.push({ qty: remaining, locationId: null, status: "no_stock" });
  return pieces;
}

/**
 * Route several lines of one order against one availability picture, so two
 * lines of the same pid/size cannot both claim the same last unit.
 *   lines      [{ key, qty, isFootwear }] — key = `${pid}|${sizeKey}`
 *   available  { [key]: { [locationId]: units } }
 * → [pieces per line, same order]. `available` is not mutated.
 */
export function routeLines(lines, available) {
  const left = {};
  for (const [key, byLoc] of Object.entries(available || {})) left[key] = { ...byLoc };
  return lines.map((line) => {
    const pool = left[line.key] || (left[line.key] = {});
    const pieces = routeLine({ qty: line.qty, isFootwear: line.isFootwear, available: pool });
    for (const p of pieces) if (p.locationId) pool[p.locationId] = units(pool[p.locationId]) - p.qty;
    return pieces;
  });
}

/**
 * Units free at each routed location for one pid/size.
 *   stockQty   { [locationId]: live cell qty } (negative or missing → 0)
 *   holdsCell  /online_reservations/{pid}/{sizeKey} — { [orderId]: { locs } }
 *   orderId    the order being routed: its OWN rows never count against it
 *              (a Resolve re-route must not be blocked by its own old hold)
 */
export function availableAt({ stockQty = {}, holdsCell = null, orderId = null }) {
  const out = {};
  for (const loc of ROUTED_LOCATIONS) {
    let held = 0;
    for (const [oid, row] of Object.entries(holdsCell || {})) {
      if (oid === orderId || !row || typeof row !== "object") continue;
      held += units(row.locs?.[loc]);
    }
    out[loc] = Math.max(0, units(stockQty[loc]) - held);
  }
  return out;
}

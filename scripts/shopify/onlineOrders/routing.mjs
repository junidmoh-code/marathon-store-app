// ── Where each website-order line comes from — PURE ─────────────────────────
// Decided ONCE, when the order arrives (again if Junid sends a line back with
// Resolve, and again by itself when a WAITING line's stock arrives — see
// waitingReroute in poll.mjs). Junid's routing, 12 Nov 2026 — shops and hubs
// only, Marathon first, then the Concrete division:
//
//   footwear / slides → hub1, then hub2, then hub3                  "pick"
//   anything else     → marathon-pe, then trophy                    "display"
//                     → then hub2                                   "pick"
//                     → then concrete, then marathon-pine           "display"
//   nowhere           → { locationId: null, status: "no_stock" }  WAITING ON REFILL
//
// CENTRAL IS NEVER A SOURCE. Its stock is listed on the website ("stock
// anywhere is our stock") but a web line is always picked from a shop or a
// hub; Central keeps those topped up through the ordinary refill scan. A line
// nobody can pick waits (no_stock, no location) and raises NOTHING — no
// request of any kind — until the scan's refill lands and it routes itself.
// (This replaces the 1 Nov 2026 rule "website orders are Marathon's".)
//
// Shops hold no sneaker stock, so footwear never routes to a shop. Hub 3 gets a
// hub order exactly like Hub 1 / Hub 2 (customer "Shopify", three-letter code,
// delivered to shipping); Concrete and Pine get a website-strip entry exactly
// like Marathon PE / Trophy (staff pull it and hand it to shipping).
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
  Object.freeze({ locationId: "hub3", status: "pick" }),
]);

export const OTHER_ROUTE = Object.freeze([
  Object.freeze({ locationId: "marathon-pe", status: "display" }),
  Object.freeze({ locationId: "trophy", status: "display" }),
  Object.freeze({ locationId: "hub2", status: "pick" }),
  Object.freeze({ locationId: "concrete", status: "display" }),
  Object.freeze({ locationId: "marathon-pine", status: "display" }),
]);

/** The shops whose website strip a line can be put on (the "display" steps). */
export const STRIP_SHOPS = Object.freeze(["marathon-pe", "trophy", "concrete", "marathon-pine"]);

/** Every location routing may read, so the caller reads exactly these cells. */
export const ROUTED_LOCATIONS = Object.freeze(["hub1", "hub2", "hub3", "marathon-pe", "trophy", "concrete", "marathon-pine"]);

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

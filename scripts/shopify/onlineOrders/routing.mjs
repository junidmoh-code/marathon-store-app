// ── Where each website-order line comes from — PURE ─────────────────────────
// Decided when the order arrives, again when a place rejects the line (the
// chain move, chainMove.mjs), again if Junid sends a line back with Resolve,
// and again by itself when a WAITING line's stock arrives (waitingReroute).
//
// THE CHAINS (Junid, 24 Nov 2026 — his model of the network: Marathon PE and
// Trophy do not share items, nor do Concrete and Pine; Hub 2 feeds PE and
// Trophy; Central feeds everything but its stock travels once, in the morning,
// so a place that has the piece NOW beats Central):
//
//   footwear / slides → hub1, hub2, hub3                            "pick"
//                     → then central                                "display" (the Source strip)
//   anything else     → marathon-pe, then trophy                    "display"
//                     → then hub2                                   "pick" (a hub order, three-letter code)
//                     → then concrete, then marathon-pine           "display"
//                     → then central                                "display" (the Source strip)
//   nowhere           → { locationId: null, status: "no_stock" }  WAITING ON REFILL
//
// THE MOST TRUSTWORTHY PLACE FIRST. docs/audits/web-unavailable-2026-11-24:
// a shelf showing ONE free piece fails 26% of the time against 9% for two or
// more, and 40% once that one piece has sat untouched for two weeks. The
// caller scores each shelf (shelfRisk below) and this module walks the chain
// three times: trustworthy shops and hubs in chain order, then the risky ones
// in chain order (a risky shelf is still used when it is all there is: its
// rejection moves the line on at once), then Central — LAST even when its
// shelf is trustworthy, because its piece arrives next morning.
//
// CENTRAL IS THE LAST STOP (this replaces the 12 Nov rule "Central is never a
// source"). A line that reaches Central shows on the website-orders strip
// inside Source; Central staff pull the piece and tap Found; it travels on the
// next morning stock run and is deducted from Central's count at packing, like
// every other line. Switch: /config/onlineOrders/routing/centralOff = true.
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

export const CENTRAL = "central";

export const FOOTWEAR_ROUTE = Object.freeze([
  Object.freeze({ locationId: "hub1", status: "pick" }),
  Object.freeze({ locationId: "hub2", status: "pick" }),
  Object.freeze({ locationId: "hub3", status: "pick" }),
  Object.freeze({ locationId: CENTRAL, status: "display" }),
]);

export const OTHER_ROUTE = Object.freeze([
  Object.freeze({ locationId: "marathon-pe", status: "display" }),
  Object.freeze({ locationId: "trophy", status: "display" }),
  Object.freeze({ locationId: "hub2", status: "pick" }),
  Object.freeze({ locationId: "concrete", status: "display" }),
  Object.freeze({ locationId: "marathon-pine", status: "display" }),
  Object.freeze({ locationId: CENTRAL, status: "display" }),
]);

/** The shops whose website strip a line can be put on (the "display" steps). */
export const STRIP_SHOPS = Object.freeze(["marathon-pe", "trophy", "concrete", "marathon-pine", CENTRAL]);

/** Every location routing may read, so the caller reads exactly these cells. */
export const ROUTED_LOCATIONS = Object.freeze(["hub1", "hub2", "hub3", "marathon-pe", "trophy", "concrete", "marathon-pine", CENTRAL]);

export function routeFor(isFootwear) {
  return isFootwear ? FOOTWEAR_ROUTE : OTHER_ROUTE;
}

const units = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : 0);

// ── How far a shelf's count can be trusted ───────────────────────────────────
// /config/onlineOrders/routing = { trustOff?, centralOff?, riskyAt?, staleDays?,
//                                  rejectedDays?, weights?: { single, stale, rejected } }
// One point per signal the report proved; a shelf is RISKY at `riskyAt` points
// (default 2: a lone piece that is also long untouched, or that also rejected
// a website pick lately).
export const ROUTING_CONFIG_PATH = "config/onlineOrders/routing";
export const ROUTING_DEFAULTS = Object.freeze({ riskyAt: 2, staleDays: 14, rejectedDays: 30, weights: Object.freeze({ single: 1, stale: 1, rejected: 1 }) });

const posNum = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const weight = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);

/** /config/onlineOrders/routing → the settings in force. Absent = the defaults. PURE. */
export function routingRulesFrom(config) {
  const c = config && typeof config === "object" ? config : {};
  const w = c.weights && typeof c.weights === "object" ? c.weights : {};
  return {
    trust: c.trustOff !== true,
    central: c.centralOff !== true,
    riskyAt: posNum(c.riskyAt, ROUTING_DEFAULTS.riskyAt),
    staleDays: posNum(c.staleDays, ROUTING_DEFAULTS.staleDays),
    rejectedDays: posNum(c.rejectedDays, ROUTING_DEFAULTS.rejectedDays),
    weights: { single: weight(w.single, 1), stale: weight(w.stale, 1), rejected: weight(w.rejected, 1) },
  };
}

/**
 * One shelf's risk. PURE.
 *   free        units free there for this line (after other website orders' holds)
 *   stampMs     when the cell last moved (null = no stamp: its age is unknown and scores nothing)
 *   rejectedAt  when this shelf last rejected a website pick (null = never, as far as the notes go)
 * → { score, risky, why: ["one piece", "untouched 41 days", "rejected a website pick 3 days ago"] }
 */
export function shelfRisk({ free, stampMs = null, rejectedAt = null, nowMs, rules = routingRulesFrom(null) }) {
  const why = [];
  let score = 0;
  if (!rules?.trust || !(Number(free) > 0)) return { score, risky: false, why };
  const days = (t) => Math.floor((nowMs - t) / 864e5);
  if (Number(free) === 1) { score += rules.weights.single; why.push("one piece"); }
  if (Number.isFinite(stampMs) && stampMs > 0 && nowMs - stampMs > rules.staleDays * 864e5) { score += rules.weights.stale; why.push(`untouched ${days(stampMs)} days`); }
  if (Number.isFinite(rejectedAt) && rejectedAt > 0 && nowMs - rejectedAt <= rules.rejectedDays * 864e5) { score += rules.weights.rejected; why.push(`rejected a website pick ${days(rejectedAt)} days ago`); }
  return { score, risky: score >= rules.riskyAt, why };
}

/**
 * The order the chain's places are asked in. PURE.
 *   risk  { [locationId]: { risky, why } } — absent = trustworthy
 * → [{ locationId, status, pass: "trusted" | "risky" | "central" }]
 */
export function chainOrder(isFootwear, risk = {}, { central = true } = {}) {
  const chain = routeFor(isFootwear).filter((s) => central || s.locationId !== CENTRAL);
  const near = chain.filter((s) => s.locationId !== CENTRAL);
  return [
    ...near.filter((s) => !risk?.[s.locationId]?.risky).map((s) => ({ ...s, pass: "trusted" })),
    ...near.filter((s) => risk?.[s.locationId]?.risky).map((s) => ({ ...s, pass: "risky" })),
    ...chain.filter((s) => s.locationId === CENTRAL).map((s) => ({ ...s, pass: "central" })),
  ];
}

/**
 * Split one line's quantity across the route.
 *   qty        units ordered (a positive integer)
 *   isFootwear footwear or slides
 *   available  { [locationId]: units free there } — anything absent is 0
 *   risk       { [locationId]: { risky, why } } from shelfRisk — absent = every shelf trusted (the chain as written)
 * → [{ qty, locationId, status, why }] quantities summing to qty. `why` says in
 *   plain words why the piece went there (logged, and kept on the line).
 */
export function routeLine({ qty, isFootwear, available = {}, risk = {}, central = true }) {
  let remaining = units(qty);
  const pieces = [];
  if (remaining === 0) return pieces;
  const order = chainOrder(isFootwear, risk, { central });
  const first = routeFor(isFootwear).find((s) => units(available[s.locationId]) > 0) || null;
  for (const step of order) {
    const take = Math.min(remaining, units(available[step.locationId]));
    if (take > 0) {
      pieces.push({ qty: take, locationId: step.locationId, status: step.status, why: whyHere(step, first, risk) });
      remaining -= take;
    }
    if (remaining === 0) return pieces;
  }
  pieces.push({ qty: remaining, locationId: null, status: "no_stock" });
  return pieces;
}

function whyHere(step, first, risk) {
  const notes = (loc) => (risk?.[loc]?.why || []).join(", ");
  if (step.pass === "central") return "last stop: no shop or hub on the chain shows it";
  if (step.pass === "risky") return `only place on the chain with it; its count is doubtful (${notes(step.locationId)})`;
  if (first && first.locationId !== step.locationId && risk?.[first.locationId]?.risky) return `trusted shelf, ahead of ${first.locationId} (${notes(first.locationId)})`;
  return "first on the chain with it";
}

/**
 * Route several lines of one order against one availability picture, so two
 * lines of the same pid/size cannot both claim the same last unit.
 *   lines      [{ key, qty, isFootwear }] — key = `${pid}|${sizeKey}`
 *   available  { [key]: { [locationId]: units } }
 *   risk       { [key]: { [locationId]: { risky, why } } } (optional)
 * → [pieces per line, same order]. `available` is not mutated.
 */
export function routeLines(lines, available, risk = {}, opts = {}) {
  const left = {};
  for (const [key, byLoc] of Object.entries(available || {})) left[key] = { ...byLoc };
  return lines.map((line) => {
    const pool = left[line.key] || (left[line.key] = {});
    const pieces = routeLine({ qty: line.qty, isFootwear: line.isFootwear, available: pool, risk: risk?.[line.key] || {}, central: opts.central !== false });
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

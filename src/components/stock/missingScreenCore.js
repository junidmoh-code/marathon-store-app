// ─── MISSING PRODUCTS — THE SCREEN'S OWN RULES (pure, no firebase) ────────────
// Junid, 22 Nov 2026. Missing Products is its own screen now. This module is
// everything that screen decides that is NOT refill logic: which cards are
// already queued at Central and so leave the list, how the two kinds of card
// become one list, the order, the search and the filters, and the plain-words
// sentence on each card.
//
// IT IS DISPLAY ONLY. Nothing here creates, changes or closes a request, a
// target or a stock cell. What is "missing" is still decided by the two cores
// that always decided it (missingProductsCore.js for everything that is not
// footwear, missingFootwearCore.js for footwear); this only chooses which of
// their cards to show, and how.

// ── QUEUED AT CENTRAL: THE CARD LEAVES THE LIST ──────────────────────────────
// A sneaker card is "missing" while no hub of its division holds a unit, so a
// Request did not retire it: the card sat there until Central picked the
// shoes, looking as if nothing had been done. Now a card whose request is
// OPEN at one of the division's hubs is taken off that division's list, and
// comes back by itself if the request is cancelled or rejected before stock
// moves (it stops being open, and the hub still holds nothing).
//
// Driven by the request records that already exist — the screen loads
// /refill_requests for its reservation arithmetic already. Only requests
// raised FROM this screen count (the Solve vias): a single scan row for one
// size of a sold-out shoe does not mean "this product has been dealt with".
//
// PER DIVISION, by construction: the hubs handed in are one division's. A
// request into Hub 1 hides the card on Marathon and leaves it on Concrete.
//
// (Everything that is not footwear already leaves by itself: its Solve seeds
// the product at the shop, which is the very thing "missing" tests for, in the
// database, for one division. Nothing is added for those cards.)
export const QUEUED_VIAS = Object.freeze(["missing_sneakers", "missing_sneakers_pick", "hub3_solve"]);

export function isQueuedFromHere(r) {
  if (!r || typeof r !== "object") return false;
  if (r.status !== "open" || r.shadow) return false;
  const via = r.createdFrom && typeof r.createdFrom === "object" ? r.createdFrom.via : null;
  return QUEUED_VIAS.includes(via);
}

/**
 * pid → { hubs: [hub…], units, sizes: [{ hub, size, qty }] } for every product
 * with a request from this screen still open at one of `hubs`.
 */
export function queuedAtHubs(requests, hubs) {
  const want = new Set(hubs || []);
  const out = new Map();
  for (const r of Array.isArray(requests) ? requests : Object.values(requests || {})) {
    if (!isQueuedFromHere(r) || !want.has(r.requestingLocation) || !r.productId) continue;
    const q = out.get(r.productId) || { hubs: [], units: 0, sizes: [] };
    if (!q.hubs.includes(r.requestingLocation)) q.hubs.push(r.requestingLocation);
    const qty = Math.max(Number(r.qty) || 0, 0);
    q.units += qty;
    q.sizes.push({ hub: r.requestingLocation, size: String(r.size ?? ""), qty });
    out.set(r.productId, q);
  }
  return out;
}

/**
 * Split one division's sneaker cards into the ones still to do and the ones
 * already queued. `justQueued` is { pid: true } for a request this device
 * raised a moment ago, so the card leaves on the tap and not on the echo.
 * Order is preserved; the cards themselves are never changed.
 */
export function partitionQueued(cards, requests, hubs, justQueued = null) {
  const queued = queuedAtHubs(requests, hubs);
  const todo = [], waiting = [];
  for (const c of cards || []) {
    const q = queued.get(c.pid);
    if (q) waiting.push({ card: c, queue: q });
    else if (justQueued && justQueued[c.pid]) waiting.push({ card: c, queue: null });
    else todo.push(c);
  }
  return { todo, waiting };
}

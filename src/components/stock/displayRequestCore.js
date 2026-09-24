// ─── "NOT ON THE WALL" → A DISPLAY REFILL TASK — the pure half ──────────────
//
// (Owner, 2026-09-24.) "Not on the wall raises a display request. The request
// goes to the Warehouse Queue at whichever hub holds that shoe, onto the Display
// Refill card. The picker taps Send, is asked what size they are sending,
// confirms, and the system registers that size as the display."
//
// ── WHAT WAS BROKEN ──────────────────────────────────────────────────────────
// The first version (2026-09-08) minted an ordinary CUSTOMER order with status
// `incoming` and no refill schedule. The Display Refill card only lists orders
// whose `displayRefillScheduledAt` is set, and the only thing that sets it is a
// warehouse person marking the order READY in the ORDER queue. So a wall-walk
// request landed in the customer queue as "Display wall — Trophy", and:
//   • order #093 (Trophy, 24 Sep 09:33) sat `incoming` and never reached the
//     Display Refill card;
//   • order #071 (PE) was marked Ready by hand, which made the picker choose a
//     size TWICE (a customer `sentSize` of 6, then again at Send), held a
//     20-minute ready-promise against Hub 1's size-6 cell, and put a "ready"
//     display wall on the customer pickup board;
//   • the screen never showed the row as requested, so a second tap met a red
//     "already on its way" error, which reads as the button not working.
//
// ── WHAT IT IS NOW ───────────────────────────────────────────────────────────
// The request is born in EXACTLY the state the fifteen-minute path leaves a
// display-partner order in after it is marked Ready — `requestDisplayPartner`,
// `displayRefillScheduledAt`, `displayRefillHub` and the four resolution fields
// null — so the Display Refill card lists it by the rule it already has, and
// Send → size → confirm resolves it through the path it already has. Nothing on
// that path is changed or copied.
//
// It skips the CUSTOMER half, because there is no customer: its status is
// WALL_WALK_STATUS, which no customer surface lists (the order queue's tabs,
// the pickup board and its announcer, the ready-promise map and the new-order
// push all select on `incoming` / `ready` / ... by name). It is still due on the
// card fifteen minutes after it is raised, because that is the rule the card
// applies to every task and this work does not touch it.
//
// PURE — no firebase, no react. displayRequestStore.js is the only writer.

import { availableUnits, promisedKey, GATED_SNEAKER_HUBS } from "./availabilityCore";
import { isOpenDisplayRequest, requestStoreFor } from "./displayRowCore";
import { labelFor } from "./locations";

/** The status a wall-walk display request carries. Not a customer status. */
export const WALL_WALK_STATUS = "display_request";

/** Where the double-tap fence lives. Under /settings because that subtree is
 *  writable by every signed-in staff account under the live rules — no rules
 *  change is needed (verified against the live rules 2026-09-24). */
export const REQUEST_LOCK_ROOT = "settings/displayRows_meta/requestLocks";

/** How long a claim fences a second request by itself. After this the order is
 *  in every device's /orders stream and the ordinary guard answers instead. */
export const REQUEST_LOCK_MS = 2 * 60 * 1000;

const SAFE = /^[^.#$/[\]\s]+$/;
export const requestLockPath = (store, productId) =>
  SAFE.test(String(store ?? "")) && SAFE.test(String(productId ?? ""))
    ? `${REQUEST_LOCK_ROOT}/${store}/${productId}` : null;

/**
 * Units a hub can actually give out for a product: booked minus ready-promised,
 * per size, clamped at zero — the resolver's own arithmetic (availableUnits).
 * `cells` is the DECODED map useStockCellsState hands over; `promised` is
 * readyPromisedByCell's `{ "pid::sizeKey": n }`.
 */
export function hubUnitsFor({ cells, promised, productId }) {
  let n = 0;
  for (const [size, cell] of Object.entries(cells?.[productId] || {})) {
    if (!cell) continue;                                   // RTDB array holes
    const qty = typeof cell === "object" ? cell.qty : cell;
    n += availableUnits(qty, promised?.[promisedKey(productId, size)]);
  }
  return n;
}

/**
 * WHICH HUB SENDS THE DISPLAY.
 *
 * The product's own hub (its `hubs` tag — the hub the shop's orders for it are
 * routed to) when that hub can give a pair out; otherwise the other gated hub
 * that can. Neither → `{ hub: null }` and nothing is raised: a request no hub
 * can fill is a task the picker can only answer "Stock Depleted".
 *
 * A hub whose cells have not ANSWERED is not judged empty and is not chosen —
 * silence is not zero (the resolver's rule). If the tagged hub is unread the
 * answer is `{ hub: null, unread: true }`, which the caller reports as "still
 * loading", never as "none in any warehouse".
 */
export function pickDisplaySourceHub({ product, hubData, hubs = GATED_SNEAKER_HUBS }) {
  const productId = product?.id;
  if (!productId) return { hub: null };
  const tag = (Array.isArray(product.hubs) && product.hubs[0]) || product.hub || null;
  const order = hubs.includes(tag) ? [tag, ...hubs.filter((h) => h !== tag)] : [...hubs];
  let unread = false;
  for (const hub of order) {
    const d = hubData?.[hub];
    if (!d?.ready) { unread = true; continue; }
    const units = hubUnitsFor({ cells: d.cells, promised: d.promised, productId });
    if (units > 0) return { hub, units, tagged: hub === tag };
  }
  return unread ? { hub: null, unread: true } : { hub: null };
}

/**
 * IS THE DOUBLE-TAP FENCE HELD? `lock` is `{ claimAt, by, orderId }`.
 * Held only while the claim is younger than REQUEST_LOCK_MS; an older claim is
 * history — its order either reached the /orders stream (where the ordinary
 * guard sees it) or was never written.
 */
export function lockHeld(lock, nowMs) {
  const at = Number(lock?.claimAt);
  return Number.isFinite(at) && nowMs - at >= 0 && nowMs - at < REQUEST_LOCK_MS;
}

/**
 * The one order a wall-walk request is. The display-refill fields are exactly
 * the ones App.jsx's READY patch writes on the fifteen-minute path; everything
 * else is what the 2026-09-08 wall-walk order already carried.
 *
 * NO SIZE: the picker chooses it at Send (the absolute rule).
 */
export function wallWalkOrder({ orderId, store, hub, product, nowIso, by }) {
  return {
    id: orderId,
    productId: product.id,
    productName: product.name || "",
    productPhoto: product.photo ?? null,
    productPhotoUrl: product.photoUrl ?? null,
    productCategory: product.category || "",
    productType: product.productType || "sneaker",
    size: null,
    sentSize: null,
    customerName: `Display wall — ${labelFor(store)}`,
    customerPhone: null,
    customerId: null,
    customerCode: null,
    customerPending: false,
    hub,
    placedAtHub: hub,
    placedStore: "central",
    destShop: store,
    requestDisplay: false,
    requestDisplayPartner: true,
    displayPairRequest: false,
    displayPairStore: null,
    wallWalk: true,
    raisedBy: by || null,
    raisedAt: nowIso,
    status: WALL_WALK_STATUS,
    readyNotifyPending: false,
    createdAt: nowIso,
    updatedAt: nowIso,
    readyAt: null,
    outOfStockAt: null,
    comingTomorrowAt: null,
    collectedAt: null,
    // ── THE FIFTEEN-MINUTE PATH'S OWN FIELDS (App.jsx, the READY patch) ──
    displayRefillScheduledAt: nowIso,
    displayRefillHub: hub,
    displayRefillStatus: null,
    displayRefilledAt: null,
    displayRefillStockDepletedAt: null,
    displayRefilledBy: null,
  };
}

/**
 * WHERE THIS SHOE STANDS FOR THIS WALL — what the screen prints on the row.
 *
 *   { state: "requested", order, dueAtMs }   an open request (either path)
 *   { state: "sent", order, size, at }       resolved `refilled` in the last day
 *   { state: "depleted", order, at }         resolved "Stock Depleted"
 *   null                                     nothing in flight
 *
 * The newest order wins. Read off the orders the screen already streams.
 */
export function wallRequestState(orders, { store, productId }, delayMs = 15 * 60 * 1000) {
  let best = null;
  // EVERY open request for this wall, not only the newest. Two can exist: the
  // wall walk and the fifteen-minute path each refuse to open a second one, but
  // only against the /orders their own device has already received, so two
  // taps on two devices within the same few seconds can both land. Newest-wins
  // would then HIDE one while the picker still sees both on the card — and
  // sends two pairs. The screen names them all instead. (Architect review.)
  const openIds = [];
  for (const o of orders || []) {
    if (!o || o.requestDisplayPartner !== true || o.productId !== productId) continue;
    if (requestStoreFor(o) !== store) continue;
    if (isOpenDisplayRequest(o)) openIds.push(String(o.id));
    const t = Date.parse(o.createdAt || "") || 0;
    if (best && t <= best.t) continue;
    if (isOpenDisplayRequest(o)) {
      const sched = Date.parse(o.displayRefillScheduledAt || "");
      best = { t, state: "requested", order: o, dueAtMs: Number.isFinite(sched) ? sched + delayMs : null };
    } else if (o.displayRefillStatus === "refilled") {
      best = { t, state: "sent", order: o, size: o.displayRefillSize || null, at: o.displayRefilledAt || null };
    } else if (o.displayRefillStatus === "stockDepleted") {
      best = { t, state: "depleted", order: o, at: o.displayRefillStockDepletedAt || null };
    }
  }
  if (!best) return null;
  const { t: _t, ...rest } = best;
  return { ...rest, openIds: openIds.sort() };
}

/**
 * THE WALL'S REQUESTS IN FLIGHT — the screen's "Requested" list: every open
 * display request for this store, plus the ones resolved in the last day so
 * the operator sees "sent, size 8, 12:03" before the pair reaches the wall.
 * Newest first. One entry per product (wallRequestState's newest-wins rule).
 */
export function wallRequestsFor(orders, store, nowMs, { windowMs = 24 * 60 * 60 * 1000, delayMs } = {}) {
  const mine = (orders || []).filter((o) => o && o.requestDisplayPartner === true && o.productId
    && requestStoreFor(o) === store);
  const seen = new Set();
  const out = [];
  for (const o of mine) {
    if (seen.has(o.productId)) continue;
    seen.add(o.productId);
    const st = wallRequestState(mine, { store, productId: o.productId }, delayMs);
    if (!st) continue;
    if (st.state !== "requested") {
      const at = Date.parse(st.at || "");
      if (!Number.isFinite(at) || nowMs - at > windowMs) continue;
    }
    out.push({ productId: o.productId, ...st });
  }
  const when = (e) => Date.parse(e.at || e.order.createdAt || "") || 0;
  return out.sort((a, b) => when(b) - when(a));
}

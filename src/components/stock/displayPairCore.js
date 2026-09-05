// ─── DISPLAY PAIR REQUESTS AT HUB 1 — the pure decisions ─────────────────────
//
// The problem this closes (owner brief 2026-08-26): a shop sees size 6
// available and requests it; the warehouse finds an empty shelf and marks it
// out of stock — because the only size 6 booked at hub1 is the DISPLAY pair.
// Display units are booked into the same cell as shelf stock (owner decision,
// #446: a display pair IS available stock), so the availability number is
// right and the shelf is still empty.
//
// THE LINK, confirmed live 2026-08-26 before anything was designed:
//
//   • /settings/displaySlots/{store}/{pid} — one slot per product per store,
//     {size, sizeKey, bookedHub, source, ...}. 180 hub1-booked LIVE slots,
//     every one carrying size AND store. Sources: registration (124),
//     display_refill (56). This is CURRENT state: set at registration and at
//     display refill, cleared (tombstoned) when the display leaves the floor.
//   • /settings/hubSneakerCount/register/hub1/{pid}__{sizeKey} — 534 rows /
//     535 units, all sized, NONE with a store, and NEVER decremented (write-
//     only-upward history). 110 cells read qty <= registered — mostly ghosts
//     of displays long sold and replaced.
//
// So THE SLOT IS THE TRUTH and the register is history: this module keys the
// display flag on live slots only. Joined against live hub1 cells: 165
// slot-claimed cells hold qty > 0, and 41 of them hold qty <= display count —
// the exact population the shop-side marker exists for. (15 slot-claimed
// cells read qty <= 0: data drift, deliberately left ✕/grey — a cell the
// books call empty must never be made requestable by a side record.)
//
// THE REQUEST rides the ORDERS lane end to end — the same path, queue, list
// and states as every shop request. It is a shop-initiated pull of a known
// unit at hub1, NOT a Central refill: it never writes /refill_requests, never
// touches the engine, and hub1's engine-only policy (reactiveRefillHubs.js)
// is untouched — the engine will notice the emptied cell at its reorder point
// exactly as it does for a shelf sale. The order carries requestDisplayPartner
// (so every existing display mechanism fires: the warehouse's staged
// "Send display pair…" flow, the slot clear, the automatic display-refill
// task) plus two new fields:
//
//   displayPairRequest: true      "the pair to send IS the display pair"
//   displayPairStore: "<store>"   whose floor it is on (from the slot)
//
// Pure module — no firebase; callers feed it data they already hold.

import { slotIsLive } from "./displaySlots";
import { isFootwearProduct, promisedKey, availableUnits, promiseFresh } from "./availabilityCore";
import { serverNowMs } from "../../utils/serverTime";

// Live display units per hub cell — TWO sources, one map:
//
//   • SLOTS (store known, current state) — one unit per live hub-booked slot.
//   • THE REGISTER (size known, store not) — measured 2026-08-26: 381 of the
//     534 hub1 register rows have NO live slot (71% of registered products
//     showed no display marker at all), because most registrations never
//     picked a store and only the slot writer records one. The register rows
//     all carry the SIZE, which is what the marker needs.
//
// The two overlap on new-flow registrations (which write both), so register
// units are counted as the UNEXPLAINED remainder — max(0, regQty − live
// slots) — exactly offShelf.js's double-count guard. `unverified` says how
// many of a cell's units came from the store-less register: the register is
// never decremented, so a ghost row (display long sold and replaced) can
// keep a glyph alive — the informational tier wears that; the request flow
// simply carries no store for them and tombstones nothing.
//
// `register` is the /settings/hubSneakerCount/register/{hub} node (keys
// "pid__sizeKey"); pass null to key on slots alone.
// → { "pid::sizeKey": { units, stores: [store, ...], unverified } }
export function displayUnitsByCell(slots, hub, register = null) {
  const out = {};
  for (const [store, byPid] of Object.entries(slots || {})) {
    for (const [pid, slot] of Object.entries(byPid || {})) {
      if (!slotIsLive(slot) || slot.bookedHub !== hub) continue;
      const key = `${pid}::${slot.sizeKey}`;
      (out[key] ||= { units: 0, stores: [], unverified: 0 });
      out[key].units += 1;
      out[key].stores.push(store);
    }
  }
  for (const [regKey, row] of Object.entries(register || {})) {
    const i = regKey.lastIndexOf("__");
    if (i <= 0) continue;
    const pid = regKey.slice(0, i);
    const sizeKey = regKey.slice(i + 2);
    if (!sizeKey || sizeKey === "_") continue;
    const qty = Number(row?.qty) || 0;
    if (qty <= 0) continue;
    const key = `${pid}::${sizeKey}`;
    const cur = (out[key] ||= { units: 0, stores: [], unverified: 0 });
    const unexplained = Math.max(0, qty - cur.stores.length);
    cur.units += unexplained;
    cur.unverified += unexplained;
  }
  return out;
}

// THE MARKER RULE: the display pair is the ONLY remaining availability.
//   avail == 0            → ✕ / grey, unchanged (nothing requestable — even
//                           when a slot claims a display; the books win)
//   0 < avail <= displays → marked (what's left IS on the display)
//   avail > displays      → plain number (shelf stock remains)
export function displayOnly(avail, displayUnits) {
  const a = Math.max(Number(avail) || 0, 0);
  const d = Math.max(Number(displayUnits) || 0, 0);
  return a > 0 && d > 0 && a <= d;
}

// Pending display pulls: an INCOMING (or COMING-TOMORROW) displayPairRequest
// order is a hard claim on a known unit whose slot has ALREADY been
// tombstoned (the clear happens at order creation), so without this term the
// tile would read as plain shelf stock until the warehouse marks it Ready.
// coming_tomorrow is in: a deferred pull is still alive and its pair is still
// claimed — dropping it un-✕'d the tile and invited a second pull of the same
// unit. Ready orders are already netted by readyPromisedByCell (the maps are
// disjoint by status). Same key space, same footwear-only rule.
// Aged through promiseFresh with the PULL lane's OWN deadline, not the ready
// lane's: the 20-minute collection deadline (owner directive 2026-09-01) is
// about a customer standing at the shop; a pull claim is a warehouse task —
// an incoming pull is still being fulfilled and a coming_tomorrow pull must
// survive overnight or the claim is meaningless. 48 hours covers "tomorrow"
// with a day's slack while still expiring the dead records (69% of live
// "incoming" rows were older than 7 days when measured 2026-09-01 — a dead
// pull claim must not ✕ a restocked cell forever any more than a dead ready
// order may).
export const PULL_CLAIM_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const PENDING_PULL_STATUSES = new Set(["incoming", "coming_tomorrow"]);
// NOT HUB-SCOPED, and that is load-bearing to remember. The keys are
// productId::sizeKey with no hub term, so this map may only be netted against a
// hub whose display-pair lane actually raises these claims — Hub 1's, today.
// Hub 2's availability deliberately nets ready orders ONLY (App.jsx
// hub2ReadyPromised): a Hub 2 sneaker structurally cannot produce a pull claim
// (sneakerDisplayOnly gates on sneakerServedByHub1), so folding this in there
// would only ever import a Hub 1 claim's ✕ onto an unrelated Hub 2 cell.
// IF the display-pair lane is ever extended to Hub 2, this function needs a
// real hub filter FIRST — widening sneakerServedByHub1 alone would leave Hub 2
// silently not netting the claims it had started raising.
export function pendingDisplayPullsByCell(orders, productsById, nowMs = serverNowMs()) {
  const out = {};
  for (const o of orders || []) {
    if (!o || !PENDING_PULL_STATUSES.has(o.status) || o.displayPairRequest !== true) continue;
    if (!promiseFresh(o, nowMs, PULL_CLAIM_MAX_AGE_MS)) continue;
    if (!o.productId) continue;
    const p = productsById ? productsById[o.productId] : null;
    if (!p || !isFootwearProduct(p)) continue;
    const size = o.sentSize ?? o.size ?? "";
    const key = promisedKey(o.productId, size);
    if (key.endsWith("::_")) continue;
    out[key] = (out[key] || 0) + (Number(o.qty) || 1);
  }
  return out;
}

// Merge promise maps (ready promises + pending display pulls) — same keys sum.
export function mergePromised(...maps) {
  const out = {};
  for (const m of maps) for (const [k, v] of Object.entries(m || {})) out[k] = (out[k] || 0) + v;
  return out;
}

// Which store's slot a display-pair order clears / the refill later re-fills.
// A display pull can take ANOTHER store's display (Trophy orders the size;
// the pair sits on Marathon PE's floor) — clearing the ORDERING shop's slot
// there would tombstone an unrelated live display. So a PULL targets the
// slot named on the order or NOTHING AT ALL: when two stores each display
// the same pid+size the prompt refuses to guess (displayPairStore null), and
// guessing here with a destShop fallback would tombstone the ordering shop's
// unrelated slot. Classic partner orders (no displayPairRequest) keep the
// destShop behaviour byte-identical: the shop's own display sold at its till.
export function displaySlotStoreFor(orderOrItem) {
  if (orderOrItem?.displayPairRequest === true) return orderOrItem.displayPairStore || null;
  return orderOrItem?.destShop || null;
}

// A "Stock Depleted" display-refill task is revivable once the hub can
// actually give a unit out again (the engine's replenishment landed). Booked
// quantity alone can never answer this — footwear isn't deducted at dispatch,
// so the pulled pair stays booked until the till sale — the RESOLVER's
// availability (booked − ready promises) is the test.
export function depletedTaskRevivable({ cellQty, promised }) {
  return availableUnits(cellQty, promised) > 0;
}

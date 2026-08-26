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
import { isFootwearProduct, promisedKey, availableUnits } from "./availabilityCore";

// Live display units per hub cell, from the whole slots map.
// → { "pid::sizeKey": { units, stores: [store, ...] } }
export function displayUnitsByCell(slots, hub) {
  const out = {};
  for (const [store, byPid] of Object.entries(slots || {})) {
    for (const [pid, slot] of Object.entries(byPid || {})) {
      if (!slotIsLive(slot) || slot.bookedHub !== hub) continue;
      const key = `${pid}::${slot.sizeKey}`;
      (out[key] ||= { units: 0, stores: [] });
      out[key].units += 1;
      out[key].stores.push(store);
    }
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

// Pending display pulls: an INCOMING displayPairRequest order is a hard claim
// on a known unit whose slot has ALREADY been tombstoned (the clear happens at
// order creation), so without this term the tile would read as plain shelf
// stock for the window until the warehouse marks it Ready. Ready orders are
// already netted by readyPromisedByCell; this covers the incoming gap.
// Same key space, same footwear-only rule, mergeable with the promise map.
export function pendingDisplayPullsByCell(orders, productsById) {
  const out = {};
  for (const o of orders || []) {
    if (!o || o.status !== "incoming" || o.displayPairRequest !== true) continue;
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
// there would tombstone an unrelated live display. The slot named on the
// order wins; destShop is the classic partner case (the shop's own display
// sold at its till).
export function displaySlotStoreFor(orderOrItem) {
  return orderOrItem?.displayPairStore || orderOrItem?.destShop || null;
}

// A "Stock Depleted" display-refill task is revivable once the hub can
// actually give a unit out again (the engine's replenishment landed). Booked
// quantity alone can never answer this — footwear isn't deducted at dispatch,
// so the pulled pair stays booked until the till sale — the RESOLVER's
// availability (booked − ready promises) is the test.
export function depletedTaskRevivable({ cellQty, promised }) {
  return availableUnits(cellQty, promised) > 0;
}

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
//   • /settings/hubSneakerCount/register/hub1/{pid}__{sizeKey} — write-only-
//     upward history, NONE with a store, NEVER decremented. Read here once as
//     a second marker source and removed again on 2026-09-07: it is what made
//     one display draw two glyphs (see displayUnitsByCell below).
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

// Live display units per hub cell — ONE SOURCE: the slots.
//
// THIS USED TO READ TWO NODES AND THAT WAS THE BUG (owner report + census,
// 2026-09-07; docs/display-marker-findings.md). The second source was the
// display REGISTER named in the header above, keyed "pid__sizeKey" — write-
// only-upward history, never replaced, never decremented. A display that
// changes size does not overwrite its register row; it gets a SECOND one, and
// the double-count guard could not see across the two because it subtracts
// within one cell key and two sizes are two keys. Both rows drew a glyph.
// Diesel Big D Green Orange: slot moved to size 6 by a display refill on
// 5 Sep, register row still saying size 8 from 22 Aug — marker on both. 51
// products carried 2+ markers live; reading slots alone gives 0.
//
// The register CANNOT be made to replace: its key IS the size, and it is the
// hub count's "booked here, standing on a floor" evidence (offShelf.js), which
// decrementing on a sale would corrupt. So it is not the marker's source, and
// the app no longer subscribes to it for this purpose at all.
//
// THE SLOT IS THE ONLY SOURCE, and it is the one that can carry the job:
//   • one record per product PER STORE, so a replacement OVERWRITES — the
//     accumulation is impossible by construction, not by cleanup;
//   • it holds the size captured at SEND time (sentSize -> displayRefillSize ->
//     setDisplaySlot), which is the settled model's single fact;
//   • it CLEARS ITSELF when the display sells, and reinstates on a failed pull;
//   • it names the store, which the request flow needs anyway.
//
// Two stores each displaying the same product at different sizes still yield
// two marked cells. That is not accumulation — that is two real displays.
//
// `unverified` is retained on every entry and is now always 0: no marked unit
// comes from a store-less record any more. Callers that read it (none today)
// keep working, and the field documents that the store-less tier is gone.
// → { "pid::sizeKey": { units, stores: [store, ...], unverified } }
export function displayUnitsByCell(slots, hub) {
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

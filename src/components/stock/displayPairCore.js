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
import { stockSizeKey } from "../../utils/sizeKey";
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

// ─── THE EXITS: replaying them off the ORDER lane, and PERSISTING the repair ─
//
// The slot is the durable record and the exits already write it: a display
// sale clears it at order creation, a display refill overwrites it with the
// size that was sent, a failed pull reinstates it. All three are best-effort
// fire-and-forget writes, because the ORDER is the fact that must never be
// lost — so a dropped write leaves a marker standing on a shoe that is no
// longer on the floor, and nothing retries it. That is a human step by another
// name, and the exits are not allowed to need one.
//
// So the marker replays the SAME three transitions off the orders the screen
// already streams, and the newer of the two wins. THREE, mirroring the writers
// in App.jsx exactly — same field, same instant, same resolved hub:
//
//   SALE       requestDisplayPartner — the displayed pair is being sold —
//              CLEARS that store's slot, as of order.createdAt.
//   REINSTATE  a display-pair PULL that came back out_of_stock: the pair never
//              left the floor, so the slot is SET BACK to order.size at
//              order.outOfStockAt. displayPairRequest only, exactly like the
//              writer — a classic partner order going out of stock means the
//              display did sell and the warehouse simply has no replacement.
//   REPLACEMENT displayRefillStatus "refilled" with displayRefillSize (the
//              size captured when the pair was physically SENT) SETS the slot
//              to that size at order.displayRefilledAt.
//
// A SET whose store has no slot record CREATES one, because setDisplaySlot
// creates one; a CLEAR with no record does nothing, because clearDisplaySlot
// no-ops. Anything less and the replay would disagree with the writer it is
// standing in for.
//
// ORDERING. Every instant is an ISO-8601 UTC string from serverNowIso() —
// always `…Z`, always millisecond precision, so lexicographic comparison IS
// chronological (pinned in the tests). The slot wins only when it is STRICTLY
// newer: at equal instants the event is the same transition the slot already
// records, so applying it is idempotent, and that matches supersededBy() in
// displaySlots.js, which also lets an equal-instant write through. Two events
// at the same instant are ranked sale < reinstate < replacement, the order
// they can only ever occur in on one order, so the projection never depends on
// the order the array happens to be in.
//
// The store an event belongs to is displaySlotStoreFor's answer, not
// destShop's: a display-pair PULL can take ANOTHER shop's display, and
// clearing the ordering shop's slot would erase an unrelated live display.
//
// ── WHY THE REPLAY IS NOT ENOUGH ON ITS OWN, AND WHAT CLOSES IT ──────────────
// Two holes, both found in review before this shipped:
//
//   • /orders IS EPHEMERAL — ids recycle daily. A repair that lives only in
//     this projection un-repairs itself the moment the order is overwritten,
//     and the ghost comes back.
//   • THE ORDER FEED IS STORE-SCOPED. A store-assigned assistant reads only
//     destShop == their shop (useOrders(myShop), rules-enforced). When Trophy
//     pulls a pair standing on Marathon PE's floor, PE's own device never
//     receives that order and would keep the ghost for ever.
//
// So the projection is not the fix; it is how the fix is FOUND.
// displaySlotRepairs turns each divergence into the exact write the exit
// dropped, and App.jsx applies it through the ordinary fenced writers. Any
// device that can see the evidence heals the durable record for every device
// that cannot — once, idempotently, and with the writers' own staleness fence
// still deciding. If the write fails again, the next load finds it again.
//
// NOT COVERED, and deliberately: the registration card's RETIRE
// (removeDisplayFact) writes no order, so nothing here can see it. That path
// is a person standing at the card, and it already tells them in words when
// its slot clear failed. It is the one exit with a human in the loop, because
// it is the one exit that is a human.

const EXIT_CLEAR = 0;         // rank at equal instants: the order they occur in
const EXIT_REINSTATE = 1;
const EXIT_REPLACE = 2;

const exitKey = (store, productId) => `${store} ${productId}`;

// One winning transition per (store, product) — { at, rank, sizeKey, size,
// bookedHub, source, orderId, productName }. sizeKey null = a clear.
function displayExitsByStoreProduct(orders) {
  const out = new Map();
  for (const o of orders || []) {
    if (!o || !o.productId) continue;
    const store = displaySlotStoreFor(o);
    if (!store) continue;
    const key = exitKey(store, o.productId);
    const put = (at, rank, ev) => {
      if (typeof at !== "string" || !at) return;
      const cur = out.get(key);
      if (cur && (at < cur.at || (at === cur.at && rank <= cur.rank))) return;
      out.set(key, { at, rank, orderId: o.id ?? null, productName: o.productName || "", ...ev });
    };
    const sized = (size, bookedHub, source) => {
      const raw = String(size);
      const sizeKey = stockSizeKey(raw);
      return sizeKey && sizeKey !== "_" ? { sizeKey, size: raw, bookedHub, source } : null;
    };
    if (o.requestDisplayPartner === true) put(o.createdAt, EXIT_CLEAR, { sizeKey: null, source: "display_sold" });
    // The reinstate writer: App.jsx, status OUT_OF_STOCK on a displayPairRequest.
    if (o.displayPairRequest === true && o.status === "out_of_stock" && o.size) {
      const ev = sized(o.size, o.placedAtHub || o.hub || "hub1", "manual");
      if (ev) put(o.outOfStockAt, EXIT_REINSTATE, ev);
    }
    // The replacement writer: App.jsx, setDisplayRefillStatus("refilled").
    if (o.displayRefillStatus === "refilled" && o.displayRefillSize) {
      const ev = sized(o.displayRefillSize, o.displayRefillHub || o.placedAtHub || o.hub || null, "display_refill");
      if (ev) put(o.displayRefilledAt, EXIT_REPLACE, ev);
    }
  }
  return out;
}

// Does this event supersede the slot record it lands on? The slot wins only
// when it is STRICTLY newer. A slot with no `at` at all is a hand-written
// record whose place in the order of events is unknowable — it wins too,
// rather than being guessed at.
const exitWins = (ev, slot) => {
  if (!slot) return true;                                   // no record — a SET creates one
  if (typeof slot.at !== "string" || !slot.at) return false;
  return ev.at >= slot.at;
};

// Is the slot already exactly what the event says? Then the write landed and
// the projection has nothing to add — which is the healthy case, every time.
const sameSlotState = (ev, slot) =>
  ev.sizeKey == null
    ? !slotIsLive(slot)
    : !!slot && slot.sizeKey === ev.sizeKey && slot.bookedHub === (ev.bookedHub ?? slot.bookedHub);

const slotFromExit = (ev, productId, slot) =>
  ev.sizeKey == null
    ? { ...(slot || {}), productId, size: null, sizeKey: null, prevSize: slot?.size ?? null,
        source: ev.source, at: ev.at, orderId: ev.orderId, derived: "orders" }
    : { ...(slot || {}), productId, productName: slot?.productName || ev.productName || "",
        size: ev.size, sizeKey: ev.sizeKey, bookedHub: ev.bookedHub ?? slot?.bookedHub ?? null,
        source: ev.source, at: ev.at, orderId: ev.orderId, derived: "orders" };

/**
 * The slots map with every exit the order lane knows about already applied.
 * Pure: same shape in, same shape out, so every existing slot reader keeps
 * working. Pass no orders and you get the same object back, untouched.
 *
 * Plain objects are built with a null prototype: a store or product id is
 * user-reachable data, and `__proto__` as a key on a `{}` literal silently
 * mutates the result's prototype instead of adding a member.
 */
export function slotsAfterOrderExits(slots, orders) {
  const exits = displayExitsByStoreProduct(orders);
  if (exits.size === 0) return slots || {};
  const out = Object.create(null);
  const seen = new Set();
  // `changed` keeps the common case reference-stable. /orders re-fires on every
  // till transaction in the shop and useOrders hands back a NEW array each
  // time, so without this every unrelated sale would rebuild the whole slot
  // graph and invalidate every memo hanging off it — for a projection that,
  // when the writers are healthy, changes nothing at all.
  let changed = false;
  for (const [store, byPid] of Object.entries(slots || {})) {
    const next = Object.create(null);
    for (const [pid, slot] of Object.entries(byPid || {})) {
      const k = exitKey(store, pid);
      seen.add(k);
      const ev = exits.get(k);
      const apply = ev && exitWins(ev, slot) && !sameSlotState(ev, slot);
      if (apply) changed = true;
      next[pid] = apply ? slotFromExit(ev, pid, slot) : slot;
    }
    out[store] = next;
  }
  for (const [k, ev] of exits) {
    if (!seen.has(k) && ev.sizeKey != null) { changed = true; break; }
  }
  if (!changed) return slots || {};
  // A replacement for a product this store has no slot record for at all: the
  // writer would have CREATED one, so the projection does too. A clear with no
  // record stays nothing, exactly as clearDisplaySlot no-ops.
  for (const [k, ev] of exits) {
    if (seen.has(k) || ev.sizeKey == null) continue;
    const i = k.indexOf(" ");
    const store = k.slice(0, i), pid = k.slice(i + 1);
    (out[store] ||= Object.create(null))[pid] = slotFromExit(ev, pid, null);
  }
  return out;
}

/**
 * The divergences as WRITES: every slot the order lane says is wrong, with the
 * exact call that fixes it. App.jsx applies these through setDisplaySlot /
 * clearDisplaySlot, whose staleness fence still has the final say — so a
 * repair that has been overtaken by a real transition simply aborts.
 *
 * `at` is the EVENT's instant, not now: passed to the writer it makes the
 * repair indistinguishable from the write that was dropped, so a repair can
 * never win over something newer that landed in between.
 *
 * → [{ op: "set" | "clear", store, productId, productName, size, bookedHub,
 *      source, at, orderId }]
 */
export function displaySlotRepairs(slots, orders) {
  const exits = displayExitsByStoreProduct(orders);
  const out = [];
  if (exits.size === 0) return out;
  for (const [k, ev] of exits) {
    const i = k.indexOf(" ");
    const store = k.slice(0, i), productId = k.slice(i + 1);
    const slot = slots?.[store]?.[productId] ?? null;
    if (!exitWins(ev, slot)) continue;
    // Already exactly what the event says — the write landed, nothing to do.
    // (A clear with no record at all is also nothing: clearDisplaySlot no-ops.)
    if (sameSlotState(ev, slot)) continue;
    if (ev.sizeKey == null) {
      out.push({ op: "clear", store, productId, source: ev.source, at: ev.at, orderId: ev.orderId });
    } else {
      out.push({ op: "set", store, productId,
        productName: slot?.productName || ev.productName || "",
        size: ev.size, bookedHub: ev.bookedHub ?? slot?.bookedHub ?? null,
        source: ev.source, at: ev.at, orderId: ev.orderId });
    }
  }
  return out;
}

/** Stable identity for one repair, so a device applies each at most once. */
export const displayRepairKey = (r) =>
  `${r.op} ${r.store} ${r.productId} ${r.at} ${r.size ?? ""}`;

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

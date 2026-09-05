// ─── THE MARKER THAT MAKES THE INVENTORY SWEEP POSSIBLE ──────────────────────
//
// WHAT WAS BROKEN. scripts/shopify/reconcile.mjs pushes a product's inventory
// to Shopify exactly ONCE — inside the block that applies a publish intent.
// Once a product is live and on, that block never runs for it again, so its
// quantity on the storefront is frozen at whatever it was on the day it went
// live. Stock then moves in the shops for weeks. Measured on the live shop on
// 2026-09-04, across 1,152 live products: 564 drifted, 1,190 variants, and 220
// variants were being OFFERED FOR SALE against an app quantity of zero —
// buyable and unshippable at the same time. That is customer harm, not a
// reporting error.
//
// WHY A MARKER AND NOT A SWEEP OVER /stock. /stock is ~5.36 MB. Reading it
// whole every two minutes to discover what moved is ~2.6 GB a day to learn that
// usually nothing did. This trigger writes ONE small key when a cell actually
// changes, and scripts/shopify/inventorySync.mjs drains those keys. A quiet
// shop costs one tiny read per tick.
//
// WHY THE VALUE IS AN INCREMENTING COUNTER. The sweep clears a marker only when
// the marker still holds the revision it processed — otherwise a stock movement
// that landed mid-push would have its marker deleted along with the one being
// worked, and Shopify would keep an obsolete quantity until some unrelated
// movement marked the product again. A timestamp cannot carry that guarantee at
// millisecond resolution; ServerValue.increment can, and is atomic server-side
// so two concurrent movements produce two revisions rather than one.
//
// DIRECTION. This is the APP → SHOPIFY leg only. A web sale coming back the
// other way is a webhook, not a sweep — a poll must never be the mechanism for
// money that has already changed hands.

// stock/in_transit is NOT sellable (src/components/stock/locations.js marks it
// kind "transit", sellable false). It is excluded from the network total the
// push computes, so a movement WITHIN it cannot change what Shopify should
// show. The movement's other leg fires its own event at a sellable location.
// This list must stay in step with UNSELLABLE_LOCATIONS in
// scripts/shopify/inventory.mjs — the contract test pins them together.
const UNSELLABLE_LOCATIONS = new Set(["in_transit"]);

const DIRTY_PATH = "shopify_inventory_dirty";

/** A cell is `{ qty, … }` from applyMovement; a bare number is tolerated for
 *  old data. Negatives are bookkeeping artefacts and are never sellable — the
 *  same clamp networkTotals applies. */
function sellableQty(cell) {
  const qty = cell !== null && typeof cell === "object" ? cell.qty : cell;
  return Math.max(0, Number(qty) || 0);
}

/**
 * Did the SELLABLE picture change between these two cell maps?
 *
 * Compared PER SIZE KEY, never by a total. A movement that takes one from S and
 * puts one on M leaves the sum identical while changing two variants on the
 * storefront — summing first would silently decline to mark exactly the case a
 * shop floor produces most often.
 *
 * Pure, so it is unit-tested without a database.
 */
function sellableChanged(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (sellableQty((before || {})[k]) !== sellableQty((after || {})[k])) return true;
  }
  return false;
}

/** Live on the storefront right now — the only products worth marking. */
function isLiveOn(node) {
  return node?.state === "live" && node?.liveState === "on";
}

/**
 * Mark a product's inventory as needing a push to Shopify.
 *
 * `deps` is everything that touches the outside world, so the whole decision is
 * testable with plain objects: { db, increment, log }.
 *
 * ── WHY THE "AFTER" SIDE IS RE-READ ─────────────────────────────────────────
 * The event payload is a snapshot of a delivery that may be minutes old and may
 * be a retry. Trusting `event.data.after` here would let a stale payload prove
 * "nothing changed" against a node that has since moved — and a MISSED mark is
 * invisible: the product simply stays drifted, which is the whole bug this
 * closes. So the current cells are read fresh and compared with the event's
 * `before`. The bias is deliberately toward over-marking: a spurious marker
 * costs one small counter write and a sweep that finds no drift, while a missed
 * one costs an oversell.
 */
async function markInventoryDirty({ db, increment, log = () => {} }, { loc, pid, before }) {
  if (!loc || !pid) return { marked: false, why: "no location or product id" };
  if (UNSELLABLE_LOCATIONS.has(loc)) return { marked: false, why: `${loc} is not sellable` };

  const after = (await db.ref(`stock/${loc}/${pid}`).get()).val();
  if (!sellableChanged(before, after)) return { marked: false, why: "no sellable change" };

  // Only products actually on the storefront. Without this gate the marker node
  // would grow a key for every stock movement on everything we do not sell
  // online — tens of thousands of products — and the sweep's per-run cap would
  // then be spent clearing noise while a live product waited its turn.
  const node = (await db.ref(`shopify_publish/${pid}`).get()).val();
  if (!isLiveOn(node)) return { marked: false, why: "not live on the storefront" };

  await db.ref(`${DIRTY_PATH}/${pid}`).set(increment(1));
  log(`shopify inventory marked dirty: ${pid} (${loc})`);
  return { marked: true };
}

module.exports = {
  DIRTY_PATH,
  UNSELLABLE_LOCATIONS,
  sellableQty,
  sellableChanged,
  isLiveOn,
  markInventoryDirty,
};

// ─── DISPLAY SLOTS — a display is a SLOT, not a quantity ─────────────────────
// (Owner spec 2026-08-12, count-integrity work.)
//
// One display per product per store, holding the SIZE currently on that shop's
// floor. This is the record PR #324 deliberately removed ("displays are hub
// stock; nothing tracks what is on display") — and the hub count is the reason
// it has to come back: a registered display unit is BOOKED at the hub but
// PHYSICALLY at a shop, and a counter who cannot see that adjusts it away. The
// slot is the count's answer to "which size is out there right now":
//
//   • REGISTERING a display (HubCleanup register pass, now with a store pick)
//     sets the slot to the registered size.
//   • SENDING a replacement (the display-refill flow) sets the slot to the new
//     size — so a display that changes size MID-COUNT needs no re-walk of the
//     floor; the count reads the slot's CURRENT state.
//   • The display SELLING clears the slot (recorded when the shop raises its
//     display-partner order — the moment this app first learns the display is
//     leaving; the POS itself stamps nothing, see below).
//
// The slot is INFORMATIONAL, never a stock cell: it moves no quantity, and the
// unit it describes stays booked at `bookedHub` exactly as before. It exists so
// the count card can say "1 on display at Marathon PE" instead of asking a
// counter to destroy that unit.
//
// ── SHAPE ────────────────────────────────────────────────────────────────────
//   /settings/displaySlots/{store}/{productId} = {
//     productId, productName,
//     size, sizeKey,          // the size on the floor NOW; null after a clear
//     bookedHub,              // which hub's cell carries the unit ("hub1"|"hub2")
//     source,                 // "registration" | "display_refill" | "display_sold"
//     at, by,                 // last transition
//     orderId,                // the order that drove it, when one did
//     prevSize,               // what a clear removed (audit)
//   }
// A CLEARED slot keeps its record with sizeKey: null — history stays readable
// and the count treats it as "nothing out there".
//
// Under /settings for the same reason as the count session: it is the one
// subtree the live rules let a signed-in app user write without a rules change.
// (Hardening rule to add in the console later, NOT now:
//   /settings/displaySlots: .write auth != null && non-anonymous.)
//
// ── WHAT EXISTING REGISTRATIONS CAN AND CANNOT GIVE US ───────────────────────
// The 806 register rows written before this module carry hub + product + size
// but NO store — a display at PE and one at Trophy are indistinguishable. They
// can be READ as store-unknown off-shelf evidence (offShelf.js does exactly
// that) but they cannot be lifted into per-store slots without a human walking
// the floors once more. Nothing here rewrites them.

import { ref, child, get, runTransaction } from "firebase/database";
import { database, auth } from "../../firebase";
import { stockSizeKey } from "../../utils/sizeKey";
import { serverNowIso } from "../../utils/serverTime";

export const DISPLAY_SLOTS_ROOT = "settings/displaySlots";

const safeSeg = (s) => String(s ?? "").replace(/[.#$/\[\]\s]/g, "_");
export const slotPath = (store, productId) =>
  `${DISPLAY_SLOTS_ROOT}/${safeSeg(store)}/${safeSeg(productId)}`;

const one = async (path) => (await get(child(ref(database), path))).val();

/** Every slot, every store, one shot → { store: { productId: slot } }. Small:
 *  one record per product per store, only for products actually on display. */
export async function loadDisplaySlots() {
  return (await one(DISPLAY_SLOTS_ROOT)) || {};
}

// ── THE STALENESS FENCE (CodeRabbit, PR #347) ────────────────────────────────
// Both writers below run as a TRANSACTION carrying the instant the write was
// INITIATED (`notAfterIso`, stamped before any network round trip). If the
// slot already holds a transition NEWER than that instant, the write aborts:
// a clear delayed on bad wifi can no longer erase the replacement that landed
// while it was in flight, and a delayed refill write can no longer resurrect a
// slot a later sale already cleared. Fresh truth always wins; the loser
// reports { superseded: true } and nothing retries it — the newer state IS the
// state.
const supersededBy = (cur, notAfterIso) =>
  !!(cur && typeof cur.at === "string" && notAfterIso && cur.at > notAfterIso);

/**
 * Set (or replace) the slot: this size is on this store's floor now, booked at
 * `bookedHub`. Last INITIATED write wins — the slot IS "current state".
 */
export async function setDisplaySlot({ store, productId, productName = "", size, bookedHub, source, orderId = null }) {
  const rawSize = String(size ?? "").trim();
  const sizeKey = stockSizeKey(rawSize);
  if (!store || !productId) return { ok: false, message: "Store and product are required." };
  if (!rawSize || sizeKey === "_") return { ok: false, message: "A display slot needs a real size." };
  const user = auth.currentUser;
  const notAfterIso = serverNowIso();
  const next = {
    productId,
    productName: productName || "",
    size: rawSize,
    sizeKey,
    bookedHub: bookedHub || null,
    source: source || "manual",
    at: notAfterIso,
    by: user ? user.uid : null,
    orderId: orderId || null,
    prevSize: null,
  };
  try {
    const res = await runTransaction(ref(database, slotPath(store, productId)), (cur) =>
      supersededBy(cur, notAfterIso) ? undefined : next
    );
    return res && res.committed ? { ok: true } : { ok: true, superseded: true };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

/**
 * Clear the slot — the display left the floor (sold, or pulled). Keeps the
 * record as a tombstone with sizeKey null so the transition is auditable.
 * Clearing a slot that does not exist (or was already cleared) is a quiet
 * no-op: the shop may raise a display-partner order for a product whose
 * display was never slot-tracked.
 */
export async function clearDisplaySlot({ store, productId, source = "display_sold", orderId = null }) {
  if (!store || !productId) return { ok: false, message: "Store and product are required." };
  const user = auth.currentUser;
  const notAfterIso = serverNowIso();
  try {
    const res = await runTransaction(ref(database, slotPath(store, productId)), (cur) => {
      if (!cur || cur.sizeKey == null) return undefined;            // nothing out there — no-op
      if (supersededBy(cur, notAfterIso)) return undefined;         // a newer transition already landed
      return {
        ...cur,
        size: null,
        sizeKey: null,
        source,
        at: notAfterIso,
        by: user ? user.uid : null,
        orderId: orderId || null,
        prevSize: cur.size || null,
      };
    });
    return res && res.committed ? { ok: true } : { ok: true, noop: true };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

// ── PURE HELPERS (unit-tested; no Firebase) ──────────────────────────────────

/** Is this slot record a LIVE display (something is on the floor)? */
export function slotIsLive(slot) {
  return !!slot && typeof slot.sizeKey === "string" && slot.sizeKey.length > 0 && slot.sizeKey !== "_";
}

/**
 * Live slots matching one hub stock cell → [{ store, slot }].
 * The count card sums these as "on display at {store}".
 */
export function slotsForCell(slots, { hub, productId, sizeKey }) {
  const out = [];
  for (const [store, byPid] of Object.entries(slots || {})) {
    const slot = byPid ? byPid[productId] : null;
    if (!slotIsLive(slot)) continue;
    if (slot.bookedHub !== hub) continue;
    if (slot.sizeKey !== sizeKey) continue;
    out.push({ store, slot });
  }
  return out;
}

/** Every live slot for a product at a hub, whatever the size (for panels that
 *  want to say "the display out there is size 7, not this size"). */
export function liveSlotsForProduct(slots, { hub, productId }) {
  const out = [];
  for (const [store, byPid] of Object.entries(slots || {})) {
    const slot = byPid ? byPid[productId] : null;
    if (!slotIsLive(slot)) continue;
    if (hub && slot.bookedHub !== hub) continue;
    out.push({ store, slot });
  }
  return out;
}

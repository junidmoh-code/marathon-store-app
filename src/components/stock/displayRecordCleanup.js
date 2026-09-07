// ─── STALE DISPLAY RECORDS — the classification, pure ────────────────────────
//
// (Owner ask, 2026-09-07, the follow-on to PR #574.)
//
// PR #574 stopped the display REGISTER feeding the shop marker, which killed
// the duplicate glyph. It deliberately changed no data — and the register is
// still read by the COUNT. offShelf.js subtracts every register row from a hub
// cell's booked total to answer "how many should be on this shelf":
//
//     booked − off-shelf = EXPECTED ON SHELF
//
// So a row describing a display that was replaced or sold is not cosmetic. It
// subtracts a unit that is not standing on any shop floor, under-states what
// the counter should find, and hands them a discrepancy that is not real. 140
// such rows were measured live across the two hubs (2026-09-07;
// docs/display-record-cleanup-census.txt).
//
// ── WHAT RETIRING ONE ACTUALLY DOES, AND WHY THE SCREEN MUST SAY SO ──────────
// Retiring a row moves NO stock. It raises that cell's expected-on-shelf by
// one, because one fewer unit is claimed to be elsewhere. If the row was a
// ghost, that is the fix. If a real display were retired by mistake, the next
// count would expect a pair on the shelf that is genuinely out at a shop, not
// find it, and post a NEGATIVE adjustment — destroying a unit that exists.
// That asymmetry is the whole reason this module refuses to guess: a row is
// only offered for retirement when a LIVE RECORD contradicts it, never because
// it is merely old or unexplained.
//
// ── THE CLASSES ──────────────────────────────────────────────────────────────
// Evidence comes from /settings/displaySlots, which is CURRENT state (one
// record per product per store, replaced on a refill, tombstoned on a sale).
//
//   MATCHED     a live slot at the same size. The row is right. Left alone.
//   REPLACED    a live slot for this product at a DIFFERENT size. The display
//               was replaced; this row describes the pair that went. Actionable,
//               for as many units as there are moved floors — never the whole row.
//   SOLD        no live slot, but a tombstone (source display_sold / manual).
//               The display left the floor and nothing replaced it. Actionable,
//               for as many units as there are tombstones — never the whole row.
//   OVER        a live slot at this size, but the row claims MORE units than
//               there are floors showing it. The surplus is actionable; the
//               matched part is not, so only the surplus is offered.
//   GONE        the product record is deleted, or merged away into another.
//               Nothing can sell this pid; the row cannot describe a display
//               anyone is looking after. Actionable.
//   UNVERIFIED  no slot record for this product at all — a registration made
//               before slots existed, or one where no shop was picked. There
//               is NO evidence either way, so it is REPORTED AND NEVER
//               ACTIONABLE. 582 rows live, and offering a button here is
//               exactly how a real display gets counted away.
//
// A DEACTIVATED product is deliberately NOT a class of its own. A finished line
// can still have its last pair standing on a wall, and "we stopped restocking
// it" is not evidence about the floor. It is surfaced as a NOTE on whatever
// class the row already falls into, so it can inform a human without ever
// being the reason a row becomes actionable.
//
// Pure — no firebase, no react. The screen and
// scripts/census-display-record-cleanup.mjs run the same function, so the live
// report and the tab can never disagree.

import { slotIsLive } from "./displaySlots";
import { isDeactivated } from "../../utils/deactivation";

/** The classes a row can land in, in the order the screen shows them. */
export const CLEANUP_CLASSES = ["replaced", "sold", "over", "gone", "unverified", "matched"];

/** Which of those a human may act on. `unverified` and `matched` never appear. */
export const ACTIONABLE_CLASSES = new Set(["replaced", "sold", "over", "gone"]);

/** Split a register key into [productId, sizeKey]. Product ids never contain
 *  "__"; the size key can ("5_5" uses a single underscore), so split on the
 *  LAST occurrence — the same rule displayPairCore uses. */
export function splitRegisterKey(key) {
  const i = String(key ?? "").lastIndexOf("__");
  if (i <= 0) return null;
  const productId = key.slice(0, i);
  const sizeKey = key.slice(i + 2);
  if (!productId || !sizeKey || sizeKey === "_") return null;
  return [productId, sizeKey];
}

/**
 * Every display slot record for one product, split into the live ones booked
 * at THIS hub and the tombstones (whatever hub they were booked at — a
 * tombstone carries no bookedHub claim worth trusting once it is cleared).
 */
function slotsForProduct(slots, productId, hub) {
  const live = [], tombs = [];
  for (const [store, byPid] of Object.entries(slots || {})) {
    const s = byPid ? byPid[productId] : null;
    if (!s) continue;
    if (slotIsLive(s)) {
      if (s.bookedHub === hub) live.push({ store, ...s });
    } else {
      tombs.push({ store, ...s });
    }
  }
  return { live, tombs };
}

/**
 * Classify one hub's register against the live slots.
 *
 * @param register      /settings/hubSneakerCount/register/{hub} — { "pid__sizeKey": row }
 * @param slots         /settings/displaySlots — { store: { pid: slot } }
 * @param hub           "hub1" | "hub2"
 * @param productsById  Map or plain object pid → product record (the catalogue
 *                      the screen already holds). A pid ABSENT from it is only
 *                      treated as "gone" when `catalogueComplete` is true —
 *                      a half-loaded catalogue must never make rows actionable.
 * @param catalogueComplete  has the product list actually answered?
 *
 * → { byClass: { replaced: [row], … }, counts: {…}, actionableCount }
 *   row = { key, productId, sizeKey, qty, retireQty, at, product, productName,
 *           cls, why, evidence: [{ kind, store, size, at, source }], deactivated }
 */
export function classifyDisplayRecords({ register, slots, hub, productsById, catalogueComplete = true }) {
  const get = (pid) =>
    productsById && typeof productsById.get === "function" ? productsById.get(pid) : (productsById || {})[pid];

  const byClass = Object.fromEntries(CLEANUP_CLASSES.map((c) => [c, []]));

  for (const [key, raw] of Object.entries(register || {})) {
    const split = splitRegisterKey(key);
    if (!split) continue;
    const [productId, sizeKey] = split;
    const qty = Number(raw?.qty) || 0;
    if (qty <= 0) continue;                       // already retired — not a record any more

    const product = get(productId) || null;
    const { live, tombs } = slotsForProduct(slots, productId, hub);
    const sameSize = live.filter((s) => s.sizeKey === sizeKey);
    const evidence = [
      ...live.map((s) => ({ kind: "live", store: s.store, size: s.size, sizeKey: s.sizeKey, at: s.at, source: s.source })),
      ...tombs.map((s) => ({ kind: "tomb", store: s.store, size: s.prevSize ?? null, sizeKey: null, at: s.at, source: s.source })),
    ];

    // ── RETIRE ONLY AS MANY UNITS AS THE EVIDENCE COVERS ────────────────────
    // A register row is a QUANTITY (qty > 1 happens — a second physical display
    // of the same product and size goes through "add another"), and it carries
    // NO store. So the number of units a piece of evidence can speak for is the
    // number of shop records behind it, never the whole row.
    //
    // The case this closes (senior-architect review): a row of qty 2 where ONE
    // unit sold at Marathon PE (one tombstone) and the other is genuinely still
    // standing at Trophy, registered before slots existed so it never produced
    // one. Retiring the whole row would count that second, real display away.
    // Bounded by the tombstone count, only the evidenced unit goes.
    //
    // The residual is stated rather than papered over: with one row, one
    // tombstone and one untracked floor, no data can say WHICH unit the row is.
    // That is exactly why this class is human-reviewed and why the screen shows
    // the shop and the date on every piece of evidence — the person decides,
    // with the evidence in front of them, and can leave it.
    let cls, why, retireQty = qty;
    if (catalogueComplete && !product) {
      cls = "gone";
      // The screen's catalogue has merged-away records already filtered out
      // (useProducts), so absence covers both cases and the wording says both.
      why = "Not in the product list any more — deleted, or merged into another record.";
    } else if (product && product.mergedInto) {
      // Reachable when the caller passes an UNFILTERED catalogue — the census
      // script does, and gets the precise reason. Kept for that, not decoration.
      cls = "gone"; why = `Merged into another product (${product.mergedInto}) — nothing can sell this record.`;
    } else if (sameSize.length) {
      if (qty > sameSize.length) {
        cls = "over";
        retireQty = qty - sameSize.length;
        why = `Claims ${qty} on display, but only ${sameSize.length} shop ${sameSize.length === 1 ? "floor shows" : "floors show"} this size.`;
      } else {
        cls = "matched"; why = "A shop floor shows this size — the record is right.";
      }
    } else if (live.length) {
      const sizes = [...new Set(live.map((s) => s.size ?? s.sizeKey))].join(", ");
      cls = "replaced";
      retireQty = Math.min(qty, live.length);
      why = `The display for this product is now size ${sizes} — this row is the pair it replaced.`
        + (qty > live.length ? ` ${qty} are registered here and ${live.length} moved, so only ${retireQty} can be retired.` : "");
    } else if (tombs.length) {
      cls = "sold";
      retireQty = Math.min(qty, tombs.length);
      why = `The display left ${tombs.length === 1 ? "the floor" : `${tombs.length} floors`} and nothing replaced it.`
        + (qty > tombs.length ? ` ${qty} are registered here and ${tombs.length} left, so only ${retireQty} can be retired.` : "");
    } else {
      cls = "unverified"; why = "No shop was ever recorded for this display — there is no evidence either way.";
    }

    byClass[cls].push({
      key, productId, sizeKey, qty, retireQty,
      at: raw?.at ?? null,
      product,
      productName: product?.name || raw?.productName || "(name not on file)",
      size: raw?.size ?? null,
      cls, why, evidence,
      deactivated: isDeactivated(product),
    });
  }

  // Newest registration first inside each class: the most recent record is the
  // one a person is most likely to remember and judge.
  for (const c of CLEANUP_CLASSES) {
    byClass[c].sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  }

  const counts = Object.fromEntries(CLEANUP_CLASSES.map((c) => [c, byClass[c].length]));
  const actionableCount = [...ACTIONABLE_CLASSES].reduce((t, c) => t + byClass[c].length, 0);
  return { byClass, counts, actionableCount };
}

/**
 * The retire call for one row, as data. The screen hands this straight to
 * displayRegistrationStore.removeDisplayFact.
 *
 * `slotStores` IS ALWAYS EMPTY, and that is the load-bearing part. removeDisplayFact
 * will clear the display slots it is given, and every actionable row here is
 * actionable BECAUSE a slot contradicts it:
 *   • a REPLACED row's live slot describes the CURRENT display at a different
 *     size — clearing it would erase the real one and re-create the very
 *     duplicate-marker problem #574 just closed;
 *   • a SOLD row's slot is already a tombstone, so there is nothing to clear;
 *   • an OVER row's slot is the matched part, which stays.
 * This screen retires a REGISTER row and never touches a slot.
 */
export function retirePlan(row, hub) {
  return {
    hub,
    product: { id: row.productId, name: row.productName },
    sizeKey: row.sizeKey,
    slotStores: [],
    times: Math.max(1, Number(row.retireQty) || 1),
    // The quantity this decision was MADE against. removeDisplayFact aborts if
    // the row has moved since, so a stale screen cannot retire a surplus that
    // somebody else has already taken — which would carry the legitimate
    // matched record down with it.
    expectQty: Number(row.qty) || 0,
  };
}

/** Stable identity for one retire, so a screen can key and de-duplicate it. */
export const retireKey = (hub, row) => `${hub} ${row.key} ${row.retireQty}`;

/**
 * The one sentence the screen puts above the button, in warehouse language.
 * Retiring never moves stock; it stops a record hiding a unit from the count.
 */
export function retireEffectLine(row) {
  const n = Math.max(1, Number(row.retireQty) || 1);
  return `Retires ${n} display record${n === 1 ? "" : "s"}. No stock moves — the hub simply stops expecting ${n === 1 ? "this pair" : "these pairs"} to be out at a shop, so the next count looks for ${n === 1 ? "it" : "them"} on the shelf.`;
}

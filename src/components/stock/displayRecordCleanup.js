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
//               there are floors showing it. REPORTED, NEVER ACTIONED: a floor
//               at this size explains a unit, it contradicts none, so the
//               surplus is unexplained rather than wrong — the same footing as
//               UNVERIFIED below.
//   GONE        the product record is deleted, or merged away into another.
//               Nothing can sell this pid; the row cannot describe a display
//               anyone is looking after. Actionable.
//   UNVERIFIED  no slot record for this product at all — a registration made
//               before slots existed, or one where no shop was picked. There
//               is NO evidence either way, so it is REPORTED AND NEVER
//               ACTIONABLE. 582 rows live, and offering a button here is
//               exactly how a real display gets counted away. A row whose
//               evidence has ALREADY BEEN SPENT on an earlier retire lands
//               here too, for the same reason: what is left is unexplained.
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
export const ACTIONABLE_CLASSES = new Set(["replaced", "sold", "gone"]);

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
 * Every display slot record for one product at THIS hub, split into the live
 * floors and the tombstones.
 *
 * BOTH ARE HUB-SCOPED. Tombstones were not, on the reasoning that a cleared
 * slot's bookedHub is not worth trusting — but clearDisplaySlot keeps every
 * other field when it tombstones (`{...cur, sizeKey: null}`), so bookedHub
 * survives and is exactly as good as it was. Counting them loose meant a
 * display sold off HUB 2's books added a unit to hub 1's evidence budget, and
 * could justify retiring a hub 1 row that nothing had contradicted.
 * (CodeRabbit.)
 *
 * A tombstone with NO bookedHub at all IS DROPPED, and the first cut had this
 * backwards. It reasoned that keeping it "loses evidence rather than inventing
 * it", so keeping was the safe direction. It is not: counted for whichever hub
 * is asking, ONE departed display enters hub1's budget AND hub2's, so if each
 * hub holds a row for that product the same departure authorises TWO
 * retirements. The second retirement raises expected-on-shelf for a display
 * that may still be standing on a wall — the exact negative-adjustment failure
 * this module is shaped to avoid. Unexplained is unverified, and unverified is
 * never actionable. (CodeRabbit.)
 */
function slotsForProduct(slots, productId, hub) {
  const live = [], tombs = [];
  for (const [store, byPid] of Object.entries(slots || {})) {
    const s = byPid ? byPid[productId] : null;
    if (!s) continue;
    if (slotIsLive(s)) {
      if (s.bookedHub === hub) live.push({ store, ...s });
    } else if (s.bookedHub === hub) {
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

  // ── EVIDENCE IS A BUDGET FOR THE PRODUCT, NOT A FACT EACH ROW MAY RE-READ ──
  // (Property fuzz, 2026-09-07 — it found this and a hand-written fixture never
  // would have.) Each row used to consult the floors on its own, so ONE shop
  // record justified retiring one unit off EVERY other-sized row of the same
  // product: three rows at sizes 3, 7 and 9 with a single floor showing size 10
  // offered three units on the strength of one record.
  //
  // Why that is the dangerous direction and not merely untidy: a display
  // standing at a shop whose slot was never written (582 rows have no slot at
  // all, so untracked shops demonstrably exist) is described by one of those
  // rows. Retiring it because an UNRELATED floor shows a different size takes
  // the register's only trace of a real pair — and offShelf then stops
  // subtracting it, so the next count expects it on the shelf, does not find
  // it, and adjusts a real unit away.
  //
  // So the shop records for a product at a hub are a budget: N records justify
  // retiring N units in total, spent across that product's rows in a fixed
  // order and never re-read. Already-retired units (bumps − qty, summed over
  // the product's rows) come off the budget first, so the budget cannot be
  // re-spent across loads either.
  //
  // OVER is exempt and stays per-row: its bound is the floors showing THAT
  // size right now, which shrinks by itself as units are retired. GONE is
  // exempt because its evidence is the product's absence, not a floor.
  const budgets = new Map();   // productId -> units the floors can still justify
  const spent = new Map();     // productId -> units already retired off its rows
  for (const [key, raw] of Object.entries(register || {})) {
    const split = splitRegisterKey(key);
    if (!split) continue;
    const [pid] = split;
    const q = Number(raw?.qty) || 0;
    // EVERY row, including one already retired to zero. Skipping those (as the
    // first cut did) forgets what they spent, hands the budget back and lets a
    // second row spend the same shop record — the fuzz walked a product to five
    // units retired on three records that way.
    spent.set(pid, (spent.get(pid) || 0) + Math.max(0, (Number(raw?.bumps) || q) - q));
  }
  const budgetFor = (productId) => {
    if (budgets.has(productId)) return budgets.get(productId);
    const { live, tombs } = slotsForProduct(slots, productId, hub);
    const b = Math.max(0, live.length + tombs.length - (spent.get(productId) || 0));
    budgets.set(productId, b);
    return b;
  };
  const takeBudget = (productId, want) => {
    const have = budgetFor(productId);
    const take = Math.max(0, Math.min(want, have));
    budgets.set(productId, have - take);
    return take;
  };

  // Rows are allocated in a FIXED order (by key) so the same world always
  // produces the same answer, whatever order RTDB hands the keys back in.
  const entries = Object.entries(register || {}).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [key, raw] of entries) {
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

    // The budget above already has this product's already-retired units taken
    // off it (bumps − qty, summed over its rows), which is what stops spent
    // evidence being re-offered: qty 2 with ONE tombstone offers 1, that lands,
    // and the next load sees the budget exhausted instead of the same tombstone
    // justifying the last unit — which would walk the row to zero and take a
    // display genuinely standing at an untracked shop.
    // How many units this row may take out of the product's remaining budget.
    // The per-class evidence count is still an upper bound on top of it — a
    // sale can never justify more than the tombstones behind it — so a row is
    // limited by BOTH what its own evidence says and what the product has left.
    const unspent = (evidenceCount) => Math.max(0, Math.min(qty, evidenceCount));

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
      // ── OVER IS REPORTED, NOT ACTIONED, AND THAT IS A CORRECTION ───────────
      // It was actionable at first: "claims 3, one floor shows it, retire 2".
      // The property fuzz made the flaw plain. A floor showing THIS size is
      // evidence FOR a display — it explains one unit — and it contradicts
      // nothing. The surplus units have no shop record of their own at all,
      // which puts them on exactly the same footing as the 582 rows with no
      // slot that this module refuses to touch. Actioning them here while
      // refusing those would be the same guess wearing a different hat, and
      // with untracked shops in the data the surplus may be real displays.
      //
      // So the rule is uniform and stated once: a row is actionable only when
      // a shop record CONTRADICTS it — a tombstone (it left) or a floor at
      // another size (it moved) — never when it is merely unexplained. The
      // surplus is still worth SEEING, so it keeps its own reason line and
      // points at where a human can resolve it.
      const want = qty - sameSize.length;
      if (want > 0) {
        cls = "over";
        retireQty = 0;
        why = `Claims ${qty} on display, but only ${sameSize.length} shop ${sameSize.length === 1 ? "floor shows" : "floors show"} this size. `
          + `Nothing says where the other ${want} went, so they are not offered here — check the walls, or record the shop on Display Registration.`;
      } else {
        cls = "matched"; why = "A shop floor shows this size — the record is right.";
      }
    } else if (live.length) {
      const sizes = [...new Set(live.map((s) => s.size ?? s.sizeKey))].join(", ");
      retireQty = takeBudget(productId, unspent(live.length));
      if (retireQty > 0) {
        cls = "replaced";
        why = `The display for this product is now size ${sizes} — this row is the pair it replaced.`
          + (qty > retireQty ? ` ${qty} are registered here and ${live.length} moved, so only ${retireQty} can be retired.` : "");
      } else {
        cls = "unverified";
        why = `The move to size ${sizes} has already been accounted for. What is left here has no shop on record.`;
      }
    } else if (tombs.length) {
      retireQty = takeBudget(productId, unspent(tombs.length));
      if (retireQty > 0) {
        cls = "sold";
        why = `The display left ${tombs.length === 1 ? "the floor" : `${tombs.length} floors`} and nothing replaced it.`
          + (qty > retireQty ? ` ${qty} are registered here and ${tombs.length} left, so only ${retireQty} can be retired.` : "");
      } else {
        cls = "unverified";
        why = "The display that left has already been accounted for. What is left here has no shop on record.";
      }
    } else {
      cls = "unverified"; why = "No shop was ever recorded for this display — there is no evidence either way.";
    }

    // A NON-ACTIONABLE CLASS CARRIES retireQty 0, structurally. The classes
    // that are only ever reported (over / unverified / matched) used to keep
    // the initial `retireQty = qty`, which is a live number sitting on a row
    // nothing should act on — one caller forgetting to check the class would
    // retire the whole row. The invariant belongs on the data, not on the
    // discipline of every reader. (Property fuzz.)
    if (!ACTIONABLE_CLASSES.has(cls)) retireQty = 0;

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
    // NEVER coerced to 1. It was `Math.max(1, …)`, so a row the classifier had
    // decided to retire NOTHING from (an over-registered row, whose surplus is
    // unexplained rather than contradicted) produced a plan to retire one unit
    // — inventing the exact guess this module refuses to make. The screen only
    // calls this for actionable rows, but a helper must not depend on its
    // caller's discipline for that. (Property fuzz.)
    times: Math.max(0, Number(row.retireQty) || 0),
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


// ─── THE OTHER DIRECTION: A DISPLAY NOBODY REGISTERED ────────────────────────
//
// (Owner ask, 2026-09-07: "so we know which one is not on display as well".)
//
// Everything above judges a REGISTER ROW against the floors. This judges the
// FLOORS against the register, which is a different fault with a different
// consequence:
//
//   • a stale ROW makes the count expect too FEW on the shelf;
//   • an unregistered FLOOR leaves the register — the auditable record of what
//     is on our walls — with a hole in it.
//
// THE COUNT IS NOT AT RISK HERE, and saying otherwise would be scaremongering:
// offShelf.js reads live display SLOTS as its first and most trusted source
// (they are store-labelled), so an unregistered display is already subtracted
// from the hub's expected-on-shelf. What it is missing from is the REGISTER —
// the list Display Registration manages, where the style code and the label
// capture live, and what the count card names when it says "on display at
// Marathon PE".
//
// HOW THEY HAPPEN, and why there are 52 of them: a display REFILL writes the
// slot and no register row (App.jsx setDisplayRefillStatus → setDisplaySlot).
// Every one measured live carries source "display_refill". Staff could not fix
// them either — recordDisplayFact decided "already registered" from the SLOT
// alone, so the card looked at the live slot, said the work was done and wrote
// nothing. That guard is fixed in the same change as this.
//
// REGISTERING ONE MOVES NO STOCK. recordDisplayFact on an existing pair records
// the FACT only (no movement) — the unit was booked when it was received. So
// this direction is the safe one: the worst case of a wrong registration is a
// row that this screen's other half will then offer to retire.

/**
 * Live display slots with no register row behind them.
 *
 * @param slots        /settings/displaySlots
 * @param registerByHub { hub: registerNode } — every hub that keeps a register
 * @param productsById  catalogue (Map or object), UNFILTERED
 * @param hubs          the hubs that HAVE a register; a slot booked anywhere
 *                      else is reported with that named as the reason rather
 *                      than silently dropped
 * → [{ store, productId, productName, product, size, sizeKey, bookedHub,
 *      source, at, reason, registeredSizes }]
 */
export function findUnregisteredDisplays({ slots, registerByHub, productsById, hubs = ["hub1", "hub2"] }) {
  const get = (pid) =>
    productsById && typeof productsById.get === "function" ? productsById.get(pid) : (productsById || {})[pid];
  const out = [];
  for (const [store, byPid] of Object.entries(slots || {})) {
    for (const [productId, slot] of Object.entries(byPid || {})) {
      if (!slotIsLive(slot)) continue;
      const hub = slot.bookedHub;
      const register = (registerByHub || {})[hub];
      if (!hubs.includes(hub) || !register) {
        out.push({
          store, productId, product: get(productId) || null,
          productName: get(productId)?.name || slot.productName || "(name not on file)",
          size: slot.size, sizeKey: slot.sizeKey, bookedHub: hub, source: slot.source, at: slot.at,
          reason: `Booked at ${hub || "no hub"}, which keeps no display register.`,
          registeredSizes: [], registerable: false,
        });
        continue;
      }
      const exact = register[`${productId}__${slot.sizeKey}`];
      if ((Number(exact?.qty) || 0) > 0) continue;                 // registered and agrees
      // Registered at ANOTHER size? That is the other tab's business (the row
      // is "replaced" there), so it is named here but not offered — registering
      // it would add a SECOND display fact for one physical pair.
      const otherSizes = Object.keys(register)
        .filter((k) => k.startsWith(`${productId}__`) && (Number(register[k].qty) || 0) > 0)
        .map((k) => k.slice(k.lastIndexOf("__") + 2));
      const product = get(productId) || null;
      out.push({
        store, productId, product,
        productName: product?.name || slot.productName || "(name not on file)",
        size: slot.size, sizeKey: slot.sizeKey, bookedHub: hub, source: slot.source, at: slot.at,
        registeredSizes: otherSizes,
        reason: otherSizes.length
          ? `Registered at size ${otherSizes.join(", ")}, not ${slot.size}. Fix the size on the Display Records tab instead — registering here would claim a second display.`
          : "On a shop floor, but the display register has never heard of it.",
        registerable: otherSizes.length === 0,
      });
    }
  }
  out.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  return out;
}

/** Stable identity for one registration, so a screen applies it at most once. */
export const registerKey = (r) => `${r.store} ${r.productId} ${r.sizeKey} ${r.bookedHub}`;

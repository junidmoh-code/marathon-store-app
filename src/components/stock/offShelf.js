// ─── OFF-SHELF UNITS — what the hub's books hold that its SHELF does not ─────
// (Owner spec 2026-08-12, count-integrity work.)
//
// The count bug in one line: the counter is shown the BOOKED total, but some
// booked units are not on the shelf in front of them — displays out at shops,
// ready orders awaiting collection at shops — so an honest counter adjusts
// them away and the system destroys stock that physically exists. This module
// computes, per hub stock cell, the off-shelf units the system KNOWS about:
//
//     booked total − known off-shelf = EXPECTED ON SHELF
//
// Sources, in order of confidence:
//   1. DISPLAY SLOTS (displaySlots.js) — store-labelled, size-current.
//   2. LEGACY REGISTER ROWS (settings/hubSneakerCount/register/{hub}) — the
//      806 pre-slot registrations that carry NO store. Counted only where no
//      slot already explains the same cell (a slot written by the new
//      registration flow shares its register row — max(), not sum, or the one
//      physical display would count twice). Labelled "shop unknown" honestly.
//   3. READY ORDERS — footwear orders at status "ready": the pair was sent to
//      the shop but the hub cell is only deducted when the POS sells it
//      (footwear_sells_from_hub), so it is booked here and physically there.
//
// WHAT CANNOT BE INCLUDED, BY CONSTRUCTION: layby pulls. /laybyPulls carries
// only an itemCount — no productId, no size — so those units (137 at hub1 when
// this was built) can never be attributed to a cell. The count view says so at
// hub level rather than pretending the numbers are complete.
//
// HELD SHIPMENT LINES ARE DELIBERATELY ABSENT: with the hold lane on
// (stockHoldStore.js) an in-flight refill is parked at stock/in_transit and is
// NOT in the hub's booked number at all — nothing to subtract. With the lane
// off, an in-flight refill is booked here and physically in a box, and nothing
// in the data says whether it has arrived; that blind spot is exactly why the
// hold lane exists.

import { ref, child, get } from "firebase/database";
import { database } from "../../firebase";
import { isFootwearProduct } from "./missingFootwearCore";
import { stockSizeKey } from "../../utils/sizeKey";
import { loadDisplaySlots, slotsForCell } from "./displaySlots";
import { HUB_COUNT_ROOT } from "../../config/hubSneakerCount";

const one = async (path) => (await get(child(ref(database), path))).val();

/**
 * One-shot load of every off-shelf source for a hub, frozen by the caller like
 * the stock snapshot. `productsById` is the catalogue Map — needed to keep the
 * ready-order sweep to footwear (clothing deducts at send; it is never
 * off-shelf-booked).
 *
 * Returns { slots, register, readyCells, laybyNote }:
 *   slots      — the whole /settings/displaySlots node
 *   register   — this hub's register rows { "pid__sizeKey": record }
 *   readyCells — { "pid::sizeKey": [{ qty, destShop, orderId }] }
 *   laybyItems — outstanding layby-pulled units stored at this hub (number;
 *                per-cell attribution impossible, see header)
 */
export async function loadOffShelfSources(hub, productsById) {
  // ALL FOUR SOURCES OR NOTHING (CodeRabbit, PR #347): a swallowed single-
  // source failure would present partial data as the complete off-shelf
  // picture, and a counter would adjust away exactly the units the missing
  // source knew about. A failed load REJECTS; the count views block counting
  // and say so, rather than degrading silently to booked totals.
  const [slots, register, orders, pulls] = await Promise.all([
    loadDisplaySlots(),
    one(`${HUB_COUNT_ROOT}/register/${hub}`),
    one("orders"),
    one("laybyPulls"),
  ]);

  const readyCells = {};
  for (const [orderId, o] of Object.entries(orders || {})) {
    if (!o || o.status !== "ready") continue;
    if ((o.placedAtHub || o.hub) !== hub) continue;
    const p = productsById && productsById.get ? productsById.get(o.productId) : null;
    if (!p || !isFootwearProduct(p)) continue;
    const sizeKey = stockSizeKey(String(o.sentSize ?? o.size ?? ""));
    if (!o.productId || sizeKey === "_") continue;
    const key = `${o.productId}::${sizeKey}`;
    (readyCells[key] = readyCells[key] || []).push({
      qty: Number(o.qty) || 1,
      destShop: o.destShop || null,
      orderId,
    });
  }

  let laybyItems = 0;
  for (const p of Object.values(pulls || {})) {
    if (p && p.storageHub === hub && p.status === "sentToStore") laybyItems += Number(p.itemCount) || 0;
  }

  return { slots: slots || {}, register: register || {}, readyCells, laybyItems };
}

// ── PURE: the per-cell breakdown ─────────────────────────────────────────────

/**
 * Off-shelf units for ONE hub stock cell.
 *
 * @returns { total, parts: [{ qty, label, verified }] }
 *   `verified: false` marks units the counter cannot check (a legacy display
 *   with no store on record) — the view must say so, never present the shelf
 *   number as simple.
 */
export function offShelfForCell({ hub, productId, sizeKey, sources, labelOf = (s) => s }) {
  const parts = [];
  if (!sources) return { total: 0, parts };

  // 1. Store-labelled display slots.
  const live = slotsForCell(sources.slots, { hub, productId, sizeKey });
  for (const { store } of live) {
    parts.push({ qty: 1, label: `on display at ${labelOf(store)}`, verified: true });
  }

  // 2. Legacy register rows — only the remainder a slot does not already
  // explain. A registration made through the NEW flow writes both the register
  // row and a slot for the same physical display; summing them would double it.
  const reg = sources.register ? sources.register[`${productId}__${sizeKey}`] : null;
  const regQty = reg ? Number(reg.qty) || 0 : 0;
  const unexplained = Math.max(0, regQty - live.length);
  if (unexplained > 0) {
    parts.push({
      qty: unexplained,
      label: `registered as a display (shop unknown)`,
      verified: false,
    });
  }

  // 3. Ready orders awaiting collection.
  for (const r of (sources.readyCells && sources.readyCells[`${productId}::${sizeKey}`]) || []) {
    parts.push({
      qty: r.qty,
      label: `awaiting collection${r.destShop ? ` at ${labelOf(r.destShop)}` : ""}`,
      verified: true,
    });
  }

  return { total: parts.reduce((t, p) => t + p.qty, 0), parts };
}

/** "12 booked · 1 on display at Marathon PE · expect 11 here" — the plain-
 *  warehouse-language line the count card shows. Pure so it is pinned by test. */
export function shelfLine({ booked, offShelf }) {
  const expected = booked - offShelf.total;
  const bits = [`${Math.max(0, booked)} booked`];
  for (const p of offShelf.parts) bits.push(`${p.qty} ${p.label}`);
  bits.push(`expect ${Math.max(0, expected)} here`);
  return bits.join(" · ");
}

/** Expected-on-shelf for a cell, floored at zero for display; the caller keeps
 *  the raw value for the "books disagree" warning when it goes negative. */
export function expectedOnShelf(booked, offShelf) {
  return Number(booked) - (offShelf ? offShelf.total : 0);
}

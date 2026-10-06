// ─── DROPPED RETURN REPAIR — THE PLAN (PURE) ─────────────────────────────────
//
// A dropped return is a return, exchange return, refund or lay-by cancel the
// POS recorded — the customer was credited or refunded — for which no stock
// movement put the unit back anywhere (scripts/sections/dropped-returns.mjs
// finds them). This plans ONE corrective restock per dropped line, by the
// same rule the POS now applies to every return:
//
//   footwear   → the hub the ORIGINAL SALE deducted from, when that hub is in
//                the section of the shop that took the return;
//   everything else → the shop that took the return.
//
// It refuses to guess. Set aside, never forced:
//   • footwear whose original sale's hub cannot be found, or is not a hub on
//     the returning shop's side of the wall;
//   • a line whose product record no longer exists and has no known survivor
//     (the movement rule requires the product to exist);
//   • a shop the registry does not know.
//
// No I/O. The runner applies the plan; the same function plans the dry run.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const reg = require("../../functions/lib/network-registry.cjs");

export const REPAIR_REASON = "sections-dropped-return-repair";
export const LOG_ROOT = "sections_repair/dropped_returns";

const enc = (s) => String(s ?? "_").replace(/\./g, "_");
export const sizeKeyOf = (size) => (size === null || size === undefined || size === "" ? "_" : enc(String(size).trim()));
// Record ids, product ids and encoded sizes hold no character RTDB forbids in
// a key; the replace is the guarantee.
export const logKeyFor = (d) => `${d.recordId}:${d.productId}:${sizeKeyOf(d.size)}`.replace(/[.$#[\]/]/g, "_");
export const repairMovementId = (d) => `repair:dropped-return:${logKeyFor(d)}`;

/**
 * @param dropped    [{ recordId, storeId, productId, size, qty, kind, category, soldFrom, originalSaleId, at, name }]
 * @param products   { productId: true | { survivor } | null }  — does the product exist; if not, its merge survivor
 * @param log        the repair log node (may be null)
 */
export function planDroppedRepair({ dropped = [], products = {}, log = {}, registry = null } = {}) {
  const R = registry || reg.SEED_REGISTRY;
  const out = { restocks: [], setAside: [], alreadyRepaired: [] };
  for (const d of dropped) {
    const short = Math.max(Number(d.soldShortfall) || 0, 0);
    const base = { recordId: d.recordId, originalSaleId: d.originalSaleId || null, kind: d.kind, storeId: d.storeId, productId: d.productId, size: d.size, sizeKey: sizeKeyOf(d.size), qty: Number(d.qty) || 0, name: d.name || d.productId, at: d.at };
    const key = logKeyFor(d);
    const entry = (log || {})[key];
    if (entry && entry.status === "done") { out.alreadyRepaired.push({ ...base, to: entry.to }); continue; }
    if (!(base.qty > 0)) { out.setAside.push({ ...base, why: "the dropped line has no quantity" }); continue; }
    // A sale the books could not fully cover (it sold with the cell short):
    // how much of THIS return is covered depends on the sale's quantity and on
    // what was already returned against it, which this list does not carry.
    // Not guessed — set aside for a person.
    if (short > 0) { out.setAside.push({ ...base, why: `the original sale was short by ${short} when it sold — how much of this return is covered needs a person to decide` }); continue; }
    const shop = reg.locationOf(R, d.storeId);
    if (!shop || shop.type !== "store") { out.setAside.push({ ...base, why: `the return was taken at a store the registry does not know (${d.storeId ?? "none"})` }); continue; }

    // The product the unit is booked under. A merged-away product's unit
    // belongs to its survivor; a product that is simply gone cannot be booked.
    const p = products[d.productId];
    let productId = d.productId;
    if (!p) { out.setAside.push({ ...base, why: "the product record no longer exists and no merge survivor is recorded" }); continue; }
    if (p !== true) {
      if (!p.survivor) { out.setAside.push({ ...base, why: "the product record no longer exists and no merge survivor is recorded" }); continue; }
      productId = p.survivor;
    }

    let to;
    if (d.category === "Footwear") {
      const hub = d.soldFrom ? reg.locationOf(R, d.soldFrom) : null;
      if (!hub) { out.setAside.push({ ...base, why: "footwear, and the hub the original sale deducted from was not found" }); continue; }
      if (hub.type !== "hub" || hub.section !== shop.section) {
        out.setAside.push({ ...base, why: `footwear, and the original sale deducted ${hub.name}, which is not a hub in the returning shop's section` });
        continue;
      }
      to = hub.id;
    } else {
      to = shop.id;
    }
    out.restocks.push({ ...base, productId, bookedUnder: productId === d.productId ? null : d.productId, to, rule: d.category === "Footwear" ? "footwear: the hub the sale deducted" : "the shop that took the return", logKey: key, movementId: repairMovementId(d) });
  }
  return out;
}

// The one multi-path update for ONE restock: the cell, a NEW movement tagged
// with the reason and linked to the original record, and the log entry.
export function buildRestockUpdate(r, { cell, nowIso, actor }) {
  const cur = cell && typeof cell.qty === "number" ? cell.qty : 0;
  // An arrival credits from max(cell, 0): a legacy negative is not "paid off"
  // by a restock (the no-negative-cells rule every other arrival follows).
  const next = Math.max(cur, 0) + r.qty;
  return {
    [`stock/${r.to}/${r.productId}/${r.sizeKey}`]: { ...(cell || {}), qty: next, v: (Number(cell?.v) || 0) + 1, lastType: "return", mv: r.movementId, updatedAt: nowIso, updatedBy: actor },
    [`stock_movements/${r.movementId}`]: {
      type: "return", productId: r.productId, size: r.sizeKey, qty: r.qty, from: null, to: r.to,
      reason: REPAIR_REASON, actor, ts: nowIso,
      link: { saleId: r.recordId, originalSaleId: r.originalSaleId, ...(r.bookedUnder ? { originalProductId: r.bookedUnder } : {}) },
      before: { [r.to]: cur }, after: { [r.to]: next },
    },
    [`${LOG_ROOT}/${r.logKey}`]: {
      status: "done", recordId: r.recordId, originalSaleId: r.originalSaleId, kind: r.kind, storeId: r.storeId,
      productId: r.productId, ...(r.bookedUnder ? { originalProductId: r.bookedUnder } : {}), size: r.sizeKey, qty: r.qty,
      to: r.to, rule: r.rule, repairMovementId: r.movementId, at: nowIso, by: actor,
    },
  };
}

export function unitsByLocation(restocks) {
  const out = {};
  for (const r of restocks) out[r.to] = (out[r.to] || 0) + r.qty;
  return out;
}

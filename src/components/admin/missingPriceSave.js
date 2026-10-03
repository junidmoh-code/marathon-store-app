// ── THE MISSING-PRICES SAVE — one path for every screen that fills a price ──
// Used by Admin › Missing prices AND the New Arrivals Ready card (Junid, 3 Oct:
// "the SAME code path, no new write path"). Validates exactly as the Missing
// prices editor does, writes only the fields that are missing, through
// applyPriceBatch (who/when/from/to recorded under a batchId; a retail price on
// special is refused). Once both prices exist the product leaves Missing prices.
import { buildUpdates, validatePrices, needsCost, needsRetail } from "../../utils/missingPrices";
import { asStoredPrice } from "../../utils/priceBatch";
import { applyPriceBatch } from "./priceStore";

/**
 * → { ok: true, count } | { ok: false, error, needsConfirm? }.
 * `confirmed` skips the "retail below cost" question once the user said yes.
 */
export async function saveMissingPrice(product, costDraft, retailDraft, { label, confirmed = false, apply = applyPriceBatch } = {}) {
  // A price that already exists stands in for an empty draft — exactly as the
  // Missing prices editor pre-fills it — so "retail below cost" is still asked.
  const cd = String(costDraft ?? "").trim() === "" && !needsCost(product) ? String(product.stockPrice) : costDraft;
  const rd = String(retailDraft ?? "").trim() === "" && !needsRetail(product) ? String(product.retailPrice) : retailDraft;
  const v = validatePrices(product, cd, rd);
  if (!v.ok && !(v.needsConfirm && confirmed)) return { ok: false, error: v.error, needsConfirm: !!v.needsConfirm };
  const updates = buildUpdates(product, cd, rd); // only the MISSING fields
  if (!Object.keys(updates).length) return { ok: true, count: 0 };
  const from = {}, to = {};
  for (const field of Object.keys(updates)) { from[field] = asStoredPrice(product[field]); to[field] = updates[field]; }
  const res = await apply({
    action: "single_edit",
    label: label || `Missing Prices: ${product.name || product.id}`,
    lines: { [product.id]: { name: product.name || "", from, to } },
  });
  return res.ok ? { ok: true, count: res.count } : { ok: false, error: res.message || "Save failed" };
}

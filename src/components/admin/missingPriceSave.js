// ── THE MISSING-PRICES SAVE ──────────────────────────────────────────────────
// Admin › Missing prices. Validates exactly as the Missing prices editor does
// and picks only the fields that are missing; the WRITE is the one product
// price save (productPriceSave.saveProductPrices → applyPriceBatch
// "single_edit": who/when/from/to recorded under a batchId; a retail price on
// special is refused). Once both prices exist the product leaves Missing prices.
import { buildUpdates, validatePrices, needsCost, needsRetail } from "../../utils/missingPrices";
import { applyPriceBatch } from "./priceStore";
import { saveProductPrices } from "./productPriceSave";

/**
 * → { ok: true, count } | { ok: false, error, needsConfirm? }.
 * `confirmed` skips the "retail below cost" question once the user said yes.
 */
export async function saveMissingPrice(product, costDraft, retailDraft, { label, confirmed = false, costOnly = false, apply = applyPriceBatch } = {}) {
  // A price that already exists stands in for an empty draft — exactly as the
  // Missing prices editor pre-fills it — so "retail below cost" is still asked.
  const cd = String(costDraft ?? "").trim() === "" && !needsCost(product) ? String(product.stockPrice) : costDraft;
  const rd = String(retailDraft ?? "").trim() === "" && !needsRetail(product) ? String(product.retailPrice) : retailDraft;
  // costOnly: only the stock price is set; a missing retail
  // price is not asked for and never written.
  // (An EXISTING retail price still takes part in the "retail below cost" check.)
  const v = validatePrices(product, cd, rd, { costOnly });
  if (!v.ok && !(v.needsConfirm && confirmed)) return { ok: false, error: v.error, needsConfirm: !!v.needsConfirm };
  const updates = buildUpdates(product, cd, costOnly ? "" : rd); // only the MISSING fields
  if (!Object.keys(updates).length) return { ok: true, count: 0 };
  const drafts = Object.fromEntries(Object.entries(updates).map(([field, v]) => [field, String(v)]));
  // Already validated (and any "retail below cost" answered) above.
  const res = await saveProductPrices(product, drafts, { label: label || `Missing Prices: ${product.name || product.id}`, confirmed: true, apply });
  return res.ok ? { ok: true, count: res.count } : { ok: false, error: res.error };
}

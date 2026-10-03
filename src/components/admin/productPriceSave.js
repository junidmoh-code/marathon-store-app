// ── THE PRODUCT PRICE EDIT — one save for every screen that edits a price ────
// The admin product page's Stock / Retail price fields, the Marketing card's
// Edit price modal, the Missing prices editor (its write) and the New Arrivals
// card all save through saveProductPrices — ONE copy of "what changed, is it a
// real price, is retail below cost, write it". The write itself is the guarded
// batch path (priceStore.applyPriceBatch, action "single_edit"): who / when /
// from / to recorded under a batchId in /price_history in the same atomic
// update, a retail price on special refused — so POS and the Shopify price
// sync see exactly what they see for any admin edit.
//
// Drafts are the text in the fields: { stockPrice?, retailPrice? }. A field
// left out is not touched. "" clears the price (the admin page's explicit
// clear); anything else must be a number above 0. A value equal to the stored
// one is not written. Retail below the (resulting) stock price needs a yes.
import { applyPriceBatch } from "./priceStore";
import { asStoredPrice, PRICE_FIELDS } from "../../utils/priceBatch";

const WORD = { stockPrice: "Stock", retailPrice: "Retail" };

/** What a save would write: { ok, from, to, belowCost, belowCostMessage } or { ok: false, error }. Pure. */
export function planProductPriceEdit(product, drafts = {}) {
  const from = {};
  const to = {};
  for (const field of PRICE_FIELDS) {
    if (!drafts || !(field in drafts) || drafts[field] === undefined) continue;
    const cur = asStoredPrice(product?.[field]);
    const t = String(drafts[field] ?? "").trim();
    const next = t === "" ? null : Number(t);
    if (next !== null && (!Number.isFinite(next) || next <= 0)) {
      return { ok: false, error: `${WORD[field]} price must be a number above 0 (or empty to clear).` };
    }
    if (next === cur) continue;
    from[field] = cur;
    to[field] = next;
  }
  const cost = "stockPrice" in to ? to.stockPrice : asStoredPrice(product?.stockPrice);
  const retail = "retailPrice" in to ? to.retailPrice : asStoredPrice(product?.retailPrice);
  const belowCost = Object.keys(to).length > 0 && cost !== null && retail !== null && retail < cost;
  return {
    ok: true, from, to, belowCost,
    belowCostMessage: belowCost ? `Retail Price (R${retail}) is lower than Stock Price (R${cost}). Continue?` : null,
  };
}

/**
 * Save one product's prices. `product` carries id, name and the CURRENT
 * prices (the audit's `from`). → { ok: true, count, batchId? } |
 * { ok: false, error, code?, needsConfirm? }. Never throws on a refusal.
 * `confirmed` answers the "retail below cost" question with yes.
 */
export async function saveProductPrices(product, drafts, { label, confirmed = false, apply = applyPriceBatch } = {}) {
  const plan = planProductPriceEdit(product, drafts);
  if (!plan.ok) return { ok: false, error: plan.error };
  if (!Object.keys(plan.to).length) return { ok: true, count: 0 };
  if (plan.belowCost && !confirmed) return { ok: false, needsConfirm: true, error: plan.belowCostMessage };
  const res = await apply({
    action: "single_edit",
    label: label || `Edit: ${product.name || product.id}`,
    lines: { [product.id]: { name: product.name || "", from: plan.from, to: plan.to } },
  });
  if (!res.ok) return { ok: false, code: res.code, error: res.message || "Save failed" };
  return { ok: true, count: res.count, batchId: res.batchId, ...(res.specialsCheckSkipped ? { specialsCheckSkipped: true } : {}) };
}

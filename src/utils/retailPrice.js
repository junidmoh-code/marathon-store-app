// ─── THE RETAIL PRICE A CARD SHOWS ───────────────────────────────────────────
//
// One reader for every assistant surface that prints a price or "No price set"
// (docs/ASSISTANT-NO-PRICE-SET.md). The canonical field is what the price
// editor and Missing Prices write: products/{id}/retailPrice, a number
// (src/utils/priceBatch.js). A legacy `price` is a fallback only. No product
// carries one today (16 Nov 2026 census), but a record that did must never read
// as unpriced while it is sellable.
//
// A price is a finite number above zero. A numeric string ("300") is accepted
// because an import or a hand edit can write one; anything else is "not set".

export const RETAIL_PRICE_FIELDS = Object.freeze(["retailPrice", "price"]);

function asPrice(v) {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v)) {
    const n = Number(v);
    return n > 0 ? n : null;
  }
  return null;
}

/** The product's retail price in rand, or null when it has none. */
export function retailPriceOf(product) {
  if (!product || typeof product !== "object") return null;
  for (const field of RETAIL_PRICE_FIELDS) {
    const n = asPrice(product[field]);
    if (n !== null) return n;
  }
  return null;
}

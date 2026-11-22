// ─── MISSING PRODUCTS — WHERE ITS LINKS LEAD ──────────────────────────────────
// Missing Products left Inventory Health on 22 Nov 2026 and is its own screen.
// Any link that names it — the new one, or the old address under Inventory
// Health — opens that screen. Pure, so the redirect is testable without App.jsx.
export const MISSING_PRODUCTS_ROLE = "missing_products";
export const MISSING_PRODUCTS_HASH = "#missing-products";

/** Is this URL fragment a link to Missing Products, old form or new? */
export function isMissingProductsHash(hash) {
  const h = String(hash || "").toLowerCase().replace(/\/+$/, "");
  return /^#\/?((inventory-)?health\/)?missing[-_]?products$/.test(h);
}

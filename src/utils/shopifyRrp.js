// ─── RRP: the struck-through "market retail" price shown on the website ──────
//
// Junid, 13 Nov 2026: every product on the Shopify store shows a struck-through
// RRP above the selling price, labelled "RRP" (never "Was"), with the % off.
// Junid's trade buyers retail his stock at 200–250% over his price, so the RRP
// states real market retail value.
//
// THE RRP IS DERIVED, NEVER STORED. The app keeps exactly one price
// (/products/{pid}/retailPrice), which the till and POS read. The RRP exists
// only on Shopify, as each variant's compareAtPrice, and is recomputed from the
// app price every time the reconciler pushes. The only stored input is the
// per-product discount choice, /shopify_publish/{pid}/rrpDiscountPct (65 or
// 70, absent = 65), set by a tap chip in Shopify Publishing.
//
// This file is imported by the browser (the chip's preview) AND by the Mac
// mini's reconciler (scripts/shopify/priceSync.mjs), so the preview and the
// website can never disagree.

/** The discount choices the chip offers. The first is the default. */
export const RRP_DISCOUNT_CHOICES = Object.freeze([65, 70]);
export const RRP_DEFAULT_DISCOUNT_PCT = RRP_DISCOUNT_CHOICES[0];

/**
 * The stored choice → a valid discount percentage. Anything that is not one of
 * the offered choices (absent, a typo in the console, a string) is the default:
 * a bad value must never produce a strange RRP on the website.
 */
export function rrpDiscountPctOf(node) {
  const n = Number(node?.rrpDiscountPct);
  return RRP_DISCOUNT_CHOICES.includes(n) ? n : RRP_DEFAULT_DISCOUNT_PCT;
}

/**
 * The RRP for a selling price, in whole rands, or null when there is no usable
 * price (missing, zero, negative, non-numeric) — then no RRP is shown at all.
 *
 *   minimum = price / (1 − pct/100)        (65% → price / 0.35)
 *   RRP     = the smallest number ending in 99 that is ≥ minimum
 *
 * So the RRP is always above the price and the saving is always at least
 * `pct` percent. Worked in integer cents so no float drift can tip a value onto
 * the wrong side of a boundary (R199 → R599, R629 → R1,799).
 */
export function rrpFor(price, discountPct = RRP_DEFAULT_DISCOUNT_PCT) {
  if (price == null || price === "" || typeof price === "boolean") return null;
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return null;
  const pct = RRP_DISCOUNT_CHOICES.includes(Number(discountPct)) ? Number(discountPct) : RRP_DEFAULT_DISCOUNT_PCT;
  const keep = 100 - pct; // the selling price is `keep`% of the RRP
  const priceCents = Math.round(n * 100);
  // The smallest whole-rand RRP with RRP × keep% ≥ price, i.e. RRP*keep ≥ priceCents.
  const minRands = Math.ceil(priceCents / keep);
  // Up to the next number ending in 99: 568 → 599, 599 → 599, 600 → 699.
  return Math.ceil((minRands - 99) / 100) * 100 + 99;
}

/**
 * The saving the website shows, as a whole percentage ROUNDED DOWN so the
 * badge never claims more than the real saving. null when there is none.
 */
export function rrpOffPct(price, rrp) {
  const p = Math.round(Number(price) * 100);
  const r = Math.round(Number(rrp) * 100);
  if (!Number.isFinite(p) || !Number.isFinite(r) || p <= 0 || r <= p) return null;
  return Math.floor(((r - p) * 100) / r);
}

/** "R1,799" — the chip's preview format (whole rands, thousands comma). */
export function formatRands(n) {
  return `R${Math.round(Number(n)).toLocaleString("en-US")}`;
}

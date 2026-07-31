// ─── SIZE ORDERING for the hub refill queues ──────────────────────────────────
// Extracted so the TEST can import the real implementation. It previously lived
// inline in Hub2RefillQueue.jsx while the test reimplemented it, which meant every
// assertion could pass while the component behaved differently. (CodeRabbit #291.)
//
// Letters keep their historical ranks — clothing is these queues' day job.
// Numeric sizes (shoes, and clothing WAIST sizes) used to tie at 99 and render in
// arbitrary order; they now sort numerically after the letters.
export const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL"];

// A FULL numeric token only. parseFloat alone accepts "7W" and "5_5_extra" and
// would drop them into the numeric bucket at 7 and 5.5, silently interleaving
// junk with real sizes instead of parking it at the end. (CodeRabbit #291.)
const NUMERIC_SIZE = /^\d+(?:\.\d+)?$/;

export function sizeRank(s) {
  const raw = String(s ?? "");
  const i = SIZE_ORDER.indexOf(raw.toUpperCase());
  if (i >= 0) return i;
  const token = raw.replace("_", ".");          // "5_5" → "5.5", the RTDB key form
  if (!NUMERIC_SIZE.test(token)) return 999;    // unknown sorts last, never first
  return 100 + Number.parseFloat(token);
}

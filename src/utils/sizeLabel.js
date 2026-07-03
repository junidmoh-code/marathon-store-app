// ─── CLOTHING SIZE DISPLAY LABELS ────────────────────────────────────────────
// Clothing tops are stored as letters (S, M, L, XL, XXL, XXXL, 4XL). This maps
// each to a lowercase "letter-number" DISPLAY label (s-30, m-32, …, 4xl-42).
//
// DISPLAY ONLY. The raw stored value ("M") still flows into every stock cell,
// barcode, order and insights key — call formatSize() only at render leaves,
// never on a value used as an object key, a write, or a lookup.
//
// Footwear (numeric shoe sizes) and any bottoms/waist numbers pass through
// unchanged; unknown tokens pass through untouched so nothing ever renders blank.
const CLOTHING_SIZE_LABELS = {
  XS:   "xs-28",
  S:    "s-30",
  M:    "m-32",
  L:    "l-34",
  XL:   "xl-36",
  XXL:  "xxl-38",
  XXXL: "xxxl-40",
  "4XL": "4xl-42",
};

export function formatSize(size) {
  if (size == null || size === "") return size;
  const key = String(size).trim().toUpperCase();
  return CLOTHING_SIZE_LABELS[key] || size;
}

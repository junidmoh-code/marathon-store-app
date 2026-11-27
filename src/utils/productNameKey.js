// "Same product name" — the page's copy of functions/lib/product-rename.cjs
// nameKey/sameName (the bundle cannot import that CommonJS file). Pinned
// equal by productNameKey.test.js. Trimmed, inner whitespace collapsed,
// case-insensitive: the Gucci twin differed only by a trailing space.
export function nameKey(s) {
  return String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}
export function sameName(a, b) { return nameKey(a) !== "" && nameKey(a) === nameKey(b); }

// ─── BRAND SEARCH — typing a brand name filters by brand ─────────────────────
//
// The sneaker wall (2026-10-19) dropped the brand dropdown, so the search box
// has to do its job: "nike" shows Nike, "new balance 550" shows New Balance
// products matching "550". Fuse alone could not — it indexes name + category,
// and a shoe whose name doesn't carry its brand ("Air Force 1 Low QS Kobe")
// was invisible to a brand query.
//
// The brand set comes FROM THE DATA (product.brand), like the dropdown it
// replaces. A product with no recognised brand still counts when the brand is
// a whole word of its name, so an unbranded "Puma Suede" is not lost to a
// "puma" query that used to find it by name.

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Every brand in the pool, keyed by its normalised spelling.
export function buildBrandIndex(products) {
  const keys = new Set();
  for (const p of products || []) {
    const k = norm(p?.brand);
    if (k) keys.add(k);
  }
  // Longest first, so "new balance" wins over a hypothetical "new".
  return [...keys].sort((a, b) => b.length - a.length);
}

// The brand a query names, and what is left of the query after it — or null
// when the query does not start with a known brand. The brand must be the
// whole query or be followed by a space: "nikes" is a name search, not Nike.
export function matchBrandQuery(index, q) {
  const ql = norm(q);
  if (!ql) return null;
  for (const key of index || []) {
    if (ql === key) return { key, rest: "" };
    if (ql.startsWith(key + " ")) return { key, rest: ql.slice(key.length + 1) };
  }
  return null;
}

// Does this product belong to the brand? Its own brand field, or — only when
// it has none — the brand as a whole word of its name.
export function productInBrand(p, key) {
  const own = norm(p?.brand);
  if (own) return own === key;
  return new RegExp(`(^|[^a-z0-9])${escapeRe(key)}([^a-z0-9]|$)`).test(norm(p?.name));
}

// ─── MERGED PRODUCTS — the redirect contract, client side ────────────────────
// When two records turn out to be one physical product, the server-side merge
// (functions/lib/product-merge.cjs) stamps the losing record with `mergedInto`
// and leaves everything else on it intact. This module is the client's half of
// that contract:
//
//   • A product carrying `mergedInto` is INVISIBLE — gone from search, gone
//     from every list, never selectable. `filterMergedProducts` runs at the ONE
//     place the app builds its products array (useProducts in App.jsx), so no
//     individual surface has to remember to exclude it.
//   • But its id keeps WORKING — it is stamped on old sales, laybys, movements
//     and barcode rows. `followMerge` chases the pointer (with a cycle guard,
//     because data can be wrong) so any lookup by a merged-away id lands on the
//     survivor.

export function isMergedAway(p) {
  return !!(p && typeof p === "object" && p.mergedInto);
}

/** The visible catalogue: every product that has not been merged away. */
export function filterMergedProducts(products) {
  return (products || []).filter((p) => !isMergedAway(p));
}

/**
 * Resolve an id to the record that answers for it today.
 *
 * `byId` is a map/object of ALL products including merged-away ones. Returns
 * the survivor record after following any chain of pointers, or the deepest
 * record found if a pointer dangles (a half-deleted survivor must not turn a
 * resolvable sale into null), or null when the id was never a product.
 */
export function followMerge(byId, id) {
  const lookup = (k) => (byId instanceof Map ? byId.get(k) : (byId || {})[k]);
  let cur = lookup(id);
  if (!cur) return null;
  const seen = new Set([id]);
  while (isMergedAway(cur)) {
    const nextId = cur.mergedInto;
    if (seen.has(nextId)) return cur;       // cycle — bad data, stop rather than spin
    const next = lookup(nextId);
    if (!next) return cur;                  // dangling pointer — the old record still renders
    seen.add(nextId);
    cur = next;
  }
  return cur;
}

// Which insights_log events belong to this product (the product page's
// "Last sold … · N orders" line).
//   · its own productId — always;
//   · otherwise by name — this name or any it had before a rename
//     (previousNames, setProductName) — but only for events with no id, or
//     with the id of a record that no longer exists (merged / deleted). An
//     event carrying ANOTHER LIVE product's id is that product's, even if the
//     name it carries is one this product once had (a freed name can be reused).
export function eventsForProduct(log, product, allProducts = []) {
  if (!product) return [];
  const names = new Set([product.name, ...(Array.isArray(product.previousNames) ? product.previousNames : [])].filter(Boolean));
  const liveIds = new Set((allProducts || []).map((p) => p && p.id).filter(Boolean));
  return (log || []).filter((e) => e && (e.productId === product.id
    || ((!e.productId || !liveIds.has(e.productId)) && names.has(e.productName))));
}

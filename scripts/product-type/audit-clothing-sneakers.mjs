// ─── AUDIT: PRODUCTS TYPED CLOTHING THAT ARE REALLY SHOES ────────────────────
//
//   ACCESS_TOKEN=… node scripts/product-type/audit-clothing-sneakers.mjs [--cache dir]
//
// Reads /products in bounded pages of 500 (never the whole node in one read)
// and the insights rollup a day at a time, classifies every Clothing-typed
// product (auditCore.classifyClothingProduct) and prints the list. It writes
// nothing: restore the "restore" ones with restore-sneaker-type.mjs
// --keep-sizes --apply. Run 26 Sep 2026: 3,400 Clothing products, two shoes
// (the AF1 White — already restored — and the AF1 Bape, restored), one
// packaging item listed for a look and left alone.
import { classifyClothingProduct } from "./auditCore.mjs";
import { orderHistory, rest } from "./productTypeData.mjs";
const argv = process.argv.slice(2);
const cacheIdx = argv.indexOf("--cache");
const CACHE = cacheIdx >= 0 ? argv[cacheIdx + 1] : null;

function productsPaged() {
  const all = {};
  let after = null;
  for (let i = 0; i < 200; i += 1) {
    const qs = after === null
      ? "orderBy=%22$key%22&limitToFirst=500"
      : `orderBy=%22$key%22&startAt=%22${encodeURIComponent(after)}%22&limitToFirst=501`;
    const page = rest("products", { qs }) || {};
    if (after !== null) delete page[after];
    const keys = Object.keys(page).sort();
    Object.assign(all, page);
    if (keys.length < 500) break;
    after = keys[keys.length - 1];
  }
  return all;
}

const products = productsPaged();
const clothing = Object.entries(products).filter(([, p]) => p && p.productType === "clothing" && !p.mergedInto);
const history = orderHistory(new Set(clothing.map(([id]) => id)), CACHE);
console.log(`${Object.keys(products).length} products, ${clothing.length} typed Clothing`);
const footwearStyleCodes = new Set(Object.values(products)
  .filter((p) => p && !p.mergedInto && p.productType !== "clothing" && p.category === "Footwear" && p.styleCodeNormalised)
  .map((p) => p.styleCodeNormalised));
for (const [id, p] of clothing) {
  const typeHist = history[id]?.types || {};
  const c = classifyClothingProduct(p, typeHist, { footwearStyleCodes });
  if (!c) continue;
  console.log(`${c.verdict.toUpperCase().padEnd(7)} ${id} | ${p.name} | ${p.category}/${p.categoryKey} | sizes ${(p.sizes || []).join(",")} | signals ${Object.entries(c.signals).filter(([, v]) => v).map(([k]) => k).join("+")}${p.deactivated ? " | DEACTIVATED" : ""}`);
}

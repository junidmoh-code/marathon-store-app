// ─── MISSING PRODUCTS — STRANDED CARDS + CATEGORIES (pure, testable) ──────────
// The card list behind Inventory Health → Missing Products, lifted out of
// NetworkTransfer so ONE function feeds both the list and the chip counts above
// it. That shared-source rule is the whole point of this module.
//
// WHY IT EXISTS: the clothing count on the dashboard came from the SCAN's
// unit-based exception buckets (onlyInCentral + onlyInHub2) while the list came
// from live /stock and carriage. The two drifted by construction — measured at
// 391 vs 380 on 2026-08-03 — and NetworkTransfer's own comments already called
// this out. Splitting the tab into category chips made it untenable: chips
// summing to 380 under a 391 headline reads as a bug. Sneakers already solved
// this the same way (missingFootwearCore) and the comment in HealthView says so.
//
// A card is a product with real stock UPSTREAM that no shop carries yet:
//   • "Only in Central" — units in Central, and neither Hub 2 nor a shop carries it
//   • "Only in Hub 2"   — units in Hub 2, and no shop carries it
// "Carries" means a stock NODE EXISTS, at any quantity including zero — the same
// gate the engine uses (storeCarries). That is why a Solve, which seeds qty-0
// cells, retires a card immediately.

const STORES = ["marathon-pe", "trophy"];
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL"];
const sizeRank = (s) => { const i = SIZE_ORDER.indexOf(String(s).toUpperCase()); return i < 0 ? 99 : i; };

// The tab's own grouping. Deliberately NOT the raw catalogue taxonomy: the
// catalogue has 8 Accessories subcategories, and a chip per subcategory would be
// mostly empty chips. These are the groups warehouse staff actually sort by.
//
// "other" is a CATCH-ALL AND IS LOAD-BEARING. Every card must land in exactly one
// group, or stranded stock becomes unreachable — invisible in a tab whose entire
// job is to surface it. Belts, eyewear, jewellery, gloves and anything added to
// the catalogue tomorrow fall here rather than nowhere. The chip is hidden when
// empty, so it costs nothing on a normal day. (Owner asked for bags/watches/
// clothing; this is the fourth bucket that keeps that request honest.)
export const MISSING_CATEGORIES = [
  { key: "clothing", label: "Clothing" },
  { key: "bags", label: "Bags" },
  { key: "watches", label: "Watches" },
  { key: "other", label: "Other" },
];

// Which chip a product belongs under. Keyed on the catalogue's own
// category/subcategory fields — the same fields the refill engine's subcategory
// policy uses, so the tab and the policy can never disagree about what a watch is.
export function categoryOf(product) {
  const sub = String(product?.subcategory || "").trim().toLowerCase();
  if (sub === "watches") return "watches";
  if (sub === "bags") return "bags";
  if (String(product?.category || "").trim().toLowerCase() === "clothing") return "clothing";
  return "other";
}

// Is this product clothing in the engine's sense? Byte-identical to
// refill-engine.cjs isClothing() and to the copy NetworkTransfer used inline —
// prefer the explicit flag, fall back to the legacy garment-size heuristic.
// NOTE this is what admits Accessories to the tab at all: bags, watches and
// belts are all recorded as productType "clothing".
export function isClothing(p) {
  if (!p) return false;
  if (p.productType) return p.productType === "clothing";
  return (p.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s)));
}

// The stranded-card list. `allStock` is { loc: { pid: { sizeKey: cell } } } and
// `products` is an array of catalogue records.
export function computeMissingProducts({ allStock, products }) {
  const byId = new Map((products || []).map((p) => [p.id, p]));
  const sumAt = (loc, pid) =>
    Object.values(allStock?.[loc]?.[pid] || {}).reduce((t, c) => t + Math.max(Number(c?.qty) || 0, 0), 0);
  const carries = (loc, pid) =>
    !!allStock?.[loc]?.[pid] && Object.keys(allStock[loc][pid]).length > 0;

  const out = [];
  const pids = new Set([...Object.keys(allStock?.central || {}), ...Object.keys(allStock?.hub2 || {})]);
  for (const pid of pids) {
    const p = byId.get(pid);
    if (!isClothing(p)) continue;
    const ce = sumAt("central", pid), h2 = sumAt("hub2", pid);
    const carriedDownstream = carries("marathon-pe", pid) || carries("trophy", pid);
    let source = null, kind = null;
    if (ce > 0 && !carries("hub2", pid) && !carriedDownstream) { source = "central"; kind = "Only in Central"; }
    else if (h2 > 0 && !carriedDownstream) { source = "hub2"; kind = "Only in Hub 2"; }
    if (!source) continue;
    const sizes = Object.entries(allStock[source]?.[pid] || {})
      .map(([size, c]) => ({ size, avail: Math.max(Number(c?.qty) || 0, 0) }))
      .filter((s) => s.avail > 0)
      .sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
    if (!sizes.length) continue;
    const missing = source === "central" ? ["hub2", ...STORES].filter((l) => !carries(l, pid)) : STORES;
    out.push({
      pid, name: p?.name || pid, photo: p?.photoUrl, source, kind, sizes, missing,
      category: categoryOf(p),
      units: sizes.reduce((t, s) => t + s.avail, 0),
    });
  }
  return out.sort((a, b) => b.units - a.units);
}

// Card counts per chip. Returns every key in MISSING_CATEGORIES (zeros included)
// so the chip row can decide what to hide without guessing which keys exist.
export function countByCategory(cards) {
  const out = Object.fromEntries(MISSING_CATEGORIES.map((c) => [c.key, 0]));
  for (const c of cards || []) out[c.category] = (out[c.category] || 0) + 1;
  return out;
}

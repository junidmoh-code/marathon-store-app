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

// ── GROUPING: exactly two chips — Sneakers and Clothing ──────────────────────
// Owner directive 2026-08-05: "remove the rest of the categories and just leave
// sneakers and clothing which clothing is going to have everything in it."
// This SUPERSEDES the 2026-08-04 per-subcategory directive (one chip per product
// type) that PR #308 built — the operator found a row of ten chips slower to
// work than one pile.
//
// So: every card in this list — bags, watches, t-shirts, tracksuits, and the
// 45% with no subcategory at all — lands under ONE Clothing chip. Sneakers keep
// their separate list (MissingFootwear) exactly as before. The uncategorised
// pile is no longer split out; by the same directive it is simply part of
// Clothing, and nothing is hidden — the Clothing chip IS the whole tab.
//
// groupOf keeps its shape ({ key, label }) so computeMissingProducts, the cards'
// group/groupLabel fields, and NetworkTransfer's `c.group === category` filter
// all work unchanged.
export function groupOf() {
  return { key: "clothing", label: "Clothing" };
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
export function computeMissingProducts({ allStock, products } = {}) {
  // Array.isArray, not `products || []`: an object here (the raw /products map
  // rather than the array the app passes) would throw on .map and blank the whole
  // Health screen. A tab that surfaces stranded stock should degrade to "nothing
  // stranded" rather than to a crash. (Codex review, PR #308.)
  const byId = new Map((Array.isArray(products) ? products : []).map((p) => [p?.id, p]));
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
    const group = groupOf(p);
    out.push({
      pid, name: p?.name || pid, photo: p?.photoUrl, source, kind, sizes, missing,
      group: group.key, groupLabel: group.label,
      units: sizes.reduce((t, s) => t + s.avail, 0),
    });
  }
  return out.sort((a, b) => b.units - a.units);
}

// Card counts per chip, keyed by group. Only groups that actually have cards
// appear — the chip row is built from the stock, not from a fixed list.
export function countByCategory(cards) {
  const out = {};
  for (const c of cards || []) out[c.group] = (out[c.group] || 0) + 1;
  return out;
}

// ── the chip row itself ──────────────────────────────────────────────────────
// Pure so it can be tested (the project has no component test runner). Two
// FIXED chips, both always present: Clothing (every stranded non-sneaker card,
// per the 2026-08-05 directive above) and Sneakers (its own list). Always
// rendering both — even at 0 — keeps the row stable under the operator's finger
// and guarantees chips[0] exists, which is what makes pickActiveTab's fallback
// safe.
export function buildChips(cards, sneakerCount) {
  return [
    ["clothing", "Clothing", (cards || []).length],
    ["sneakers", "Sneakers", sneakerCount || 0],
  ];
}

// The chip actually rendered. The stored selection can disappear underneath the
// user — solve the last stranded bag while looking at Bags and that chip is gone
// on the next render — so fall back rather than render a selection that no
// longer exists. buildChips guarantees a non-empty list, so chips[0] is safe.
export function pickActiveTab(chips, selected) {
  return (chips || []).some(([k]) => k === selected) ? selected : chips?.[0]?.[0];
}

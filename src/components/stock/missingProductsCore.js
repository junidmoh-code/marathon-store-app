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

import { TAXONOMY_SEED } from "../../utils/productTaxonomy.js";

const STORES = ["marathon-pe", "trophy"];
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL"];
const sizeRank = (s) => { const i = SIZE_ORDER.indexOf(String(s).toUpperCase()); return i < 0 ? 99 : i; };

// ── GROUPING: one chip per real product type ─────────────────────────────────
// Owner directive 2026-08-04: "i want to have sneakers watches bags t shirts
// tracksuit etc." — i.e. what the product IS, not a coarse three-bucket split.
// So the chips ARE the catalogue's own `subcategory` values: T-Shirts, Jerseys,
// Bags, Watches, Tracksuits & Sets, Jeans & Denim … plus Sneakers, which keeps
// its separate list.
//
// This is deliberately DATA-DRIVEN. A chip appears because stranded stock of
// that type exists, so a subcategory added to the taxonomy tomorrow gets a chip
// with no code change — the same principle as the taxonomy registry itself,
// which is an RTDB node precisely so adding a category is a data edit.
//
// UNCATEGORISED IS ITS OWN CHIP AND MUST STAY VISIBLE. 170 of the 380 stranded
// products carry subcategory "Clothing — Uncategorized" — 45% of the tab. It is
// tempting to bury them; that would hide the single largest pile of stranded
// stock in the business behind a taxonomy gap. It sorts last, but it shows.

const UNCATEGORISED = { key: "uncategorised", label: "Uncategorised" };

// One normaliser for both the chip key and the canonical order, so the two can
// never disagree about what "Tracksuits & Sets" is called. Declared BEFORE
// CANONICAL_SUBCATEGORIES, which calls it at module scope — a const below that
// point is in the temporal dead zone and throws on import, taking the whole
// Health screen with it.
const slugify = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Canonical chip order, derived from the taxonomy registry's own row order so
// the row reads the way the Add Product form does, and stays STABLE as counts
// change. Sorting by count would reshuffle the chips under the operator's finger
// every time stock moved.
// Held as SLUGS, not labels: ranking compared canonical labels against the
// product's own spelling, so a legacy record reading "T-shirts" or with odd
// spacing kept its chip but silently dropped to the alphabetical tail. The slug
// is the same key the chip itself is identified by, so both sides normalise the
// same way. (CodeRabbit, PR #308.)
const CANONICAL_SUBCATEGORIES = [...new Set(
  Object.values(TAXONOMY_SEED.cats || {})
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((c) => c?.legacy?.subcategory)
    .filter(Boolean)
    .map((s) => slugify(s)),
)];

// A missing, blank or explicitly-"uncategorized" subcategory all mean the same
// thing to an operator: nobody has said what this product is. They collapse into
// one chip rather than several near-identical ones.
const looksUncategorised = (sub) => !sub || /uncategori[sz]ed/i.test(sub);

// The chip a product belongs under: { key, label }. Keyed on `subcategory` — the
// same field the refill engine's subcategory policy uses (PR #305) — so the tab
// and the policy can never disagree about what a watch is.
export function groupOf(product) {
  const sub = String(product?.subcategory || "").trim();
  if (looksUncategorised(sub)) return { ...UNCATEGORISED };
  return { key: slugify(sub), label: sub };
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
// Pure so it can be tested: this is the logic most likely to break in a way the
// core's own tests would never see (a chip vanishing under the user, an empty
// selection, an index error on an empty list), and the project has no component
// test runner — react-test-renderer isn't even a dependency. Keeping the rules
// here rather than inline in JSX is what makes them checkable at all.
// (Senior-architect review, PR #308.)

// Which chips to show, in order, as [key, label, count]. Built from the CARDS,
// so the row shows exactly the product types that actually have stranded stock —
// no empty chips to scroll past, and a new subcategory needs no code change.
//
// ORDER is the taxonomy's own row order (stable), with anything not in the
// taxonomy after it alphabetically, and Uncategorised last. Deliberately NOT
// sorted by count: that would reshuffle the chips under the operator's finger
// every time stock moved.
//
// Sneakers is appended unconditionally — it owns a separate list, and it
// guarantees the row is never empty, which is what makes chips[0] a safe
// fallback in pickActiveTab.
export function buildChips(cards, sneakerCount) {
  const seen = new Map();   // key → { key, label, n }
  for (const c of cards || []) {
    const e = seen.get(c.group) || { key: c.group, label: c.groupLabel, n: 0 };
    e.n += 1;
    seen.set(c.group, e);
  }
  const rank = (key) => {
    const i = CANONICAL_SUBCATEGORIES.indexOf(key);
    return i < 0 ? CANONICAL_SUBCATEGORIES.length : i;
  };
  const groups = [...seen.values()].sort((a, b) => {
    if (a.key === UNCATEGORISED.key) return 1;          // always last
    if (b.key === UNCATEGORISED.key) return -1;
    const d = rank(a.key) - rank(b.key);
    return d !== 0 ? d : String(a.label).localeCompare(String(b.label));
  });
  return [
    ...groups.map((g) => [g.key, g.label, g.n]),
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

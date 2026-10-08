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

// Numeric-aware ordering: letters keep their historical ranks; shoe/waist
// sizes sort numerically after them instead of tying at 99 and rendering in
// arbitrary map order (12/13 would otherwise land anywhere).
import { sizeRank } from "./hubSizeRank";
import { isDeactivated } from "../../utils/deactivation.js";
import { effectiveCategoryKey } from "../../utils/productTaxonomy.js";
import { FOOTWEAR_CATEGORY_KEYS } from "../../utils/footwearLine.js";

import { sectionOf, locationName } from "../../utils/networkRegistry";
import { net, storeIds, solveHubsOfSection, centralId, liveSections } from "./sectionRouting";
import { centralFedPerSize, centralFedIsClothing, centralFedSizes } from "./centralFed";
import { decodedCellKey } from "../../utils/sizeKey";

// ── ONE SECTION AT A TIME ────────────────────────────────────────────────────
// "Stranded" is a statement about ONE section: stock that sits upstream of
// that section's shops and none of them carries. Upstream is Central plus the
// hub(s) holding that section's back stock for the product; downstream is
// that section's shops. A product Marathon PE carries is not stranded for
// Section 2 — and says nothing at all about Section 1.
//
// The section is asked of the network registry. With no `section` given the
// list is Section 2's — Hub 2 upstream, Marathon PE and Trophy downstream —
// which is the list this function has always built (the registry's seed
// answers exactly those three; pinned by test).
const DEFAULT_SECTION = 2;

// ── GROUPING: three chips — Clothing, Perfume, Sneakers ──────────────────────
// Owner directive 2026-08-05: "remove the rest of the categories and just leave
// sneakers and clothing which clothing is going to have everything in it."
// This SUPERSEDES the 2026-08-04 per-subcategory directive (one chip per product
// type) that PR #308 built — the operator found a row of ten chips slower to
// work than one pile.
//
// So: every clothing card in this list — bags, watches, t-shirts, tracksuits,
// and the 45% with no subcategory at all — lands under ONE Clothing chip.
// Sneakers keep their separate list (MissingFootwear) exactly as before. The
// uncategorised pile is no longer split out; by the same directive it is simply
// part of Clothing, and nothing is hidden — the Clothing chip IS the clothing
// pile.
//
// PERFUME (owner directive 2026-08-13) gets its OWN chip rather than joining
// the pile, for one load-bearing reason: the Clothing chip's count must stay
// byte-for-byte what it was — the engine, the scan and the operator's mental
// model all treat "clothing" as the isClothing() class, and folding perfume in
// would change that number everywhere it is read. A perfume card is decided by
// isPerfume() below; the two legacy records that carry BOTH categoryKey
// "perfumes" AND productType "clothing" stay under Clothing (isClothing wins),
// exactly where they appear today.
//
// groupOf keeps its shape ({ key, label }) so computeMissingProducts, the cards'
// group/groupLabel fields, and NetworkTransfer's `c.group === category` filter
// all work unchanged.
export function groupOf(p) {
  if (isPerfume(p) && !isClothing(p)) return { key: "perfume", label: "Perfume" };
  return { key: "clothing", label: "Clothing" };
}

// ── PERFUME — the second class this tab admits (owner directive 2026-08-13) ──
// Perfume was invisible here, and the invisibility was total: a perfume short
// at a shop could never be seen, never be solved, and its stock sat stranded at
// Central indefinitely (6 products / 288 units measured 2026-08-13). The cause
// is the isClothing() gate below — live perfume records carry NO productType at
// all (the app form can't create them; they are script-written), and their only
// size is the "_" sentinel, so both the flag branch and the garment-size
// fallback say "not clothing".
//
// categoryKey === "perfumes" is the identity every live perfume record shares
// (65/65 measured 2026-08-13; category "Perfume" and subcategory "Perfume" hold
// only 63). It admits perfume and NOTHING else — deliberately narrow, because
// the engine manages non-clothing only through explicit /stock_targets rows,
// and perfume is the one non-clothing class the owner has armed rows for
// (112 rows at marathon-pe + hub2). Widening this to other typeless categories
// is an owner decision, not a code default.
export function isPerfume(p) {
  return !!p && p.categoryKey === "perfumes";
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

// ── THE FOOTWEAR GROUP — the ONE class this tab does not own ─────────────────
// (2026-09-17, first batch for every category.) The gate used to be
// `isClothing || isPerfume`, which kept the footwear group out correctly but
// ALSO kept out, by accident, every non-footwear record that is neither
// clothing-typed nor a perfume: a suit jacket mis-typed productType "sneaker"
// (8 units at Central, invisible on BOTH tabs on 2026-09-17), and the typeless
// categories. The owner's rule is that everything except sneakers and slides
// goes through Hub 2 into the shop, so this tab admits the COMPLEMENT of the
// footwear group — the engine's own Health predicate (refill-engine.cjs
// `inFootwearGroup`): NOT clothing in the engine's sense AND (legacy category
// "Footwear" OR a footwear category key, resolved through the catalogue's
// effectiveCategoryKey so a keyless legacy sneaker is still a sneaker).
// Footwear keeps its own list (missingFootwearCore, `category === "Footwear"`),
// so the two tabs stay complementary on every legacy-Footwear record. A
// clothing-typed record is clothing to this tab whatever its category says —
// the same precedence the engine applies (isClothing is evaluated first).
export const FOOTWEAR_GROUP_KEYS = Object.freeze([...FOOTWEAR_CATEGORY_KEYS, "designer-shoes"]);
export function inFootwearGroup(p) {
  if (!p || isClothing(p)) return false;
  if (p.category === "Footwear") return true;
  const key = effectiveCategoryKey(p);
  return !!key && FOOTWEAR_GROUP_KEYS.includes(key);
}
// What this tab admits: a catalogue record that is not in the footwear group.
// (A stock node with no product record is not admitted — same as before.)
export const admitsMissingProduct = (p) => !!p && !inFootwearGroup(p);

// The stranded-card list. `allStock` is { loc: { pid: { sizeKey: cell } } } and
// `products` is an array of catalogue records. `section` (default 2) is the
// section the list is for; `network` is the registry (default: the current
// one). A card built for an explicitly named section carries it as `section`.
// `centralFed` (optional): the engine config. For a section named explicitly,
// a CENTRAL-FED store (centralFed.js — Concrete's clothing, kept in the shop
// and refilled straight from Central) adds, for its clothing:
//   • a product the store does not carry that Central has — even when another
//     store or the hub of the section carries it (that is not where this
//     store gets its clothing);
//   • a product the store carries with declared sizes it has no cell for —
//     the sizes Central has can be solved; those it lacks read "Central has
//     none" (`centralNone`) and stay here until Central has them.
// Absent ⇒ the list is exactly what it always was.
export function computeMissingProducts({ allStock, products, network, section, centralFed } = {}) {
  const N = net(network);
  const sec = section || DEFAULT_SECTION;
  const central = centralId(N);
  const STORES = storeIds(N, { section: sec });
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
  // Every hub that is some shop of this section's default back-stock hub —
  // the candidate set; each product then asks for ITS hubs (a category or a
  // product can be mapped to another hub of the section).
  const sectionHubs = solveHubsOfSection(N, sec, null, null);
  const pids = new Set([...Object.keys(allStock?.[central] || {}), ...sectionHubs.flatMap((h) => Object.keys(allStock?.[h] || {}))]);
  for (const pid of pids) {
    const p = byId.get(pid);
    // Everything outside the footwear group — clothing, perfume, and (since
    // 2026-09-17) every other non-footwear record. Footwear keeps its own list
    // (missingFootwearCore). See inFootwearGroup above.
    if (!admitsMissingProduct(p)) continue;
    // Finished lines take no requests and no Solve — same guard as the
    // footwear twin. Without it, Solve here would seed qty-0 cells that no
    // arrival ever follows, so nothing would auto-reactivate: the exact
    // "seed, vanish, never refill" divergence the mirror comments warn about.
    if (isDeactivated(p)) continue;
    // This product's hubs in this section (Hub 2 for every Section 2 product).
    const hubs = solveHubsOfSection(N, sec, p, pid);
    const ce = sumAt(central, pid);
    const carriedDownstream = STORES.some((s) => carries(s, pid));
    let source = null, kind = null;
    if (ce > 0 && !hubs.some((h) => carries(h, pid)) && !carriedDownstream) { source = central; kind = "Only in Central"; }
    else if (!carriedDownstream) {
      const h = hubs.find((x) => sumAt(x, pid) > 0);
      if (h) { source = h; kind = `Only in ${locationName(N, h)}`; }
    }
    if (!source) continue;
    const sizes = Object.entries(allStock[source]?.[pid] || {})
      .map(([size, c]) => ({ size, avail: Math.max(Number(c?.qty) || 0, 0) }))
      .filter((s) => s.avail > 0)
      .sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
    if (!sizes.length) continue;
    const missing = source === central ? [...hubs, ...STORES].filter((l) => !carries(l, pid)) : STORES;
    const group = groupOf(p);
    out.push({
      pid, name: p?.name || pid, photo: p?.photoUrl, source, kind, sizes, missing,
      group: group.key, groupLabel: group.label,
      units: sizes.reduce((t, s) => t + s.avail, 0),
      // Named only when the caller named a section — the default call's cards
      // are exactly the shape they always were.
      ...(section ? { section: sec } : {}),
    });
  }
  if (section && centralFed) addCentralFedCards({ out, N, sec, central, allStock, byId, centralFed, sumAt, carries });
  return out.sort((a, b) => b.units - a.units);
}

function addCentralFedCards({ out, N, sec, central, allStock, byId, centralFed, sumAt, carries }) {
  const fedStores = storeIds(N, { section: sec }).filter((s) => centralFedPerSize(centralFed, N, s) !== null);
  if (!fedStores.length) return;
  const at = (loc, pid, sz) => Math.max(Number(allStock?.[loc]?.[pid]?.[decodedCellKey(sz)]?.qty) || 0, 0);
  const hasCell = (loc, pid, sz) => allStock?.[loc]?.[pid]?.[decodedCellKey(sz)] != null;
  const byPid = new Map(out.map((c, i) => [c.pid, i]));
  const pids = new Set([...Object.keys(allStock?.[central] || {}), ...fedStores.flatMap((s) => Object.keys(allStock?.[s] || {}))]);
  for (const pid of pids) {
    const p = byId.get(pid);
    if (!admitsMissingProduct(p) || isDeactivated(p) || !centralFedIsClothing(p)) continue;
    for (const store of fedStores) {
      const declared = centralFedSizes(p);
      const gap = carries(store, pid) ? declared.filter((sz) => !hasCell(store, pid, sz)) : declared;
      if (!gap.length) continue;
      const sizes = gap.map((sz) => ({ size: decodedCellKey(sz), avail: at(central, pid, sz), ...(at(central, pid, sz) > 0 ? {} : { centralNone: true }) }))
        .sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
      const has = sizes.some((s) => s.avail > 0);
      // A product the store does not carry is offered only when Central has
      // some of it; a size gap is listed either way (the owner sees it).
      if (!carries(store, pid) && !has) continue;
      const kind = carries(store, pid) ? `Sizes missing at ${locationName(N, store)}` : `Not at ${locationName(N, store)}`;
      const i = byPid.get(pid);
      if (i !== undefined && out[i].source === central) {
        if (!out[i].missing.includes(store)) out[i].missing = [...out[i].missing, store];
        continue;
      }
      const card = {
        pid, name: p?.name || pid, photo: p?.photoUrl, source: central, kind, sizes, missing: [store],
        group: groupOf(p).key, groupLabel: groupOf(p).label,
        units: sizes.reduce((t, s) => t + s.avail, 0), section: sec, centralFed: store,
      };
      if (i !== undefined) out[i] = card; else { byPid.set(pid, out.length); out.push(card); }
    }
  }
}

// The lists a screen builds BY ITSELF: one per section that has a LIVE shop
// (Section 2 on the registry's seed). A section whose shops are not live yet
// has no work list of its own accord — nothing is routed there automatically —
// but its list can still be LOOKED at: computeMissingProducts({ section }).
export const missingProductSections = (network) => liveSections(network);
// The section a card belongs to (cards from the default call carry none).
export const cardSection = (card, network) =>
  card?.section || (card?.source && sectionOf(net(network), card.source)) || DEFAULT_SECTION;

// Card counts per chip, keyed by group. With the two-chip rule every card lands
// under "clothing", so this reduces to { clothing: N } — kept generic because
// the load-bearing test ("chips account for every card") sums it.
export function countByCategory(cards) {
  const out = {};
  for (const c of cards || []) out[c.group] = (out[c.group] || 0) + 1;
  return out;
}

// ── the chip row itself ──────────────────────────────────────────────────────
// Pure so it can be tested (the project has no component test runner). Three
// FIXED chips, all always present: Clothing (every stranded clothing card, per
// the 2026-08-05 directive above), Perfume (2026-08-13), and Sneakers (its own
// list). Always rendering all of them — even at 0 — keeps the row stable under
// the operator's finger and guarantees chips[0] exists, which is what makes
// pickActiveTab's fallback safe.
//
// The Clothing count is the GROUP count, not the card count — with perfume in
// the list those are different numbers, and the Clothing chip must keep showing
// exactly what it showed before perfume was admitted. On a clothing-only list
// the two are equal, which is why the old `.length` was ever right.
export function buildChips(cards, sneakerCount) {
  const n = (key) => (cards || []).filter((c) => c?.group === key).length;
  return [
    ["clothing", "Clothing", n("clothing")],
    ["perfume", "Perfume", n("perfume")],
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

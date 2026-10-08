// ─── WHICH HUB, FOR WHICH SHOP — ASKED OF THE NETWORK REGISTRY ───────────────
//
// App.jsx used to answer "which hub?" with literals: a universe → hub map
// ({central: "hub2", pine: "hub3"}), "hub3 means Pine", and some fifteen
// `|| "hub1"` / `|| "hub2"` fallbacks. Every one of those fallbacks points at
// Section 2, so a Section 1 record with a missing hub was silently filed under
// Marathon PE's hubs — on the far side of the wall.
//
// This module is the one place those questions are answered now:
//
//   • MARATHON PE AND TROPHY KEEP THE OLD ANSWER, LITERALLY. Each helper takes
//     the literal the call site always used (`legacyHub`) or the computation it
//     always ran (`legacyCompute`) and returns exactly that for a Section 2
//     shop. Nothing about their routing is re-derived from the registry here.
//   • A RECORD WITH NO SHOP AT ALL is a legacy record (orders predate destShop).
//     It keeps the old literal too, so it renders and closes as it always has.
//   • EVERY OTHER SHOP asks the registry: backStockFor(shop, category, product).
//     Pine → Hub 3. Concrete → Hub 3, or the Concrete Stockroom for a category
//     or product the owner has flipped on the Network card.
//   • A SHOP THE REGISTRY DOES NOT KNOW gets null — never a Section 2 hub.
//
// Pure: no firebase, no clock, no React. The caller passes the registry
// (currentNetwork() outside React, useNetwork() inside).
import { sectionName,
  locationOf, sectionOf, hubsOf, storesOf, backStockFor,
  wallCheck, wallMessage, autoRouteAllowed, locationName,
} from "./networkRegistry";
import { effectiveCategoryKey } from "./productTaxonomy";
import { storeBucketOf } from "../insights/rollupCodec";

// The retired clothing-customer trial. NOT a registry location and never a
// stock location; it keeps working exactly as it did, as a Section 2 screen.
export const TRIAL_HUB = "hubC";
const TRIAL_HUB_LABEL = "Hub C";
// The Section 2 hub the trial hub stands beside, for the wall and for who may
// see it.
const TRIAL_HUB_SIDE = "hub2";

// The shop a record is for. New records carry destShop; a legacy Pine order
// carries only placedStore "pine"; a legacy central order names no shop.
export function shopOfRecord(rec) {
  if (!rec) return null;
  return rec.destShop || (rec.placedStore === "pine" ? "marathon-pine" : null);
}

// Does this shop keep the old literal? True for Marathon PE / Trophy and for
// "no shop at all". False for every other shop, known or not.
export function keepsLegacyHub(network, shop) {
  if (shop === null || shop === undefined || shop === "") return true;
  return sectionOf(network, shop) === 2;
}

// The hub to assume when a record does not say. `legacyHub` is the literal the
// call site always used.
export function fallbackHub(network, shop, legacyHub, product) {
  if (keepsLegacyHub(network, shop)) return legacyHub;
  return backStockFor(network, shop, product ? effectiveCategoryKey(product) : null, product ? product.id : undefined);
}

// A record's hub: what it says, else the fallback above.
export function hubOfRecord(network, rec, legacyHub, product) {
  if (!rec) return legacyHub;
  return rec.placedAtHub || rec.hub || fallbackHub(network, shopOfRecord(rec), legacyHub, product);
}

// The hub a NEW order line for this shop + product is placed at.
// Marathon PE / Trophy: `legacyCompute()` — the stock-aware sneaker allocation
// and tag routing, untouched. Everyone else: the registry's back-stock hub.
export function placementHub(network, shop, product, legacyCompute) {
  if (sectionOf(network, shop) === 2) return legacyCompute();
  return backStockFor(network, shop, product ? effectiveCategoryKey(product) : null, product ? product.id : undefined);
}

// The ONE hub a shop's assistant screen watches for clothing availability.
// Section 2: the literal it always was. Otherwise the shop's default hub.
export function servingHubFor(network, shop, legacyHub) {
  if (keepsLegacyHub(network, shop)) return legacyHub;
  return backStockFor(network, shop, null);
}

// Does the assistant screen for this shop use Section 2's gated sneaker hubs
// (Hub 1 / Hub 2 cells, display slots)? Only a Section 2 shop does. This is
// what `storeMode === "pine"` used to mean — "not the central pair" — said so
// that Concrete, and any shop the registry does not know, land on the same
// side as Pine rather than subscribing to the other section's hubs.
export function usesSection2Hubs(network, shop) {
  return sectionOf(network, shop) === 2;
}

// Every registry hub id (stock locations; the trial hub is not one).
export function stockHubIds(network) {
  return hubsOf(network).map((l) => l.id);
}

// Hubs that carry the CR (shop clothing refill) tab: every hub that is not a
// sneakers-only hub. A hub is sneakers-only when the back-stock map names it,
// and names it for nothing but "sneakers" (Hub 1). A hub the map does not name
// yet (the Concrete Stockroom, until the owner flips a category) gets the tab:
// it can be given clothing at any moment, without a deploy.
export function crHubIds(network) {
  const back = (network && network.backStock) || {};
  const uses = {};
  for (const store of Object.keys(back)) {
    for (const cat of Object.keys(back[store])) {
      const h = back[store][cat];
      (uses[h] = uses[h] || new Set()).add(cat);
    }
  }
  return stockHubIds(network).filter((h) => !uses[h] || [...uses[h]].some((cat) => cat !== "sneakers"));
}

export function hubLabel(network, hub) {
  if (hub === TRIAL_HUB) return TRIAL_HUB_LABEL;
  const l = locationOf(network, hub);
  return l ? l.name : (hub || "");
}

// Section 2 first: Hub 1 and Hub 2 stay where they have always been on every
// picker; Section 1 follows.
const bySectionLegacyOrder = (a, b) => (b.section - a.section) || (a.sort - b.sort) || a.id.localeCompare(b.id);

function grouped(network, locs, canSee, toRow) {
  const out = [];
  for (const l of [...locs].sort(bySectionLegacyOrder)) {
    if (canSee && !canSee(l.id)) continue;
    let g = out.find((x) => x.section === l.section);
    if (!g) { g = { section: l.section, name: sectionName(network, l.section), items: [] }; out.push(g); }
    g.items.push(toRow(l));
  }
  return out;
}

// The warehouse hub picker: registry hubs grouped by section, filtered to what
// the viewer may see — exactly Hub 1, Hub 2, Hub 3 (owner, 8 Oct 2026).
// Hub C is NOT offered here; it is untouched everywhere else (a device already
// on it keeps it; its queue, labels, alerts and deep links still work).
//   [{ section, name, items: [{ id, label, live }] }]
export function warehouseHubGroups(network, canSee) {
  return grouped(network, hubsOf(network), canSee, (l) => ({ id: l.id, label: l.name, live: l.live === true }));
}

// May this viewer work as this hub? The persisted localStorage.warehouseHub
// and a push deep link both go through here, so neither can put a device on a
// hub outside the viewer's sections — or on something that is not a hub.
export function hubAllowedForViewer(network, canSee, hub) {
  if (!hub || typeof canSee !== "function") return false;
  if (hub === TRIAL_HUB) return canSee(TRIAL_HUB_SIDE);
  const l = locationOf(network, hub);
  return !!l && l.type === "hub" && l.id === hub && canSee(hub);
}

// What to do with the hub a device has PERSISTED (localStorage.warehouseHub):
//   "none"  nothing stored.
//   "keep"  a hub this viewer may work as.
//   "drop"  not allowed (the other section's hub, a retired or made-up id) —
//           the device must not go on carrying it.
//   "wait"  not allowed by the registry in hand, but /network has not answered
//           yet: a hub that exists only in the live node would be thrown away
//           on every cold start if this were judged on the built-in seed.
// `registryAnswered`: /network has settled (or failed for good).
export function storedHubVerdict(network, canSee, hub, registryAnswered) {
  if (!hub) return "none";
  if (hubAllowedForViewer(network, canSee, hub)) return "keep";
  return registryAnswered ? "drop" : "wait";
}

// ─── THE WAREHOUSE SCREEN'S TABS, PER HUB ────────────────────────────────────
// One list, read by the screen (which adds the labels and badges) and by the
// push deep link (which may only persist a tab the hub actually has):
//   the trial hub         Order Queue only.
//   a CR hub              Order Queue, CR Orders, Display Refills, Layby —
//                         Hub 2, Hub 3 and the Concrete Stockroom.
//   a sneakers-only hub   the same without CR Orders — Hub 1.
//   anything else         nothing: it is not a hub.
export function warehouseTabKeys(network, hub) {
  if (hub === TRIAL_HUB) return ["queue"];
  const l = locationOf(network, hub);
  if (!l || l.type !== "hub" || l.id !== hub) return [];
  return crHubIds(network).includes(hub)
    ? ["queue", "clothing", "refills", "layby"]
    : ["queue", "refills", "layby"];
}

// Shops grouped by section, filtered to the viewer. [{ section, name, items: [{ id, label, live }] }]
export function shopGroups(network, canSee, labelOf) {
  return grouped(network, storesOf(network), canSee, (l) => ({ id: l.id, label: labelOf ? labelOf(l.id) : l.name, live: l.live === true }));
}

// The shops a hub sends to: its `serves` list when it has one (the Concrete
// Stockroom serves only Concrete), else every shop in its section.
// Hub 2 → Marathon PE, Trophy — the two pills the CR tab has always shown.
export function shopsOfHub(network, hub) {
  const h = locationOf(network, hub);
  if (!h || h.type !== "hub") return [];
  const all = [...storesOf(network, { section: h.section })].sort(bySectionLegacyOrder).map((l) => l.id);
  return h.serves && h.serves.length ? all.filter((s) => h.serves.includes(s)) : all;
}

// Is an order on this hub's queue?
//   Hub 1 / Hub 2: the legacy `hub` field, defaulting a hub-less order to
//   Hub 1 ONLY when it is Marathon PE's / Trophy's / nobody's.
//   Every other hub (Hub 3, Concrete Stockroom, the trial hub): placedAtHub.
export function orderIsAtHub(network, order, hub) {
  if (!order || !hub) return false;
  if (hub !== TRIAL_HUB && sectionOf(network, hub) === 2) {
    return (order.hub || fallbackHub(network, shopOfRecord(order), "hub1")) === hub;
  }
  return order.placedAtHub === hub;
}

// ─── THE WALL, AT ORDER PLACEMENT ────────────────────────────────────────────
// An order is a request for stock to travel hub → destShop. It must never be
// WRITTEN with its two ends on opposite sides of the wall: dispatch would
// refuse the move later (applyMovement), leaving an order nobody can send.
//
//   auto: true  — something automatic is raising it: both ends must also be
//                 LIVE (autoRouteAllowed). A person placing an order by hand
//                 for a shop that is not live yet is allowed.
// Returns { ok, reason, message }.
export function orderPlacementCheck(network, { hub, destShop, auto = false } = {}) {
  if (!destShop) return { ok: true, reason: "no_shop", message: null };
  const shop = locationOf(network, destShop);
  if (!shop || shop.type !== "store") {
    return { ok: false, reason: "unknown_shop", message: "That shop is not in the network registry. Nothing was placed." };
  }
  if (!hub) {
    return { ok: false, reason: "no_hub", message: `${shop.name} has no back-stock hub for this item. Nothing was placed.` };
  }
  const wallHub = hub === TRIAL_HUB ? TRIAL_HUB_SIDE : hub;
  const wall = wallCheck(network, wallHub, shop.id);
  if (!wall.ok) {
    return {
      ok: false, reason: wall.reason,
      message: wall.reason === "cross_section"
        ? `${hubLabel(network, hub)} and ${shop.name} are in different sections, so this order cannot be placed.`
        : (wallMessage(network, wallHub, shop.id) || "This order cannot be placed."),
    };
  }
  if (auto && !autoRouteAllowed(network, wallHub, shop.id)) {
    return { ok: false, reason: "not_live", message: `${locationName(network, hub)} or ${shop.name} is not live yet, so nothing automatic is raised for it.` };
  }
  return { ok: true, reason: wall.reason, message: null };
}

// ─── SECTION ON THE RECORD ───────────────────────────────────────────────────
// New /orders records carry `section` (of destShop). Old ones do not and are
// never rewritten: a reader derives it from the shop.
export function sectionStamp(network, destShop) {
  const l = locationOf(network, destShop);
  return l && l.type === "store" ? l.section : null;
}

export function sectionOfRecord(network, rec) {
  if (!rec) return null;
  const n = Number(rec.section);
  if (n === 1 || n === 2) return n;
  return sectionOf(network, shopOfRecord(rec));
}

// ─── THE 6-MINUTE DISPATCH HOLD ──────────────────────────────────────────────
// Hub 2's parcels travel to the shop, so its "Ready" is revealed to the
// customer six minutes after Sent. That is a fact about Hub 2's van, and the
// registry has no field for it, so it is stated here per hub rather than
// guessed for Hub 3 or the Concrete Stockroom (which is inside the shop).
// To hold another hub: one line.
const DISPATCH_HOLD_MS_BY_HUB = { hub2: 6 * 60 * 1000 };

export function dispatchHoldMs(hub) {
  return DISPATCH_HOLD_MS_BY_HUB[hub] || 0;
}

// ─── SOURCE (CENTRAL) TABS ───────────────────────────────────────────────────
// Central supplies both sections. The four Section 2 tabs keep their keys,
// labels and order (persisted tab state and push deep links name them); every
// other hub and shop in the registry gets a tab keyed by its location id.
const LEGACY_SOURCE_TABS = [
  { key: "hub1refill", label: "Hub 1 Refill", loc: "hub1", kind: "hub" },
  { key: "clothing", label: "Hub 2 Refill", loc: "hub2", kind: "hub" },
  { key: "trophy", label: "Trophy", loc: "trophy", kind: "shop" },
  { key: "marathonpe", label: "Marathon", loc: "marathon-pe", kind: "shop" },
];
export const SOURCE_HISTORY_TAB = { key: "refillhistory", label: "Refill History", loc: null, kind: "history", section: null };

// [{ key, label, loc, kind: "hub" | "shop" | "history", section }]
export function sourceTabsFor(network, canSee) {
  const see = (id) => (canSee ? canSee(id) : true);
  const out = [];
  for (const t of LEGACY_SOURCE_TABS) {
    if (locationOf(network, t.loc) && see(t.loc)) out.push({ ...t, section: sectionOf(network, t.loc) });
  }
  const named = new Set(LEGACY_SOURCE_TABS.map((t) => t.loc));
  const rest = [...hubsOf(network), ...storesOf(network)].filter((l) => !named.has(l.id) && see(l.id));
  // Per section: its hubs, then its shops — the order Section 2's tabs are in.
  rest.sort((a, b) => (b.section - a.section) || ((a.type === "hub" ? 0 : 1) - (b.type === "hub" ? 0 : 1)) || (a.sort - b.sort));
  for (const l of rest) {
    out.push({
      key: `loc:${l.id}`, loc: l.id, section: l.section,
      kind: l.type === "hub" ? "hub" : "shop",
      label: l.type === "hub" ? `${l.name} Refill` : l.name,
    });
  }
  out.push(SOURCE_HISTORY_TAB);
  return out;
}

// Every Source tab key the registry yields, for the push deep link — which
// runs before anyone is signed in, so it cannot ask who the viewer is. The
// Source screen itself drops a tab the viewer's sections do not include.
export function sourceTabKeys(network) {
  return sourceTabsFor(network, null).map((t) => t.key);
}

// ─── INSIGHTS STORE FILTER ───────────────────────────────────────────────────
// The filter's values are the ones it has always used ("marathon-pe", "trophy",
// "pine"), plus "concrete". Each names a bucket of the day rollup
// (src/insights/rollupCodec.js storeBucketOf) — and the screen filters with
// that same function, so a count and the list beside it cannot disagree.
// A shop with no bucket of its own is counted under "other" and has no pill.
const INSIGHTS_FILTER_BY_SHOP = { "marathon-pe": "marathon-pe", trophy: "trophy", "marathon-pine": "pine", concrete: "concrete" };

// [["all","All"], ["marathon-pe","Marathon PE"], ["trophy","Trophy"], ["pine","Pine"], ["concrete","Concrete"]]
export function insightsStoreOptions(network, canSee, labelOf) {
  const out = [["all", "All"]];
  for (const l of [...storesOf(network)].sort(bySectionLegacyOrder)) {
    const value = INSIGHTS_FILTER_BY_SHOP[l.id];
    if (!value || (canSee && !canSee(l.id))) continue;
    out.push([value, labelOf ? labelOf(l.id) : l.name]);
  }
  return out;
}

// Filter value → the rollup bucket / totals key it reads.
export function insightsBucketKey(storeFilter) {
  return storeFilter === "marathon-pe" ? "pe" : storeFilter;
}

export function insightsStoreMatcher(storeFilter) {
  if (storeFilter === "all") return () => true;
  const key = insightsBucketKey(storeFilter);
  return (e) => !!e && storeBucketOf(e) === key;
}

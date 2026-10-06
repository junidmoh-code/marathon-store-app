// ─── PER-USER STORE ASSIGNMENT (Phase 15) ────────────────────────────────────
// Pure helpers for restricting which operational store(s) a staff member may
// place orders against. Kept React-free so they can be unit-tested directly and
// reused by both the admin UI (UserManagement) and the order flow (AssistantView).
//
// Data model — /users/{uid}.storeIds: string[] of STORE_IDS values.
//   • field ABSENT (legacy users)  → all-access (backward-compatible, no migration)
//   • field present, non-empty     → exactly those stores
//   • field present, empty []      → NO store access (order flow blocks)
//
// This scope is SEPARATE from marathon-pos-app's /users/{uid}/posAccess.storeIds —
// the two apps each track their own store scope.

// ─── ANSWERED FROM THE NETWORK REGISTRY (sections, 2026-10) ──────────────────
// These lists used to be typed here. They are now read off the registry
// (src/utils/networkRegistry.js), so a store the registry knows — Concrete —
// is a shop here without another edit, and the values this file has always
// handed out for Marathon PE, Trophy and Pine are the SAME values in the SAME
// order (stores.test.js pins that against the seed).
//
// The constants are built from the SEED, not the live /network node: they are
// evaluated once at import, before any read. Code that needs a location added
// later from the Network card uses the functions (shopIdsOf / shopLabelOf /
// shopUniverse), which ask the live registry.
import { SEED_REGISTRY, storesOf, locationOf } from "./networkRegistry";
import { currentNetwork } from "./networkStore";

// Today's order is Marathon PE, Trophy, Pine — Section 2 first. The registry
// sorts Section 1 first, so the order is restated here rather than inherited.
const shopsInOrder = (network) =>
  [...storesOf(network)].sort((a, b) => (b.section - a.section) || (a.sort - b.sort) || a.id.localeCompare(b.id));

// Pine has always been "Pine" on these screens; the registry calls it
// "Marathon Pine". Kept while the registry still carries that seed name, so a
// rename from the Network card shows up here.
const SHORT_SHOP_LABEL = { "marathon-pine": { when: "Marathon Pine", label: "Pine" } };

// The label of one shop. Unknown id → the id itself, never blank.
export function shopLabelOf(shopId, network = currentNetwork()) {
  const l = locationOf(network, shopId);
  if (!l || l.type !== "store") return shopId || "";
  const short = SHORT_SHOP_LABEL[l.id];
  return short && l.name === short.when ? short.label : l.name;
}

// Every shop id, Section 2 first (today's order), then Section 1.
export function shopIdsOf(network = currentNetwork()) {
  return shopsInOrder(network).map((l) => l.id);
}

// Map a physical shop id to its routing universe (central / pine / concrete).
// An UNKNOWN shop has no universe: null. It used to default to "central",
// which is Section 2 — with a wall between the sections, an unmapped Section 1
// shop quietly joining Marathon PE's routing is the dangerous direction, so it
// now joins nothing and the caller fails closed.
export function shopUniverse(shopId, network = currentNetwork()) {
  const l = locationOf(network, shopId);
  return l && l.type === "store" && l.universe ? l.universe : null;
}

const universesOf = (network) => [...new Set(shopsInOrder(network).map((l) => l.universe).filter(Boolean))];

// The operational stores an order can be placed against — the domain of
// /users/{uid}.storeIds. "central" (Marathon PE + Trophy), "pine", "concrete".
export const STORE_IDS = universesOf(SEED_REGISTRY);

// "central" is not a shop's name, so it is the one label that cannot be read
// off a shop; every other universe is named after its (first) shop.
export const STORE_LABELS = Object.fromEntries(STORE_IDS.map((u) => [
  u,
  u === "central" ? "Central" : shopLabelOf(shopsInOrder(SEED_REGISTRY).find((l) => l.universe === u).id, SEED_REGISTRY),
]));

// ─── SHOP ↔ ROUTING-UNIVERSE BRIDGE ──────────────────────────────────────────
// Two separate vocabularies meet here:
//   • SHOP ids (the /locations stock registry): marathon-pe, trophy,
//     marathon-pine, concrete — the physical shops staff actually stand in and
//     that hold sellable stock.
//   • ROUTING UNIVERSE (STORE_IDS above): central, pine, concrete — the
//     order-routing buckets.
//
// "Central" contains TWO physical shops (Marathon PE + Trophy); "pine" and
// "concrete" are one each. The assistant store toggle speaks the SHOP
// vocabulary (so an order records WHICH shop it's for, enabling warehouse→shop
// transfer recording on dispatch). The universe no longer picks the hub: that
// is the registry's back-stock map (src/utils/sectionRouting.js).
export const SHOP_TO_UNIVERSE = Object.fromEntries(shopsInOrder(SEED_REGISTRY).map((l) => [l.id, l.universe]));

// ─── PER-USER SINGLE-SHOP ASSIGNMENT (store-access restriction) ───────────────
// A staff user assigned a `destShop` on /users/{uid} sees & acts on ONLY that
// physical shop's orders — enforced at the DB level by the /orders rule (a scoped
// user's unscoped read is rejected). No destShop → warehouse/admin/super-admin/
// unassigned → full access. These are the real shops (== order.destShop).
export const SHOP_IDS = shopIdsOf(SEED_REGISTRY);
export const SHOP_LABELS = Object.fromEntries(SHOP_IDS.map((id) => [id, shopLabelOf(id, SEED_REGISTRY)]));

// Resolve the stores a user may actually place orders against.
//   • super-admin               → all stores (bypass, per ADMIN_EMAIL)
//   • no storeIds field (legacy) → all stores (backward-compatible)
//   • storeIds present           → that list, filtered to known stores
// An empty result means "no store access" — the caller should block the flow.
export function effectiveStoreIds(permRecord, isSuperAdmin = false) {
  if (isSuperAdmin) return [...STORE_IDS];
  const raw = permRecord?.storeIds;
  if (!Array.isArray(raw)) return [...STORE_IDS]; // legacy = all-access
  // Iterate STORE_IDS (not raw) so the result is deduped and canonically
  // ordered — a duplicated persisted value can't inflate length and fool the
  // single-store check downstream.
  return STORE_IDS.filter((s) => raw.includes(s));
}

// Compute the next storeIds array after toggling one store on/off.
// Seeds from all stores when the field is absent so a legacy (all-access) user
// who unchecks ONE store keeps access to the other — rather than collapsing to
// just the toggled store. Result is always filtered to known stores and ordered
// by STORE_IDS for stable persistence.
export function nextStoreIds(currentStoreIds, storeId, on) {
  const base = Array.isArray(currentStoreIds) ? currentStoreIds : [...STORE_IDS];
  const set = new Set(base.filter((s) => STORE_IDS.includes(s)));
  if (on) set.add(storeId);
  else set.delete(storeId);
  return STORE_IDS.filter((s) => set.has(s));
}

// Does this user place orders? Used to decide whether an empty store scope is a
// problem worth flagging. role "store_assistant" or the place_orders /
// store_assistant permissions all mean "takes orders".
export function placesOrders(user) {
  if (!user) return false;
  if (user.role === "store_assistant") return true;
  const perms = Array.isArray(user.permissions) ? user.permissions : [];
  return perms.includes("place_orders") || perms.includes("store_assistant");
}

// Warn on the admin row/detail when an order-taker has been locked out of every
// store (explicit empty array). Absent field is fine — that's all-access.
export function shouldWarnNoStore(user) {
  return Array.isArray(user?.storeIds) && user.storeIds.length === 0 && placesOrders(user);
}

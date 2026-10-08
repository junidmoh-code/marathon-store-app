// ─── DISPLAY CHECKS — FEATURE FLAGS + ACCESS GATE ─────────────────────────────
// The single policy surface for the Display Check module (clothing department).
// Nothing in the module decides who-can-see-what on its own: every gate in the
// module imports from HERE. No inline role checks anywhere else. This keeps the
// permission model in one auditable place and lets the eventual server-side
// callables (Phase 2) re-derive the exact same rules from `context.auth`.
//
// PR 1 is a SHELL. It reads NO data — no listeners, no get(), no callables. This
// file only decides visibility and manager access. The feature is dark until the
// master flag below is flipped by hand.
//
// ── SUPER-ADMIN ──────────────────────────────────────────────────────────────
// Super-admin is the Firebase admin account gunidmoh@gmail.com (NOT junidmoh@…).
// We import the ONE existing ADMIN_EMAIL constant rather than re-declaring the
// address, so there is a single source of truth for "who is super-admin".
//
// ── STORE SCOPE IS PART OF THE GATE ──────────────────────────────────────────
// The three stores run as separate feeds/rosters/marks. A manager for `trophy`
// must NOT see `marathon-pe` analytics. So `canManageDisplayChecks` takes the
// store being viewed and returns true only when the user's grant matches THAT
// store. Super-admin bypasses store scope (sees every store).
//
// ── INERT STAFF/MANAGER BRANCHES (no new user-model surface in PR 1) ──────────
// No `display_checks` or `display_manager` permission is seeded yet, so the
// non-super-admin branches below evaluate to FALSE for everyone today — Today +
// Availability are super-admin-only, Analytics + Settings are super-admin-only.
// That is expected and correct: seeding the permission later switches the gate
// on with NO code change. These branches read ONLY fields that already exist on
// /users/{uid} (`permissions` array + `destShop`) — they invent no new fields.
//
//   SHAPE THIS NEEDS TO GO LIVE (for Junid to seed in PR 0, not PR 1):
//     • base access  → add "display_checks"  to /users/{uid}.permissions
//     • manager tier → add "display_manager" to /users/{uid}.permissions
//     • store scope  → /users/{uid}.destShop === the shop id ("marathon-pe" |
//                       "trophy" | "marathon-pine")
//   This reuses the existing single-store `destShop`. It expresses a per-store
//   manager (which is what the design's independent PE/Trophy rosters need). It
//   CANNOT express one manager over two stores — if that's ever required, switch
//   the scope read to a `displayManagerStores: string[]` field instead. Flagged
//   for the owner; not decided here.

import { ADMIN_EMAIL } from "../components/PermissionsContext";
import { SEED_REGISTRY, storesOf, locationOf } from "../utils/networkRegistry";
import { currentNetwork } from "../utils/networkStore";

// ── FEATURE FLAGS ─────────────────────────────────────────────────────────────

// MASTER kill switch. Default OFF — nothing renders (no card, no route) until
// Junid flips this to true. Every visibility path is AND-ed with this.
export const DISPLAY_CHECKS_MASTER_ENABLED = true;

// Per-store enable flags. Phase 1 goes live at PE + Trophy; Pine is built but
// dark (flip to true, no code change). Keyed by the physical shop id used by
// /stock and /users.destShop.
//
// SECTIONS (2026-10): the flag IS the store's LIVE flag in the network
// registry. Marathon PE and Trophy are live, Pine is not — the same three
// answers this map always held — and Concrete is a store like any other: off
// until the owner marks it live on the Network card, on from that moment, no
// deploy. This constant is the seed's answer; isDisplayChecksStoreEnabled
// asks the live registry.
const flagsOf = (network) => Object.fromEntries(
  [...storesOf(network)].sort((a, b) => (b.section - a.section) || (a.sort - b.sort)).map((l) => [l.id, l.live === true]));
export const DISPLAY_CHECKS_STORE_FLAGS = flagsOf(SEED_REGISTRY);

// ── PER-STORE SWITCH + SCOPE (owner, 8 Oct 2026) ────────────────────────────
// /displayChecks_settings/{store}/enabled (boolean) and /scope ("clothing" |
// "all_but_sneakers"). An explicit `enabled` DECIDES for a registry store;
// absent, the store follows its LIVE flag (above). Scope absent = "clothing".
// Server mirror: functions/displayChecks/lib.cjs isTriggerStoreEnabled.
export const DISPLAY_SCOPES = Object.freeze(["clothing", "all_but_sneakers"]);
export const DISPLAY_SCOPE_LABELS = Object.freeze({ clothing: "Clothing and perfume", all_but_sneakers: "Everything except sneakers" });

// The switches as last read: { storeId: { enabled, scope } }. Filled by
// primeDisplayCheckSwitches (the Display Checks screen; App may call it too).
let switchCache = {};
const switchListeners = new Set();
export function currentDisplayCheckSwitches() { return switchCache; }
export function noteDisplayCheckSwitches(map) {
  switchCache = { ...switchCache, ...(map || {}) };
  for (const fn of switchListeners) fn(switchCache);
}
export function onDisplayCheckSwitchesChange(fn) { switchListeners.add(fn); return () => switchListeners.delete(fn); }
export function __resetDisplayCheckSwitchesForTests() { switchCache = {}; }

// Read each registry store's two small fields (never the roster). A store the
// viewer may not read (the rule scopes staff to their own store) is skipped.
export async function primeDisplayCheckSwitches(network = currentNetwork(), readField) {
  const read = readField || (async (path) => {
    const [{ ref, get }, { database }] = await Promise.all([import("firebase/database"), import("../firebase")]);
    return (await get(ref(database, path))).val();
  });
  const out = {};
  await Promise.all(storesOf(network).map(async (l) => {
    try {
      const [enabled, scope] = await Promise.all([
        read(`displayChecks_settings/${l.id}/enabled`), read(`displayChecks_settings/${l.id}/scope`),
      ]);
      out[l.id] = { enabled, scope };
    } catch { /* not readable by this viewer: the live rule decides */ }
  }));
  noteDisplayCheckSwitches(out);
  return out;
}

export function displayCheckSwitchOf(storeId, switches = currentDisplayCheckSwitches()) {
  const s = switches && switches[storeId];
  return {
    enabled: s && typeof s.enabled === "boolean" ? s.enabled : null,
    scope: s && DISPLAY_SCOPES.includes(s.scope) ? s.scope : "clothing",
  };
}

// The enabled stores, in order, from the live registry and the switches.
export function displayChecksEnabledStores(network = currentNetwork(), switches = currentDisplayCheckSwitches()) {
  const flags = flagsOf(network);
  return Object.keys(flags).filter((id) => {
    const s = displayCheckSwitchOf(id, switches);
    return s.enabled !== null ? s.enabled : flags[id] === true;
  });
}

// Every registry store, in the same order — the owner's picker, so a store
// that is switched off can be opened and switched on.
export function displayChecksAllStores(network = currentNetwork()) {
  return Object.keys(flagsOf(network));
}

// Permission strings the gate looks for. Neither is seeded yet (inert today).
export const DISPLAY_CHECKS_PERMISSION = "display_checks";   // base access
export const DISPLAY_MANAGER_PERMISSION = "display_manager"; // Analytics + Settings

// Is a given shop turned on for Display Checks? Unknown/absent shop → false.
export function isDisplayChecksStoreEnabled(storeId, network = currentNetwork(), switches = currentDisplayCheckSwitches()) {
  const l = locationOf(network, storeId);
  if (!l || l.type !== "store" || l.id !== storeId) return false;
  const s = displayCheckSwitchOf(storeId, switches);
  return s.enabled !== null ? s.enabled : l.live === true;
}

// ── GATES ─────────────────────────────────────────────────────────────────────
// Every gate takes a plain `user` = { email, permissions, destShop }. Callers
// build it from the auth user (email) + the /users/{uid} record (permissions,
// destShop). Pure + side-effect-free so the same logic is unit-testable and can
// be mirrored server-side later.

// The verified super-admin email. `user.email` comes from Firebase Auth, which
// is the only trusted identity signal (a /users record cannot forge it).
export function isDisplayChecksSuperAdmin(user) {
  return !!user && user.email === ADMIN_EMAIL;
}

// BASE ACCESS — may this user see the module (card, route, Today, Availability)
// for the store being viewed? Super-admin: always. Otherwise: holds the base
// permission AND is scoped to THIS store. Inert today (permission unseeded).
export function canUseDisplayChecks(user, storeId) {
  if (isDisplayChecksSuperAdmin(user)) return true;
  if (!storeId) return false; // non-super-admin access is always store-scoped
  const perms = Array.isArray(user?.permissions) ? user.permissions : [];
  return perms.includes(DISPLAY_CHECKS_PERMISSION) && user?.destShop === storeId;
}

// MANAGER TIER — may this user see Analytics + Settings for the store being
// viewed? THE single manager gate: every manager-only surface in the module
// calls this, no exceptions. Super-admin: always, every store. Otherwise: holds
// the manager permission AND is scoped to THIS store (a trophy manager fails for
// marathon-pe). Inert today (permission unseeded) → super-admin-only.
export function canManageDisplayChecks(user, storeId) {
  if (isDisplayChecksSuperAdmin(user)) return true;
  if (!storeId) return false; // manager tier is ALWAYS store-scoped
  const perms = Array.isArray(user?.permissions) ? user.permissions : [];
  return perms.includes(DISPLAY_MANAGER_PERMISSION) && user?.destShop === storeId;
}

// ROUTER CONVENIENCE — should the Home card + route be visible to this viewer?
// Composes master flag + base access + per-store enable. Super-admin sees the
// entry whenever the master flag is on (the store toggle lives inside the view);
// staff see it only for their own, enabled store.
export function displayChecksVisibleForViewer(user, storeId) {
  if (!DISPLAY_CHECKS_MASTER_ENABLED) return false;
  if (isDisplayChecksSuperAdmin(user)) return true;
  return canUseDisplayChecks(user, storeId) && isDisplayChecksStoreEnabled(storeId);
}

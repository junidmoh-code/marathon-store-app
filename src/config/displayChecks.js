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

// ── FEATURE FLAGS ─────────────────────────────────────────────────────────────

// MASTER kill switch. Default OFF — nothing renders (no card, no route) until
// Junid flips this to true. Every visibility path is AND-ed with this.
export const DISPLAY_CHECKS_MASTER_ENABLED = true;

// Per-store enable flags. Phase 1 goes live at PE + Trophy; Pine is built but
// dark (flip to true, no code change). Keyed by the physical shop id used by
// /stock and /users.destShop.
export const DISPLAY_CHECKS_STORE_FLAGS = {
  "marathon-pe": true,
  "trophy": true,
  "marathon-pine": false,
};

// Permission strings the gate looks for. Neither is seeded yet (inert today).
export const DISPLAY_CHECKS_PERMISSION = "display_checks";   // base access
export const DISPLAY_MANAGER_PERMISSION = "display_manager"; // Analytics + Settings

// Is a given shop turned on for Display Checks? Unknown/absent shop → false.
export function isDisplayChecksStoreEnabled(storeId) {
  return DISPLAY_CHECKS_STORE_FLAGS[storeId] === true;
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

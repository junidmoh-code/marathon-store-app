// ─── HUB SNEAKER COUNT — MASTER FLAG + ACCESS GATE ────────────────────────────
// TEMPORARY MODULE. This exists to run one physical sneaker stock-take at the
// hubs. When the count is finished, flip HUB_SNEAKER_COUNT_ENABLED to false and
// the whole feature goes dark — home card AND route, for everyone, in one line.
// Nothing else in the app depends on it, so deleting the module later is a clean
// removal (see the PR description for the removal checklist).
//
// Same shape as src/config/displayChecks.js on purpose: one policy surface, no
// inline role checks scattered through the module. Every gate in the feature
// imports from HERE.
//
// ── WHY ADMIN-ONLY ───────────────────────────────────────────────────────────
// Not a UI preference — the LIVE security rules decide this, and the UI merely
// agrees with them so the failure is visible before it happens:
//
//   /stock_movements/$mvId/type  → "adjustment" requires
//                                  users/{uid}/stockRole === 'admin'
//
// An Adjust IS an `adjustment` movement, so a counter signed in with
// stockRole 'warehouse' would be rejected by RTDB on every correction. Owner
// confirmed (2026-08-02) that counters sign in as admin, so the gate below
// matches the rule rather than papering over it. If that ever changes, the fix
// is a rules change in the console — NOT a widening of this gate.
//
// ── WHAT THIS FEATURE DOES NOT NEED ──────────────────────────────────────────
// No rules change of any kind. Verified against the LIVE rules (fetched from
// .settings/rules.json, not the local file, which is known to drift):
//   • stock cells      — written only via applyMovement (existing single writer)
//   • stock_movements  — `adjustment` + provenance in `link` (no $other deny)
//   • session state    — /settings/hubSneakerCount/** (/settings is already
//                        read: auth != null, write: any non-anon auth)

import { ADMIN_EMAIL } from "../components/PermissionsContext";

// ── THE MASTER FLAG ───────────────────────────────────────────────────────────
// Flip to false when the count is done. Nothing renders after that: no home
// card, no route, and the route guard bounces anyone holding a stale deep link.
export const HUB_SNEAKER_COUNT_ENABLED = true;

// How many product rows render per page. The count view is one-shot-read and
// fully client-side, and hub 2 alone holds cells for 1,971 products, so the list
// is paginated rather than rendered whole. Pagination (not windowing) because
// rows expand to a variable height when tapped — a windowed list would have to
// re-measure on every expand.
export const HUB_COUNT_PAGE_SIZE = 50;

// The one RTDB subtree this feature owns. Chosen because /settings is the only
// node the live rules let a signed-in app user write without a rules change.
export const HUB_COUNT_ROOT = "settings/hubSneakerCount";

// ── GATES ─────────────────────────────────────────────────────────────────────
// Pure and side-effect free — same testability contract as the Display Checks
// gates. `viewer` is { email, stockRole }, built by the caller from Firebase
// Auth (email — the only unforgeable signal) + the /users/{uid} record.

export function isHubCountSuperAdmin(viewer) {
  return !!viewer && viewer.email === ADMIN_EMAIL;
}

/** May this viewer open the count view and write counts? */
export function canUseHubSneakerCount(viewer) {
  if (!HUB_SNEAKER_COUNT_ENABLED) return false;
  if (isHubCountSuperAdmin(viewer)) return true;
  return viewer?.stockRole === "admin";
}

/**
 * May this viewer see the variance list?
 *
 * ⚠️ CLIENT-SIDE ONLY, and deliberately so. The session data lives under
 * /settings, which the live rules make readable to every signed-in user, so this
 * hides the variance list in the UI — it does not make the underlying numbers
 * unreadable to someone with a console. Enforcing it for real would need a rules
 * change, which is out of scope by instruction. Today it is moot in practice:
 * the whole module is already admin-gated by canUseHubSneakerCount above, so the
 * only people who can reach the view are the only people allowed to see variance.
 * It stays a separate function so widening access to counters later does NOT
 * accidentally widen access to variance.
 */
export function canSeeHubCountVariance(viewer) {
  return canUseHubSneakerCount(viewer);
}

/** Should the temporary home card render for this viewer? */
export function hubSneakerCountVisibleForViewer(viewer) {
  return canUseHubSneakerCount(viewer);
}

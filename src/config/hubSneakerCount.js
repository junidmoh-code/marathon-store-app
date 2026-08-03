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

/**
 * May this viewer OPEN the count view and record counts?
 *
 * WAREHOUSE IS IN (owner direction 2026-08-03: "they go in the card and count
 * what needs to be counted" — "they" being the hub staff, who sign in with
 * stockRole "warehouse", not "admin"). The original admin-only gate made the
 * card invisible on every tablet that would actually do the counting.
 *
 * What warehouse counters CAN do is bounded by the live rules, not by us:
 *   • CONFIRM a matching cell        → /settings write, open to any staff ✓
 *   • RECORD a mismatch (flag)       → /settings write, no stock change   ✓
 *   • APPLY a stock correction       → `adjustment` movement, rules demand
 *                                      stockRole "admin" — NOT warehouse  ✗
 * So staff record everything; the mismatches queue in Variance and an admin
 * applies them. See canAdjustHubCount below — that gate did not widen.
 */
export function canUseHubSneakerCount(viewer) {
  if (!HUB_SNEAKER_COUNT_ENABLED) return false;
  if (isHubCountSuperAdmin(viewer)) return true;
  return viewer?.stockRole === "admin" || viewer?.stockRole === "warehouse";
}

/**
 * May this viewer actually WRITE an adjustment?
 *
 * ⚠️ DELIBERATELY NOT the same gate as opening, and deliberately NOT satisfied by
 * being super-admin. The two questions have different answers because they are
 * decided in different places:
 *
 *   • OPENING the view is decided by this app, in JS.
 *   • WRITING is decided by the RTDB rules, which do not know ADMIN_EMAIL exists
 *     and read only the STORED record:
 *
 *       /stock/$loc/$pid/$size  .write  requires users/{uid}/stockRole to EXIST
 *       /stock_movements/$mvId/type     requires stockRole === 'admin'
 *                                       for an `adjustment`
 *
 * The app's super-admin shortcut is a CLIENT-side permissions bypass — it makes
 * hasPermission() return true for an email, and mints no stockRole. So being
 * super-admin is not, on its own, evidence that a write will be accepted: an
 * account can pass every UI gate here and still be refused by RTDB on every
 * correction, if its /users record carries no admin stockRole.
 *
 * This gate therefore asks the same question the rules will ask, and the view
 * shows a banner when the answer is no — so the refusal is visible at the door
 * rather than on the fortieth box. When it does fire, the fix is a stockRole
 * field on that user's /users record: an owner action in the console, NOT a
 * widening of this gate.
 *
 * Deliberately states no fact about any particular account. Stored roles change
 * without this file changing, so a claim about who currently holds what would be
 * stale the moment someone edits /users — and a comment asserting the wrong
 * thing is worse than no comment. (An earlier version of this block did exactly
 * that: it recorded, as verified fact, that a specific account had no /users
 * record. It did. The check below is the honest form of the question.)
 */
export function canAdjustHubCount(viewer) {
  if (!HUB_SNEAKER_COUNT_ENABLED) return false;
  return viewer?.stockRole === "admin";        // the STORED role, never the email shortcut
}


/** Should the temporary home card render for this viewer? */
export function hubSneakerCountVisibleForViewer(viewer) {
  return canUseHubSneakerCount(viewer);
}

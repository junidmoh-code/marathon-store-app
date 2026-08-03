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
 * May this viewer OPEN the count view? (Reading, and the variance list.)
 * Super-admin always; otherwise a real admin stock role.
 */
export function canUseHubSneakerCount(viewer) {
  if (!HUB_SNEAKER_COUNT_ENABLED) return false;
  if (isHubCountSuperAdmin(viewer)) return true;
  return viewer?.stockRole === "admin";
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

/**
 * May this viewer see the variance list?
 *
 * ⚠️ CLIENT-SIDE ONLY, and weaker than it looks. Session data lives under
 * /settings, whose live rules are:
 *
 *   .read   auth != null                    ← includes ANONYMOUS auth
 *   .write  auth != null && non-anonymous   ← any staff account, any stockRole
 *
 * The read gate matters because this app deliberately runs anonymous sessions on
 * the TV displays, so "signed-in staff only" is not what `auth != null` buys.
 * And because there is no child validation, any non-anonymous account — a POS or
 * warehouse user who cannot write a single adjustment — can overwrite the
 * counted records or the session node outright. The count PROGRESS and VARIANCE
 * are therefore convenience state, NOT tamper-evident audit.
 *
 * The audit record is /stock_movements, which IS rule-protected and carries the
 * whole count in `link.count*` — every adjustment is independently reconstructible
 * from the ledger without trusting /settings at all.
 *
 * Making the count data itself private and tamper-proof needs one hand-written
 * console rule on settings/hubSneakerCount (read+write gated to
 * stockRole === 'admin'). Flagged to the owner; not done here, because rules are
 * managed by hand and this branch is forbidden from touching them.
 */
export function canSeeHubCountVariance(viewer) {
  return canUseHubSneakerCount(viewer);
}

/** Should the temporary home card render for this viewer? */
export function hubSneakerCountVisibleForViewer(viewer) {
  return canUseHubSneakerCount(viewer);
}

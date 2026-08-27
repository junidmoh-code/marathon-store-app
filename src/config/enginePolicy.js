// ─── ENGINE POLICY — WHO MAY SEE IT ───────────────────────────────────────────
//
// ONE function, used by BOTH client gates, so the home tile and the route can
// never disagree about who is allowed in. (They are still two independent
// gates: each calls this separately and each fails closed on its own. Deleting
// either one leaves the other working — that is checked by mutation proof, not
// by a comment.)
//
// ── TWO WAYS IN, AND ONLY TWO ────────────────────────────────────────────────
// 1. The owner's Firebase Auth email (ADMIN_EMAIL).
// 2. An account carrying the `engine_policy` permission — read from the
//    permFlags MIRROR, not from the permissions array.
//
// Nothing else. No stockRole, no role, no store scope, no other permission.
//
// ── WHY IT WAS EMAIL-ONLY UNTIL 2026-08-27, AND WHY THAT CHANGED ─────────────
// The original gate was `viewer.email === ADMIN_EMAIL` and nothing else. The
// stated reason was that Junid's own /users record has NO permissions array —
// his access works only because hasPermission() short-circuits on ADMIN_EMAIL
// before it ever looks at the array — so a gate written as
// hasPermission("engine_policy") would have locked out the one person the
// screen existed for.
//
// That reason is still true, and it is why the owner branch is FIRST and is
// tested on the Auth email alone: the owner clause never consults the /users
// record at all. The permission is added BESIDE it, not in place of it, so the
// owner keeps working with an empty record and a second person can be let in
// without a deploy (owner request, 2026-08-27 — MC).
//
// ── WHY permFlags AND NOT THE permissions ARRAY ──────────────────────────────
// The same signal the SERVER reads (see assertEnginePolicy in functions/
// index.js) and the same shape an RTDB rule can read: a scalar at
// /users/{uid}/permFlags/engine_policy. Reading the array here and the flag
// there would let a client answer and a server answer drift; reading the same
// field means they cannot. Both are written in one update() by the staff
// editor — see permFlagsFor in src/components/permissionCatalog.js.
//
// It is also the field that is hardest to fake: /users is writable ONLY by the
// super-admin email (live rule, checked 2026-08-23), so a staff member can no
// more grant themselves this flag than a stockRole.
//
// ── AND IT IS NOT A SECURITY BOUNDARY ────────────────────────────────────────
// Say it plainly: this runs in the browser, and anyone can edit their own
// JavaScript. It stops the wrong person opening the screen; it does not stop a
// determined one writing the policy node.
//
// Be precise about what that hole is, because an earlier version of this comment
// asserted that the root RTDB rules were `auth !== null` for read AND write and
// that /config carried no tighter rule. That was never verified against
// anything: it was repeated from the brief this feature was built to, and BOTH
// the live rules AND the repo's own database.rules.json already said otherwise.
// Checked 2026-08-21 via /.settings/rules.json:
//
//   • no root ".read" and no root ".write" at all — unmatched paths DENY
//   • /config          ".read":  auth != null && sign_in_provider != 'anonymous'
//   • /config/refillEngine ".write": …the same, AND
//     root.child('users').child(auth.uid).child('stockRole').val() === 'admin'
//
// So the policy node is writable by any stockRole 'admin' account — four of
// them on the live /users node today (Ibrahim, Ahmed, Mike, 2POS) — not by
// every signed-in staff member, and not by nobody. Note what that means for
// this change: the people who could already write the node directly are NOT the
// people this permission admits, and granting it adds no RTDB write of its own.
// Every change on the Categories tab goes through the callable. (The Seating
// tab is the one exception and is handled explicitly — see
// enginePolicySeatingWritable below.)
//
// The console rule printed by scripts/print-engine-policy-rule.mjs narrows
// those four to one; it is not live yet. The third gate — setCategoryPolicy's
// own server-side check — is the only one an attacker cannot reach around, and
// even it is bypassed by writing the node directly until then.

import { ADMIN_EMAIL } from "../components/PermissionsContext";

// The permission key. Mirrored in src/components/permissionCatalog.js (what the
// editor can grant) and in VALID_PERMISSIONS in functions/index.js (what
// createStaffUser will accept). All three must agree — pinned by test.
export const ENGINE_POLICY_PERMISSION = "engine_policy";

// `viewer` is { email, permFlags } — the email from the Firebase Auth user
// (never from the /users record), permFlags from the /users record itself.
// Absent, anonymous, or an account without the flag: false.

// ─── SEATING WRITES ARE A DIFFERENT QUESTION ─────────────────────────────────
// Everything on the Categories tab goes through the setCategoryPolicy callable,
// which writes with the Admin SDK — so `engine_policy` alone is enough for it.
//
// THE SEATING TAB DOES NOT. Switch off, Move and switch off, and Re-seat write
// /stock_targets and /stock STRAIGHT FROM THE BROWSER (seatingStore.js →
// applyMovement), and the live rules ask for something this permission
// deliberately does not carry:
//
//   /stock_targets/$loc/$pid/$size  .write  … stockRole === 'admin'
//   /stock/$loc/$pid/$size          .write  … stockRole exists
//
// So a grantee without a stockRole would open the card, work happily through
// every category, then tap Switch off and collect a raw PERMISSION_DENIED. The
// codebase already names that exact failure mode — UserManagement warns that
// granting a stock permission with no stockRole "would open the screen but
// silently block every write" — and this permission opts out of the stockRole
// auto-link ON PURPOSE, because linking one would hand over the engine kill
// switch, /locations and every /config branch.
//
// The answer is therefore neither to auto-link a stockRole nor to let the
// buttons fail: it is to ASK THE SAME QUESTION THE RULES ASK, and say so in
// words. MC happens to hold stockRole 'admin' already (from the Shopify
// Publishing grant, 2026-08-23), so he never meets this — which is exactly why
// it has to be handled now rather than found by the next grantee.
//
// Read is not gated: /stock_targets and /stock are readable by any signed-in
// non-anonymous account, so the tab still SHOWS where a product sits.
export function enginePolicySeatingWritable(viewer) {
  if (!viewer) return false;
  if (viewer.email === ADMIN_EMAIL) return true;
  // Not "has a stockRole" — 'admin', because /stock_targets asks for 'admin'
  // and a switch-off writes a target row before it writes a cell.
  return viewer.stockRole === "admin";
}

// ─── AND MOVING IS NOT SWITCHING OFF ─────────────────────────────────────────
// The first version of the gate above stood over all three buttons at once and
// demanded 'admin' for every one of them. That is right for Switch off, for
// Re-seat, and for Move-and-switch-off with the tick left in — all three write
// /stock_targets. It is WRONG for the fourth thing this screen can do.
//
// Un-tick "Switch off {label}" and the action becomes Move only, which calls
// applyMovement and nothing else: /stock and /stock_movements, no target row
// (seatingStore.js — `if (!alsoSwitchOff) return` lands before switchOff). The
// rules ask less of it:
//
//   /stock/$loc/$pid/$size            .write     … stockRole EXISTS
//   /stock_movements/$mv/type         .validate  … 'transfer_out' needs
//                                                  warehouse | store | admin
//
// So a grantee holding stockRole 'store' may legitimately move the stock and
// may not switch the shop off — and the coarse gate told them they could do
// neither, in a sentence claiming they lacked stock access altogether. Refusing
// someone who would have succeeded is a smaller harm than offering a button
// that fails, but it is still a wrong answer, and this screen is not allowed to
// give one. (Adversarial re-review, PR #469.)
export function enginePolicySeatingMovable(viewer) {
  if (!viewer) return false;
  if (viewer.email === ADMIN_EMAIL) return true;
  // The movement rule's own list, in its own order. `p` roles (POS) are absent
  // deliberately: they may record a sale, not a transfer.
  return ["admin", "warehouse", "store"].includes(viewer.stockRole);
}

export function enginePolicyVisibleForViewer(viewer) {
  if (!viewer) return false;
  // Gate A — the owner, on the Auth email alone. Deliberately consults nothing
  // else: his /users record carries no permissions array to consult.
  if (viewer.email === ADMIN_EMAIL) return true;
  // Gate B — the named grant. `=== true` and not a truthy test: the flag is
  // written as a boolean, and anything else arriving here is not a grant.
  return viewer.permFlags?.[ENGINE_POLICY_PERMISSION] === true;
}

export { ADMIN_EMAIL };

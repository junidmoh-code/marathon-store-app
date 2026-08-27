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
// The card writes nothing directly; every change goes through the callable.
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

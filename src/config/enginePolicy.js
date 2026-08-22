// ─── ENGINE POLICY — WHO MAY SEE IT ───────────────────────────────────────────
//
// ONE function, used by BOTH client gates, so the home tile and the route can
// never disagree about who is allowed in. (They are still two independent
// gates: each calls this separately and each fails closed on its own. Deleting
// either one leaves the other working — that is checked by mutation proof, not
// by a comment.)
//
// ── WHY EMAIL AND NOT A PERMISSION ───────────────────────────────────────────
// Junid's own /users record has NO permissions array. His access to everything
// works only because hasPermission() short-circuits on the hardcoded
// ADMIN_EMAIL constant before it ever looks at the array. A gate written as
// hasPermission("engine_policy") would therefore lock out the one person this
// screen exists for, while opening it to anyone that permission was later
// granted to — the exact inverse of what is wanted.
//
// So the identity signal is the Firebase Auth email, which is the only one a
// /users record cannot forge. Staff sign in as {username}@marathon.internal
// under Phase 1 auth and can never match a gmail.com address, whatever their
// permissions array or stockRole says. There is no stockRole, no permission and
// no store scope that opens this screen. That is deliberate: the category map
// governs what every shop in the network keeps on its shelves, and a wrong
// number in it is felt everywhere before anybody notices.
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
// every signed-in staff member, and not by nobody.
//
// The console rule printed by scripts/print-engine-policy-rule.mjs narrows
// those four to one; it is not live yet. The third gate — setCategoryPolicy's
// own server-side email check — is the only one an attacker cannot reach
// around, and even it is bypassed by writing the node directly until then.

import { ADMIN_EMAIL } from "../components/PermissionsContext";

// `viewer` is { email } — built from the Firebase Auth user, never from the
// /users record. Absent, anonymous, staff, or any other Google account: false.
export function enginePolicyVisibleForViewer(viewer) {
  return !!viewer && viewer.email === ADMIN_EMAIL;
}

export { ADMIN_EMAIL };

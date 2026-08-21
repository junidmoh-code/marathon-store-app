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
// Be precise about what that hole actually is, because an earlier version of
// this comment was confidently wrong about it. Live RTDB rules (checked
// 2026-08-21) have NO root ".read" or ".write" — unmatched paths deny — and
// /config/refillEngine is already gated on stockRole 'admin'. So the node is
// writable by four staff accounts, not by everyone and not by nobody. The
// console rule printed by scripts/print-engine-policy-rule.mjs narrows those
// four to one; it is not live yet.
//
// The third gate — setCategoryPolicy's own server-side email check — is the
// only one an attacker cannot reach around, and even it is bypassed by writing
// /config/refillEngine/categoryPolicy directly until that rule is pasted.

import { ADMIN_EMAIL } from "../components/PermissionsContext";

// `viewer` is { email } — built from the Firebase Auth user, never from the
// /users record. Absent, anonymous, staff, or any other Google account: false.
export function enginePolicyVisibleForViewer(viewer) {
  return !!viewer && viewer.email === ADMIN_EMAIL;
}

export { ADMIN_EMAIL };

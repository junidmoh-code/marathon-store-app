// ─── ONE TILL'S DAILY SLIP: WHO MAY SEND IT ──────────────────────────────────
// Junid, 16 Oct 2026: two staff members each send the evening card slip for
// ONE till — a photo of the speedpoint slip and the card total it prints, and
// nothing else. They see nothing back. The `card_recon` permission is the
// wrong grant for that: it is store-wide (every till in the account's
// section), and it is the key to the manager's capture screen and the mailbox
// feed. This is narrower: a list of TILLS.
//
// WHERE IT LIVES: /users/{uid}/cardSlipTills/{storeId}/{tillId} = true.
//   • /users is writable by the owner alone (live rule), so nobody grants
//     themselves a till; scripts/cardrecon/grant-card-slip-tills.mjs writes it
//     with the Admin SDK.
//   • It is a TILL, not a terminal. A machine moves between tills (placements,
//     lib/card-terminal-placements.cjs); the person is responsible for the till
//     they work at. Which terminal that is, is the registry's answer at the
//     moment of the submission.
//   • Separate from `permissions` / `permFlags`, which the User Management
//     screen rewrites wholesale — editing someone's other permissions there
//     never touches this.
//
// THE SERVER DECIDES (cardBatchCapture, action "slip"): a till outside the list
// is refused there, whatever a screen offered. Fail closed: an unreadable or
// malformed list allows nothing.
"use strict";

const SLIP_SCOPE_FIELD = "cardSlipTills";

// The same shape the registry's own ids have ("pe", "trophy", "till-2").
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/**
 * The tills a stored scope grants, as "storeId/tillId" strings. Anything that
 * is not exactly `{ store: { till: true } }` grants nothing.
 * @returns {string[]}
 */
function readSlipScope(raw) {
  const out = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [storeId, tills] of Object.entries(raw)) {
    if (!ID_RE.test(storeId) || !tills || typeof tills !== "object" || Array.isArray(tills)) continue;
    for (const [tillId, on] of Object.entries(tills)) {
      if (on === true && ID_RE.test(tillId)) out.push(`${storeId}/${tillId}`);
    }
  }
  return out.sort();
}

/** Does the scope include the till `place` ({ storeId, tillId }) stands for? */
function slipScopeAllows(scope, place) {
  if (!Array.isArray(scope) || !place || !ID_RE.test(String(place.storeId || "")) || !ID_RE.test(String(place.tillId || ""))) return false;
  return scope.includes(`${place.storeId}/${place.tillId}`);
}

module.exports = { SLIP_SCOPE_FIELD, readSlipScope, slipScopeAllows };

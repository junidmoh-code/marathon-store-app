// ─── THE CONSOLE RULE THIS FEATURE NEEDS — PRINTS IT, PASTES NOTHING ─────────
//
// database.rules.json in this repo is STALE and console-managed. Deploying it
// would REGRESS the live rules. So this script prints the exact text to paste
// and does nothing else — no deploy, no write.
//
// ── WHAT IS ACTUALLY LIVE (read 2026-08-21, from /.settings/rules.json) ──────
// An earlier version of this file — and four other headers in this feature —
// claimed the root rules were `".read": "auth !== null", ".write": "auth !== null"`
// and that /config carried no tighter rule of its own. THAT WAS WRONG. It was
// taken from the stale repo copy instead of from live, and it was wrong in both
// directions at once. What is actually live:
//
//   • The rules object has NO root ".read" and NO root ".write" at all.
//     Unmatched paths therefore DENY by default, rather than allow.
//   • /config                ".read":  auth != null && sign_in_provider != 'anonymous'
//   • /config/refillEngine   ".write": auth != null && sign_in_provider != 'anonymous'
//                                      && root.child('users').child(auth.uid)
//                                           .child('stockRole').val() === 'admin'
//
// So the policy node is NOT writable by "any signed-in staff account". It is
// writable by any account holding stockRole 'admin' — measured on the live
// /users node on 2026-08-21 that is FOUR accounts: Ibrahim, Ahmed, Mike, 2POS.
// Any of them can change what every shop keeps on its shelves, and the kill
// switch with it, straight from a tablet, bypassing this feature's three gates
// and every safeguard behind them: no validation, no drift check, no rollback
// snapshot, no audit entry.
//
// A much smaller hole than the one previously described, and a much more
// precise one. It is still a hole, and it is why this rule exists.
//
// ── WHAT THIS RULE CHANGES, AND WHAT IT DELIBERATELY DOES NOT ────────────────
//   /config/refillEngine   — REPLACES the stockRole gate with the owner's
//                            email. Four accounts become one.
//   /engine_policy_history — NEW node. Readable by any signed-in non-anonymous
//                            session; writable by NOBODY. Every entry is
//                            written by the setCategoryPolicy callable through
//                            the Admin SDK, which is not subject to rules, so
//                            no client needs write access — and an audit trail
//                            a client can rewrite is not an audit trail.
//                            ".indexOn" on "at" so the history read is a query
//                            rather than a download.
//
//   /config ".read" IS NOT TOUCHED. The live rule already excludes anonymous
//   sessions and is correct as it stands. An earlier draft of this script
//   printed `".read": "auth !== null"` for /config and instructed the owner to
//   merge it in — which would have GRANTED ANONYMOUS SESSIONS READ ACCESS to
//   the whole engine config, kill switches included. Printing a rule is not a
//   safe operation just because a human is the one who pastes it.
//
// Run: node scripts/print-engine-policy-rule.mjs

const ADMIN_EMAIL = "gunidmoh@gmail.com";

// Replaces the existing ".write" under the EXISTING "config": { "refillEngine": … }
// block. Everything else under /config stays exactly as it is.
const RULE_REFILL_ENGINE = `
"refillEngine": {
  ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && auth.token.email === '${ADMIN_EMAIL}'"
}
`.trim();

// A NEW top-level node, alongside "config", "orders" and the rest.
const RULE_HISTORY = `
"engine_policy_history": {
  ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
  ".write": false,
  ".indexOn": ["at"]
}
`.trim();

const indent = (s) => s.split("\n").map((l) => `     ${l}`).join("\n");

console.log(`
════════════════════════════════════════════════════════════════════════════════
  PASTE INTO THE FIREBASE CONSOLE — Realtime Database → Rules
  Do NOT deploy database.rules.json from this repo; it is stale and would
  regress live.
════════════════════════════════════════════════════════════════════════════════

1) REPLACE the existing "refillEngine" block inside "config".
   It currently reads:

     "refillEngine": {
       ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && root.child('users').child(auth.uid).child('stockRole').val() === 'admin'"
     }

   Replace it with:

${indent(RULE_REFILL_ENGINE)}

   Leave "config" > ".read" exactly as it is. It already excludes anonymous
   sessions and needs no change.


2) ADD this new top-level node, alongside "config" and "orders":

${indent(RULE_HISTORY)}

────────────────────────────────────────────────────────────────────────────────
  WHAT THIS COSTS YOU

  • Four accounts lose the ability to write engine config: Ibrahim, Ahmed, Mike
    and 2POS — everyone with stockRole 'admin' as of 2026-08-21. That includes
    the kill switch (ruleBasedTargets), maxIntentsPerRun and the footwear
    switches, not just the category map. That is the intent; check nobody is
    relying on it. Nothing in this repo writes engine config from a staff
    session.

  • The Cloud Functions are unaffected either way. The scan and
    setCategoryPolicy both use the Admin SDK, which bypasses rules entirely.

  AFTER PUBLISHING, verify from a stockRole-admin staff session that a direct
  write to /config/refillEngine/categoryPolicy is refused. Until you have seen
  that refusal with your own eyes, treat this feature's three gates as an
  operational control — they stop the wrong person opening the screen — and not
  as a security boundary.
════════════════════════════════════════════════════════════════════════════════
`);

// ─── THE CONSOLE RULE THIS FEATURE NEEDS — PRINTS IT, PASTES NOTHING ─────────
//
// database.rules.json in this repo is STALE and console-managed. Deploying it
// would REGRESS the live rules. So this script prints the exact text to paste
// and does nothing else — no deploy, no write, not even a read.
//
// ── WHY IT IS NEEDED ─────────────────────────────────────────────────────────
// The root rules on this database are `".read": "auth !== null"` and
// `".write": "auth !== null"`, and /config has no tighter rule of its own. So
// TODAY, any signed-in staff account can write
// /config/refillEngine/categoryPolicy straight through the client SDK: no
// validation, no drift check, no rollback snapshot, no audit entry, and none of
// the three gates in the Engine Policy feature involved at any point.
//
// Those three gates are an operational control — they stop the wrong person
// stumbling into the screen. They are NOT a security boundary until this rule
// is live. Say that plainly to anyone who asks.
//
// ── WHAT IT DOES ─────────────────────────────────────────────────────────────
//   /config/refillEngine   — writable ONLY by gunidmoh@gmail.com; readable by
//                            any signed-in session, unchanged (the scan, Solve,
//                            Health and the card all read it).
//   /engine_policy_history — the audit trail and rollback snapshots. Readable
//                            by any signed-in session so the card can render
//                            the history list and its one-tap revert. WRITABLE
//                            BY NOBODY: every entry is written by the
//                            setCategoryPolicy callable through the Admin SDK,
//                            which bypasses rules entirely, so no client needs
//                            write access — and an audit trail a client can
//                            rewrite is not an audit trail. `false` is
//                            therefore both the strictest rule available and
//                            the exactly-correct one, with nothing to weaken
//                            later for a legitimate caller.
//
// Run: node scripts/print-engine-policy-rule.mjs

const ADMIN_EMAIL = "gunidmoh@gmail.com";

const RULE = `
"config": {
  ".read": "auth !== null",
  "refillEngine": {
    ".write": "auth.token.email === '${ADMIN_EMAIL}'"
  }
},

"engine_policy_history": {
  ".read": "auth !== null",
  ".write": false,
  ".indexOn": ["at"]
}
`.trim();

console.log(`
════════════════════════════════════════════════════════════════════════════════
  PASTE INTO THE FIREBASE CONSOLE — Realtime Database → Rules
  Merge these two blocks into the EXISTING rules object. Do NOT deploy
  database.rules.json from this repo; it is stale and would regress live.
════════════════════════════════════════════════════════════════════════════════

${RULE}

────────────────────────────────────────────────────────────────────────────────
  THREE THINGS TO CHECK BEFORE YOU PUBLISH

  1. /config already has a rule in the live tree. If it does, ADD the
     "refillEngine" child and the ".read" line into it rather than replacing
     the whole block — something else may depend on what is there.

  2. ".write" on /config/refillEngine locks the WHOLE engine config to the
     owner's account, not just the category map. That includes the kill switch
     (ruleBasedTargets), maxIntentsPerRun and the footwear switches. That is
     intended — none of those should be writable by a shop tablet — but it does
     mean any script or screen that writes engine config from a staff session
     will start failing. Nothing in this repo does today.

  3. ".write": false on /engine_policy_history refuses EVERY client, the owner
     included. That is correct: the entries are written by the
     setCategoryPolicy Cloud Function through the Admin SDK, which is not
     subject to rules. If a future screen ever needs to write there directly,
     the right move is to route it through the callable, not to loosen this.

  AFTER PUBLISHING, verify from a staff session that a direct write to
  /config/refillEngine/categoryPolicy is refused. Until you have seen that
  refusal, treat the in-app gates as convenience, not security.
════════════════════════════════════════════════════════════════════════════════
`);

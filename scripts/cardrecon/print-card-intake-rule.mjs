// ─── THE RULE JUNID MUST PASTE, AND EXACTLY WHERE ────────────────────────────
// database.rules.json in this repo is NOT deployed and must not be edited — the
// repo copy is stale and deploying it would REGRESS the live rules. Card recon's
// existing blocks were merged into the LIVE document through the
// .settings/rules.json REST endpoint (docs/CARD-RECON.md), and these two new
// nodes go in the same way, by hand, in the Firebase console.
//
//   node scripts/cardrecon/print-card-intake-rule.mjs
console.log(`
────────────────────────────────────────────────────────────────────────────
PASTE INTO: Firebase console → Realtime Database → Rules
WHERE:      at the TOP LEVEL, as siblings of "card_batches" — NOT inside /pos,
            and NOT inside /config.
────────────────────────────────────────────────────────────────────────────

"card_batch_intake": {
  ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && (auth.token.email === 'gunidmoh@gmail.com' || root.child('users').child(auth.uid).child('permFlags').child('card_recon').val() === true)",
  ".write": "false",
  ".indexOn": ["at"]
},
"card_batch_poll_status": {
  ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && (auth.token.email === 'gunidmoh@gmail.com' || root.child('users').child(auth.uid).child('permFlags').child('card_recon').val() === true)",
  ".write": "false"
},
"card_batch_intake_seen": {
  ".read": "auth != null && auth.token.email === 'gunidmoh@gmail.com'",
  ".write": "false"
}

────────────────────────────────────────────────────────────────────────────
WHY EACH LINE IS WHAT IT IS

".read" on card_batch_intake — WIDER than /card_batches on purpose, and only
  just. /card_batches is owner-only because it holds masked PANs, auth codes,
  RRNs and a per-till variance. This node holds NONE of that: a message's
  sender, subject and time, a file name, and an outcome per attachment. It is
  read by exactly the people who capture slips (the card_recon permission), so
  that a terminal quietly failing to reconcile is VISIBLE to them instead of
  being a silence only the owner could ever notice — which is the whole reason
  the feed exists. Anonymous sign-ins (the TV board) are excluded.

".write": "false" on BOTH — the poller writes with the Admin SDK, which
  bypasses rules entirely. A false write rule is therefore not a restriction on
  the writer; it is a guarantee that NOTHING ELSE can write here. Without it,
  and being top-level nodes, they would answer to no rule at all.

card_batch_poll_status is the HEARTBEAT — one small node, overwritten by the
  poller every tick including the ticks that find nothing. It is readable by the
  same people as the feed because without it a quiet mailbox and a dead poller
  are the same empty panel, and "no refusals" from a poller that stopped hours
  ago is the most dangerous thing that panel could imply. It holds counts and a
  timestamp; no message content.

card_batch_intake_seen is the dedupe ledger — one tiny row per message, no
  content. Owner-only because nobody needs to read it; the poller does not
  read it through rules either.

".indexOn": ["at"] — the Card recon tab reads the tail of this feed with
  orderByChild("at").limitToLast(n). Without the index the database sorts it in
  memory on every read and warns; with it, the read is bounded at the server.
  (The keys are push ids, which are already chronological — the explicit "at"
  ordering is what survives a record being written by a run whose claim was
  retaken, and it is what the tab asks for.)

AFTER PASTING, verify from the app: the Card recon tab's "Emailed slips" panel
should populate for a card_recon holder and show the permission notice for a
staff member without the flag. THREE nodes go in, not two — a missing
card_batch_poll_status leaves the panel unable to tell a quiet mailbox from a
stopped poller, which is the one thing it exists to say.
`);

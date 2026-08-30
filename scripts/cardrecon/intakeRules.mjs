// ─── THE THREE INTAKE NODES' RULES — ONE DEFINITION ──────────────────────────
// Printed for pasting (print-card-intake-rule.mjs) AND applied to the live
// document (apply-card-intake-rules.mjs) from HERE, so the rule Junid is shown
// and the rule that is actually live cannot be two different things. They were
// two different things for exactly one commit, which is one more than a rule
// governing who can read investigation material about named staff deserves.
//
// `database.rules.json` in this repo is NOT deployed and must not be edited:
// the repo copy is stale, and deploying it would REGRESS the live rules. These
// go in through the `.settings/rules.json` REST endpoint, the same way the
// card-recon nodes did (scripts/merge-card-recon-top-level-rules.mjs) — live
// fetch, timestamped backup, merge in memory, diff, write, re-fetch, verify,
// restore on any surprise. NEVER `firebase deploy --only database`.

export const OWNER = "gunidmoh@gmail.com";

const ownerOnly = `auth != null && auth.token.email === '${OWNER}'`;
// Everyone who captures a slip, and nobody else. Anonymous sign-ins (the TV
// board) are excluded explicitly rather than by assuming no anonymous client
// will ever hold a permFlag.
const cardReconHolder =
  `auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && ` +
  `(auth.token.email === '${OWNER}' || root.child('users').child(auth.uid).child('permFlags').child('card_recon').val() === true)`;

export const INTAKE_RULE_BLOCKS = {
  // What the mailbox poller did with each emailed PDF: a sender, a subject, a
  // file name, and recorded-or-why-not. No lines, no PANs — and no FIGURES,
  // which is not free: the refusal sentences quote them, so every amount is
  // struck out on the way in (redactMoney in intakeCore.mjs). The evidence
  // itself stays in /card_batches, which is owner-only.
  card_batch_intake: {
    ".read": cardReconHolder,
    ".write": "false",
    // The tab reads the tail with orderByChild("at").limitToLast(n).
    ".indexOn": ["at"],
  },
  // The heartbeat: one small node saying when the mailbox was last checked.
  card_batch_poll_status: {
    ".read": cardReconHolder,
    ".write": "false",
  },
  // The dedupe ledger — one tiny row per message, no content, read by nobody.
  card_batch_intake_seen: {
    ".read": ownerOnly,
    ".write": "false",
  },
};

// Why each line is what it is. Printed under the block for the person pasting
// it, and kept beside the rules themselves so the reasoning cannot drift away
// from what it explains.
export const RATIONALE = `
".read" on card_batch_intake — WIDER than /card_batches on purpose, and only
  just. /card_batches is owner-only because it holds masked PANs, auth codes,
  RRNs and a per-till variance. This node holds NONE of that: a message's
  sender, subject and time, a file name, and an outcome per attachment.

  THAT IS A PROPERTY OF THE WRITER, NOT A HOPE. The refusal sentences it stores
  are written for the person holding the slip and quote the figures — "the
  lines add up to R… but the slip's own total is R…", and the variance sentence
  itself — so every amount is struck out before it is stored (redactMoney in
  scripts/cardrecon/intakeCore.mjs, tested against the real validators' own
  output). Counts, terminal ids and batch numbers stay: they are what makes a
  refusal actionable and they are not what /card_batches is protected for. If
  that redaction is ever removed, THIS GRANT MUST GO BACK TO OWNER-ONLY. It is
  read by exactly the people who capture slips (the card_recon permission), so
  that a terminal quietly failing to reconcile is VISIBLE to them instead of
  being a silence only the owner could ever notice — which is the whole reason
  the feed exists. Anonymous sign-ins (the TV board) are excluded.

card_batch_poll_status is the HEARTBEAT — one small node, overwritten by the
  poller every tick including the ticks that find nothing. It is readable by the
  same people as the feed because without it a quiet mailbox and a dead poller
  are the same empty panel, and "no refusals" from a poller that stopped hours
  ago is the most dangerous thing that panel could imply. It holds counts and a
  timestamp; no message content.

card_batch_intake_seen is the dedupe ledger — one tiny row per message, no
  content. Owner-only because nobody needs to read it; the poller does not read
  it through rules either.

".write": "false" on ALL THREE — the poller writes with the Admin SDK, which
  bypasses rules entirely. A false write rule is therefore not a restriction on
  the writer; it is a guarantee that NOTHING ELSE can write here. Without it,
  and being top-level nodes, they would answer to no rule at all.

".indexOn": ["at"] — the Card recon tab reads the tail of the feed with
  orderByChild("at").limitToLast(n). Without the index the database sorts it in
  memory on every read and warns; with it, the read is bounded at the server.
`.trim();

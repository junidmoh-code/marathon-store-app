// ─── THE THREE INTAKE NODES' RULES, AS TEXT ──────────────────────────────────
// APPLIED LIVE 2026-08-30 by scripts/cardrecon/apply-card-intake-rules.mjs —
// this is no longer a "paste this" note. It prints what is live, for reading,
// for a console comparison, and for the day someone needs to restore them by
// hand.
//
// It renders from scripts/cardrecon/intakeRules.mjs, which is the SAME object
// the applier wrote. That matters more than it sounds: a printer with its own
// copy of a rule is a printer that will eventually show something the database
// does not do, and this rule governs who can read investigation material about
// named staff.
//
//   node scripts/cardrecon/print-card-intake-rule.mjs
import { INTAKE_RULE_BLOCKS, RATIONALE } from "./intakeRules.mjs";

const rule = Object.entries(INTAKE_RULE_BLOCKS)
  .map(([name, block]) => `"${name}": ${JSON.stringify(block, null, 2)}`)
  .join(",\n");

console.log(`
────────────────────────────────────────────────────────────────────────────
LIVE since 2026-08-30. Applied through the .settings/rules.json REST endpoint
(scripts/cardrecon/apply-card-intake-rules.mjs), NOT by editing
database.rules.json — the repo copy is stale and deploying it would REGRESS
the live rules. Never \`firebase deploy --only database\`.

WHERE THEY SIT: at the TOP LEVEL, as siblings of "card_batches" — not inside
/pos, and not inside /config.
────────────────────────────────────────────────────────────────────────────

${rule}

────────────────────────────────────────────────────────────────────────────
WHY EACH LINE IS WHAT IT IS

${RATIONALE}

────────────────────────────────────────────────────────────────────────────
PROVED AGAINST THE LIVE DATABASE on the day they were applied, with a real
card_recon holder's ID token (the poller identity) rather than the owner's,
which would have read them either way:

  card_batch_intake        401 → 200
  card_batch_poll_status   401 → 200
  card_batch_intake_seen   401 → 401   (owner-only, as intended)
  card_batches             401 → 401   (untouched — the evidence stays owner-only)

  a signed-in identity with NO card_recon flag:  denied on both feeds
  a write from the holder itself:                denied on all three

Rollback: the pre-change document is in this worktree as
rules-live-backup-20260830T080115Z-card-intake.json (64 root children, none of
these three). PUT it back through the same endpoint.
`);

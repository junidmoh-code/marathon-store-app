// ─── THE EFT POOL'S RULE — ONE DEFINITION ────────────────────────────────────
// Printed AND applied from here (apply-eft-pool-rules.mjs), the same discipline
// as intakeRules.mjs: the rule Junid is shown and the rule that is live cannot
// be two different things.
//
// `database.rules.json` in this repo is NOT deployed and must not be edited:
// the repo copy is stale, and deploying it would REGRESS the live rules. This
// goes in through the `.settings/rules.json` REST endpoint — live fetch,
// timestamped backup, merge in memory, diff, write, re-fetch, verify, restore
// on any surprise. NEVER `firebase deploy --only database`.
import { OWNER } from "./intakeRules.mjs";

const ownerOnly = `auth != null && auth.token.email === '${OWNER}'`;

export const EFT_RULE_BLOCKS = {
  // Every EFT notification the poller examined: verified payments (status
  // "unmatched", waiting for the matching sessions to come), forgery attempts
  // (refused-auth) and format surprises (refused-parse). OWNER-ONLY, and for
  // the same reason as /card_batches: records carry amounts, payer names and
  // the notification's own text. Admin SDK writes only.
  eft_pool: {
    ".read": ownerOnly,
    ".write": "false",
    // The owner's feed reads the tail with orderByChild("at").limitToLast(n).
    ".indexOn": ["at"],
  },
};

export const RATIONALE = `
".read" owner-only — a pool record carries the amount, the payer's name, the
  customer's own reference and the notification's text. That is exactly the
  material /card_batches is owner-only for, so the pool gets the same wall.
  When a cashier surface arrives in a later session, it goes through a callable
  that answers a specific question, never through a read grant on this node.

".write": "false" — the poller writes with the Admin SDK, which bypasses rules
  entirely. A false write rule is not a restriction on the writer; it is the
  guarantee that NOTHING ELSE can write here. Being a top-level node, without
  it /eft_pool would answer to no rule at all.

".indexOn": ["at"] — the owner's feed reads the tail with
  orderByChild("at").limitToLast(n); the index keeps that read bounded at the
  server instead of sorted in memory with a warning.

The dedupe/claim ledger is the existing /card_batch_intake_seen — one mailbox,
one claim discipline, no second ledger to keep in step.
`.trim();

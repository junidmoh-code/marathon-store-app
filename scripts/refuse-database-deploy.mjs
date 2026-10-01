#!/usr/bin/env node
// ─── `firebase deploy --only database` IS ALWAYS WRONG HERE ─────────────────
//
// Not "risky", not "check first" — always wrong, and this hook says so instead
// of letting the deploy proceed.
//
// The live marathon-club RTDB rules are CONSOLE-MANAGED and have not matched
// this repository's database.rules.json for a long time. The live document has
// ~69 top-level nodes; the repo file is missing shopify_publish, shopify_sync
// and much else. So deploying the repo file does not "update" the live rules —
// it REPLACES them, silently deleting every node the stale copy has never heard
// of. A security regression, shipped by a command that looks routine.
//
// Stated in four places in this repo already, which is four more than anybody
// reads at the moment they type a deploy command:
//   docs/display-checks-design.md      "database.rules.json is stale and is never deployed"
//   docs/insights-read-contract.md     "stale and is not to be touched or deployed"
//   docs/rules-stock-seed-proposal.md  "the repo database.rules.json is stale and is NOT the deploy source"
//   docs/CARD-RECON.md                 same
//
// ── WHY THIS EXISTS AS ITS OWN HOOK ─────────────────────────────────────────
// The deploy preflight was wired onto this target first, to close a real gap:
// `--only database` had no check at all. But a preflight that prints
// "✓ preflight passed" immediately before a known-destructive deploy is WORSE
// than no check — it puts a green tick on the thing it should be stopping, and
// a green tick is read as sanction. (CodeRabbit; the fix is theirs.)
//
// The git invariants are irrelevant here: a clean checkout, exactly at
// origin/main, deploying this file is still destructive. There is no state of
// the repository that makes this command correct, so there is no condition to
// check and no override to offer.
//
// ── WHAT TO DO INSTEAD ──────────────────────────────────────────────────────
// Change ONE node in the live document: read the live rules, back them up
// outside the repo, patch the single node, verify, restore on failure. The
// established example is scripts/rules/apply-customers-owner-only.mjs (dry-run
// by default, writes only with --apply), and its header explains the reasoning
// at length.
//
// `--only storage` is deliberately NOT refused: storage.rules has no
// equivalent live/repo divergence on the evidence available, so it keeps the
// ordinary git preflight.

const RED = "\x1b[31m", BOLD = "\x1b[1m", OFF = "\x1b[0m";

console.error("");
console.error(`${RED}${BOLD}  ✗ DEPLOY REFUSED — database rules are not deployed from this repository${OFF}`);
console.error("");
console.error("    The live marathon-club RTDB rules are console-managed and have long since");
console.error("    diverged from database.rules.json. The live document has ~69 top-level");
console.error("    nodes; the repo copy is missing shopify_publish, shopify_sync and more.");
console.error("");
console.error("    Deploying the repo file would not update the live rules — it would REPLACE");
console.error("    them, deleting every node this stale copy has never heard of.");
console.error("");
console.error(`${BOLD}    Change one node in the LIVE document instead:${OFF}`);
console.error("      read live .settings/rules.json → back it up outside the repo → patch the");
console.error("      one node → verify → restore on failure.");
console.error("");
console.error("      The worked example, dry-run by default:");
console.error("        node scripts/rules/apply-customers-owner-only.mjs");
console.error("        node scripts/rules/apply-customers-owner-only.mjs --apply");
console.error("");
console.error("    There is no override. No state of this repository makes this command");
console.error("    correct, so there is no condition to check.");
console.error("");

process.exit(1);

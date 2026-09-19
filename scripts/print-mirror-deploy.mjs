// ─── The scoped deploy command for the offline mirror's functions ────────────
//
// WRITES NOTHING. Prints the command to run, and the rule that must be pasted
// before it is.
//
// This project shares its Cloud Functions with other apps, so a bare
// `firebase deploy --only functions` would redeploy every function in it,
// including ones nobody reviewed. functions/package.json refuses that outright.
// Deploys here are scoped BY NAME, and this prints the names so nobody has to
// keep eighteen of them in their head.
//
//   node scripts/print-mirror-deploy.mjs

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { LEGS, CHANGES_ROOT, COUNTS_ROOT } = require("../functions/mirrorChanges/legs.cjs");

const names = [...LEGS.map((l) => l.fn), "mirrorCensus", "mirrorChangesSweep"];

console.log(`
─── 1. PASTE THIS RULE FIRST ────────────────────────────────────────────────
The functions write /${CHANGES_ROOT} and /${COUNTS_ROOT} as admin, so they do
not need a write rule — but every DEVICE reads them, and without a read rule
every device's change feed returns permission-denied and every leg records a
failure. Neither node exists yet, so there is no live block beside this one;
both inherit the database root, which denies read and write.

Add to the rules in the console, as a sibling of "insights_log":

  "${CHANGES_ROOT}": {
    ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
    ".write": "false"
  },
  "${COUNTS_ROOT}": {
    ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
    ".write": "false"
  }

".write": "false" is deliberate. Only these functions append to the log, and
they run as admin, which bypasses rules. No client may write either node.

─── 2. THEN DEPLOY, SCOPED BY NAME ──────────────────────────────────────────

firebase deploy --project marathon-club --only \\
${names.map((n) => `  functions:${n}`).join(",\\\n")}

${names.length} functions: ${LEGS.length} change triggers, the daily census, and the
daily retention sweep.

─── 3. NO INDEX IS NEEDED ───────────────────────────────────────────────────
Both ranged feeds avoid one by construction:
  /${CHANGES_ROOT}   orderByKey().startAfter(cursor)   key order, never indexed
  /insights_log      orderByKey().startAfter(cursor)   key order, never indexed
  /stock_movements   orderByChild("ts").startAt(iso)   ".indexOn": ["ts"] is ALREADY LIVE
`);

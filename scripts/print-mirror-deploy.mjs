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

// The super-admin, who is the only person allowed to flip the fleet switch.
// Kept in step with src/components/PermissionsContext's ADMIN_EMAIL.
const ADMIN_EMAIL = "gunidmoh@gmail.com";

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
Every feed avoids one by construction:
  /${CHANGES_ROOT}   orderByKey().startAfter(cursor)   key order, never indexed
  /insights_log      orderByKey().startAfter(cursor)        key order, never indexed
  /stock_movements   orderByChild("ts").startAt(ts, key)    ".indexOn": ["ts"] is ALREADY LIVE

The /stock_movements cursor is a PAIR, not a timestamp: ts is not unique, so
the bound must be inclusive or a multi-size transfer loses all but one of its
movements — and inclusive on ts alone re-reads the whole newest timestamp on
every pass, for ever. The two-argument startAt(value, key) resumes at the exact
row last consumed. Same index, no new one.

─── 4. THE FLEET KILL SWITCH — PASTE THIS TOO ───────────────────────────────
Every device watches ONE boolean and obeys it live. Setting it to false drops
the whole fleet back to live reads immediately — no reload, no deploy, no
visit to a device. Without this rule no device can read it, and a device that
has never read it does not mirror at all, so this paste is the gate on the
rollout as much as it is the gate on the kill.

  "mirror_switch": {
    ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
    ".write": "auth != null && auth.token.email === '${ADMIN_EMAIL}'"
  },
  "mirror_devices": {
    ".read": "auth != null && auth.token.email === '${ADMIN_EMAIL}'",
    "$deviceId": {
      ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
      ".validate": "newData.child('deviceId').val() === $deviceId"
    }
  }

TO TURN THE MIRROR ON FOR THE FLEET — set, in the console:

  /mirror_switch/enabled = true

Pasting the rule alone changes NOTHING: an absent value reads as OFF, on
purpose. Only a value somebody wrote turns the fleet on, so the paste and the
decision are two separate acts and clearing the node is a kill, never a start.

TO KILL IT — set the same value to false, or delete it. Every open device
drops to live reads within a second, and every device that opens afterwards
reads live too. The copies stay on the devices, so turning it back on costs
nobody another download.

/mirror_devices is the fleet's own health: one small record per device (is its
copy complete, when did it last sync, how many bytes today, which build, any
guard tripped). Devices write only their OWN record; only the super-admin
reads the lot, because the list names individual staff devices.
`);

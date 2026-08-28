// ── BACKFILL / RECONCILE the card_recon custom claim ─────────────────────────
//
//   node scripts/backfill-card-recon-claim.mjs             # dry run — writes nothing
//   node scripts/backfill-card-recon-claim.mjs --execute   # writes
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// Storage rules cannot read RTDB, so read access to the slip photos under
// cardRecon/** is gated on a Firebase Auth custom claim mirroring the
// `card_recon` permission. From now on syncCardReconClaim keeps that claim in
// step with /users/{uid}/permFlags/card_recon on every write.
//
// Accounts that already hold the permission were granted it before the trigger
// existed, so no write will ever fire for them: they would hold the permission,
// see the Card Recon screen, and be refused the photos by Storage — a grant
// that looks present and is not. This pass closes that.
//
// It is also the DRIFT CHECK. It runs in BOTH directions: it adds the claim
// where the permission is held, and it REMOVES the claim where it is not. A
// stale claim keeping someone's access after their permission was removed is
// the failure this whole build is about, so re-running this is always safe and
// always the right first move if you suspect drift.
//
// ── WHY IT IS SAFE TO RUN, AND TO RE-RUN ─────────────────────────────────────
// PURELY DERIVED: the desired claim is computed from the permFlags scalar
// already on the record. It grants nobody anything they do not already have.
// IDEMPOTENT: it reads each account's real claims and converges; a second run
// finds nothing to do. It touches NOTHING but the card_recon key of each
// account's custom claims — every other claim is read back and rewritten
// verbatim, and no RTDB node is written at all.
//
// The dry run still READS every auth account, so its report is about the real
// claim state rather than about what we assume it is.
//
// ── WHY IT READS THE WHOLE /users NODE ───────────────────────────────────────
// Same reason as backfillPermFlags.mjs: /users is the staff table (33 records,
// ~8 KB), there is no bounded query that answers "every account", and per-uid
// reads would need the uid list first — which is the same read.
//
// ── AFTER RUNNING ────────────────────────────────────────────────────────────
// A claim reaches a signed-in browser only when its ID token refreshes. Anyone
// whose claim changed here should reload (or wait for the automatic refresh);
// the POS Card recon tab force-refreshes the token itself the moment it sees
// the permission change.
import { createRequire } from "node:module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { CLAIM, reconcileAll } = require("../functions/lib/card-recon-claim.cjs");

const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const EXECUTE = process.argv.includes("--execute");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  // Named explicitly: databaseURL settles RTDB, but the Auth Admin API needs a
  // project id of its own and user-based ADC carries none.
  projectId: "marathon-club",
  databaseURL: DB,
});

const users = (await admin.database().ref("users").get()).val() || {};
const uids = Object.keys(users);
console.log(`/users: ${uids.length} accounts`);

const { planned, changed, errors } = await reconcileAll({
  auth: admin.auth(), users, execute: EXECUTE,
});

const holders = planned.filter((p) => p.granted);
console.log(`accounts holding the ${CLAIM} permission: ${holders.length}${holders.length ? ` (${holders.map((h) => h.uid).join(", ")})` : ""}`);

if (!changed.length) {
  console.log("every claim already matches its permission — nothing to do.");
} else {
  for (const c of changed) {
    const what = c.granted ? "ADD    claim" : "REMOVE claim";
    const other = c.otherClaims.length ? ` (preserving ${c.otherClaims.join(", ")})` : "";
    console.log(`  ${EXECUTE ? "" : "would "}${what}  ${c.uid}${other}`);
  }
  console.log(`${changed.length} account(s) ${EXECUTE ? "reconciled" : "out of step"}.`);
}

const missing = planned.filter((p) => p.missing);
if (missing.length) {
  console.log(`note: ${missing.length} /users record(s) have no Firebase Auth account (nothing to claim): ${missing.map((m) => m.uid).join(", ")}`);
}
if (errors.length) {
  console.error(`\n${errors.length} account(s) FAILED — re-run to retry just these:`);
  for (const e of errors) console.error(`  ${e.uid}: ${e.message}`);
}

if (!EXECUTE) console.log("\nDRY RUN — nothing was written. Re-run with --execute.");
process.exit(errors.length ? 1 : 0);

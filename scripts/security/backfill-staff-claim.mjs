// One-off: give every existing /users record its `staff` claim (and remove a
// stray one from any account with no record). Same reconciler as the trigger.
//
//   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> node scripts/security/backfill-staff-claim.mjs [--execute]
//
// Dry run by default. Prints counts only — no uid, no email.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const admin = require("../../functions/node_modules/firebase-admin");
const { reconcileClaim } = require("../../functions/lib/card-recon-claim.cjs");

admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const execute = process.argv.includes("--execute");
const db = admin.database();
const auth = admin.auth();

// shallow key list: bounded to the number of accounts, never the record bodies
const res = await fetch(`https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app/users.json?shallow=true&access_token=${(await admin.app().options.credential.getAccessToken()).access_token}`);
const uids = Object.keys((await res.json()) || {});
const tally = { records: uids.length, granted: 0, already: 0, noAuthAccount: 0 };
for (const uid of uids) {
  const r = await reconcileClaim({ auth, uid, granted: true, claim: "staff", dryRun: !execute });
  if (r.missing) tally.noAuthAccount++; else if (r.changed) tally.granted++; else tally.already++;
}
// accounts that carry the claim but have no record
let strays = 0, page;
const have = new Set(uids);
do {
  page = await auth.listUsers(1000, page?.pageToken);
  for (const u of page.users) {
    if (u.customClaims?.staff === true && !have.has(u.uid)) {
      strays++;
      await reconcileClaim({ auth, uid: u.uid, granted: false, claim: "staff", dryRun: !execute });
    }
  }
} while (page.pageToken);
console.log(JSON.stringify({ ...tally, straysRemoved: strays, mode: execute ? "EXECUTED" : "dry-run" }));
void db;
process.exit(0);

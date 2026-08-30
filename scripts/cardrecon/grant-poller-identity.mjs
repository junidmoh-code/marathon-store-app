// ─── THE POLLER'S IDENTITY — granted once, revocable without a deploy ────────
// The mailbox poller calls the SAME cardBatchCapture callable a manager's phone
// calls, so it must arrive as somebody. It arrives as a uid of its own, holding
// exactly two permission flags and nothing else:
//
//   card_recon         what every capture needs.
//   card_recon_intake  the email channel — the ONE path with no picked till.
//                      A second flag rather than a wider grant, so nobody who
//                      can capture from a phone also acquires a path that skips
//                      the till pick.
//
// It is DATA, not a deploy: revoking the poller is deleting these two flags.
//
// IT IS NOT A STAFF ACCOUNT, and must never become one. The user-management
// screen REPLACES the whole permFlags map from the permissions array it saves
// (permFlagsFor in src/components/permissionCatalog.js), and card_recon_intake
// is deliberately not in that catalogue — so saving this row through that screen
// would silently strip the flag and the poller would start refusing every slip
// with "This identity may not capture emailed slips". It cannot happen today:
// that flow requires a username and a 4-digit PIN and this row has neither, so
// it does not appear in the staff list. If it ever does, re-run this script.
//
// The uid is not a person and has no PIN, no email and no password. The poller
// mints its own ID token from the service-account key already on the Mac mini
// (admin.auth().createCustomToken → Identity Toolkit), so there is no
// credential to store anywhere for it.
//
// IT WRITES TO /users, SO IT NEEDS ADMIN CREDENTIALS and does not read .env:
// applicationDefault() means GOOGLE_APPLICATION_CREDENTIALS (the Mac mini's
// service-account key) or an owner gcloud ADC login. Without either, the first
// database call fails with a credentials error rather than anything about
// permissions. (CodeRabbit, PR #510.)
//
//   node scripts/cardrecon/grant-poller-identity.mjs            # says what it would do
//   node scripts/cardrecon/grant-poller-identity.mjs --execute
//   node scripts/cardrecon/grant-poller-identity.mjs --revoke --execute
import { createRequire } from "node:module";
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
};
const EXECUTE = process.argv.includes("--execute");
const REVOKE = process.argv.includes("--revoke");
const uid = (arg("uid") || "card-recon-email-poller").trim();

if (!/^[A-Za-z0-9_-]{6,64}$/.test(uid)) {
  console.error("--uid must be 6-64 characters of [A-Za-z0-9_-]");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

// A READ OF TWO LEAVES, never of /users. That node holds every staff account.
const path = `users/${uid}`;
const before = {
  card_recon: (await db.ref(`${path}/permFlags/card_recon`).get()).val(),
  card_recon_intake: (await db.ref(`${path}/permFlags/card_recon_intake`).get()).val(),
};
console.log(`BEFORE /${path}/permFlags:`, JSON.stringify(before));

const flags = REVOKE
  ? { card_recon: null, card_recon_intake: null }
  : { card_recon: true, card_recon_intake: true };
const profile = REVOKE ? {} : {
  // Enough for a human reading /users to know what this row is and not to
  // treat it as a person. No email, no PIN, no permissions array — the flags
  // are the whole grant.
  name: "Card recon email poller",
  isService: true,
  note: "Unattended: reads the recon mailbox on the Mac mini and submits emailed batch report PDFs through cardBatchCapture. Revoke by deleting the two permFlags.",
};

console.log(`${EXECUTE ? "WRITING" : "WOULD write"} /${path}:`, JSON.stringify({ permFlags: flags, ...profile }));
if (EXECUTE) {
  const updates = {};
  for (const [k, v] of Object.entries(flags)) updates[`permFlags/${k}`] = v;
  for (const [k, v] of Object.entries(profile)) updates[k] = v;
  await db.ref(path).update(updates);
  console.log("AFTER:", JSON.stringify((await db.ref(`${path}/permFlags`).get()).val()));
}
await admin.app().delete();

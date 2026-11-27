"use strict";
// ─── STAFF CLAIM — "has a /users record" as a token claim, for Storage ───────
//
// Storage rules cannot read the Realtime Database, so the RTDB test the rules
// now apply everywhere ("root.child('users').child(auth.uid).exists()") cannot
// be written in storage.rules. Client sign-up is open (closing it would also
// close new anonymous TV sessions), so "signed in, not anonymous" — the only
// test storage.rules could make — admits anyone on the internet to overwrite
// product photos and the TV advert.
//
// This mirrors the record into a custom claim `staff: true`, the same way
// syncCardReconClaim mirrors permFlags/card_recon, using the SAME converge-
// and-preserve reconciler (other claims on the account are never touched).
//
// It acts ONLY when a whole /users/{uid} record appears or disappears; edits
// inside an existing record exit before any Auth call, so ordinary writes
// under /users cost one cheap invocation and nothing else. Before writing it
// re-reads the record, so a retried or reordered event converges on what the
// database says NOW rather than on what the event said then.
const { onValueWritten } = require("firebase-functions/v2/database");
const admin = require("firebase-admin");
const { reconcileClaim } = require("../lib/card-recon-claim.cjs");

if (!admin.apps.length) {
  admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
}

const STAFF_CLAIM = "staff";

// Reconcile, then VERIFY and correct (the card-recon trigger's pattern): the
// card-recon claim trigger can run at the same moment on the same account, and
// two get→set sequences can interleave so one overwrites the other's claim.
// Each trigger re-checks its OWN claim against the database until it holds, so
// both converge.
const MAX_PASSES = 5;
async function syncStaffClaimFor({ auth, db, uid }) {
  let res;
  for (let i = 0; i < MAX_PASSES; i++) {
    const exists = (await db.ref(`users/${uid}`).once("value")).exists();
    res = await reconcileClaim({ auth, uid, granted: exists, claim: STAFF_CLAIM });
    if (res.missing) return res;
    const user = await auth.getUser(uid);
    const has = (user.customClaims || {})[STAFF_CLAIM] === true;
    const stillExists = (await db.ref(`users/${uid}`).once("value")).exists();
    if (has === stillExists) return res;
  }
  throw new Error(`syncStaffClaim: ${uid}'s staff claim did not settle in ${MAX_PASSES} passes`);
}

exports.STAFF_CLAIM = STAFF_CLAIM;
exports.syncStaffClaimFor = syncStaffClaimFor;
exports.syncStaffClaim = onValueWritten(
  {
    ref: "/users/{uid}",
    instance: "marathon-club-default-rtdb",
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 60,
    retry: true,
  },
  async (event) => {
    const before = event.data.before.exists();
    const after = event.data.after.exists();
    if (before === after) return; // an edit inside a record — nothing to mirror
    const uid = event.params.uid;
    const res = await syncStaffClaimFor({ auth: admin.auth(), db: admin.database(), uid });
    if (res.missing) return;
    if (res.changed) console.log(`syncStaffClaim: ${res.granted ? "GRANTED" : "REVOKED"} staff claim for ${uid}`);
  }
);

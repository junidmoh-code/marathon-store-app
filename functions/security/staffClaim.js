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

async function syncStaffClaimFor({ auth, db, uid }) {
  const exists = (await db.ref(`users/${uid}`).once("value")).exists();
  return reconcileClaim({ auth, uid, granted: exists, claim: STAFF_CLAIM });
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

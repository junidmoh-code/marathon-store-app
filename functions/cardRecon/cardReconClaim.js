// ─── syncCardReconClaim — the card_recon permission becomes a token claim ────
// Slip photos live in Storage under cardRecon/**. They carry masked PANs, auth
// codes and RRNs for every transaction in a batch — investigation material
// about named staff — so read has to be limited to holders of the existing
// `card_recon` permission, not to every signed-in staff member.
//
// Storage rules cannot read RTDB. The only thing storage.rules can see about
// the caller is their ID token, so the permission is mirrored into a custom
// claim and the rule reads that:
//
//   allow read: if request.auth.token.card_recon == true;   (storage.rules)
//
// TRIGGER, NOT CALLABLE. Permissions are edited straight into RTDB by
// UserManagement.togglePermission (and by createStaffUser, and by the odd
// script), so there is no single callable to hang this off. Hanging it off the
// WRITE instead means every path that can grant or revoke the permission —
// including ones that do not exist yet — mirrors correctly by construction.
//
// SCOPED TO THE LEAF, /users/{uid}/permFlags/card_recon: a stockRole edit, a
// display-name change or any other permission toggle never wakes this. Note
// UserManagement writes `permFlags` as a whole child, which still fires the
// leaf trigger when this key's value changes — and correctly does NOT fire
// when it does not.
//
// RETRY IS ON. A dropped grant is an inconvenience; a dropped REVOKE leaves a
// stale claim keeping someone's access after their permission was removed,
// which is the exact failure this build exists to prevent. The handler is a
// reconciler (it reads the account's real claims and converges), so a retry, a
// replay and an out-of-order delivery all land in the same place.
//
// DEPLOY BY NAME (functions/ is shared with marathon-pos-app):
//   firebase deploy --only functions:syncCardReconClaim

"use strict";

const { onValueWritten } = require("firebase-functions/v2/database");
const admin = require("firebase-admin");

const { CLAIM, syncClaimFromFlag } = require("../lib/card-recon-claim.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

exports.syncCardReconClaim = onValueWritten(
  {
    ref:            `/users/{uid}/permFlags/${CLAIM}`,
    instance:       "marathon-club-default-rtdb",
    region:         "europe-west1",
    memory:         "256MiB",
    timeoutSeconds: 60,
    retry:          true,
  },
  async (event) => {
    const uid = event.params.uid;
    const after = event.data.after.val();
    const res = await syncClaimFromFlag({ auth: admin.auth(), uid, after });
    if (res.missing) {
      console.log(`syncCardReconClaim: ${uid} has no auth account — nothing to clear.`);
      return;
    }
    if (!res.changed) return;
    // Logged because this is an access change on evidence about staff: it
    // should be findable in the function log without reading anyone's token.
    console.log(
      `syncCardReconClaim: ${res.granted ? "GRANTED" : "REVOKED"} ${CLAIM} claim for ${uid}` +
      (res.otherClaims.length ? ` (${res.otherClaims.length} other claim(s) preserved)` : "")
    );
  }
);

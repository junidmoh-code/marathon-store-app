"use strict";
// ─── A callable's "is this staff?" — a live /users record, not just a token ───
// Client sign-up is open on the project (it cannot be closed without also
// closing new anonymous TV sessions), so "signed in and not anonymous" admits
// anyone on the internet. The database rules now require a /users record
// (Nov 2026 audit); callables bypass the rules, so the ones that only rejected
// anonymous sessions call this instead. Every staff member, till, owner and
// the card-recon poller has a record; strangers never do.
async function requireStaffRecord(db, auth, HttpsError) {
  if (!auth || !auth.uid || auth.token?.firebase?.sign_in_provider === "anonymous") {
    throw new HttpsError("unauthenticated", "Sign in first.");
  }
  const snap = await db.ref(`users/${auth.uid}`).once("value");
  if (!snap.exists()) throw new HttpsError("permission-denied", "This account is not a Marathon staff account.");
}
module.exports = { requireStaffRecord };

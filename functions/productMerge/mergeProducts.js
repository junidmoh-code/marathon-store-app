// ─── mergeProducts — the admin-only callable in front of performMerge ─────────
// Thin on purpose: authorisation and error translation live here; every merge
// rule lives in functions/lib/product-merge.cjs where the tests can reach it
// with a fake db. See that file's header for what a merge does and refuses.
//
// WHO MAY MERGE: a stored stockRole of "admin" on /users/{uid}, or the verified
// super-admin email. Deliberately NARROWER than the style-code gate — a merge
// rewrites stock cells, the ledger and the barcode index in one commit, which
// is admin work, not shop-floor work.

"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const { performMerge } = require("../lib/product-merge.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

const ADMIN_EMAIL = "gunidmoh@gmail.com"; // super-admin (mirrors styleCode/access.cjs)

async function assertMergeAccess(request, db) {
  const provider = request.auth && request.auth.token && request.auth.token.firebase
    && request.auth.token.firebase.sign_in_provider;
  if (!request.auth || provider === "anonymous") {
    throw new HttpsError("unauthenticated", "Sign-in required.");
  }
  const uid = request.auth.uid;
  const email = (request.auth.token && request.auth.token.email) || null;
  const emailVerified = !!(request.auth.token && request.auth.token.email_verified);
  const isSuper = email === ADMIN_EMAIL && emailVerified;

  const userRec = (await db.ref(`users/${uid}`).get()).val() || {};
  if (!isSuper && userRec.stockRole !== "admin") {
    throw new HttpsError("permission-denied", "Merging products needs stock admin rights.");
  }
  return { uid, email, isSuper };
}

exports.mergeProducts = onCall({ region: "europe-west1" }, async (request) => {
  const db = admin.database();
  const actor = await assertMergeAccess(request, db);

  const loserId = request.data && request.data.loserId;
  const survivorId = request.data && request.data.survivorId;

  try {
    return await performMerge(db, { loserId, survivorId, actor, nowMs: Date.now() });
  } catch (err) {
    if (err && err.refused) throw new HttpsError(err.code, err.message);
    console.error("[mergeProducts] failed", err);
    throw new HttpsError("internal", `Merge failed and nothing was changed: ${err.message || err}`);
  }
});

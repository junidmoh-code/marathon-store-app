// ─── productIdentity — "what does this catalogue answer to?", in one read ─────
// Thin on purpose: authorisation and IO here, the fold in
// functions/lib/label-identity.cjs where the tests reach it with plain
// objects. See that file's header for why the client cannot build this map
// itself.
//
// WHO MAY CALL IT: the same people as every other style-code callable —
// assertStyleCodeAccess (functions/styleCode/access.cjs): a real signed-in
// user holding one of the catalogue / shop-floor permissions, or the verified
// super-admin. The screens that read this map (count, register, leftovers,
// merge) already file through labelAlias behind that exact gate, so reusing it
// costs nobody access; a bare "any non-anonymous account" check (the first
// version) would have handed two admin-only stores to an account with no
// /users record at all. READ-ONLY; deliberately wider than mergeProducts
// (admin-only) because the shop floor reads codes off the count screen.
//
// DEPLOY SCOPED, BY NAME:  firebase deploy --only functions:productIdentity

"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const { buildIdentityMap } = require("../lib/label-identity.cjs");
const { assertStyleCodeAccess } = require("../styleCode/access.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

exports.productIdentity = onCall({ region: "europe-west1" }, async (request) => {
  const db = admin.database();
  await assertStyleCodeAccess(request, db); // throws unauthenticated / permission-denied

  try {
    const [aliases, styleIndex] = await Promise.all([
      db.ref("label_aliases").get(),
      db.ref("style_code_index").get(),
    ]);
    return { map: buildIdentityMap(aliases.val(), styleIndex.val()) };
  } catch (err) {
    console.error("[productIdentity] failed", err);
    throw new HttpsError("internal", `Could not read the label identity stores: ${err.message || err}`);
  }
});

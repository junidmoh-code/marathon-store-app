// ─── productIdentity — "what does this catalogue answer to?", in one read ─────
// Thin on purpose: authorisation and IO here, the fold in
// functions/lib/product-identity.cjs where the tests reach it with plain
// objects. See that file's header for why the client cannot build this map
// itself.
//
// WHO MAY CALL IT: any signed-in, non-anonymous staff member. It is READ-ONLY
// and returns nothing a staff member cannot already see one key at a time —
// the style code printed inside the shoe they are holding. Deliberately WIDER
// than mergeProducts (admin-only): the shop floor needs this to read a code off
// the count screen, and a gate here would put the Leftovers list back in the
// state this whole change exists to fix.
//
// DEPLOY SCOPED, BY NAME:  firebase deploy --only functions:productIdentity

"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const { buildIdentityMap } = require("../lib/label-identity.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

exports.productIdentity = onCall({ region: "europe-west1" }, async (request) => {
  const provider = request.auth && request.auth.token && request.auth.token.firebase
    && request.auth.token.firebase.sign_in_provider;
  if (!request.auth || provider === "anonymous") {
    throw new HttpsError("unauthenticated", "Sign-in required.");
  }

  const db = admin.database();
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

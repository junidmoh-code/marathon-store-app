// ─── mediaHashClaim — "is this exact file already another product's?" ───────
// Called by Shopify Publishing before a photo or video is uploaded. Claims the
// file's SHA-256 for the product, or refuses with the product that already
// owns it. The decision and its reasons are in lib/media-hash.cjs.
//
// Reads, all per path: the caller's /users/{uid} (permission), the index
// entry, and — only on a clash — the owner's media list and its name. Never a
// whole node.
//
// Deploy by name, never bare (functions are shared with marathon-pos-app):
//   firebase deploy --only functions:mediaHashClaim
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { MEDIA_HASH_ROOT, parseClaimArgs, mediaHasHash, decideClaim, maySetPublishing } = require("../lib/media-hash.cjs");

if (!admin.apps.length) {
  admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
}

async function ownerFacts(db, ownerPid, sha) {
  const [media, name] = await Promise.all([
    db.ref(`shopify_publish/${ownerPid}/media`).once("value").then((s) => s.val()),
    db.ref(`products/${ownerPid}/name`).once("value").then((s) => s.val()),
  ]);
  return { uses: mediaHasHash(media, sha), name: typeof name === "string" ? name : null };
}

async function handleMediaHashClaim(request, deps) {
  const { db } = deps;
  const auth = request.auth;
  if (!auth || !auth.uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const user = (await db.ref(`users/${auth.uid}`).once("value")).val();
  if (!maySetPublishing(auth.token, user)) {
    throw new HttpsError("permission-denied", "Shopify publishing changes are limited to Junid or a stock admin.");
  }
  const args = parseClaimArgs(request.data);
  if (args.problem) throw new HttpsError("invalid-argument", args.problem);
  const { pid, sha, kind } = args;
  // ONE product's record, by a validated, non-empty id (parseClaimArgs).
  const exists = (await db.ref(`products/${pid}`).once("value")).exists();
  if (!exists) throw new HttpsError("not-found", "That product no longer exists.");

  const entryRef = db.ref(`${MEDIA_HASH_ROOT}/${sha}`);
  const existing = (await entryRef.once("value")).val();
  let ownerUses = false;
  let ownerName = null;
  if (existing?.pid && existing.pid !== pid) {
    const f = await ownerFacts(db, existing.pid, sha);
    ownerUses = f.uses;
    ownerName = f.name;
  }
  const verdict = decideClaim({ pid, existing, ownerUses });
  if (!verdict.claim) {
    return { ok: false, ownerPid: verdict.ownerPid, ownerName };
  }

  // The claim itself is compare-and-set against the entry the verdict was
  // made from: a different product claiming the same hash in the meantime is
  // a clash, answered by asking again rather than overwritten.
  const before = existing?.pid ?? null;
  let clash = false;
  const now = deps.now();
  const txn = await entryRef.transaction((cur) => {
    const curPid = cur?.pid ?? null;
    if (curPid !== before && curPid !== pid) { clash = true; return undefined; }
    clash = false;
    return { pid, at: now, uid: auth.uid, kind };
  });
  if (!txn.committed || clash || txn.snapshot.val()?.pid !== pid) {
    throw new HttpsError("aborted", "Another upload of this exact file landed at the same moment. Try again.");
  }
  return { ok: true, transferredFrom: before && before !== pid ? before : null };
}

exports.mediaHashClaim = onCall(
  { region: "europe-west1", memory: "256MiB", timeoutSeconds: 30, maxInstances: 5 },
  (request) => handleMediaHashClaim(request, { db: admin.database(), now: () => Date.now() }),
);
exports._handleMediaHashClaim = handleMediaHashClaim;

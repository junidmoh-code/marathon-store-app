// ─── STYLE CODE — SHARED CALLABLE ACCESS GATE ────────────────────────────────
// Every style-code callable (resolve, label read, capture) authorises the same
// way, so the rule lives here once instead of drifting across three files.
//
// WHO: a real signed-in user (never anonymous) who already holds a permission
// that implies "this person handles the catalogue or the shop floor". We
// deliberately do NOT mint a new permission key — the client catalogue must stay
// a subset of the server's VALID_PERMISSIONS gate in createStaffUser, so a new
// key is a two-repo change with a seeding step. Reusing existing keys keeps the
// blast radius at zero.
//
// The super-admin shortcut trusts the email claim, so it demands a VERIFIED
// email — otherwise a self-signed-up account claiming the super-admin address
// with email_verified:false would inherit super-admin. Google sign-in (the real
// super-admin's provider) sets email_verified:true. The staff path never trusts
// email: it authorises off the uid-keyed /users record.

"use strict";

const { HttpsError } = require("firebase-functions/v2/https");

const ADMIN_EMAIL = "gunidmoh@gmail.com"; // super-admin (mirrors config/displayChecks.js)

// Any ONE of these implies style-code work is part of this person's job:
// intake (products), the shop-floor display flow, receiving stock — and, since
// the assistant tongue-label finder (owner fix 4, 2026-08-06), store
// assistants: their view reads labels to FIND a product a customer is holding.
// The widening grants label READS and alias lookups; writes stay bounded by
// what each callable does (capture enqueue is additionally rules-gated on the
// client side, and the alias store only ever gains human-confirmed readings).
const STYLE_CODE_PERMISSIONS = ["product_admin", "display_checks", "stock_add", "stock_management", "store_assistant"];

/**
 * Authorise a style-code callable and return the actor to stamp on writes.
 * Throws HttpsError on failure — never returns a partial actor.
 *
 * @param {object} request  the onCall request
 * @param {object} db       admin database (for the /users lookup)
 * @returns {Promise<{uid:string,name:string,email:string|null,isSuper:boolean,permissions:string[]}>}
 */
async function assertStyleCodeAccess(request, db) {
  const provider = request.auth && request.auth.token && request.auth.token.firebase
    && request.auth.token.firebase.sign_in_provider;
  if (!request.auth || provider === "anonymous") {
    throw new HttpsError("unauthenticated", "Sign-in required.");
  }
  const uid = request.auth.uid;
  const email = (request.auth.token && request.auth.token.email) || null;
  const emailVerified = !!(request.auth.token && request.auth.token.email_verified);

  const userRec = (await db.ref(`users/${uid}`).get()).val() || {};
  const permissions = Array.isArray(userRec.permissions) ? userRec.permissions : [];
  const isSuper = email === ADMIN_EMAIL && emailVerified;
  const allowed = isSuper || STYLE_CODE_PERMISSIONS.some((p) => permissions.includes(p));
  if (!allowed) {
    throw new HttpsError("permission-denied", "You don't have access to style-code lookup.");
  }

  return {
    uid,
    name: userRec.displayName || userRec.username || (email ? email.split("@")[0] : "staff"),
    email,
    isSuper,
    permissions,
  };
}

module.exports = { ADMIN_EMAIL, STYLE_CODE_PERMISSIONS, assertStyleCodeAccess };

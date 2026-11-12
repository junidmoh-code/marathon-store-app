// ─── SUPER ADMINS (functions copy) ────────────────────────────────────────────
// The ONE place the Cloud Functions name the super-admin Google accounts.
// Junid and Jafer (50/50 partners) hold exactly the same power everywhere.
// Every callable gate asks isSuperAdmin / isSuperAdminToken; nothing compares
// request.auth.token.email against a literal.
//
// The client keeps its own copy in src/config/superAdmins.js. Keep the two
// lists in step; src/superAdminsGrep.test.js fails if a literal creeps back in.
"use strict";

const JUNID_EMAIL = "gunidmoh@gmail.com";
const JAFER_EMAIL = "jafermohammed340@gmail.com";

const SUPER_ADMIN_EMAILS = Object.freeze([JUNID_EMAIL, JAFER_EMAIL]);
const SUPER_ADMIN_NAMES = Object.freeze({ [JUNID_EMAIL]: "Junid", [JAFER_EMAIL]: "Jafer" });

function normaliseEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function isSuperAdmin(email) {
  const e = normaliseEmail(email);
  return e !== "" && SUPER_ADMIN_EMAILS.includes(e);
}

// The address must also be verified by the provider (Google always is).
function isSuperAdminToken(token) {
  return !!token && isSuperAdmin(token.email) && token.email_verified === true;
}

function superAdminName(email) {
  return isSuperAdmin(email) ? SUPER_ADMIN_NAMES[normaliseEmail(email)] : null;
}

module.exports = {
  JUNID_EMAIL, JAFER_EMAIL, SUPER_ADMIN_EMAILS, SUPER_ADMIN_NAMES,
  normaliseEmail, isSuperAdmin, isSuperAdminToken, superAdminName,
};

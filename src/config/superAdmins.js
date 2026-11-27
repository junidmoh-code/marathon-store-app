// ─── SUPER ADMINS ─────────────────────────────────────────────────────────────
// The ONE place the super-admin Google accounts are named. Junid and Jafer
// (50/50 partners) hold exactly the same power everywhere. Every client gate
// asks isSuperAdmin(email); nothing compares against a literal email.
//
// The Cloud Functions keep their own copy in functions/lib/super-admins.cjs
// (they deploy separately and cannot import from src/). Keep the two lists in
// step; src/superAdminsGrep.test.js fails if a literal creeps back in.

export const JUNID_EMAIL = "gunidmoh@gmail.com";
export const JAFER_EMAIL = "jafermohammed340@gmail.com";

export const SUPER_ADMIN_EMAILS = Object.freeze([JUNID_EMAIL, JAFER_EMAIL]);

// Display names, for labels that used to say "Junid" for the one admin.
export const SUPER_ADMIN_NAMES = Object.freeze({ [JUNID_EMAIL]: "Junid", [JAFER_EMAIL]: "Jafer" });

export function normaliseEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export function isSuperAdmin(email) {
  const e = normaliseEmail(email);
  return e !== "" && SUPER_ADMIN_EMAILS.includes(e);
}

// Functions-style check: the address must also be verified by the provider.
export function isSuperAdminToken(token) {
  return !!token && isSuperAdmin(token.email) && token.email_verified === true;
}

// "Junid" / "Jafer" for a super-admin email, else null.
export function superAdminName(email) {
  return isSuperAdmin(email) ? SUPER_ADMIN_NAMES[normaliseEmail(email)] : null;
}

// The RTDB rule expression that admits either super admin. The live console
// rules (RTDB and Storage) were widened to exactly this shape on 12 Nov 2026;
// admin cards print it when they show the rule a node needs.
export const SUPER_ADMIN_RULE_EXPR =
  "(" + SUPER_ADMIN_EMAILS.map((e) => `auth.token.email === '${e}'`).join(" || ") + ")";

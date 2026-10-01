// ─── DEVICE ENROLMENT — WHAT THIS DEVICE IS, AND WHETHER IT MAY IN ───────────
//
// Staff share MC's login. A login marked /users/{uid}/deviceCodeRequired needs
// each DEVICE enrolled with a personal 4-digit code (see EnrolmentGate.jsx and
// functions/lib/device-enrolment.cjs for the server half). Once enrolled, the
// device's session is a custom-token session for the same uid whose ID token
// carries the device's claims: deviceId, eid (this enrolment), personId,
// personName. The claims are signed by the server, so the database rules can
// trust them; this file only READS them.
//
// A device may use the app when, and only while:
//   its token names a device, AND /users/{uid}/deviceGate/{deviceId} === eid.
// That entry is deleted by a revoke, and /users/{uid} is already subscribed by
// AuthGate, so a revoked device drops back to the code screen within a second
// with no reload — and the rules refuse its next write regardless.
//
// Reading the claims never needs the network: getIdTokenResult() answers from
// the cached token, and if even that fails (an expired token offline) the
// payload is decoded from the token string itself. The claims never change for
// the life of an enrolment, so a stale token names the device just as well.

import { getDeviceId } from "./deviceId";

// ── the claims ───────────────────────────────────────────────────────────────

export function decodeJwtClaims(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const json = typeof atob === "function"
      ? decodeURIComponent(Array.from(atob(b64), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""))
      : Buffer.from(b64, "base64").toString("utf8");
    const o = JSON.parse(json);
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

// Only the fields this app uses, each a non-empty string or null.
export function pickDeviceClaims(claims) {
  const s = (v) => (typeof v === "string" && v ? v : null);
  return {
    deviceId: s(claims?.deviceId),
    eid: s(claims?.eid),
    personId: s(claims?.personId),
    personName: s(claims?.personName),
    kind: claims?.dkind === "shared" ? "shared" : "person",
    // Only decides whether the Device codes tile is SHOWN; the server re-checks
    // the person on every admin call.
    canManageCodes: claims?.dmgr === true,
  };
}

export async function readSessionClaims(user) {
  if (!user) return pickDeviceClaims(null);
  try {
    const r = await user.getIdTokenResult();
    return pickDeviceClaims(r?.claims);
  } catch {
    return pickDeviceClaims(decodeJwtClaims(user.accessToken));
  }
}

// ── the verdict ──────────────────────────────────────────────────────────────
/**
 * "app"     — use the app (not a login that needs a code, or a live enrolment)
 * "code"    — show the code screen and nothing else
 * "loading" — the claims are still being read; show nothing yet
 * Junid never needs a code; nor does an account whose flag is absent.
 */
export function deviceGateVerdict({ permRecord, claims, isSuperAdmin, readError = false, knownRequired = false }) {
  if (isSuperAdmin) return "app";
  // The /users record could not be read, so whether this login needs a code
  // is unknown. A login THIS device has seen flagged stays shut — never opened
  // by an error. (CodeRabbit, PR #647.) The rules exempt /users from the gate,
  // so this is a refused read that should not happen; a login never seen
  // flagged keeps today's behaviour, and the server rules still refuse it.
  if (readError) return knownRequired ? "code" : "app";
  if (permRecord?.deviceCodeRequired !== true) return "app";
  if (claims === undefined) return "loading";
  return isLiveEnrolment(permRecord, claims) ? "app" : "code";
}

export function isLiveEnrolment(permRecord, claims) {
  const c = claims || {};
  if (!c.deviceId || !c.eid) return false;
  const gate = permRecord?.deviceGate;
  return !!gate && typeof gate === "object" && gate[c.deviceId] === c.eid;
}

// ── who is holding this device (for the stamps on every write) ──────────────
// Set by AuthGate from the claims and the /users record; read by deviceStamp.
// For a login without codes (Mike's own account) the person is the account.
let identity = { deviceId: null, personName: null, personId: null, enrolled: false, canManageCodes: false };

// Pure: the identity for these claims and this /users record.
export function identityFrom({ claims, permRecord, user }) {
  const c = claims || {};
  const enrolled = !!(c.deviceId && c.eid);
  return {
    deviceId: (enrolled && c.deviceId) || getDeviceId(),
    personName: (enrolled && c.personName)
      || permRecord?.displayName || permRecord?.username
      || (user?.email ? String(user.email).split("@")[0] : null),
    personId: enrolled ? c.personId : null,
    enrolled,
    canManageCodes: enrolled && c.canManageCodes === true && isLiveEnrolment(permRecord, c),
  };
}

export function setDeviceIdentity(args) {
  identity = identityFrom(args);
  return identity;
}

export function getDeviceIdentity() {
  return identity;
}

// ── what kind of device this is (for Junid's list and the email) ────────────
export function deviceTypeHint(nav = typeof navigator === "undefined" ? undefined : navigator) {
  const ua = String(nav?.userAgent || "");
  let os = "Unknown device";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && Number(nav?.maxTouchPoints || 0) > 1)) os = "iPad";
  else if (/iPhone|iPod/.test(ua)) os = "iPhone";
  else if (/Android/.test(ua)) os = /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  else if (/Windows/.test(ua)) os = "Windows PC";
  else if (/CrOS/.test(ua)) os = "Chromebook";
  else if (/Macintosh/.test(ua)) os = "Mac";
  else if (/Linux|X11/.test(ua)) os = "Linux computer";
  let browser = null;
  if (/SamsungBrowser/.test(ua)) browser = "Samsung Internet";
  else if (/Edg\//.test(ua)) browser = "Edge";
  else if (/Firefox|FxiOS/.test(ua)) browser = "Firefox";
  else if (/Chrome|CriOS/.test(ua)) browser = "Chrome";
  else if (/Safari/.test(ua)) browser = "Safari";
  return browser ? `${os} · ${browser}` : os;
}

// ── last seen ────────────────────────────────────────────────────────────────
// An enrolled device writes /device_enrolment/devices/{id}/lastSeenAtMs when
// the app opens and every ten minutes while it is on screen. The rule accepts
// only the device's OWN leaf, only while its enrolment is live, and only a time
// within five minutes of the server's — hence serverNowMs(), not Date.now().
// A refused or failed write is swallowed: last seen is a courtesy for Junid's
// list, never a reason for the app to stop.
export const LAST_SEEN_EVERY_MS = 10 * 60e3;
const LAST_SEEN_KEY = "marathon.enrolLastSeenAt";

export function lastSeenDue(nowMs, storage = typeof localStorage === "undefined" ? null : localStorage) {
  try {
    const prev = Number(storage?.getItem(LAST_SEEN_KEY)) || 0;
    return nowMs - prev >= LAST_SEEN_EVERY_MS || nowMs < prev;
  } catch {
    return true;
  }
}

export async function writeLastSeen({ deviceId, write, nowMs, storage = typeof localStorage === "undefined" ? null : localStorage }) {
  if (!deviceId || !lastSeenDue(nowMs, storage)) return false;
  try {
    await write(`device_enrolment/devices/${deviceId}/lastSeenAtMs`, nowMs);
    try { storage?.setItem(LAST_SEEN_KEY, String(nowMs)); } catch { /* storage off */ }
    return true;
  } catch {
    return false;
  }
}

// Remembers, per login, that this device has seen the login flagged — so a
// later failed read of /users cannot open the app (see deviceGateVerdict).
const KNOWN_KEY = (uid) => `marathon.deviceCodeRequired.${uid}`;
export function rememberRequired(uid, required, storage = typeof localStorage === "undefined" ? null : localStorage) {
  if (!uid) return;
  try {
    if (required === true) storage?.setItem(KNOWN_KEY(uid), "1");
    else storage?.removeItem(KNOWN_KEY(uid));
  } catch { /* storage off */ }
}
export function knownRequired(uid, storage = typeof localStorage === "undefined" ? null : localStorage) {
  try { return !!uid && storage?.getItem(KNOWN_KEY(uid)) === "1"; } catch { return false; }
}

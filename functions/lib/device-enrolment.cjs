// ─── DEVICE ENROLMENT — THE DECISIONS, PURE ──────────────────────────────────
//
// Staff share one login (MC's). Anyone who ever learned its PIN can still
// open the app on their own phone, and a password change would sign out every
// shop at once. So each DEVICE is enrolled instead: Junid (or MC) makes a
// 4-digit code for a named person, the person types it once on their phone,
// and the phone gets an identity of its own that the server can check.
//
// ── HOW THE IDENTITY WORKS ───────────────────────────────────────────────────
// enrolDevice (deviceEnrolment/deviceEnrolment.js) checks the code, then signs
// the device in again with a Firebase CUSTOM TOKEN for the SAME uid (MC's), so
// every existing rule keyed on auth.uid keeps working unchanged. The token
// carries extra claims — deviceId, eid (one id per enrolment), personId,
// personName — which Firebase copies into every ID token that session ever
// gets, including refreshes. No client can forge them.
//
// The switch that makes an account need a code, and the list of devices it may
// write from, live on the account's own /users record:
//
//   /users/{uid}/deviceCodeRequired   true  → this login needs a code per device
//   /users/{uid}/deviceGate/{deviceId} = eid → present ONLY while enrolled
//
// /users is readable by every signed-in staff account and writable only by
// Junid (and the Admin SDK), so the app hears a revocation through the
// permissions listener it already has, and the database rules can check
// `deviceGate/{auth.token.deviceId} === auth.token.eid` on every write. A
// revoked device's entry is deleted, so its very next write is refused and
// its screen falls back to the code entry — no reload.
//
// Everything else (people, codes, full device records, attempt counters, the
// email queue) is under /device_enrolment, which has no client read rule at
// all: the admin screen reads it through deviceEnrolmentAdmin.
//
// This file holds every DECISION, so the tests can run them without a
// database. The callables only read, decide, write.
"use strict";

const ROOT = "device_enrolment";
const PATHS = {
  people: `${ROOT}/people`,
  devices: `${ROOT}/devices`,
  codes: `${ROOT}/codes`,
  attempts: `${ROOT}/attempts`,
  emailQueue: `${ROOT}/emailQueue`,
  emailStatus: `${ROOT}/emailStatus`,
  audit: `${ROOT}/audit`,
};

const OWNER_EMAIL = "gunidmoh@gmail.com";
// A person's code enrols at most this many devices at once; a shared shop
// device's code exactly one.
const PERSON_MAX_DEVICES = 2;
const SHARED_MAX_DEVICES = 1;

// ── RATE LIMITS ──────────────────────────────────────────────────────────────
// There are only 10,000 codes, so guessing has to be slowed at every level an
// attacker could reset:
//   device  — the brief: 5 wrong codes → 15 minutes locked. A browser can mint a
//             new device id by clearing its storage, so this alone is not enough.
//   ip      — the same limit for everything behind one internet connection. A
//             shop shares one, so it is a little looser.
//   account — every device on the login together: 30 wrong in an hour locks
//             code entry for the whole login for an hour, and Junid is emailed.
// A lock only stops ENTERING CODES. Devices already enrolled keep working.
const LIMITS = {
  device: { max: 5, windowMs: 15 * 60e3, lockMs: 15 * 60e3 },
  ip: { max: 10, windowMs: 15 * 60e3, lockMs: 15 * 60e3 },
  account: { max: 30, windowMs: 60 * 60e3, lockMs: 60 * 60e3 },
};

const CODE_RE = /^\d{4}$/;
// The same alphabet getDeviceId() mints (a UUID, or its dev-… fallback); it is
// also used inside a database path and a rules expression, so nothing else.
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function readCode(x) {
  const s = typeof x === "string" ? x.trim() : typeof x === "number" ? String(x) : "";
  return CODE_RE.test(s) ? s : null;
}

function readDeviceId(x) {
  return typeof x === "string" && DEVICE_ID_RE.test(x) ? x : null;
}

// Collapses whitespace, trims, caps length; null for nothing left.
function cleanText(x, max) {
  if (typeof x !== "string") return null;
  const s = x.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

// The name a person is known by, for "is there already an active person
// called that?" — case- and spacing-blind.
function nameKey(name) {
  return String(name || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Codes someone would try first. Never issued.
function isWeakCode(code) {
  if (!CODE_RE.test(code)) return true;
  if (/^(\d)\1{3}$/.test(code)) return true;                       // 0000, 7777
  const d = code.split("").map(Number);
  const up = d.every((v, i) => i === 0 || v === (d[i - 1] + 1) % 10);
  const down = d.every((v, i) => i === 0 || v === (d[i - 1] + 9) % 10);
  if (up || down) return true;                                      // 1234, 8901, 4321
  if (code.slice(0, 2) === code.slice(2)) return true;              // 1212, 4545
  if (/^(19|20)\d\d$/.test(code)) return true;                      // years
  return false;
}

// A random code that is neither weak nor in `taken`. `randomInt(n)` returns
// 0 ≤ k < n (crypto.randomInt in production). Null after `tries` misses —
// the caller then refuses rather than looping forever.
function pickCode(randomInt, isTaken, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const code = String(randomInt(10000)).padStart(4, "0");
    if (!isWeakCode(code) && !isTaken(code)) return code;
  }
  return null;
}

// ── ATTEMPT COUNTERS ─────────────────────────────────────────────────────────
// Record shape: { fails, windowStartMs, lockedUntilMs }.

function lockVerdict(rec, now) {
  const until = Number(rec?.lockedUntilMs) || 0;
  return until > now ? { locked: true, retryAfterMs: until - now } : { locked: false, retryAfterMs: 0 };
}

// The counter after one more wrong code. A window that has run out starts
// again at 1; the attempt that reaches `max` sets the lock and restarts the
// window at the lock, so once the lock has run out (lockMs ≥ windowMs) the
// next wrong code counts from 1 again.
function afterFailure(rec, now, limit) {
  const inWindow = !!rec && Number(rec.windowStartMs) > 0 && now - Number(rec.windowStartMs) < limit.windowMs;
  const fails = (inWindow ? Number(rec.fails) || 0 : 0) + 1;
  const windowStartMs = inWindow ? Number(rec.windowStartMs) : now;
  if (fails >= limit.max) return { fails: 0, windowStartMs: now, lockedUntilMs: now + limit.lockMs, justLocked: true };
  return { fails, windowStartMs, lockedUntilMs: Number(rec?.lockedUntilMs) || 0, justLocked: false };
}

function attemptsLeft(rec, now, limit) {
  if (lockVerdict(rec, now).locked) return 0;
  const inWindow = rec && now - (Number(rec.windowStartMs) || 0) < limit.windowMs;
  return Math.max(0, limit.max - (inWindow ? Number(rec.fails) || 0 : 0));
}

// ── PEOPLE AND THEIR DEVICES ─────────────────────────────────────────────────
// Person: { name, kind: "person"|"shared", status: "active"|"revoked",
//           maxDevices, code, canManageCodes, createdAtMs, createdBy,
//           devices: { [deviceId]: { eid, atMs } } }

function activeDeviceIds(person) {
  const d = person && typeof person.devices === "object" && person.devices ? person.devices : {};
  return Object.keys(d).filter((k) => d[k] && typeof d[k] === "object" && d[k].eid);
}

function maxDevicesFor(person) {
  const n = Number(person?.maxDevices);
  if (Number.isInteger(n) && n > 0) return n;
  return person?.kind === "shared" ? SHARED_MAX_DEVICES : PERSON_MAX_DEVICES;
}

/**
 * Decide an enrolment against the person record as it stands. The same device
 * enrolling again (storage cleared, signed out and back in) takes its own slot
 * back rather than a second one. Pure: returns the next person record.
 * @returns {{ok:true, person, count, max, reachedLimit, replaced}
 *          | {ok:false, reason:"missing"|"revoked"|"full", count?, max?}}
 */
function planEnrol(person, { deviceId, eid, now }) {
  if (!person || typeof person !== "object") return { ok: false, reason: "missing" };
  if (person.status !== "active") return { ok: false, reason: "revoked" };
  const ids = activeDeviceIds(person);
  const max = maxDevicesFor(person);
  const replaced = ids.includes(deviceId);
  if (!replaced && ids.length >= max) return { ok: false, reason: "full", count: ids.length, max };
  const devices = { ...(person.devices || {}), [deviceId]: { eid, atMs: now } };
  const count = replaced ? ids.length : ids.length + 1;
  return {
    ok: true,
    person: { ...person, devices },
    count, max, replaced,
    // Only the enrolment that FILLS the code is the limit email, not a
    // re-enrolment of a device already counted.
    reachedLimit: !replaced && count === max,
  };
}

// The claims the custom token carries. Firebase refuses reserved names
// (firebase, sub, iat, …) and anything over 1000 bytes; these are neither.
function buildClaims({ deviceId, eid, personId, personName, kind }) {
  return {
    deviceId, eid, personId,
    personName: String(personName || "").slice(0, 80),
    dkind: kind === "shared" ? "shared" : "person",
  };
}

// A short, human description of the device from what the browser says about
// itself. Only for Junid's list and emails — never a security decision.
function describeDevice(typeHint, userAgent) {
  const hint = cleanText(typeHint, 60);
  if (hint) return hint;
  const ua = String(userAgent || "");
  if (/iPad/.test(ua)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Linux/.test(ua)) return "Linux computer";
  return "Unknown device";
}

// Anything that could identify WHICH network, hashed so the counter key is
// safe in a path and the raw address is never stored.
function ipKey(ip, sha256Hex) {
  const s = typeof ip === "string" && ip ? ip : "unknown";
  return `ip_${sha256Hex(s).slice(0, 24)}`;
}

module.exports = {
  ROOT, PATHS, OWNER_EMAIL, LIMITS, PERSON_MAX_DEVICES, SHARED_MAX_DEVICES,
  readCode, readDeviceId, cleanText, nameKey, isWeakCode, pickCode,
  lockVerdict, afterFailure, attemptsLeft,
  activeDeviceIds, maxDevicesFor, planEnrol, buildClaims, describeDevice, ipKey,
};

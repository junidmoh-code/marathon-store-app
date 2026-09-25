// ─── DEVICE ENROLMENT — THE CALLABLES ────────────────────────────────────────
//
// enrolDevice — a phone signed in on a login that needs a code types the
// 4-digit code it was given. This checks it (slowly, for a guesser), records
// the device against the person, and hands back a custom token for the SAME
// uid carrying the device's own identity. The phone signs in with it and is
// then, as far as the database rules are concerned, "MC on Sipho's phone"
// rather than just "MC". Every decision is in lib/device-enrolment.cjs; the
// design, and why the gate lives on /users/{uid}, is at the top of that file.
//
// THE NULL-FIRST TRAP. An RTDB transaction's first call often sees `null`
// whatever the server holds. Every transaction here that would REFUSE on
// null commits null instead, which the server rejects if the node is really
// there and re-runs with the real value. Only a refusal against a real value
// aborts.
//
// Deploy by name, never bare:
//   firebase deploy --only functions:enrolDevice
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { createHash, randomUUID } = require("node:crypto");
const admin = require("firebase-admin");
const E = require("../lib/device-enrolment.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

const sha256Hex = (s) => createHash("sha256").update(String(s)).digest("hex");

// The lock on one counter, or null. Read-only: a refused attempt made WHILE
// locked does not extend the lock (otherwise a shop could never get back in).
async function readLock(db, key, now) {
  const rec = (await db.ref(`${E.PATHS.attempts}/${key}`).once("value")).val();
  const v = E.lockVerdict(rec, now);
  return v.locked ? v : null;
}

// One more wrong code on one counter. Returns the counter as committed.
async function countFailure(db, key, now, limit) {
  let out = null;
  await db.ref(`${E.PATHS.attempts}/${key}`).transaction((cur) => {
    out = E.afterFailure(cur, now, limit);
    const { justLocked, ...rec } = out;
    return { ...rec, lastAtMs: now };
  });
  return out;
}

function queueEvent(db, event) {
  return db.ref(E.PATHS.emailQueue).push().set(event);
}

/**
 * The whole enrolment, with every dependency injected so the tests run it
 * against the in-memory database.
 * deps: { db, createCustomToken(uid, claims), now(), newId() }
 */
async function handleEnrol(request, deps) {
  const { db } = deps;
  const now = deps.now();
  const auth = request.auth;
  if (!auth || !auth.uid || auth.token?.firebase?.sign_in_provider === "anonymous") {
    throw new HttpsError("unauthenticated", "Sign in first.");
  }
  if (auth.token?.email === E.OWNER_EMAIL) {
    throw new HttpsError("failed-precondition", "Junid's account never needs a device code.");
  }
  const code = E.readCode(request.data?.code);
  const deviceId = E.readDeviceId(request.data?.deviceId);
  if (!deviceId) throw new HttpsError("invalid-argument", "This device has no id. Close the app and open it again.");
  const userAgent = E.cleanText(request.data?.userAgent, 200);
  const deviceType = E.describeDevice(request.data?.deviceType, userAgent);

  const uid = auth.uid;
  const required = (await db.ref(`users/${uid}/deviceCodeRequired`).once("value")).val();
  if (required !== true) {
    throw new HttpsError("failed-precondition", "This login does not need a device code.");
  }

  // ── the locks, before the code is even looked at ──────────────────────────
  const keys = {
    device: `dev_${deviceId}`,
    ip: E.ipKey(request.rawRequest?.ip, sha256Hex),
    account: `acct_${uid}`,
  };
  const locks = await Promise.all(Object.entries(keys).map(async ([k, key]) => [k, await readLock(db, key, now)]));
  const lock = locks.filter(([, v]) => v).sort((a, b) => b[1].retryAfterMs - a[1].retryAfterMs)[0];
  if (lock) return { ok: false, reason: "locked", scope: lock[0], retryAfterMs: lock[1].retryAfterMs };

  const wrong = async () => {
    const after = {};
    for (const [k, key] of Object.entries(keys)) after[k] = await countFailure(db, key, now, E.LIMITS[k]);
    const locked = Object.entries(after).filter(([, v]) => v.justLocked).map(([k]) => k);
    if (locked.length) {
      await queueEvent(db, {
        type: "lockout", atMs: now, scope: locked.join("+"), deviceId, deviceType,
        minutes: Math.round(Math.max(...locked.map((k) => E.LIMITS[k].lockMs)) / 60e3),
      });
      return { ok: false, reason: "locked", scope: locked[0], retryAfterMs: Math.max(...locked.map((k) => E.LIMITS[k].lockMs)) };
    }
    const left = Math.min(...Object.entries(after).map(([k, v]) => E.LIMITS[k].max - v.fails));
    return { ok: false, reason: "wrong", attemptsLeft: Math.max(0, left) };
  };

  if (!code) return wrong();
  const personId = (await db.ref(`${E.PATHS.codes}/${code}`).once("value")).val();
  if (typeof personId !== "string" || !personId) return wrong();

  // ── the slot ───────────────────────────────────────────────────────────────
  const eid = deps.newId();
  let plan = null;
  const txn = await db.ref(`${E.PATHS.people}/${personId}`).transaction((cur) => {
    if (cur === null) { plan = null; return null; }
    plan = E.planEnrol(cur, { deviceId, eid, now });
    return plan.ok ? plan.person : undefined;
  });
  if (!plan) return wrong();                       // the code pointed at nobody
  if (!plan.ok && plan.reason === "revoked") return wrong();
  const person = txn.snapshot.val() || {};
  if (!plan.ok) {
    await queueEvent(db, {
      type: "full", atMs: now, personId, personName: person.name || null, kind: person.kind || "person",
      code, deviceId, deviceType, max: plan.max,
    });
    return { ok: false, reason: "full", max: plan.max };
  }

  // The token BEFORE the device record, so a signing failure (the service
  // account missing its Token Creator role) leaves nothing half-enrolled.
  const claims = E.buildClaims({ deviceId, eid, personId, personName: person.name, kind: person.kind });
  let token;
  try {
    token = await deps.createCustomToken(uid, claims);
  } catch (err) {
    console.error("enrolDevice: could not sign the device token:", err && err.message);
    // Give the slot back — the phone has nothing to show for it.
    await db.ref(`${E.PATHS.people}/${personId}/devices/${deviceId}`).transaction((cur) =>
      (cur && cur.eid === eid ? null : cur === null ? null : undefined));
    throw new HttpsError("internal", "The code was right but the device could not be signed in. Try again in a minute.");
  }

  // A device that was enrolled under SOMEONE ELSE before is moved, not doubled:
  // the old person's slot is freed.
  const prev = (await db.ref(`${E.PATHS.devices}/${deviceId}`).once("value")).val();
  if (prev && prev.personId && prev.personId !== personId && prev.status === "active") {
    await db.ref(`${E.PATHS.people}/${prev.personId}/devices/${deviceId}`).transaction((cur) =>
      (cur === null ? null : cur.eid === prev.eid ? null : undefined));
  }

  const dev = `${E.PATHS.devices}/${deviceId}`;
  await db.ref().update({
    [`${dev}/deviceId`]: deviceId,
    [`${dev}/eid`]: eid,
    [`${dev}/uid`]: uid,
    [`${dev}/personId`]: personId,
    [`${dev}/personName`]: person.name || null,
    [`${dev}/kind`]: person.kind === "shared" ? "shared" : "person",
    [`${dev}/status`]: "active",
    [`${dev}/deviceType`]: deviceType,
    [`${dev}/userAgent`]: userAgent,
    [`${dev}/enrolledAtMs`]: now,
    [`${dev}/revokedAtMs`]: null,
    [`${dev}/revokedBy`]: null,
    [`users/${uid}/deviceGate/${deviceId}`]: eid,
    [`${E.PATHS.attempts}/${keys.device}`]: null,
  });

  await queueEvent(db, {
    type: "enrolled", atMs: now, personId, personName: person.name || null, kind: person.kind || "person",
    code, deviceId, deviceType, count: plan.count, max: plan.max, again: plan.replaced,
  });
  if (plan.reachedLimit) {
    await queueEvent(db, {
      type: "limit", atMs: now, personId, personName: person.name || null, kind: person.kind || "person",
      code, max: plan.max,
    });
  }

  return { ok: true, token, personName: person.name || null, kind: person.kind || "person" };
}

exports.enrolDevice = onCall(
  { region: "europe-west1", memory: "256MiB", timeoutSeconds: 30, maxInstances: 5 },
  (request) => handleEnrol(request, {
    db: admin.database(),
    createCustomToken: (uid, claims) => admin.auth().createCustomToken(uid, claims),
    now: () => Date.now(),
    newId: () => randomUUID(),
  }),
);

exports._handleEnrol = handleEnrol;

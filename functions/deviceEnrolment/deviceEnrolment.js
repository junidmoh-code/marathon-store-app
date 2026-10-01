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
//   firebase deploy --only functions:enrolDevice,functions:deviceEnrolmentAdmin,functions:deviceEnrolmentEmail
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { createHash, randomInt, randomUUID } = require("node:crypto");
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

// TAKE one attempt on one counter BEFORE the code is looked at, in a
// transaction: parallel requests each take their own attempt, and once the
// limit is reached every later one is refused — a burst can never test more
// codes than the limit. (CodeRabbit, PR #647.) The attempt is given back only
// if the code turns out right. Returns { locked, retryAfterMs } when refused,
// else { rec } — the counter as committed, with justLocked when THIS attempt
// was the one that reached the limit (it is still checked).
async function takeAttempt(db, key, now, limit) {
  let taken = null;
  let refusal = null;
  const res = await db.ref(`${E.PATHS.attempts}/${key}`).transaction((cur) => {
    const v = E.lockVerdict(cur, now);
    if (cur !== null && v.locked) { refusal = v; taken = null; return undefined; }
    refusal = null;
    taken = E.afterFailure(cur, now, limit);
    const { justLocked, ...rec } = taken;
    return { ...rec, lastAtMs: now };
  });
  if (!res.committed || refusal) return { locked: true, retryAfterMs: (refusal || E.lockVerdict(res.snapshot.val(), now)).retryAfterMs };
  return { rec: taken };
}

// A right code gives its attempt back. If it was the attempt that set a lock,
// the lock goes too.
async function giveBack(db, key, now, rec) {
  await db.ref(`${E.PATHS.attempts}/${key}`).transaction((cur) => {
    if (cur === null) return null;
    if (rec.justLocked && Number(cur.lockedUntilMs) === Number(rec.lockedUntilMs)) {
      return { ...cur, fails: 0, lockedUntilMs: 0 };
    }
    return Number(cur.fails) > 0 ? { ...cur, fails: Number(cur.fails) - 1 } : undefined;
  });
}

// Behind Google's front end, req.ip can be the proxy's address — every shop
// would then share one bucket. The LAST X-Forwarded-For entry is the address
// Google's front end itself saw (anything before it is client-supplied).
function clientIp(raw) {
  const xff = String(raw?.headers?.["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : raw?.ip || null;
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
    ip: E.ipKey(clientIp(request.rawRequest), sha256Hex),
    account: `acct_${uid}`,
  };
  const locks = await Promise.all(Object.entries(keys).map(async ([k, key]) => [k, await readLock(db, key, now)]));
  const lock = locks.filter(([, v]) => v).sort((a, b) => b[1].retryAfterMs - a[1].retryAfterMs)[0];
  if (lock) return { ok: false, reason: "locked", scope: lock[0], retryAfterMs: lock[1].retryAfterMs };

  // Take this attempt on every counter first (see takeAttempt).
  const taken = {};
  for (const [k, key] of Object.entries(keys)) {
    const t = await takeAttempt(db, key, now, E.LIMITS[k]);
    if (t.locked) return { ok: false, reason: "locked", scope: k, retryAfterMs: t.retryAfterMs };
    taken[k] = t.rec;
  }
  const justLocked = Object.entries(taken).filter(([, v]) => v.justLocked).map(([k]) => k);

  const wrong = async () => {
    if (justLocked.length) {
      await queueEvent(db, {
        type: "lockout", atMs: now, scope: justLocked.join("+"), deviceId, deviceType,
        minutes: Math.round(Math.max(...justLocked.map((k) => E.LIMITS[k].lockMs)) / 60e3),
      });
      return { ok: false, reason: "locked", scope: justLocked[0], retryAfterMs: Math.max(...justLocked.map((k) => E.LIMITS[k].lockMs)) };
    }
    const left = Math.min(...Object.entries(taken).map(([k, v]) => E.LIMITS[k].max - v.fails));
    return { ok: false, reason: "wrong", attemptsLeft: Math.max(0, left) };
  };

  if (!code) return wrong();
  const personId = (await db.ref(`${E.PATHS.codes}/${code}`).once("value")).val();
  if (typeof personId !== "string" || !personId) return wrong();

  // A device id is only what the browser says it is. A device that is LIVE
  // under someone else is never moved by a code — otherwise anyone holding a
  // valid code and another phone's id could knock that phone off. Junid or MC
  // revokes it first. (Sonnet architect review, PR #647.)
  const prev = (await db.ref(`${E.PATHS.devices}/${deviceId}`).once("value")).val();
  if (prev && prev.status === "active" && prev.personId && prev.personId !== personId) {
    return { ok: false, reason: "taken", personName: prev.personName || null };
  }

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
  const claims = E.buildClaims({
    deviceId, eid, personId, personName: person.name, kind: person.kind,
    canManageCodes: person.kind !== "shared" && person.canManageCodes === true,
  });
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

  await giveBack(db, keys.ip, now, taken.ip);
  await giveBack(db, keys.account, now, taken.account);

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

// ─── deviceEnrolmentAdmin — THE ADMIN SCREEN'S ONLY READER AND WRITER ────────
// Junid (verified Google email), or an enrolled device whose PERSON may make
// codes (MC) — re-checked on the person record on every call, never trusted
// from the token alone. Actions:
//   list                       people + devices (never a code)
//   createCode {name, kind, canManageCodes}   a unique random code, returned ONCE
//   revokeDevice {deviceId}    that device only; frees its slot on the code
//   revokePerson {personId}    every device of theirs, and the code is dead
// A revoke deletes /users/{uid}/deviceGate/{deviceId}: the device's next write
// is refused by the rules and its screen drops to the code entry, live.

// Small admin nodes (tens of rows), read with a bound all the same.
const LIST_LIMIT = 1000;
async function readBounded(db, path) {
  return (await db.ref(path).orderByKey().limitToFirst(LIST_LIMIT).once("value")).val() || {};
}

// A MANAGER: Junid (verified Google email), or an enrolled device whose
// person may make codes (MC) — re-checked on the person record every call,
// never trusted from the token alone. null for anyone else. Also used by
// setProductType (functions/productType/), which is manager-only for a product
// with stock or sales.
async function managerIdentity(db, auth) {
  if (!auth || !auth.uid) return null;
  const t = auth.token || {};
  if (t.email === E.OWNER_EMAIL && t.email_verified === true) return { owner: true, by: "Junid", personId: null, deviceId: null };
  if (typeof t.deviceId === "string" && typeof t.eid === "string" && typeof t.personId === "string") {
    const [gate, person] = await Promise.all([
      db.ref(`users/${auth.uid}/deviceGate/${t.deviceId}`).once("value"),
      db.ref(`${E.PATHS.people}/${t.personId}`).once("value"),
    ]);
    const p = person.val();
    if (gate.val() === t.eid && p && p.status === "active" && p.canManageCodes === true) {
      return { owner: false, by: p.name || "MC", personId: t.personId, deviceId: t.deviceId };
    }
  }
  return null;
}

async function whoIsAdmin(db, auth) {
  if (!auth || !auth.uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const who = await managerIdentity(db, auth);
  if (who) return who;
  throw new HttpsError("permission-denied", "Only Junid or MC can manage device codes.");
}

function audit(db, now, who, action, detail) {
  return db.ref(E.PATHS.audit).push().set({ atMs: now, by: who.by, owner: who.owner, action, ...detail });
}

async function revokeOne(db, deviceId, now, who) {
  const d = (await db.ref(`${E.PATHS.devices}/${deviceId}`).once("value")).val();
  if (!d) return false;
  const patch = {
    [`${E.PATHS.devices}/${deviceId}/status`]: "revoked",
    [`${E.PATHS.devices}/${deviceId}/revokedAtMs`]: now,
    [`${E.PATHS.devices}/${deviceId}/revokedBy`]: who.by,
  };
  if (d.uid) patch[`users/${d.uid}/deviceGate/${deviceId}`] = null;
  await db.ref().update(patch);
  // Free the slot only if it is still THIS enrolment's (the device may have
  // been re-enrolled under someone else since).
  if (d.personId) {
    await db.ref(`${E.PATHS.people}/${d.personId}/devices/${deviceId}`).transaction((cur) =>
      (cur === null ? null : cur.eid === d.eid ? null : undefined));
  }
  return true;
}

async function handleAdmin(request, deps) {
  const { db } = deps;
  const now = deps.now();
  const who = await whoIsAdmin(db, request.auth);
  const action = request.data?.action;

  if (action === "list") {
    const [people, devices, emailStatus, queued] = await Promise.all([
      readBounded(db, E.PATHS.people), readBounded(db, E.PATHS.devices),
      db.ref(E.PATHS.emailStatus).once("value").then((x) => x.val() || {}),
      db.ref(E.PATHS.emailQueue).orderByKey().limitToFirst(50).once("value").then((x) => Object.keys(x.val() || {}).length),
    ]);
    return {
      ok: true, ...E.listView(people, devices), you: { owner: who.owner, name: who.by },
      email: { lastSentAtMs: Number(emailStatus.lastSentAtMs) || null, queued },
    };
  }

  if (action === "createCode") {
    const name = E.cleanText(request.data?.name, 40);
    if (!name) throw new HttpsError("invalid-argument", "Type the person's name (or the shop device's name).");
    const kind = request.data?.kind === "shared" ? "shared" : "person";
    // Only Junid may make another code-maker.
    const canManageCodes = who.owner && kind === "person" && request.data?.canManageCodes === true;
    const people = await readBounded(db, E.PATHS.people);
    if (E.nameTaken(people, name)) {
      throw new HttpsError("already-exists", `${name} already has a live code. Revoke it first, or use a different name.`);
    }
    const taken = new Set(Object.values(people).map((p) => p && p.status === "active" && p.code).filter(Boolean));
    const personId = db.ref(E.PATHS.people).push().key;
    // Pick, then CLAIM in a transaction: two admins making codes in the same
    // second can never be handed the same one.
    let code = null;
    for (let i = 0; i < 20 && !code; i++) {
      const candidate = E.pickCode(deps.randomInt, (c) => taken.has(c));
      if (!candidate) break;
      const r = await db.ref(`${E.PATHS.codes}/${candidate}`).transaction((cur) => (cur === null ? personId : undefined));
      if (r.committed && r.snapshot.val() === personId) code = candidate;
      else taken.add(candidate);
    }
    if (!code) throw new HttpsError("resource-exhausted", "Could not find a free code. Try again.");
    const person = {
      name, kind, status: "active", code, canManageCodes,
      maxDevices: kind === "shared" ? E.SHARED_MAX_DEVICES : E.PERSON_MAX_DEVICES,
      createdAtMs: now, createdBy: who.by,
    };
    await db.ref(`${E.PATHS.people}/${personId}`).set(person);
    await audit(db, now, who, "createCode", { personId, name, kind, canManageCodes });
    return { ok: true, code, person: E.publicPerson(personId, person) };
  }

  if (action === "revokeDevice") {
    const deviceId = E.readDeviceId(request.data?.deviceId);
    if (!deviceId) throw new HttpsError("invalid-argument", "Which device?");
    const d = (await db.ref(`${E.PATHS.devices}/${deviceId}`).once("value")).val();
    if (!d) throw new HttpsError("not-found", "That device is not on the list.");
    if (!who.owner && d.personId) {
      const p = (await db.ref(`${E.PATHS.people}/${d.personId}`).once("value")).val();
      if (p && p.canManageCodes === true && d.personId !== who.personId) {
        throw new HttpsError("permission-denied", "Only Junid can revoke another code-maker's device.");
      }
    }
    await revokeOne(db, deviceId, now, who);
    await audit(db, now, who, "revokeDevice", { deviceId, personName: d.personName || null });
    return { ok: true };
  }

  if (action === "revokePerson") {
    const personId = typeof request.data?.personId === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(request.data.personId)
      ? request.data.personId : null;
    if (!personId) throw new HttpsError("invalid-argument", "Which person?");
    const p = (await db.ref(`${E.PATHS.people}/${personId}`).once("value")).val();
    if (!p) throw new HttpsError("not-found", "That person is not on the list.");
    if (!who.owner && p.canManageCodes === true && personId !== who.personId) {
      throw new HttpsError("permission-denied", "Only Junid can revoke another code-maker.");
    }
    // The code first: from this moment it enrols nothing.
    if (p.code) {
      await db.ref(`${E.PATHS.codes}/${p.code}`).transaction((cur) =>
        (cur === null ? null : cur === personId ? null : undefined));
    }
    await db.ref(`${E.PATHS.people}/${personId}`).update({ status: "revoked", revokedAtMs: now, revokedBy: who.by, code: null });
    // Every device that names this person — by the person's own list AND by
    // the device records, so a device the list lost track of is caught too.
    const byList = E.activeDeviceIds(p);
    const byRecord = Object.entries(await readBounded(db, E.PATHS.devices))
      .filter(([, d]) => d && d.personId === personId && d.status === "active").map(([id]) => id);
    const ids = [...new Set([...byList, ...byRecord])];
    for (const id of ids) await revokeOne(db, id, now, who);
    await audit(db, now, who, "revokePerson", { personId, name: p.name || null, devices: ids.length });
    return { ok: true, devices: ids.length };
  }

  throw new HttpsError("invalid-argument", "Unknown action.");
}

exports.deviceEnrolmentAdmin = onCall(
  { region: "europe-west1", memory: "256MiB", timeoutSeconds: 60, maxInstances: 3 },
  (request) => handleAdmin(request, {
    db: admin.database(),
    now: () => Date.now(),
    randomInt: (n) => randomInt(n),
  }),
);

// ─── deviceEnrolmentEmail — THE EMAIL TO JUNID ───────────────────────────────
// Every 5 minutes: if anything is queued (a new enrolment, a code reaching its
// limit, a full code typed again, a lockout) and the last email went out more
// than EMAIL_GAP_MS ago, print ONE marker line covering the queue and clear
// what it covered. The line becomes an email through the Cloud Monitoring
// policy installed by scripts/device-enrolment/install-enrolment-alarm.mjs.
// THE MARKER IS LOAD-BEARING: renaming it without re-running the installer
// disconnects the email; the installer's --verify pins the two together.
async function handleEmail(deps) {
  const { db, log } = deps;
  const now = deps.now();
  const status = (await db.ref(E.PATHS.emailStatus).once("value")).val() || {};
  if (Number(status.lastSentAtMs) > 0 && now - Number(status.lastSentAtMs) < E.EMAIL_GAP_MS) {
    return { sent: 0, waiting: true };
  }
  const queue = (await db.ref(E.PATHS.emailQueue).orderByKey().limitToFirst(50).once("value")).val();
  if (!queue) return { sent: 0 };
  const { line, sent } = E.buildEmailLine(queue);
  if (line) log(`${E.MARKER} ${line}`);
  const patch = {
    [`${E.PATHS.emailStatus}/lastSentAtMs`]: line ? now : Number(status.lastSentAtMs) || null,
    [`${E.PATHS.emailStatus}/lastLine`]: line || status.lastLine || null,
    [`${E.PATHS.emailStatus}/lastCount`]: sent.length,
  };
  for (const k of sent) patch[`${E.PATHS.emailQueue}/${k}`] = null;
  await db.ref().update(patch);
  return { sent: sent.length, line };
}

exports.deviceEnrolmentEmail = onSchedule(
  { schedule: "*/5 * * * *", timeZone: "Africa/Johannesburg", region: "europe-west1", memory: "256MiB", timeoutSeconds: 60 },
  () => handleEmail({ db: admin.database(), now: () => Date.now(), log: (l) => console.error(l) }),
);

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
exports._handleAdmin = handleAdmin;
exports._handleEmail = handleEmail;
exports.managerIdentity = managerIdentity;

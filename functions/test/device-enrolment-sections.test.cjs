// Device enrolment × sections: a code is made for Section 1 or Section 2, the
// device that enrols with it carries that section in its token and on its
// record, and a code (or an enrolled device) from before sections is untouched.
// Run: cd functions && node --test test/device-enrolment-sections.test.cjs
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const E = require("../lib/device-enrolment.cjs");
const { makeFakeDb, readAt } = require("./helpers/fake-rtdb.cjs");
const { _handleEnrol, _handleAdmin, managerIdentity } = require("../deviceEnrolment/deviceEnrolment.js");
const { sectionsFor, SEED_REGISTRY } = require("../lib/network-registry.cjs");

const NOW = Date.parse("2026-10-02T10:00:00.000Z");
const MC = "mc-uid";
const DEV_A = "aaaaaaaa-1111-4111-8111-111111111111";
const DEV_B = "bbbbbbbb-2222-4222-8222-222222222222";
const OWNER = { uid: "owner", token: { email: E.OWNER_EMAIL, email_verified: true } };

let ids = 0;
function deps(db) {
  const tokens = [];
  return {
    tokens, db, now: () => NOW, newId: () => `eid-${++ids}`,
    createCustomToken: async (uid, claims) => { tokens.push({ uid, claims }); return `token-${claims.eid}`; },
  };
}
const adminDeps = (db, seq = [4821, 7305, 3916, 5082]) => {
  let i = 0;
  return { db, now: () => NOW, randomInt: () => seq[i++ % seq.length] };
};
const call = (auth, data, db, d) => _handleAdmin({ auth, data }, d || adminDeps(db));
const enrolReq = (code, deviceId = DEV_A) => ({
  auth: { uid: MC, token: { email: "mc@marathon.internal", firebase: { sign_in_provider: "password" } } },
  data: { code, deviceId, userAgent: "Mozilla/5.0 (Linux; Android 10; K) Mobile" },
  rawRequest: { ip: "41.1.2.3" },
});
const fresh = () => makeFakeDb({ users: { [MC]: { deviceCodeRequired: true } } });

// ── pure ─────────────────────────────────────────────────────────────────────
test("a section is exactly the number 1 or 2", () => {
  assert.equal(E.readSection(1), 1);
  assert.equal(E.readSection(2), 2);
  for (const bad of [0, 3, "1", "2", true, null, undefined, 1.5, NaN, {}, [1]]) assert.equal(E.readSection(bad), null, JSON.stringify(bad));
});

test("the claim is there only when the code has a section — an old code's token is the token it always was", () => {
  const base = { deviceId: DEV_A, eid: "e1", personId: "p1", personName: "Sipho", kind: "person" };
  assert.deepEqual(E.buildClaims(base), { deviceId: DEV_A, eid: "e1", personId: "p1", personName: "Sipho", dkind: "person" });
  assert.deepEqual(E.buildClaims({ ...base, section: 1 }).section, 1);
  assert.deepEqual(E.buildClaims({ ...base, section: 2 }).section, 2);
  for (const bad of ["1", 3, true, null]) assert.equal("section" in E.buildClaims({ ...base, section: bad }), false, String(bad));
});

// ── making a code ────────────────────────────────────────────────────────────
test("Junid makes a Section 1 code: it is on the person, in the list, and in the audit line", async () => {
  const db = fresh();
  const made = await call(OWNER, { action: "createCode", name: "Pine tablet", kind: "shared", section: 1 }, db);
  assert.equal(made.person.section, 1);
  const root = db.state.root;
  assert.equal(readAt(root, `device_enrolment/people/${made.person.personId}/section`), 1);
  const list = await call(OWNER, { action: "list" }, db);
  assert.equal(list.people[0].section, 1);
  assert.equal(Object.values(readAt(root, "device_enrolment/audit"))[0].section, 1);
});

test("SECTION 2, AS TODAY: a Section 2 code enrols a device exactly as before, plus the claim", async () => {
  const db = fresh();
  await call(OWNER, { action: "createCode", name: "Sipho", section: 2 }, db);
  const d = deps(db);
  const out = await _handleEnrol(enrolReq("4821"), d);
  assert.equal(out.ok, true);
  const { uid, claims } = d.tokens[0];
  assert.equal(uid, MC, "still the SAME uid");
  assert.deepEqual(claims, { deviceId: DEV_A, eid: claims.eid, personId: claims.personId, personName: "Sipho", dkind: "person", section: 2 });
  const dev = readAt(db.state.root, `device_enrolment/devices/${DEV_A}`);
  assert.equal(dev.section, 2);
  assert.equal(dev.status, "active");
  assert.equal(readAt(db.state.root, `users/${MC}/deviceGate/${DEV_A}`), claims.eid);
  assert.equal((await call(OWNER, { action: "list" }, db)).devices[0].section, 2);
});

test("SECTION 1: a Section 1 code puts section 1 in the token and on the device record", async () => {
  const db = fresh();
  await call(OWNER, { action: "createCode", name: "Concrete till", kind: "shared", section: 1 }, db);
  const d = deps(db);
  await _handleEnrol(enrolReq("4821"), d);
  assert.equal(d.tokens[0].claims.section, 1);
  assert.equal(readAt(db.state.root, `device_enrolment/devices/${DEV_A}/section`), 1);
  // What the app then concludes for a device on MC's unscoped login.
  assert.deepEqual(sectionsFor(SEED_REGISTRY, { deviceCodeRequired: true }, { deviceSection: d.tokens[0].claims.section }), [1]);
});

test("the server refuses any section that is not 1 or 2 — and writes nothing", async () => {
  const db = fresh();
  for (const bad of [3, 0, "1", "2", "both", true, {}, [1], 1.5]) {
    await assert.rejects(call(OWNER, { action: "createCode", name: `X ${JSON.stringify(bad)}`, section: bad }, db),
      /Section 1 or Section 2/, JSON.stringify(bad));
  }
  assert.equal(readAt(db.state.root, "device_enrolment/people"), null);
  assert.equal(readAt(db.state.root, "device_enrolment/codes"), null);
});

test("a request with NO section (a browser on the old bundle) makes the unscoped code it always made", async () => {
  const db = fresh();
  const made = await call(OWNER, { action: "createCode", name: "Thandi" }, db);
  assert.equal(made.person.section, null);
  assert.equal("section" in readAt(db.state.root, `device_enrolment/people/${made.person.personId}`), false);
  const d = deps(db);
  await _handleEnrol(enrolReq("4821"), d);
  assert.equal("section" in d.tokens[0].claims, false);
  assert.equal(readAt(db.state.root, `device_enrolment/devices/${DEV_A}/section`), null);
});

// ── what already exists keeps working ────────────────────────────────────────
test("AN EXISTING CODE AND DEVICE WITH NO SECTION work exactly as today", async () => {
  const db = makeFakeDb({
    users: { [MC]: { deviceCodeRequired: true, deviceGate: { [DEV_B]: "eid-old" } } },
    device_enrolment: {
      codes: { 4821: "p-sipho" },
      people: { "p-sipho": { name: "Sipho", kind: "person", status: "active", code: "4821", devices: { [DEV_B]: { eid: "eid-old", atMs: 1 } } } },
      devices: { [DEV_B]: { deviceId: DEV_B, eid: "eid-old", uid: MC, personId: "p-sipho", personName: "Sipho", kind: "person", status: "active" } },
    },
  });
  // The already-enrolled device is listed, sectionless, untouched.
  const list = await call(OWNER, { action: "list" }, db);
  assert.equal(list.devices[0].section, null);
  assert.equal(list.devices[0].status, "active");
  assert.equal(list.people[0].section, null);
  // Its code still enrols a second phone, with the claims it always produced.
  const d = deps(db);
  const out = await _handleEnrol(enrolReq("4821", DEV_A), d);
  assert.equal(out.ok, true);
  assert.deepEqual(d.tokens[0].claims, { deviceId: DEV_A, eid: d.tokens[0].claims.eid, personId: "p-sipho", personName: "Sipho", dkind: "person" });
  assert.equal(readAt(db.state.root, `users/${MC}/deviceGate/${DEV_B}`), "eid-old", "the old device's gate entry is untouched");
  // No section on the token is "both sections" to the app.
  assert.deepEqual(sectionsFor(SEED_REGISTRY, {}, { deviceSection: d.tokens[0].claims.section }), [1, 2]);
});

test("a device re-enrolled under a code with no section loses the section it had", async () => {
  const db = fresh();
  await call(OWNER, { action: "createCode", name: "S1 person", section: 1 }, db, adminDeps(db, [4821]));
  await _handleEnrol(enrolReq("4821"), deps(db));
  assert.equal(readAt(db.state.root, `device_enrolment/devices/${DEV_A}/section`), 1);
  await call(OWNER, { action: "revokeDevice", deviceId: DEV_A }, db);
  await call(OWNER, { action: "createCode", name: "Old style" }, db, adminDeps(db, [7305]));
  await _handleEnrol(enrolReq("7305"), deps(db));
  assert.equal(readAt(db.state.root, `device_enrolment/devices/${DEV_A}/section`), null);
});

// ── a code-maker's own section ───────────────────────────────────────────────
async function mcWith(section) {
  const db = fresh();
  db.state.root.device_enrolment = {
    codes: { 3916: "p-mc" },
    people: { "p-mc": { name: "MC", kind: "person", status: "active", code: "3916", canManageCodes: true, ...(section ? { section } : {}) } },
  };
  const d = deps(db);
  await _handleEnrol(enrolReq("3916", DEV_B), d);
  return { db, auth: { uid: MC, token: { ...d.tokens[0].claims, email: "mc@marathon.internal" } } };
}

test("MC, whose own code predates sections, may make a code for either section", async () => {
  const { db, auth } = await mcWith(null);
  assert.equal((await managerIdentity(db, auth)).section, null);
  assert.equal((await call(auth, { action: "createCode", name: "A", section: 1 }, db, adminDeps(db, [4821]))).person.section, 1);
  assert.equal((await call(auth, { action: "createCode", name: "B", section: 2 }, db, adminDeps(db, [7305]))).person.section, 2);
});

test("a code-maker scoped to Section 2 cannot mint a Section 1 device — and an unsectioned request becomes Section 2", async () => {
  const { db, auth } = await mcWith(2);
  assert.equal((await managerIdentity(db, auth)).section, 2);
  await assert.rejects(call(auth, { action: "createCode", name: "Sneaky", section: 1 }, db, adminDeps(db, [4821])),
    /only make codes for Section 2/);
  assert.equal((await call(auth, { action: "createCode", name: "Fine", section: 2 }, db, adminDeps(db, [4821]))).person.section, 2);
  assert.equal((await call(auth, { action: "createCode", name: "Old bundle" }, db, adminDeps(db, [7305]))).person.section, 2);
});

test("the code-maker's section is read from the PERSON RECORD, never trusted from the token", async () => {
  const { db, auth } = await mcWith(2);
  const forged = { ...auth, token: { ...auth.token, section: 1 } };
  assert.equal((await managerIdentity(db, forged)).section, 2);
  await assert.rejects(call(forged, { action: "createCode", name: "Sneaky", section: 1 }, db, adminDeps(db, [4821])),
    /only make codes for Section 2/);
});

// Device enrolment: the pure decisions (lib/device-enrolment.cjs) and the
// enrolDevice handler end to end against the in-memory database, which
// deletes empty containers the way RTDB does and runs transactions null-first.
// Run: cd functions && node --test test/device-enrolment.test.cjs
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const E = require("../lib/device-enrolment.cjs");
const { makeFakeDb, readAt } = require("./helpers/fake-rtdb.cjs");
const { _handleEnrol } = require("../deviceEnrolment/deviceEnrolment.js");

const NOW = Date.parse("2026-09-25T10:00:00.000Z");
const MC = "mc-uid";
const DEV_A = "aaaaaaaa-1111-4111-8111-111111111111";
const DEV_B = "bbbbbbbb-2222-4222-8222-222222222222";
const DEV_C = "cccccccc-3333-4333-8333-333333333333";

// ── pure ─────────────────────────────────────────────────────────────────────
test("a code is exactly four digits; a device id is the getDeviceId alphabet", () => {
  assert.equal(E.readCode("0412"), "0412");
  assert.equal(E.readCode(" 4821 "), "4821");
  for (const bad of ["", "123", "12345", "12a4", null, undefined, 1234.5, "١٢٣٤"]) assert.equal(E.readCode(bad), null, String(bad));
  assert.equal(E.readDeviceId(DEV_A), DEV_A);
  assert.equal(E.readDeviceId("dev-lx2k3-9abc"), "dev-lx2k3-9abc");
  for (const bad of ["", "short", "a/b/c/d/e/f", "x".repeat(65), "has space 12345", "a.b.c.d.e.f", null]) {
    assert.equal(E.readDeviceId(bad), null, String(bad));
  }
});

test("weak codes are never issued", () => {
  for (const w of ["0000", "7777", "1234", "4321", "8901", "0987", "1212", "4545", "1999", "2026"]) assert.equal(E.isWeakCode(w), true, w);
  for (const ok of ["4821", "0412", "7305", "3916"]) assert.equal(E.isWeakCode(ok), false, ok);
});

test("pickCode skips weak and taken codes and gives up rather than loop", () => {
  const seq = [1234, 4821, 7305];
  let i = 0;
  const rnd = () => seq[i++ % seq.length];
  assert.equal(E.pickCode(rnd, (c) => c === "4821"), "7305");
  assert.equal(E.pickCode(() => 1111, () => false, 5), null);
});

test("attempt counter: 5 wrong in 15 minutes locks the device for 15 minutes", () => {
  const L = E.LIMITS.device;
  let rec = null;
  for (let n = 1; n <= 4; n++) {
    rec = E.afterFailure(rec, NOW + n * 1000, L);
    assert.equal(rec.justLocked, false);
    assert.equal(rec.fails, n);
    assert.equal(E.attemptsLeft(rec, NOW + n * 1000, L), 5 - n);
  }
  rec = E.afterFailure(rec, NOW + 5000, L);
  assert.equal(rec.justLocked, true);
  assert.equal(rec.lockedUntilMs, NOW + 5000 + 15 * 60e3);
  assert.deepEqual(E.lockVerdict(rec, NOW + 6000), { locked: true, retryAfterMs: 15 * 60e3 - 1000 });
  assert.equal(E.lockVerdict(rec, NOW + 5000 + 15 * 60e3).locked, false);
  // After the lock the count starts again from one.
  const next = E.afterFailure(rec, NOW + 5000 + 15 * 60e3, L);
  assert.equal(next.fails, 1);
  assert.equal(next.justLocked, false);
});

test("attempt counter: wrong codes spread wider than the window never lock", () => {
  const L = E.LIMITS.device;
  let rec = null;
  for (let n = 0; n < 20; n++) {
    rec = E.afterFailure(rec, NOW + n * 4 * 60e3, L);
    assert.equal(rec.justLocked, false, `attempt ${n}`);
  }
});

test("planEnrol: two devices per person, a third is refused, the same device re-takes its own slot", () => {
  const p0 = { name: "Sipho", kind: "person", status: "active" };
  const a = E.planEnrol(p0, { deviceId: DEV_A, eid: "e1", now: NOW });
  assert.equal(a.ok, true);
  assert.equal(a.count, 1);
  assert.equal(a.reachedLimit, false);
  const b = E.planEnrol(a.person, { deviceId: DEV_B, eid: "e2", now: NOW });
  assert.equal(b.count, 2);
  assert.equal(b.reachedLimit, true);
  const c = E.planEnrol(b.person, { deviceId: DEV_C, eid: "e3", now: NOW });
  assert.deepEqual(c, { ok: false, reason: "full", count: 2, max: 2 });
  const again = E.planEnrol(b.person, { deviceId: DEV_A, eid: "e4", now: NOW });
  assert.equal(again.ok, true);
  assert.equal(again.replaced, true);
  assert.equal(again.reachedLimit, false);
  assert.equal(again.person.devices[DEV_A].eid, "e4");
  assert.equal(E.planEnrol({ ...p0, status: "revoked" }, { deviceId: DEV_A, eid: "e", now: NOW }).reason, "revoked");
  assert.equal(E.planEnrol(null, { deviceId: DEV_A, eid: "e", now: NOW }).reason, "missing");
});

test("a shared shop device's code enrols exactly one device", () => {
  const p = { name: "Hub 2 tablet", kind: "shared", status: "active" };
  const a = E.planEnrol(p, { deviceId: DEV_A, eid: "e1", now: NOW });
  assert.equal(a.reachedLimit, true);
  assert.equal(E.planEnrol(a.person, { deviceId: DEV_B, eid: "e2", now: NOW }).reason, "full");
});

test("describeDevice prefers the app's own hint and never throws", () => {
  assert.equal(E.describeDevice("Android phone · Chrome", ""), "Android phone · Chrome");
  assert.equal(E.describeDevice(null, "Mozilla/5.0 (Linux; Android 10; K) Mobile Safari"), "Android phone");
  assert.equal(E.describeDevice(null, "Mozilla/5.0 (iPad; CPU OS 17_0)"), "iPad");
  assert.equal(E.describeDevice(null, null), "Unknown device");
});

// ── the handler ──────────────────────────────────────────────────────────────
function world(extra = {}) {
  return makeFakeDb({
    users: { [MC]: { username: "mc", deviceCodeRequired: true }, other: { username: "mike" } },
    device_enrolment: {
      codes: { 4821: "p-sipho", 7305: "p-hub2" },
      people: {
        "p-sipho": { name: "Sipho", kind: "person", status: "active", code: "4821" },
        "p-hub2": { name: "Hub 2 tablet", kind: "shared", status: "active", code: "7305" },
      },
    },
    ...extra,
  });
}

let ids = 0;
function deps(db, over = {}) {
  const tokens = [];
  return {
    tokens,
    db,
    now: () => NOW,
    newId: () => `eid-${++ids}`,
    createCustomToken: async (uid, claims) => { tokens.push({ uid, claims }); return `token-for-${uid}-${claims.eid}`; },
    ...over,
  };
}

const req = (data, { uid = MC, email = "mc@marathon.internal", provider = "password", ip = "41.1.2.3" } = {}) => ({
  auth: { uid, token: { email, firebase: { sign_in_provider: provider } } },
  data: { deviceId: DEV_A, userAgent: "Mozilla/5.0 (Linux; Android 10; K) Mobile", ...data },
  rawRequest: { ip },
});

test("a right code: device recorded, gate entry written, token for the SAME uid with the device's claims", async () => {
  const db = world();
  const d = deps(db);
  const out = await _handleEnrol(req({ code: "4821", deviceType: "Android phone" }), d);
  assert.equal(out.ok, true);
  assert.equal(out.personName, "Sipho");
  assert.equal(d.tokens.length, 1);
  const { uid, claims } = d.tokens[0];
  assert.equal(uid, MC);
  assert.deepEqual(claims, { deviceId: DEV_A, eid: claims.eid, personId: "p-sipho", personName: "Sipho", dkind: "person" });
  const root = db.state.root;
  assert.equal(readAt(root, `users/${MC}/deviceGate/${DEV_A}`), claims.eid);
  const dev = readAt(root, `device_enrolment/devices/${DEV_A}`);
  assert.equal(dev.status, "active");
  assert.equal(dev.personName, "Sipho");
  assert.equal(dev.deviceType, "Android phone");
  assert.equal(dev.enrolledAtMs, NOW);
  assert.equal(readAt(root, `device_enrolment/people/p-sipho/devices/${DEV_A}/eid`), claims.eid);
  const q = Object.values(readAt(root, "device_enrolment/emailQueue"));
  assert.deepEqual(q.map((e) => e.type), ["enrolled"]);
  assert.equal(q[0].code, "4821");
  assert.equal(q[0].deviceType, "Android phone");
});

test("the second device fills the code and queues the limit email; the third is refused and reported", async () => {
  const db = world();
  await _handleEnrol(req({ code: "4821" }), deps(db));
  await _handleEnrol(req({ code: "4821", deviceId: DEV_B }), deps(db));
  const q1 = Object.values(readAt(db.state.root, "device_enrolment/emailQueue")).map((e) => e.type);
  assert.deepEqual(q1, ["enrolled", "enrolled", "limit"]);
  const d = deps(db);
  const third = await _handleEnrol(req({ code: "4821", deviceId: DEV_C }), d);
  assert.deepEqual(third, { ok: false, reason: "full", max: 2 });
  assert.equal(d.tokens.length, 0);
  assert.equal(readAt(db.state.root, `users/${MC}/deviceGate/${DEV_C}`), null);
  const q2 = Object.values(readAt(db.state.root, "device_enrolment/emailQueue")).map((e) => e.type);
  assert.deepEqual(q2, ["enrolled", "enrolled", "limit", "full"]);
});

test("the same device entering its code again takes its own slot back, with a NEW enrolment id", async () => {
  const db = world();
  const d1 = deps(db);
  await _handleEnrol(req({ code: "4821" }), d1);
  const d2 = deps(db);
  const again = await _handleEnrol(req({ code: "4821" }), d2);
  assert.equal(again.ok, true);
  assert.notEqual(d2.tokens[0].claims.eid, d1.tokens[0].claims.eid);
  assert.equal(readAt(db.state.root, `users/${MC}/deviceGate/${DEV_A}`), d2.tokens[0].claims.eid);
  assert.equal(Object.keys(readAt(db.state.root, "device_enrolment/people/p-sipho/devices")).length, 1);
  const q = Object.values(readAt(db.state.root, "device_enrolment/emailQueue"));
  assert.deepEqual(q.map((e) => e.type), ["enrolled", "enrolled"]);
  assert.equal(q[1].again, true);
});

test("a device LIVE under someone else is never taken over by another code — only after a revoke", async () => {
  const db = world();
  const first = deps(db);
  await _handleEnrol(req({ code: "4821" }), first);
  const d = deps(db);
  const out = await _handleEnrol(req({ code: "7305" }), d);
  assert.deepEqual(out, { ok: false, reason: "taken", personName: "Sipho" });
  assert.equal(d.tokens.length, 0);
  assert.equal(readAt(db.state.root, `users/${MC}/deviceGate/${DEV_A}`), first.tokens[0].claims.eid, "Sipho's phone keeps working");
  assert.equal(readAt(db.state.root, "device_enrolment/people/p-hub2/devices"), null, "no slot taken");
  await _handleAdmin({ auth: { uid: "owner", token: { email: E.OWNER_EMAIL, email_verified: true } }, data: { action: "revokeDevice", deviceId: DEV_A } },
    { db, now: () => NOW, randomInt: () => 4821 });
  const after = await _handleEnrol(req({ code: "7305" }), deps(db));
  assert.equal(after.ok, true);
  assert.equal(readAt(db.state.root, `device_enrolment/devices/${DEV_A}/personName`), "Hub 2 tablet");
});

test("the network limit keys on the address Google's front end saw, not a spoofable first X-Forwarded-For", async () => {
  const db = world();
  const withXff = (xff) => ({ ...req({ code: "1111", deviceId: `x-${xff.replace(/\W/g, "")}-0000` }), rawRequest: { ip: "169.254.1.1", headers: { "x-forwarded-for": xff } } });
  for (let n = 0; n < 10; n++) await _handleEnrol(withXff(`${n}.${n}.${n}.${n}, 41.1.2.3`), deps(db));
  const keys = Object.keys(readAt(db.state.root, "device_enrolment/attempts")).filter((k) => k.startsWith("ip_"));
  assert.equal(keys.length, 1, "ten different spoofed first entries, one real address, one bucket");
  assert.ok(readAt(db.state.root, `device_enrolment/attempts/${keys[0]}/lockedUntilMs`) > NOW);
});

test("five wrong codes lock this device; a right code is then refused until the lock runs out", async () => {
  const db = world();
  for (let n = 1; n <= 4; n++) {
    const out = await _handleEnrol(req({ code: "1111" }), deps(db));
    assert.equal(out.reason, "wrong");
    assert.equal(out.attemptsLeft, 5 - n);
  }
  const fifth = await _handleEnrol(req({ code: "1111" }), deps(db));
  assert.equal(fifth.reason, "locked");
  assert.equal(fifth.retryAfterMs, 15 * 60e3);
  const d = deps(db);
  const right = await _handleEnrol(req({ code: "4821" }), d);
  assert.equal(right.reason, "locked");
  assert.equal(d.tokens.length, 0, "a locked device is never signed in, even with the right code");
  const later = await _handleEnrol(req({ code: "4821" }), deps(db, { now: () => NOW + 15 * 60e3 + 1 }));
  assert.equal(later.ok, true);
  const q = Object.values(readAt(db.state.root, "device_enrolment/emailQueue")).map((e) => e.type);
  assert.deepEqual(q, ["lockout", "enrolled"]);
});

test("a guesser who clears storage (new device id each time) is stopped by the network limit", async () => {
  const db = world();
  let last;
  for (let n = 0; n < 10; n++) {
    last = await _handleEnrol(req({ code: "1111", deviceId: `guess-${String(n).padStart(8, "0")}` }), deps(db));
  }
  assert.equal(last.reason, "locked");
  assert.equal(last.scope, "ip");
  const fresh = await _handleEnrol(req({ code: "4821", deviceId: "guess-fresh-000" }), deps(db));
  assert.equal(fresh.reason, "locked", "a brand-new device on the same network is locked too");
  const elsewhere = await _handleEnrol(req({ code: "4821", deviceId: "guess-fresh-000" }, { ip: "105.9.9.9" }), deps(db));
  assert.equal(elsewhere.ok, true);
});

test("30 wrong codes on one login within an hour lock code entry for the whole login", async () => {
  const db = world();
  let last;
  for (let n = 0; n < 30; n++) {
    last = await _handleEnrol(req({ code: "1111", deviceId: `acct-${String(n).padStart(8, "0")}` }, { ip: `10.0.0.${n}` }), deps(db));
  }
  assert.equal(last.reason, "locked");
  assert.equal(last.scope, "account");
  const right = await _handleEnrol(req({ code: "4821", deviceId: "acct-fresh-0000" }, { ip: "10.9.9.9" }), deps(db));
  assert.equal(right.reason, "locked");
});

test("a revoked person's code is just a wrong code", async () => {
  const db = world();
  db.state.root.device_enrolment.people["p-sipho"].status = "revoked";
  const out = await _handleEnrol(req({ code: "4821" }), deps(db));
  assert.equal(out.reason, "wrong");
});

test("an account that does not need a code, Junid, anonymous and a missing device id are refused outright", async () => {
  const db = world();
  await assert.rejects(_handleEnrol(req({ code: "4821" }, { uid: "other" }), deps(db)), /does not need a device code/);
  await assert.rejects(_handleEnrol(req({ code: "4821" }, { email: E.OWNER_EMAIL }), deps(db)), /never needs a device code/);
  await assert.rejects(_handleEnrol(req({ code: "4821" }, { provider: "anonymous" }), deps(db)), /Sign in first/);
  await assert.rejects(_handleEnrol({ ...req({ code: "4821" }), auth: null }, deps(db)), /Sign in first/);
  await assert.rejects(_handleEnrol(req({ code: "4821", deviceId: "x/../y" }), deps(db)), /no id/);
  assert.equal(readAt(db.state.root, "device_enrolment/emailQueue"), null);
});

test("a token that cannot be signed leaves nothing enrolled and gives the slot back", async () => {
  const db = world();
  const d = deps(db, { createCustomToken: async () => { throw new Error("iam.serviceAccounts.signBlob denied"); } });
  await assert.rejects(_handleEnrol(req({ code: "4821" }), d), /could not be signed in/);
  assert.equal(readAt(db.state.root, `users/${MC}/deviceGate`), null);
  assert.equal(readAt(db.state.root, `device_enrolment/devices/${DEV_A}`), null);
  assert.equal(readAt(db.state.root, "device_enrolment/people/p-sipho/devices"), null);
  assert.equal(readAt(db.state.root, "device_enrolment/emailQueue"), null);
});

test("a success clears this device's wrong-code count", async () => {
  const db = world();
  await _handleEnrol(req({ code: "1111" }), deps(db));
  assert.ok(readAt(db.state.root, `device_enrolment/attempts/dev_${DEV_A}`));
  await _handleEnrol(req({ code: "4821" }), deps(db));
  assert.equal(readAt(db.state.root, `device_enrolment/attempts/dev_${DEV_A}`), null);
});

// ── the admin callable ───────────────────────────────────────────────────────
const { _handleAdmin } = require("../deviceEnrolment/deviceEnrolment.js");
const OWNER = { uid: "owner", token: { email: E.OWNER_EMAIL, email_verified: true } };
const adminDeps = (db, seq = [4821, 7305, 3916, 5082]) => {
  let i = 0;
  return { db, now: () => NOW, randomInt: () => seq[i++ % seq.length] };
};
const call = (auth, data, db, d) => _handleAdmin({ auth, data }, d || adminDeps(db));

test("admin: Junid makes a code — unique, not weak, shown once, never in the list", async () => {
  const db = makeFakeDb({ users: { [MC]: { deviceCodeRequired: true } } });
  const made = await call(OWNER, { action: "createCode", name: "  Thandi  Ngcobo " }, db, adminDeps(db, [1234, 4821]));
  assert.equal(made.code, "4821", "1234 is weak and skipped");
  assert.equal(made.person.name, "Thandi Ngcobo");
  assert.equal(made.person.maxDevices, 2);
  assert.equal(readAt(db.state.root, "device_enrolment/codes/4821"), made.person.personId);
  const list = await call(OWNER, { action: "list" }, db);
  assert.equal(list.people.length, 1);
  assert.equal(JSON.stringify(list).includes("4821"), false, "the code never appears in the list");
  // The code works.
  const out = await _handleEnrol(req({ code: "4821" }), deps(db));
  assert.equal(out.ok, true);
  assert.equal(out.personName, "Thandi Ngcobo");
});

test("admin: a second person never gets a code already live, even when the dice say so", async () => {
  const db = makeFakeDb({});
  const a = await call(OWNER, { action: "createCode", name: "A" }, db, adminDeps(db, [4821]));
  const b = await call(OWNER, { action: "createCode", name: "B" }, db, adminDeps(db, [4821, 4821, 7305]));
  assert.equal(a.code, "4821");
  assert.equal(b.code, "7305");
});

test("admin: a code already claimed in the index (a concurrent admin) is skipped by the transaction", async () => {
  const db = makeFakeDb({ device_enrolment: { codes: { 4821: "someone-else" } } });
  const b = await call(OWNER, { action: "createCode", name: "B" }, db, adminDeps(db, [4821, 7305]));
  assert.equal(b.code, "7305");
  assert.equal(readAt(db.state.root, "device_enrolment/codes/4821"), "someone-else");
});

test("admin: a live name cannot be issued twice; a shared shop device holds one device", async () => {
  const db = makeFakeDb({});
  await call(OWNER, { action: "createCode", name: "Sipho" }, db);
  await assert.rejects(call(OWNER, { action: "createCode", name: "sipho " }, db), /already has a live code/);
  const hub = await call(OWNER, { action: "createCode", name: "Hub 2 tablet", kind: "shared" }, db, adminDeps(db, [7305]));
  assert.equal(hub.person.kind, "shared");
  assert.equal(hub.person.maxDevices, 1);
});

test("admin: revoke a device — gate entry gone, slot freed, code still works for a new phone", async () => {
  const db = world();
  await _handleEnrol(req({ code: "4821" }), deps(db));
  await _handleEnrol(req({ code: "4821", deviceId: DEV_B }), deps(db));
  await call(OWNER, { action: "revokeDevice", deviceId: DEV_A }, db);
  assert.equal(readAt(db.state.root, `users/${MC}/deviceGate/${DEV_A}`), null);
  assert.ok(readAt(db.state.root, `users/${MC}/deviceGate/${DEV_B}`), "the other phone is untouched");
  assert.equal(readAt(db.state.root, `device_enrolment/devices/${DEV_A}/status`), "revoked");
  assert.equal(readAt(db.state.root, `device_enrolment/devices/${DEV_A}/revokedBy`), "Junid");
  const c = await _handleEnrol(req({ code: "4821", deviceId: DEV_C }), deps(db));
  assert.equal(c.ok, true, "the freed slot takes a new phone");
});

test("admin: revoke a person — every device off, the code dead", async () => {
  const db = world();
  await _handleEnrol(req({ code: "4821" }), deps(db));
  await _handleEnrol(req({ code: "4821", deviceId: DEV_B }), deps(db));
  const out = await call(OWNER, { action: "revokePerson", personId: "p-sipho" }, db);
  assert.equal(out.devices, 2);
  assert.equal(readAt(db.state.root, `users/${MC}/deviceGate`), null);
  assert.equal(readAt(db.state.root, "device_enrolment/codes/4821"), null);
  assert.equal(readAt(db.state.root, "device_enrolment/people/p-sipho/status"), "revoked");
  assert.equal(readAt(db.state.root, "device_enrolment/people/p-sipho/code"), null);
  const again = await _handleEnrol(req({ code: "4821", deviceId: DEV_C }), deps(db));
  assert.equal(again.reason, "wrong");
  const list = await call(OWNER, { action: "list" }, db);
  assert.deepEqual(list.devices.map((d) => d.status), ["revoked", "revoked"]);
});

test("admin: MC (an enrolled code-maker) can make codes and revoke staff, but not make code-makers or revoke Junid's other code-makers", async () => {
  const db = world();
  db.state.root.device_enrolment.people["p-mc"] = { name: "MC", kind: "person", status: "active", code: "3916", canManageCodes: true };
  db.state.root.device_enrolment.codes["3916"] = "p-mc";
  db.state.root.device_enrolment.people["p-boss2"] = { name: "Other boss", kind: "person", status: "active", canManageCodes: true };
  const d = deps(db);
  await _handleEnrol(req({ code: "3916", deviceId: DEV_C }), d);
  assert.equal(d.tokens[0].claims.dmgr, true, "the token tells the app to show the tile");
  const mcAuth = { uid: MC, token: { ...d.tokens[0].claims, email: "mc@marathon.internal" } };
  const made = await call(mcAuth, { action: "createCode", name: "New Staff", canManageCodes: true }, db, adminDeps(db, [5082]));
  assert.equal(made.person.canManageCodes, false, "only Junid makes code-makers");
  await _handleEnrol(req({ code: "4821" }), deps(db));
  await call(mcAuth, { action: "revokeDevice", deviceId: DEV_A }, db);
  assert.equal(readAt(db.state.root, `users/${MC}/deviceGate/${DEV_A}`), null);
  await assert.rejects(call(mcAuth, { action: "revokePerson", personId: "p-boss2" }, db), /Only Junid/);
});

test("admin: everyone else is refused — a staff phone, a revoked code-maker, a stale enrolment, an unverified email", async () => {
  const db = world();
  db.state.root.device_enrolment.people["p-mc"] = { name: "MC", kind: "person", status: "active", code: "3916", canManageCodes: true };
  db.state.root.device_enrolment.codes["3916"] = "p-mc";
  const staff = deps(db);
  await _handleEnrol(req({ code: "4821" }), staff);
  const staffAuth = { uid: MC, token: staff.tokens[0].claims };
  await assert.rejects(call(staffAuth, { action: "list" }, db), /Only Junid or MC/);
  const mc = deps(db);
  await _handleEnrol(req({ code: "3916", deviceId: DEV_C }), mc);
  const mcAuth = { uid: MC, token: mc.tokens[0].claims };
  await call(mcAuth, { action: "list" }, db);
  await call(OWNER, { action: "revokeDevice", deviceId: DEV_C }, db);
  await assert.rejects(call(mcAuth, { action: "list" }, db), /Only Junid or MC/, "a revoked device's token no longer works");
  await assert.rejects(call({ uid: MC, token: { email: "mc@marathon.internal" } }, { action: "list" }, db), /Only Junid or MC/);
  await assert.rejects(call({ uid: "x", token: { email: E.OWNER_EMAIL, email_verified: false } }, { action: "list" }, db), /Only Junid or MC/);
  await assert.rejects(call(null, { action: "list" }, db), /Sign in first/);
});

test("admin: list is sorted active-first and carries last seen and reject count", async () => {
  const db = world();
  await _handleEnrol(req({ code: "4821" }), deps(db));
  db.state.root.device_enrolment.devices[DEV_A].lastSeenAtMs = NOW + 5000;
  db.state.root.device_enrolment.devices[DEV_A].rejectCount = 3;
  const list = await call(OWNER, { action: "list" }, db);
  assert.deepEqual(
    { ...list.devices[0], enrolledAtMs: undefined },
    { deviceId: DEV_A, personId: "p-sipho", personName: "Sipho", kind: "person", status: "active", deviceType: "Android phone",
      enrolledAtMs: undefined, lastSeenAtMs: NOW + 5000, rejectCount: 3, revokedAtMs: null, revokedBy: null },
  );
  assert.equal(list.people.find((p) => p.personId === "p-sipho").devices, 1);
  assert.deepEqual(list.email, { lastSentAtMs: null, queued: 1 });
});

// ── the email ────────────────────────────────────────────────────────────────
const { _handleEmail } = require("../deviceEnrolment/deviceEnrolment.js");

test("email: a new enrolment and the code filling up go out in ONE marker line with who, code, device and time", async () => {
  const db = world();
  await _handleEnrol(req({ code: "4821", deviceType: "Android phone · Chrome" }), deps(db));
  await _handleEnrol(req({ code: "4821", deviceId: DEV_B, deviceType: "iPhone · Safari" }), deps(db));
  const lines = [];
  const out = await _handleEmail({ db, now: () => NOW + 60e3, log: (l) => lines.push(l) });
  assert.equal(out.sent, 3);
  assert.equal(lines.length, 1);
  const l = lines[0];
  assert.ok(l.startsWith(`${E.MARKER} `));
  assert.match(l, /NEW DEVICE: Sipho · code 4821 · Android phone · Chrome · 25 Sep 12:00 · 1 of 2/);
  assert.match(l, /NEW DEVICE: Sipho · code 4821 · iPhone · Safari · 25 Sep 12:00 · 2 of 2/);
  assert.match(l, /CODE FULL: 4821 \(Sipho\) is now on 2 of 2 devices/);
  assert.ok(l.length <= E.MARKER.length + 1 + E.EMAIL_MAX_CHARS);
  assert.equal(readAt(db.state.root, "device_enrolment/emailQueue"), null, "what was sent is cleared");
  assert.equal(readAt(db.state.root, "device_enrolment/emailStatus/lastSentAtMs"), NOW + 60e3);
});

test("email: within 31 minutes of the last one it WAITS (Google folds a match into an open alert) — then sends everything queued", async () => {
  const db = world();
  await _handleEnrol(req({ code: "4821" }), deps(db));
  const lines = [];
  await _handleEmail({ db, now: () => NOW, log: (l) => lines.push(l) });
  await _handleEnrol(req({ code: "7305", deviceId: DEV_B }), deps(db));
  const wait = await _handleEmail({ db, now: () => NOW + 30 * 60e3, log: (l) => lines.push(l) });
  assert.deepEqual(wait, { sent: 0, waiting: true });
  assert.equal(lines.length, 1);
  await _handleEmail({ db, now: () => NOW + 31 * 60e3, log: (l) => lines.push(l) });
  assert.equal(lines.length, 2);
  assert.match(lines[1], /NEW DEVICE: Hub 2 tablet \(shop device\) · code 7305/);
  assert.match(lines[1], /CODE FULL: 7305 \(Hub 2 tablet \(shop device\)\) is now on 1 of 1 device /);
});

test("email: a full code typed again and a lockout are reported; an empty queue sends nothing", async () => {
  const db = world();
  const lines = [];
  assert.deepEqual(await _handleEmail({ db, now: () => NOW, log: (l) => lines.push(l) }), { sent: 0 });
  await _handleEnrol(req({ code: "7305" }), deps(db));
  await _handleEnrol(req({ code: "7305", deviceId: DEV_B, deviceType: "iPad · Safari" }), deps(db));
  for (let n = 0; n < 5; n++) await _handleEnrol(req({ code: "1111", deviceId: DEV_C, deviceType: "Android tablet · Chrome" }, { ip: "9.9.9.9" }), deps(db));
  await _handleEmail({ db, now: () => NOW, log: (l) => lines.push(l) });
  assert.match(lines[0], /REFUSED: code 7305 \(Hub 2 tablet \(shop device\)\) was typed on another device \(iPad · Safari\) but is already on 1/);
  assert.match(lines[0], /LOCKED: 5 wrong codes on a Android tablet · Chrome — code entry paused 15 min/);
});

test("email: an over-long queue is cut to the label limit and the rest goes next time — nothing is lost", () => {
  const q = {};
  for (let i = 0; i < 40; i++) q[`k${String(i).padStart(3, "0")}`] = { type: "enrolled", atMs: NOW + i, personName: `Person number ${i}`, code: "4821", deviceType: "Android phone · Chrome", count: 1, max: 2 };
  q.bad = { type: "mystery", atMs: NOW };
  const { line, sent } = E.buildEmailLine(q);
  assert.ok(line.length <= E.EMAIL_MAX_CHARS, `${line.length}`);
  assert.ok(sent.length < 41 && sent.length > 3);
  assert.ok(sent.includes("bad"), "an unreadable row never blocks the queue");
  assert.match(line, /\+\d+ more in the next email$/);
  const left = Object.fromEntries(Object.entries(q).filter(([k]) => !sent.includes(k)));
  const second = E.buildEmailLine(left);
  assert.ok(second.sent.length > 0);
});

test("a BURST of parallel guesses from one device checks at most 5 codes (the attempt is taken before the code is read)", async () => {
  let codeReads = 0;
  const db = makeFakeDb({
    users: { [MC]: { deviceCodeRequired: true } },
    device_enrolment: { codes: { 4821: "p-sipho" }, people: { "p-sipho": { name: "Sipho", kind: "person", status: "active", code: "4821" } } },
  }, { beforeRead: async (path) => { if (path.startsWith("device_enrolment/codes/")) codeReads++; await new Promise((r) => setImmediate(r)); } });
  const guesses = Array.from({ length: 20 }, (_, i) => String(3000 + i));
  const out = await Promise.all(guesses.map((c) => _handleEnrol(req({ code: c }), deps(db))));
  assert.ok(codeReads <= 5, `checked ${codeReads} codes`);
  assert.ok(out.filter((o) => o.reason === "locked").length >= 15);
});

test("a right code gives its attempt back on the network and login counters", async () => {
  const db = world();
  await _handleEnrol(req({ code: "1111" }), deps(db));
  await _handleEnrol(req({ code: "4821", deviceId: DEV_B }), deps(db));
  const ipKey = Object.keys(readAt(db.state.root, "device_enrolment/attempts")).find((k) => k.startsWith("ip_"));
  assert.equal(readAt(db.state.root, `device_enrolment/attempts/${ipKey}/fails`), 1, "only the wrong code counts");
  assert.equal(readAt(db.state.root, `device_enrolment/attempts/acct_${MC}/fails`), 1);
});

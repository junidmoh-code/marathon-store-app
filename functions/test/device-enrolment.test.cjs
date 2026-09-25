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

test("a device moved to another person frees its old slot", async () => {
  const db = world();
  await _handleEnrol(req({ code: "4821" }), deps(db));
  await _handleEnrol(req({ code: "7305" }), deps(db));
  assert.equal(readAt(db.state.root, "device_enrolment/people/p-sipho/devices"), null);
  assert.equal(readAt(db.state.root, `device_enrolment/devices/${DEV_A}/personName`), "Hub 2 tablet");
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

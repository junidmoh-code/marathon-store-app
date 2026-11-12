"use strict";
// Jafer gets the same super-admin power as Junid, at every Cloud Functions gate.
// For each gate: Jafer passes, Junid passes, a staff account fails. Removing
// Jafer from SUPER_ADMIN_EMAILS (lib/super-admins.cjs) must fail this file.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SA = require("../lib/super-admins.cjs");
const { mayEnterManually } = require("../lib/card-manual-entry.cjs");
const { mayDeclareTotal } = require("../lib/card-recon.cjs");
const { authorityOf } = require("../lib/card-supporting-slips.cjs");
const { maySetPublishing } = require("../lib/media-hash.cjs");
const { assertStyleCodeAccess } = require("../styleCode/access.cjs");
const { applyCategoryPolicy } = require("../lib/category-policy-write.cjs");
const { _assertOwner } = require("../cardRecon/cardTerminalAdmin.js");
const { _internals: na } = require("../newArrivals/newArrivals.js");
const { managerIdentity } = require("../deviceEnrolment/deviceEnrolment.js");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");

const JUNID = "gunidmoh@gmail.com";
const JAFER = "jafermohammed340@gmail.com";
const STAFF = "rashid@marathon.internal";
const tok = (email, extra = {}) => ({ email, email_verified: true, firebase: { sign_in_provider: "google.com" }, ...extra });
const req = (email, extra) => ({ auth: { uid: `uid-${email}`, token: tok(email, extra) }, data: {} });

// ── the helper itself ────────────────────────────────────────────────────────
test("SUPER_ADMIN_EMAILS is exactly Junid and Jafer", () => {
  assert.deepEqual([...SA.SUPER_ADMIN_EMAILS], [JUNID, JAFER]);
  assert.ok(Object.isFrozen(SA.SUPER_ADMIN_EMAILS));
});

test("isSuperAdmin: Jafer and Junid pass, lowercased and trimmed; everything else fails", () => {
  assert.equal(SA.isSuperAdmin(JAFER), true);
  assert.equal(SA.isSuperAdmin(JUNID), true);
  assert.equal(SA.isSuperAdmin("  JaferMohammed340@Gmail.com "), true);
  assert.equal(SA.isSuperAdmin(" GUNIDMOH@GMAIL.COM"), true);
  for (const bad of [STAFF, "junidmoh@gmail.com", "jafermohammed340@gmail.com.evil.com", "x" + JAFER, "", "   ",
    null, undefined, 42, {}, [JAFER]]) {
    assert.equal(SA.isSuperAdmin(bad), false, `must refuse ${JSON.stringify(bad)}`);
  }
});

test("isSuperAdminToken needs a VERIFIED super-admin email", () => {
  assert.equal(SA.isSuperAdminToken(tok(JAFER)), true);
  assert.equal(SA.isSuperAdminToken(tok(JUNID)), true);
  assert.equal(SA.isSuperAdminToken(tok(STAFF)), false);
  assert.equal(SA.isSuperAdminToken({ email: JAFER, email_verified: false }), false);
  assert.equal(SA.isSuperAdminToken({ email: JAFER }), false);
  assert.equal(SA.isSuperAdminToken(null), false);
});

test("superAdminName names whichever admin it is", () => {
  assert.equal(SA.superAdminName(JUNID), "Junid");
  assert.equal(SA.superAdminName(JAFER), "Jafer");
  assert.equal(SA.superAdminName(STAFF), null);
});

// ── the gates ────────────────────────────────────────────────────────────────
test("card manual entry (mayEnterManually): Jafer, Junid pass; staff fails", () => {
  assert.equal(mayEnterManually(tok(JAFER)), true);
  assert.equal(mayEnterManually(tok(JUNID)), true);
  assert.equal(mayEnterManually(tok(STAFF)), false);
});

test("card declared total (mayDeclareTotal): Jafer, Junid pass; staff fails", () => {
  assert.equal(mayDeclareTotal(tok(JAFER)), true);
  assert.equal(mayDeclareTotal(tok(JUNID)), true);
  assert.equal(mayDeclareTotal(tok(STAFF)), false);
});

test("supporting-slip authority: a total typed by Jafer or Junid is the admin kind; staff stays staff", () => {
  const rec = (byEmail) => ({ declaredTotal: { byEmail } });
  assert.equal(authorityOf(rec(JAFER)), "junid");
  assert.equal(authorityOf(rec(JUNID)), "junid");
  assert.equal(authorityOf(rec(STAFF)), "staff");
});

test("Shopify publishing (maySetPublishing): Jafer, Junid pass; staff fails", () => {
  assert.equal(maySetPublishing(tok(JAFER), {}), true);
  assert.equal(maySetPublishing(tok(JUNID), {}), true);
  assert.equal(maySetPublishing(tok(STAFF), {}), false);
  assert.equal(maySetPublishing(tok(JAFER, { email_verified: false }), {}), false, "unverified super-admin email is nobody special");
});

test("style-code access: Jafer, Junid pass as super; staff with no permission fails", async () => {
  const db = { ref: () => ({ get: async () => ({ val: () => null }) }) };
  assert.equal((await assertStyleCodeAccess(req(JAFER), db)).isSuper, true);
  assert.equal((await assertStyleCodeAccess(req(JUNID), db)).isSuper, true);
  await assert.rejects(() => assertStyleCodeAccess(req(STAFF), db), (e) => e.code === "permission-denied");
});

test("category policy (applyCategoryPolicy caller gate): Jafer, Junid pass with the list; staff fails", async () => {
  const data = { action: "census" };
  const call = (email) => applyCategoryPolicy({
    db: makeFakeDb({}), callerEmail: email, callerUid: `uid-${email}`, adminEmail: SA.SUPER_ADMIN_EMAILS, data, nowMs: 1,
  });
  // A super admin gets past the caller gate (whatever the census then says).
  for (const email of [JAFER, JUNID]) {
    await call(email).catch((e) => assert.notEqual(e.httpsCode, "permission-denied", `${email} refused at the gate`));
  }
  await assert.rejects(() => call(STAFF), (e) => e.httpsCode === "permission-denied");
});

test("card terminals (assertOwner): Jafer, Junid pass; staff fails", () => {
  assert.doesNotThrow(() => _assertOwner(req(JAFER)));
  assert.doesNotThrow(() => _assertOwner(req(JUNID)));
  assert.throws(() => _assertOwner(req(STAFF)));
});

test("new arrivals pause (isJunid = any super admin): Jafer, Junid pass; staff fails", async () => {
  assert.equal(na.isJunid(req(JAFER)), true);
  assert.equal(na.isJunid(req(JUNID)), true);
  assert.equal(na.isJunid(req(STAFF)), false);
  const db = makeFakeDb({});
  await na.assertNewArrivalsAccess(req(JAFER), db);
  await na.assertNewArrivalsAccess(req(JUNID), db);
  await assert.rejects(() => na.assertNewArrivalsAccess(req(STAFF), db));
});

test("device codes (managerIdentity): Jafer and Junid are owners, named; staff is nobody", async () => {
  const db = makeFakeDb({});
  assert.deepEqual(await managerIdentity(db, { uid: "j", token: tok(JAFER) }), { owner: true, by: "Jafer", personId: null, deviceId: null });
  assert.deepEqual(await managerIdentity(db, { uid: "g", token: tok(JUNID) }), { owner: true, by: "Junid", personId: null, deviceId: null });
  assert.equal(await managerIdentity(db, { uid: "s", token: tok(STAFF) }), null);
});

// ── index.js gates (the module needs live secrets to load, so its gates are
// checked by shape: each one must ask the helper, never a literal) ──────────
test("index.js gates all ask the super-admin helper", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const body = (name) => {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at >= 0, `${name} missing`);
    return src.slice(at, src.indexOf("\n}\n", at));
  };
  // Every CALLER gate asks the verified-token helper (email_verified === true),
  // never the bare email. (CodeRabbit, PR #896.)
  assert.match(body("assertAdmin"), /isSuperAdminToken\(request\.auth\?\.token\)/);
  assert.match(body("assertPhotoGeneration"), /isSuperAdminToken\(request\.auth\?\.token\)/);
  assert.match(body("assertEnginePolicy"), /isSuperAdminToken\(request\.auth\?\.token\)/);
  assert.match(src, /const callerIsSuperAdmin = isSuperAdminToken\(request\.auth\.token\);/); // reorder-planner force
  assert.match(src, /if \(!isSuperAdminToken\(decoded\)\) \{/);                               // chatStream
  for (const g of ["assertAdmin", "assertPhotoGeneration", "assertEnginePolicy"]) {
    assert.doesNotMatch(body(g), /isSuperAdmin\(/, `${g} must not accept an unverified email`);
  }
  assert.match(src, /if \(isSuperAdmin\(target\.email\)\) \{/);                               // never delete either admin
  assert.match(src, /adminEmail: SUPER_ADMIN_EMAILS,/);
});

// ── per-gate behaviour, the gates the first pass only checked by shape ───────
const cardRecon = require("../cardRecon/cardRecon.js");
const { _isOwner } = require("../eftPool/eftPool.js");
const { _displayCheckAllowed } = require("../displayChecks/completeCheck.js");
const { _assertMergeAccess } = require("../productMerge/mergeProducts.js");
const { _handleEnrol } = require("../deviceEnrolment/deviceEnrolment.js");

test("cardRecon assertCardRecon: Jafer, Junid pass without a flag; staff without it fails", async () => {
  const db = makeFakeDb({ users: {} });
  await cardRecon._assertCardRecon(req(JAFER), db);
  await cardRecon._assertCardRecon(req(JUNID), db);
  await assert.rejects(() => cardRecon._assertCardRecon(req(STAFF), db), (e) => e.code === "permission-denied");
});

test("cardRecon assertEmailIntake: Jafer, Junid pass; staff without the intake flag fails", async () => {
  const db = makeFakeDb({ users: {} });
  await cardRecon._assertEmailIntake(req(JAFER), db);
  await cardRecon._assertEmailIntake(req(JUNID), db);
  await assert.rejects(() => cardRecon._assertEmailIntake(req(STAFF), db), (e) => e.code === "permission-denied");
});

test("cardRecon sectionRefusalFor: Jafer, Junid are never narrowed; a PE-locked staff account is refused Concrete", async () => {
  const concrete = { storeId: "concrete", tillId: "till-1", label: "Concrete Till 1" };
  const db = makeFakeDb({ users: { [`uid-${STAFF}`]: { destShop: "marathon-pe" } } });
  assert.equal(await cardRecon.sectionRefusalFor(db, req(JAFER), "A", concrete), null);
  assert.equal(await cardRecon.sectionRefusalFor(db, req(JUNID), "A", concrete), null);
  assert.match(await cardRecon.sectionRefusalFor(db, req(STAFF), "A", concrete), /not in your section/);
});

test("cardRecon slipScopeAllowsNow: Jafer, Junid may send any till's slip; staff with no scope may not", async () => {
  const term = { storeId: "pe", tillId: "till-1", label: "Marathon Till 1" };
  const db = makeFakeDb({ users: {} });
  assert.equal(await cardRecon._slipScopeAllowsNow(db, req(JAFER), term, Date.now()), true);
  assert.equal(await cardRecon._slipScopeAllowsNow(db, req(JUNID), term, Date.now()), true);
  assert.equal(await cardRecon._slipScopeAllowsNow(db, req(STAFF), term, Date.now()), false);
});

test("eftPool isOwner: Jafer, Junid pass; staff fails", () => {
  assert.equal(_isOwner(req(JAFER)), true);
  assert.equal(_isOwner(req(JUNID)), true);
  assert.equal(_isOwner(req(STAFF)), false);
});

test("display checks completion: Jafer, Junid pass for any store; staff with no grant fails", () => {
  const userRec = { permissions: [] };
  assert.equal(_displayCheckAllowed({ email: JAFER, emailVerified: true, userRec, store: "pe" }), true);
  assert.equal(_displayCheckAllowed({ email: JUNID, emailVerified: true, userRec, store: "pe" }), true);
  assert.equal(_displayCheckAllowed({ email: STAFF, emailVerified: true, userRec, store: "pe" }), false);
});

test("mergeProducts access: Jafer, Junid pass as super; staff without stock admin fails", async () => {
  const db = makeFakeDb({ users: {} });
  db.ref = ((orig) => (p) => { const r = orig(p); r.get = r.get || (async () => r.once("value")); return r; })(db.ref.bind(db));
  assert.equal((await _assertMergeAccess(req(JAFER), db)).isSuper, true);
  assert.equal((await _assertMergeAccess(req(JUNID), db)).isSuper, true);
  await assert.rejects(() => _assertMergeAccess(req(STAFF), db), (e) => e.code === "permission-denied");
});

test("device enrolment: Jafer and Junid are told they never need a code; staff are not", async () => {
  const deps = { db: makeFakeDb({}), now: () => Date.now() };
  const enrol = (email) => _handleEnrol({ auth: { uid: `uid-${email}`, token: tok(email) }, data: { code: "4821", deviceId: "aaaaaaaa-1111-4111-8111-111111111111" } }, deps);
  await assert.rejects(() => enrol(JAFER), /never need a device code/);
  await assert.rejects(() => enrol(JUNID), /never need a device code/);
  await enrol(STAFF).then(() => {}, (e) => assert.doesNotMatch(String(e.message), /never need a device code/));
});

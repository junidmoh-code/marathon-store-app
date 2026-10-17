// ─── ONE TILL'S DAILY SLIP: THE PER-TILL SCOPE ───────────────────────────────
// Junid, 16 Oct 2026: Yasmin sends Marathon PE Till 2's card slip, Amanda
// Trophy Till 2's — each ONE till, a photo and the card total, nothing back.
// The scope lives at /users/{uid}/cardSlipTills/{storeId}/{tillId} and the
// callable is what enforces it (lib/card-slip-scope.cjs, action "slip").
//
// The registry shapes are the live ones (16 Oct 2026), with made-up TIDs: no
// terminal is named in what ships.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { assertSent } = require("./helpers/slip-receipt.cjs");
const fs = require("node:fs");
const path = require("node:path");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { handleSlip, handleSubmit, handleSlipTills } = require("../cardRecon/cardRecon.js");
const { readSlipScope, slipScopeAllows } = require("../lib/card-slip-scope.cjs");

const MT2 = "0000AA2X";   // Marathon Till 2 — pe/till-2
const TT2 = "0000BB2Y";   // Trophy Till 2 — trophy/till-2, typed entry
const MT3 = "67000003";   // Marathon Till 3 — pe/till-3
const placed = (storeId, tillId, label, from = 1789733243057) => ({ [`at-${from}`]: { effectiveFrom: from, storeId, tillId, label } });
const TERMINALS = {
  [MT2]: { storeId: "pe", tillId: "till-2", label: "Marathon Till 2", placements: placed("pe", "till-2", "Marathon Till 2") },
  [TT2]: { storeId: "trophy", tillId: "till-2", label: "Trophy Till 2", capture: "typed", placements: placed("trophy", "till-2", "Trophy Till 2") },
  [MT3]: { storeId: "pe", tillId: "till-3", label: "Marathon Till 3", placements: placed("pe", "till-3", "Marathon Till 3") },
};
const YASMIN = { uid: "u-yasmin", token: { email: "yasmin@marathon.internal" } };
const AMANDA = { uid: "u-amanda", token: { email: "amanda@marathon.internal" } };
const MANAGER = { uid: "u-manager", token: { email: "manager@marathon.internal" } };
const SAST = (s) => Date.parse(`${s}+02:00`);
const NOW = SAST("2026-10-16T18:30:00");

// The last batch on Marathon Till 2 as recorded live: #544, photographed.
const B544 = { batchKey: "544", batchNo: 544, revision: 1, capturedVia: "photo",
  slip: { openedAt: SAST("2026-10-14T17:02:11"), closedAt: SAST("2026-10-15T16:59:43"), totalCents: 2137500, format: "printed", windowSource: "printed" } };

const PHOTO = { base64: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("a jpeg, as far as the header goes")]).toString("base64") };
function world(extra = {}) {
  return makeFakeDb({
    config: { cardTerminals: TERMINALS },
    users: {
      [YASMIN.uid]: { posAccess: { storeIds: ["pe"] }, stockRole: "pos", cardSlipTills: { pe: { "till-2": true } } },
      [AMANDA.uid]: { posAccess: { storeIds: ["trophy"] }, cardSlipTills: { trophy: { "till-2": true } } },
      [MANAGER.uid]: { permFlags: { card_recon: true } },
    },
    card_batches: { pe: { [MT2]: { 544: B544 } } },
    ...extra,
  });
}
const bucket = () => ({ saved: [], file(p) { const self = this; return { save: async () => { self.saved.push(p); } }; } });
const slip = (db, auth, tid, total, b = bucket(), now = NOW) =>
  handleSlip(db, { auth, data: { action: "slip", pickedTid: tid, photos: [PHOTO], declaredTotal: total } }, { now: () => now, bucket: b });
const batches = async (db, store, tid) => (await db.ref(`card_batches/${store}/${tid}`).once("value")).val() || {};

test("readSlipScope takes exactly { store: { till: true } } and nothing else", () => {
  assert.deepEqual(readSlipScope({ pe: { "till-2": true } }), ["pe/till-2"]);
  assert.deepEqual(readSlipScope({ pe: { "till-2": true, "till-3": false, "till-1": "yes" }, trophy: { "till-2": true } }), ["pe/till-2", "trophy/till-2"]);
  for (const bad of [null, undefined, true, "pe/till-2", ["pe/till-2"], { pe: true }, { pe: ["till-2"] }, { "pe/x": { a: true } }, { pe: { "../till": true } }]) {
    assert.deepEqual(readSlipScope(bad), [], JSON.stringify(bad));
  }
  assert.equal(slipScopeAllows(["pe/till-2"], { storeId: "pe", tillId: "till-2" }), true);
  assert.equal(slipScopeAllows(["pe/till-2"], { storeId: "pe", tillId: "till-3" }), false);
  assert.equal(slipScopeAllows(["pe/till-2"], { storeId: "trophy", tillId: "till-2" }), false);
  assert.equal(slipScopeAllows([], { storeId: "pe", tillId: "till-2" }), false);
  assert.equal(slipScopeAllows(["pe/till-2"], null), false);
});

test("Yasmin sends Marathon Till 2's slip: recorded, and all she gets back is 'received'", async () => {
  const db = world();
  const b = bucket();
  const out = await slip(db, YASMIN, MT2, "21,375.00", b);
  assertSent(out, "no figure, no batch, no verdict travels back");
  const rec = (await batches(db, "pe", MT2))["545"];
  assert.ok(rec, "filed as the next batch after #544");
  assert.equal(rec.capturedVia, "typed");
  assert.equal(rec.slip.format, "typed");
  assert.equal(rec.slip.totalCents, 2137500);
  assert.equal(rec.slip.openedAt, B544.slip.closedAt, "the window runs from the last settlement");
  assert.equal(rec.slip.closedAt, SAST("2026-10-16T18:50:00"), "filed against the batch: it closes at the FNB cut-off, not when she sent it");
  assert.equal(rec.declaredTotal.cents, 2137500);
  assert.equal(rec.declaredTotal.via, "staff-slip");
  assert.equal(rec.declaredTotal.byUid, YASMIN.uid);
  assert.equal(rec.declaredTotal.byEmail, "yasmin@marathon.internal");
  assert.ok(Number.isFinite(rec.declaredTotal.at));
  assert.deepEqual(rec.submittedBy, { uid: YASMIN.uid, email: "yasmin@marathon.internal" });
  const photos = Array.isArray(rec.photos) ? rec.photos : Object.values(rec.photos);
  assert.equal(photos.length, 1);
  assert.match(photos[0], /^cardRecon\/[A-Za-z0-9_-]+\/photo-0\.jpg$/);
  assert.deepEqual(b.saved, photos, "the photo stored is the photo on the record");
  assert.ok(rec.warnings.some((w) => /typed in by yasmin@marathon\.internal from the slip, with a photo/.test(w)));
});

test("a typed 0 is a R0.00 record", async () => {
  const db = world();
  assertSent(await slip(db, YASMIN, MT2, "0"));
  assert.equal((await batches(db, "pe", MT2))["545"].slip.totalCents, 0);
});

test("Yasmin is refused for every other till, and nothing is written", async () => {
  for (const tid of [TT2, MT3]) {
    const db = world();
    const b = bucket();
    await assert.rejects(() => slip(db, YASMIN, tid, "100.00", b), (e) => e.code === "permission-denied", tid);
    assert.deepEqual(b.saved, [], "no photo stored");
    assert.deepEqual(await batches(db, TERMINALS[tid].storeId, tid), tid === MT2 ? { 544: B544 } : {}, "no record");
    assert.equal((await db.ref(`card_batch_drafts/${YASMIN.uid}`).once("value")).val(), null, "no draft");
  }
});

test("Amanda sends Trophy Till 2's and is refused Marathon Till 2's", async () => {
  const db = world();
  assertSent(await slip(db, AMANDA, TT2, "2,500.00"));
  assert.equal(Object.values(await batches(db, "trophy", TT2))[0].slip.totalCents, 250000);
  await assert.rejects(() => slip(db, AMANDA, MT2, "1.00"), (e) => e.code === "permission-denied");
});

test("the scope follows the TILL: a machine moved off the till is no longer hers to send", async () => {
  const moved = { ...TERMINALS, [MT2]: { ...TERMINALS[MT2], placements: {
    ...TERMINALS[MT2].placements, ...placed("pe", "till-1", "Marathon Till 1", SAST("2026-10-16T09:00:00")) } } };
  const db = world({ config: { cardTerminals: moved } });
  await assert.rejects(() => slip(db, YASMIN, MT2, "1.00"), (e) => e.code === "permission-denied");
});

test("card_recon is not this scope: a manager without a till list is refused; no sign-in is refused", async () => {
  const db = world();
  await assert.rejects(() => slip(db, MANAGER, MT2, "1.00"), (e) => e.code === "permission-denied");
  await assert.rejects(() => slip(db, { uid: undefined }, MT2, "1.00"), (e) => e.code === "permission-denied");
});

test("one photo is required; a mangled number is refused in words", async () => {
  const db = world();
  const call = (data) => handleSlip(db, { auth: YASMIN, data: { action: "slip", pickedTid: MT2, ...data } }, { now: () => NOW, bucket: bucket() });
  await assert.rejects(() => call({ photos: [], declaredTotal: "1.00" }), (e) => e.code === "invalid-argument");
  await assert.rejects(() => call({ photos: [PHOTO, PHOTO], declaredTotal: "1.00" }), (e) => e.code === "invalid-argument");
  const bent = await call({ photos: [PHOTO], declaredTotal: "12abc" });
  assert.equal(bent.ok, false);
  assert.match(bent.reason, /is not an amount/);
  assert.deepEqual(await batches(db, "pe", MT2), { 544: B544 });
});

test("a scope taken away between the two halves stops the record", async () => {
  // The same correction draft, twice: recorded while the till is hers, refused
  // once it is not. (handleSlip submits at once; the gap is where a revoke lands.)
  const db = world();
  assertSent(await slip(db, YASMIN, MT2, "5.00"));
  const rec545 = (await batches(db, "pe", MT2))["545"];
  const draft = async () => {
    const ref = db.ref(`card_batch_drafts/${YASMIN.uid}`).push();
    await ref.set({
      by: YASMIN.uid, createdAt: NOW, expiresAt: Date.now() + 60000, pickedTid: MT2, summaryOnly: true, correction: true,
      photoPaths: [`cardRecon/${ref.key}/photo-0.jpg`], slipSubmit: true, typedOnly: true,
      extraction: { ...rec545.slip, tid: MT2, batchNo: "545", lines: [], format: "typed", mid: null },
      terminal: { storeId: "pe", tillId: "till-2", label: "Marathon Till 2" },
      declaredTotal: { cents: rec545.slip.totalCents, byUid: YASMIN.uid },
    });
    return ref.key;
  };
  const kept = await handleSubmit(db, { auth: YASMIN, data: { action: "submit", draftId: await draft() } });
  assert.equal(kept.ok, true, kept.reason);
  assert.equal(kept.batchKey, "545-r2");
  await db.ref(`users/${YASMIN.uid}/cardSlipTills`).set(null);
  const out = await handleSubmit(db, { auth: YASMIN, data: { action: "submit", draftId: await draft() } });
  assert.equal(out.ok, false);
  assert.equal((await batches(db, "pe", MT2))["545-r3"], undefined);
});

test("every action except 'slip' and 'slipTills' (own tills only, read-only) still sits behind card_recon", () => {
  const code = fs.readFileSync(path.join(__dirname, "../cardRecon/cardRecon.js"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const handler = code.slice(code.indexOf("exports.cardBatchCapture = onCall("));
  const gate = handler.indexOf("await assertCardRecon(request);");
  const slipAt = handler.indexOf('if (action === "slip")');
  assert.ok(gate > 0 && slipAt > 0 && slipAt < gate, "slip is dispatched before the card_recon gate");
  // Nothing else is dispatched before the gate.
  const before = handler.slice(0, gate);
  assert.deepEqual((before.match(/action === "([a-zA-Z]+)"/g) || []).sort(), ['action === "slip"', 'action === "slipTills"'], "only 'slip' and 'slipTills' are handled ahead of card_recon");
  for (const a of ["receive", "notices", "noticeSent", "version", "extract", "typed", "submit"]) {
    assert.ok(handler.indexOf(`action === "${a}"`) > gate, `${a} is behind card_recon`);
  }
});

test("not a photo: bytes that are not a JPEG are refused before anything is stored", async () => {
  const db = world();
  const b = bucket();
  await assert.rejects(() => handleSlip(db, { auth: YASMIN, data: { action: "slip", pickedTid: MT2, photos: [{ base64: Buffer.from("%PDF-1.4 hello").toString("base64") }], declaredTotal: "1.00" } },
    { now: () => NOW, bucket: b }), (e) => e.code === "invalid-argument");
  assert.deepEqual(b.saved, []);
});

test("the machine's own report for today is already in: the slip is NEVER refused — it is kept beside the report", async () => {
  // Marathon Till 2's photographed #544 closed at 16:59 today. Junid, 16 Oct
  // 2026: the staff slip is accepted and stored as a supporting slip on #544;
  // the machine's report stays the figure. She is told only "received".
  const today = { ...B544, slip: { ...B544.slip, openedAt: SAST("2026-10-15T17:02:11"), closedAt: SAST("2026-10-16T16:59:43") } };
  const db = world({ card_batches: { pe: { [MT2]: { 544: today } } } });
  const b = bucket();
  const out = await slip(db, YASMIN, MT2, "21,375.00", b);
  assertSent(out);
  const recs = await batches(db, "pe", MT2);
  assert.deepEqual(Object.keys(recs), ["544"], "not filed as another batch");
  assert.equal(recs["544"].slip.totalCents, today.slip.totalCents, "the machine's figure is untouched");
  const [s] = Object.values(recs["544"].supportingSlips);
  assert.equal(s.cents, 2137500);
  assert.equal(s.byEmail, "yasmin@marathon.internal");
  assert.equal(b.saved.length, 1);
  assert.deepEqual(s.photos, b.saved);
});

// ─── Junid, 17 Oct 2026: Marathon PE Till 2 is a PHOTO ONLY; Trophy Till 2
// (typed-total, no total on its paper) is photo AND number. ───────────────────
const JOBS = "card_batch_jobs";
const jobs = async (db) => (await db.ref(JOBS).once("value")).val() || {};

test("Yasmin's photo alone is received: stored first, queued to be read, and nothing but 'received' goes back", async () => {
  const db = world();
  const b = bucket();
  const out = await handleSlip(db, { auth: YASMIN, data: { action: "slip", pickedTid: MT2, photos: [PHOTO] } }, { now: () => NOW, bucket: b });
  assertSent(out);
  const queued = Object.values(await jobs(db));
  assert.equal(queued.length, 1, "one read job");
  const job = queued[0];
  assert.equal(job.pickedTid, MT2);
  assert.equal(job.storeId, "pe");
  assert.equal(job.tillId, "till-2");
  assert.equal(job.by, YASMIN.uid);
  assert.equal(job.status, "queued");
  assert.equal(b.saved.length, 1, "the photo is stored before anything is read");
  assert.ok(b.saved[0].endsWith("/photo-0.jpg"));
  // No record yet: the total comes off the photo when it is read.
  assert.deepEqual(await batches(db, "pe", MT2), { 544: B544 });
});

test("an empty total on a photo-only till is the same as none: the photo is received", async () => {
  const db = world();
  const out = await handleSlip(db, { auth: YASMIN, data: { action: "slip", pickedTid: MT2, photos: [PHOTO], declaredTotal: "" } }, { now: () => NOW, bucket: bucket() });
  assertSent(out);
  assert.equal(Object.keys(await jobs(db)).length, 1);
});

test("the per-till scope still decides a photo-only slip: Yasmin can't send Till 3's or Trophy's, and nothing is stored", async () => {
  const db = world();
  for (const tid of [MT3, TT2]) {
    const b = bucket();
    await assert.rejects(
      () => handleSlip(db, { auth: YASMIN, data: { action: "slip", pickedTid: tid, photos: [PHOTO] } }, { now: () => NOW, bucket: b }),
      (e) => e.code === "permission-denied", tid);
    assert.equal(b.saved.length, 0);
  }
  assert.deepEqual(await jobs(db), {});
});

test("Trophy Till 2 is typed-total: Amanda's photo without the number is refused, with it it is recorded", async () => {
  const db = world();
  await assert.rejects(
    () => handleSlip(db, { auth: AMANDA, data: { action: "slip", pickedTid: TT2, photos: [PHOTO] } }, { now: () => NOW, bucket: bucket() }),
    (e) => e.code === "invalid-argument" && /Type the card total/.test(e.message));
  assert.deepEqual(await jobs(db), {});
  const out = await slip(db, AMANDA, TT2, "2,500.00");
  assertSent(out);
  const recs = Object.values(await batches(db, "trophy", TT2));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].slip.totalCents, 250000);
});

test("a typed total on a photo-only till still works (an old screen still open on a phone)", async () => {
  const db = world();
  const out = await slip(db, YASMIN, MT2, "21,375.00");
  assertSent(out);
  assert.ok((await batches(db, "pe", MT2))["545"]);
});

test("with Yasmin's live record (destShop marathon-pe, POS cashier) the photo-only slip passes the section check too", async () => {
  const db = world();
  await db.ref(`users/${YASMIN.uid}`).update({ destShop: "marathon-pe", role: "store_assistant", permissions: ["store_assistant", "place_orders"] });
  const out = await handleSlip(db, { auth: YASMIN, data: { action: "slip", pickedTid: MT2, photos: [PHOTO] } }, { now: () => NOW, bucket: bucket() });
  assertSent(out);
  assert.equal(Object.keys(await jobs(db)).length, 1);
});

// ─── "Which tills are mine" over HTTP (Junid, 17 Oct 2026: the screen took
// ~47 s on a phone, queued behind the app's first load on the socket). ────────
test("slipTills: each person gets ONLY their own till — id, label, typed — and nothing else", async () => {
  const db = world();
  const y = await handleSlipTills(db, { auth: YASMIN, data: { action: "slipTills" } }, { now: () => NOW });
  assert.deepEqual(y, { ok: true, dayYmd: "2026-10-16", tills: [{ tid: MT2, storeId: "pe", tillId: "till-2", label: "Marathon Till 2", typed: false, sent: null }] });
  const a = await handleSlipTills(db, { auth: AMANDA, data: { action: "slipTills" } }, { now: () => NOW });
  assert.deepEqual(a.tills.map((t) => [t.tid, t.typed]), [[TT2, true]]);
  const m = await handleSlipTills(db, { auth: MANAGER, data: { action: "slipTills" } }, { now: () => NOW });
  assert.deepEqual(m, { ok: true, dayYmd: "2026-10-16", tills: [] }, "card_recon is not a till scope");
  assert.doesNotMatch(JSON.stringify(y), /total|cents|batch|variance/i);
  await assert.rejects(() => handleSlipTills(db, { auth: null, data: {} }), (e) => e.code === "permission-denied");
});

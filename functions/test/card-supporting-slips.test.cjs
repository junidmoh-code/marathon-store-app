// ─── THE SUPPORTING SLIP: PRECEDENCE machine report > Junid > staff typed ─────
// Junid, 16 Oct 2026: a staff slip is never refused because a better figure is
// in. It is kept beside that figure — photo and typed total — and never
// replaces it. A staff slip that was the day's record first moves beside the
// figure that takes over from it. The sender sees "received" and nothing else.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { assertSent } = require("./helpers/slip-receipt.cjs");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { handleSlip, handleSubmit, handleTypedCapture, processReadJob, resolveWriteFor, carriedSlipsFor } = require("../cardRecon/cardRecon.js");
const { handleManualEntry } = require("../cardRecon/cardBatchManual.js");
const { authorityOf, shouldAttach, carriedSlips } = require("../lib/card-supporting-slips.cjs");

const MT2 = "0000AA2X";   // Marathon Till 2 — pe/till-2, photographed / emailed
const TT2 = "0000BB2Y";   // Trophy Till 2 — trophy/till-2, typed entry
const placed = (storeId, tillId, label, from = 1789733243057) => ({ [`at-${from}`]: { effectiveFrom: from, storeId, tillId, label } });
const TERMINALS = {
  [MT2]: { storeId: "pe", tillId: "till-2", label: "Marathon Till 2", placements: placed("pe", "till-2", "Marathon Till 2") },
  [TT2]: { storeId: "trophy", tillId: "till-2", label: "Trophy Till 2", capture: "typed", placements: placed("trophy", "till-2", "Trophy Till 2") },
};
const YASMIN = { uid: "u-yasmin", token: { email: "yasmin@marathon.internal" } };
const AMANDA = { uid: "u-amanda", token: { email: "amanda@marathon.internal" } };
const JUNID = { uid: "junid", token: { email: "gunidmoh@gmail.com", email_verified: true } };
const SAST = (s) => Date.parse(`${s}+02:00`);
const NOW = SAST("2026-10-16T18:30:00");
const PHOTO = { base64: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg bytes")]).toString("base64") };

// Marathon Till 2's own report, photographed at 16:59 TODAY.
const M544 = { batchKey: "544", batchNo: 544, revision: 1, capturedVia: "photo",
  slip: { openedAt: SAST("2026-10-15T17:02:11"), closedAt: SAST("2026-10-16T16:59:43"), totalCents: 2137500, format: "printed", windowSource: "printed" } };
// Trophy Till 2's last settlement, typed by Junid YESTERDAY.
const T499 = { batchKey: "499", batchNo: 499, revision: 1, capturedVia: "typed",
  declaredTotal: { cents: 0, byUid: "junid", byEmail: "gunidmoh@gmail.com", at: SAST("2026-10-15T17:12:00") },
  slip: { openedAt: SAST("2026-10-14T18:59:00"), closedAt: SAST("2026-10-15T17:12:00"), totalCents: 0, format: "typed", windowSource: "typed-span" } };

function world(batches) {
  return makeFakeDb({
    config: { cardTerminals: TERMINALS },
    users: {
      [YASMIN.uid]: { cardSlipTills: { pe: { "till-2": true } } },
      [AMANDA.uid]: { cardSlipTills: { trophy: { "till-2": true } } },
    },
    card_batches: batches,
  });
}
const bucket = () => ({ saved: [], deleted: [], file(p) { const self = this; return { save: async () => { self.saved.push(p); }, delete: async () => { self.deleted.push(p); } }; } });
const slip = (db, auth, tid, total, now = NOW, b = bucket()) =>
  handleSlip(db, { auth, data: { action: "slip", pickedTid: tid, photos: [PHOTO], declaredTotal: total } }, { now: () => now, bucket: b });
// The Unread rows and the notices to Junid — the staff-slip log beside them is not one.
const unreadOrNotice = async (db) => { const o = (await db.ref("card_batch_overrides").once("value")).val() || {}; delete o.staff_slips; return Object.keys(o).length ? o : null; };
const node = async (db, p) => (await db.ref(p).once("value")).val();
const junidTypes = async (db, total, { correction = false, now = NOW } = {}) => {
  const drafted = await handleTypedCapture(db, { auth: JUNID, data: { declaredTotal: total, correction } }, { picked: TT2, terminal: TERMINALS[TT2], nowMs: now });
  assert.equal(drafted.ok, true, drafted.reason);
  return handleSubmit(db, { auth: JUNID, data: { action: "submit", draftId: drafted.draftId } });
};

// ── the rule, pure ───────────────────────────────────────────────────────────

test("whose figure: the machine's report, Junid's (typed or manual), or a staff slip", () => {
  assert.equal(authorityOf(M544), "machine");
  assert.equal(authorityOf(T499), "junid");
  assert.equal(authorityOf({ ...M544, capturedVia: "manual" }), "junid");
  assert.equal(authorityOf({ ...T499, declaredTotal: { ...T499.declaredTotal, via: "staff-slip" } }), "staff");
});

test("attach only to TODAY's better figure: never to their own slip (a correction), never to yesterday's", () => {
  assert.equal(shouldAttach({ key: "544", record: M544 }, NOW), true);
  assert.equal(shouldAttach({ key: "500", record: { ...T499, slip: { ...T499.slip, closedAt: SAST("2026-10-16T17:51:00") } } }, NOW), true);
  assert.equal(shouldAttach({ key: "499", record: T499 }, NOW), false, "yesterday's: the slip is today's record");
  const theirs = { ...M544, declaredTotal: { cents: 1, via: "staff-slip" } };
  assert.equal(shouldAttach({ key: "545", record: theirs }, NOW), false);
  assert.equal(shouldAttach({ key: null, record: null }, NOW), false);
});

test("carried forward: a replacement inherits always; a later-day report of an open batch never does", () => {
  const staff = { ...M544, batchKey: "545", capturedVia: "typed", photos: ["cardRecon/d1/photo-0.jpg"],
    declaredTotal: { cents: 2137500, via: "staff-slip", byUid: "u-yasmin", byEmail: "yasmin@marathon.internal", at: NOW },
    photoRead: { status: "read", readCents: 2137000, differs: true },
    supportingSlips: { a: { slipId: "a", cents: 5 } } };
  const sameDayReport = { autoSuperseded: true, slip: { closedAt: NOW + 3600000 } };
  const out = carriedSlips(staff, "545", sameDayReport);
  assert.deepEqual(Object.keys(out).sort(), ["a", "rec-545"]);
  assert.equal(out["rec-545"].cents, 2137500);
  assert.equal(out["rec-545"].fromKey, "545");
  assert.deepEqual(out["rec-545"].photos, ["cardRecon/d1/photo-0.jpg"]);
  assert.equal(out["rec-545"].photoRead.readCents, 2137000);
  assert.equal(carriedSlips(staff, "545", { autoSuperseded: true, slip: { closedAt: NOW + 24 * 3600000 } }), null,
    "a later day's report of an open batch keeps its own day's slips");
  assert.ok(carriedSlips(staff, "545", { autoSuperseded: false, slip: { closedAt: NOW - 24 * 3600000 } })["rec-545"],
    "a replacement stands in its place, whatever the day");
  assert.equal(carriedSlips(M544, "544", sameDayReport), null, "nothing to carry from a machine report without slips");
});

// ── 1. the machine's report is in ────────────────────────────────────────────

test("Yasmin after Marathon Till 2's own report today: kept beside #544, nothing replaced, 'received' only", async () => {
  const db = world({ pe: { [MT2]: { 544: M544 } } });
  const b = bucket();
  assertSent(await slip(db, YASMIN, MT2, "21,300.00", NOW, b));
  const recs = await node(db, `card_batches/pe/${MT2}`);
  assert.deepEqual(Object.keys(recs), ["544"]);
  assert.equal(recs["544"].slip.totalCents, 2137500, "the machine's report stays the figure");
  assert.equal(recs["544"].revision, 1);
  const [s] = Object.values(recs["544"].supportingSlips);
  assert.equal(s.cents, 2130000);
  assert.equal(s.via, "staff-slip");
  assert.equal(s.byUid, "u-yasmin");
  assert.equal(s.at, NOW);
  assert.match(s.photos[0], /^cardRecon\/slip-[^/]+\/photo-0\.jpg$/);
  assert.deepEqual(b.saved, s.photos);
});

test("her slip's photo is read in the background and the read goes on HER slip, not on the machine's figure", async () => {
  const db = world({ pe: { [MT2]: { 544: M544 } } });
  await slip(db, YASMIN, MT2, "21,300.00");
  const [job] = Object.values(await node(db, "card_batch_jobs"));
  assert.equal(job.mode, "check");
  assert.equal(job.batchKey, "544");
  assert.ok(job.slipId);
  assert.equal(job.typedCents, 2130000);
  const ocr = async () => ({ parsed: { tid: MT2, batchNo: "544", total: "R21,375.00", confidence: {} }, tokensIn: 1, tokensOut: 1, model: "gemini-test", attempts: 1 });
  const r = await processReadJob(db, job.jobId, { now: () => NOW + 60000, onArrival: true, loadPhotos: async () => [PHOTO], ocr });
  assert.equal(r.final, "recorded");
  const rec = await node(db, `card_batches/pe/${MT2}/544`);
  assert.equal(rec.photoRead, undefined, "the machine's record is not annotated");
  const pr = rec.supportingSlips[job.slipId].photoRead;
  assert.deepEqual([pr.status, pr.readCents, pr.typedCents, pr.differs], ["read", 2137500, 2130000, true]);
  assert.equal(await unreadOrNotice(db), null, "no Unread row");
});

test("two slips beside the same report are both kept", async () => {
  const db = world({ pe: { [MT2]: { 544: M544 } } });
  await slip(db, YASMIN, MT2, "21,300.00");
  await slip(db, YASMIN, MT2, "21,375.00", NOW + 600000);
  const rec = await node(db, `card_batches/pe/${MT2}/544`);
  assert.deepEqual(Object.values(rec.supportingSlips).map((s) => s.cents).sort(), [2130000, 2137500]);
  assert.equal(rec.slip.totalCents, 2137500);
});

// ── 2. Junid's figure outranks a staff slip ──────────────────────────────────

test("Amanda after Junid typed Trophy Till 2 today: kept beside his #500, never a correction of it", async () => {
  const db = world({ trophy: { [TT2]: { 499: T499 } } });
  const mine = await junidTypes(db, "2,500.00", { now: SAST("2026-10-16T17:51:00") });
  assert.equal(mine.ok, true, mine.reason);
  assertSent(await slip(db, AMANDA, TT2, "2,400.00"));
  const recs = await node(db, `card_batches/trophy/${TT2}`);
  assert.deepEqual(Object.keys(recs).sort(), ["499", "500"], "no 500-r2: his figure is not replaced");
  assert.equal(recs["500"].slip.totalCents, 250000);
  assert.equal(recs["500"].declaredTotal.byEmail, "gunidmoh@gmail.com");
  assert.deepEqual(Object.values(recs["500"].supportingSlips).map((s) => [s.cents, s.byEmail]), [[240000, "amanda@marathon.internal"]]);
});

test("Yasmin after Junid's manual entry for today: kept beside it", async () => {
  const manual = { ...M544, capturedVia: "manual", declaredTotal: { cents: 2137500, byUid: "junid", byEmail: "gunidmoh@gmail.com", at: NOW - 3600000 } };
  const db = world({ pe: { [MT2]: { 544: manual } } });
  assertSent(await slip(db, YASMIN, MT2, "21,375.00"));
  const recs = await node(db, `card_batches/pe/${MT2}`);
  assert.deepEqual(Object.keys(recs), ["544"]);
  assert.equal(Object.values(recs["544"].supportingSlips)[0].cents, 2137500);
});

test("Amanda first, then Junid corrects: his figure takes over and her slip moves beside it", async () => {
  const db = world({ trophy: { [TT2]: { 499: T499 } } });
  assertSent(await slip(db, AMANDA, TT2, "2,400.00"));
  assert.equal((await node(db, `card_batches/trophy/${TT2}/500`)).declaredTotal.via, "staff-slip", "her slip is the day's record while nothing better is in");
  const mine = await junidTypes(db, "2,500.00", { correction: true, now: NOW + 600000 });
  assert.equal(mine.ok, true, mine.reason);
  const recs = await node(db, `card_batches/trophy/${TT2}`);
  assert.deepEqual(Object.keys(recs).sort(), ["499", "500", "500-r2"]);
  const r2 = recs["500-r2"];
  assert.equal(r2.slip.totalCents, 250000, "Junid's figure is the record");
  assert.equal(r2.declaredTotal.via, undefined);
  const s = r2.supportingSlips["rec-500"];
  assert.deepEqual([s.cents, s.byEmail, s.fromKey], [240000, "amanda@marathon.internal", "500"]);
  assert.equal(s.photos.length, 1);
  assert.equal(recs["500"].slip.totalCents, 240000, "her record is kept unchanged");
  // …and her next slip today goes beside his figure, not over it.
  await slip(db, AMANDA, TT2, "2,450.00", NOW + 1200000);
  const after = await node(db, `card_batches/trophy/${TT2}`);
  assert.deepEqual(Object.keys(after).sort(), ["499", "500", "500-r2"]);
  assert.deepEqual(Object.values(after["500-r2"].supportingSlips).map((x) => x.cents).sort(), [240000, 245000]);
});

test("Junid's manual correction of a staff slip carries the slip too", async () => {
  const staff = { batchKey: "545", batchNo: 545, revision: 1, capturedVia: "typed", photos: ["cardRecon/d9/photo-0.jpg"],
    declaredTotal: { cents: 2130000, via: "staff-slip", byUid: "u-yasmin", byEmail: "yasmin@marathon.internal", at: NOW - 3600000 },
    slip: { openedAt: SAST("2026-10-15T17:02:11"), closedAt: NOW - 3600000, totalCents: 2130000, format: "typed", windowSource: "typed-span" } };
  const db = world({ pe: { [MT2]: { 544: { ...M544, slip: { ...M544.slip, closedAt: SAST("2026-10-15T17:02:11") } }, 545: staff } } });
  const out = await handleManualEntry(db, { auth: JUNID, data: { tid: MT2, dayYmd: "2026-10-16", reason: "wrong", replaces: "545", total: "21,375.00" } },
    { now: () => NOW, computeExpectedCard: async (d, q) => ({ cardCents: 2137500, legs: 1, byKind: null, cashiers: [], query: q }) });
  assert.equal(out.ok, true, out.reason);
  const rec = await node(db, `card_batches/pe/${MT2}/${out.batchKey}`);
  assert.equal(rec.slip.totalCents, 2137500);
  assert.deepEqual([rec.supportingSlips["rec-545"].cents, rec.supportingSlips["rec-545"].fromKey], [2130000, "545"]);
});

// ── 3. the machine's report arrives after a staff slip ────────────────────────

test("the machine's report of the slip's filing number takes over, and the slip moves beside it", async () => {
  const db = world({ pe: { [MT2]: { 544: { ...M544, slip: { ...M544.slip, closedAt: SAST("2026-10-15T17:02:11") } } } } });
  await slip(db, YASMIN, MT2, "21,300.00");             // filed as #545, typed — nothing better is in
  const real = { format: "printed", windowSource: "printed", emptyBatch: false, totalCents: 2137500, printedAt: NOW + 1800000 };
  const { write } = await resolveWriteFor(db, { storeId: "pe", tid: MT2, batchNo: "545", correction: false, lines: [], totalCents: 2137500, incoming: real });
  assert.equal(write.supersedes, "545");
  const carried = await carriedSlipsFor(db, "pe", MT2, write.supersedes, NOW + 1800000);
  assert.deepEqual([carried["rec-545"].cents, carried["rec-545"].byUid], [2130000, "u-yasmin"]);
});

// ── review fixes (CodeRabbit + Sonnet, #731) ──────────────────────────────────

const { syncCarried } = require("../cardRecon/cardRecon.js");
const { MAX_SUPPORTING_SLIPS } = require("../lib/card-supporting-slips.cjs");
// Junid's manual correction of #544, same day.
const M544R2 = { ...M544, batchKey: "544-r2", revision: 2, supersedes: "544", autoSuperseded: false, capturedVia: "manual",
  declaredTotal: { cents: 2140000, byUid: "junid", byEmail: "gunidmoh@gmail.com", at: NOW - 60000 },
  slip: { ...M544.slip, totalCents: 2140000 } };

test("a better figure lands while the slip is in flight: the slip still ends up on the record Junid sees", async () => {
  let injected = false;
  const db = makeFakeDb({
    config: { cardTerminals: TERMINALS },
    users: { [YASMIN.uid]: { cardSlipTills: { pe: { "till-2": true } } } },
    card_batches: { pe: { [MT2]: { 544: M544 } } },
  }, {
    // Junid's correction is written between Yasmin's read of the record in
    // force (#544) and her slip's transaction on it.
    beforeRead: async (path, state) => {
      if (!injected && path === `card_batches/pe/${MT2}/544`) {
        injected = true;
        state.root.card_batches.pe[MT2]["544-r2"] = structuredClone(M544R2);
      }
    },
  });
  assertSent(await slip(db, YASMIN, MT2, "21,300.00"));
  assert.equal(injected, true);
  const recs = await node(db, `card_batches/pe/${MT2}`);
  const onR1 = Object.values(recs["544"].supportingSlips || {});
  const onR2 = Object.values(recs["544-r2"].supportingSlips || {});
  assert.equal(onR1.length, 1, "on the record it was sent against…");
  assert.deepEqual(onR2.map((s) => [s.slipId, s.cents]), onR1.map((s) => [s.slipId, s.cents]), "…and on the one that took over");
  assert.equal(recs["544-r2"].slip.totalCents, 2140000, "Junid's figure untouched");
});

test("the successor is written after the slip: its writer brings the slip across (syncCarried), never twice", async () => {
  const withSlip = { ...M544, supportingSlips: { s1: { slipId: "s1", cents: 2130000, photos: ["cardRecon/slip-s1/photo-0.jpg"], at: NOW, photoRead: null } } };
  const db = world({ pe: { [MT2]: { 544: withSlip, "544-r2": M544R2 } } });
  await syncCarried(db, `card_batches/pe/${MT2}`, "544", "544-r2");
  await syncCarried(db, `card_batches/pe/${MT2}`, "544", "544-r2");
  const r2 = await node(db, `card_batches/pe/${MT2}/544-r2`);
  assert.deepEqual(Object.keys(r2.supportingSlips), ["s1"]);
  assert.equal(r2.slip.totalCents, 2140000);
  // A later day's report is not this day's: nothing is carried across midnight.
  const later = { ...M544R2, batchKey: "544-r3", revision: 3, supersedes: "544-r2", autoSuperseded: true, capturedVia: "pdf", declaredTotal: null,
    slip: { ...M544.slip, closedAt: NOW + 24 * 3600000 } };
  await db.ref(`card_batches/pe/${MT2}/544-r3`).set(later);
  await syncCarried(db, `card_batches/pe/${MT2}`, "544-r2", "544-r3");
  assert.equal((await node(db, `card_batches/pe/${MT2}/544-r3`)).supportingSlips, undefined);
});

test("the photo read reaches the carried copy on the record that took over", async () => {
  const db = world({ pe: { [MT2]: { 544: M544 } } });
  await slip(db, YASMIN, MT2, "21,300.00");
  const [job] = Object.values(await node(db, "card_batch_jobs"));
  // Junid corrects #544 before the background read runs; his write carries the slip.
  const r2 = { ...M544R2, supportingSlips: (await node(db, `card_batches/pe/${MT2}/544`)).supportingSlips };
  await db.ref(`card_batches/pe/${MT2}/544-r2`).set(r2);
  const ocr = async () => ({ parsed: { tid: MT2, batchNo: "544", total: "R21,375.00", confidence: {} }, tokensIn: 1, tokensOut: 1, model: "gemini-test", attempts: 1 });
  await processReadJob(db, job.jobId, { now: () => NOW + 60000, onArrival: true, loadPhotos: async () => [PHOTO], ocr });
  const carried = (await node(db, `card_batches/pe/${MT2}/544-r2`)).supportingSlips[job.slipId];
  assert.deepEqual([carried.photoRead.readCents, carried.photoRead.differs], [2137500, true]);
});

test(`at most ${MAX_SUPPORTING_SLIPS} slips beside one record: the next is refused in words, its photo removed`, async () => {
  const many = Object.fromEntries(Array.from({ length: MAX_SUPPORTING_SLIPS }, (_, i) => [`s${i}`, { slipId: `s${i}`, cents: i }]));
  const db = world({ pe: { [MT2]: { 544: { ...M544, supportingSlips: many } } } });
  const b = bucket();
  const out = await slip(db, YASMIN, MT2, "1.00", NOW, b);
  assert.equal(out.ok, false);
  assert.match(out.reason, /Tell Junid/);
  assert.doesNotMatch(out.reason, /R\s?\d/, "no figure in the answer");
  assert.equal(Object.keys((await node(db, `card_batches/pe/${MT2}/544`)).supportingSlips).length, MAX_SUPPORTING_SLIPS);
  assert.deepEqual(b.deleted, b.saved);
  assert.equal(await node(db, "card_batch_jobs"), null, "no paid read queued");
});

test("a manager's typed total is staff typing, not Junid's: a later staff slip corrects it, as before", () => {
  const mgr = { ...T499, declaredTotal: { ...T499.declaredTotal, byEmail: "manager@marathon.internal" },
    slip: { ...T499.slip, closedAt: SAST("2026-10-16T17:00:00") } };
  assert.equal(authorityOf(mgr), "staff");
  assert.equal(shouldAttach({ key: "500", record: mgr }, NOW), false);
});

test("a deleted record is never brought back by a slip", async () => {
  let gone = false;
  const db = makeFakeDb({
    config: { cardTerminals: TERMINALS },
    users: { [YASMIN.uid]: { cardSlipTills: { pe: { "till-2": true } } } },
    card_batches: { pe: { [MT2]: { 544: M544 } } },
  }, {
    beforeRead: async (path, state) => {
      if (!gone && path === `card_batches/pe/${MT2}/544`) { gone = true; delete state.root.card_batches.pe[MT2]["544"]; }
    },
  });
  const b = bucket();
  const out = await slip(db, YASMIN, MT2, "1.00", NOW, b);
  assert.equal(out.ok, false);
  assert.equal(await node(db, `card_batches/pe/${MT2}/544`), null);
  assert.deepEqual(b.deleted, b.saved);
});

// ── spec review fixes (Fable, #731) ──────────────────────────────────────────

test("yesterday's report arrives LATE, after today's staff slip took its number: recorded as the slip's replacement, the slip kept beside it", async () => {
  // #543 is the last on file (14 Oct → 15 Oct); yesterday's report never came in.
  const M543 = { ...M544, batchKey: "543", batchNo: 543, slip: { ...M544.slip, openedAt: SAST("2026-10-14T16:57:00"), closedAt: SAST("2026-10-15T17:02:11") } };
  const db = world({ pe: { [MT2]: { 543: M543 } } });
  await slip(db, YASMIN, MT2, "21,375.00");               // today, filed as #544 (typed)
  assert.equal((await node(db, `card_batches/pe/${MT2}/544`)).declaredTotal.via, "staff-slip");
  // …then the machine's real #544, which closed YESTERDAY (16 Oct is today).
  const late = { format: "printed", windowSource: "printed", emptyBatch: false, totalCents: 1910500,
    openedAt: SAST("2026-10-15T17:02:11"), closedAt: SAST("2026-10-15T23:30:00"), printedAt: SAST("2026-10-15T23:30:00") };
  const { write } = await resolveWriteFor(db, { storeId: "pe", tid: MT2, batchNo: "544", correction: false, lines: [], totalCents: 1910500, incoming: late });
  assert.equal(write.ok, true, write.reason);
  assert.equal(write.supersedes, "544");
  assert.equal(write.autoSuperseded, false, "a replacement, not a later report that would put yesterday's money on today");
  const carried = await carriedSlipsFor(db, "pe", MT2, write.supersedes, { autoSuperseded: write.autoSuperseded, slip: { closedAt: late.closedAt } });
  assert.deepEqual([carried["rec-544"].cents, carried["rec-544"].byUid], [2137500, "u-yasmin"], "her slip is never lost");
});

test("Junid's NEW manual entry on a day whose record is a staff slip replaces it (no second batch, no double count) and keeps the slip", async () => {
  const db = world({ trophy: { [TT2]: { 499: T499 } } });
  await slip(db, AMANDA, TT2, "2,400.00");                // #500 — her slip is the day's record
  const out = await handleManualEntry(db, { auth: JUNID, data: { tid: TT2, dayYmd: "2026-10-16", reason: "no-slip", batchNo: "501", total: "2,500.00" } },
    { now: () => NOW + 600000, computeExpectedCard: async (d, q) => ({ cardCents: 250000, legs: 1, byKind: null, cashiers: [], query: q }) });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.batchKey, "500-r2");
  assert.equal(out.supersedes, "500");
  const recs = await node(db, `card_batches/trophy/${TT2}`);
  assert.deepEqual(Object.keys(recs).sort(), ["499", "500", "500-r2"], "no #501 beside her #500");
  const s = recs["500-r2"].supportingSlips["rec-500"];
  assert.deepEqual([s.cents, s.byEmail], [240000, "amanda@marathon.internal"]);
  assert.ok(recs["500-r2"].warnings.some((w) => /staff slip \(500\) was already the record/.test(w)));
});

test("Junid is the one constant mayDeclareTotal checks", () => {
  const { JUNID_EMAIL } = require("../lib/card-supporting-slips.cjs");
  const { DECLARED_TOTAL_EMAIL } = require("../lib/card-recon.cjs");
  assert.equal(JUNID_EMAIL, DECLARED_TOTAL_EMAIL);
});

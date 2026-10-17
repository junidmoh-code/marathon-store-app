// ─── "DID MY SLIP ARRIVE?" — ONE ANSWER EVERY SCREEN READS ───────────────────
// Junid, 17 Oct 2026: Yasmin said she sent Marathon PE Till 2's slip and
// nothing showed anywhere. Every staff slip the server keeps now leaves an
// entry at /card_batch_overrides/staff_slips/{store}/{tid}/{tradingDay} — the
// photo-only one IN THE SAME WRITE as its job — and the reply carries a
// receipt the phone shows "Sent" against. A typed staff slip is filed against
// its batch (closing at the FNB cut-off, 18:50), whatever time it was sent.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { assertSent } = require("./helpers/slip-receipt.cjs");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { handleSlip, handleSlipTills, handleTypedCapture, handleSubmit } = require("../cardRecon/cardRecon.js");
const { slipTradingDay, batchCloseOf, staffSlipDayPath, latestStaffSlip } = require("../lib/card-staff-slip-log.cjs");
const { shouldAttach } = require("../lib/card-supporting-slips.cjs");

const SAST = (s) => Date.parse(`${s}+02:00`);
const placed = (storeId, tillId, label) => ({ "at-1789733243057": { effectiveFrom: 1789733243057, storeId, tillId, label } });
const MT2 = "0000HP1X";
const TT2 = "0000Z4M6";
const TERMINALS = {
  [MT2]: { storeId: "pe", tillId: "till-2", label: "Marathon Till 2", placements: placed("pe", "till-2", "Marathon Till 2") },
  [TT2]: { storeId: "trophy", tillId: "till-2", label: "Trophy Till 2", capture: "typed", placements: placed("trophy", "till-2", "Trophy Till 2") },
};
const YASMIN = { uid: "u-yasmin", token: { email: "yasmin@marathon.internal" } };
const AMANDA = { uid: "u-amanda", token: { email: "amanda@marathon.internal" } };
const JUNID = { uid: "junid", token: { email: "gunidmoh@gmail.com", email_verified: true } };
const PHOTO = { base64: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg bytes")]).toString("base64") };

// Marathon Till 2's own report, closed 16 Oct 16:59; Trophy Till 2 typed by Junid 16 Oct 17:51.
const M544 = { batchKey: "544", batchNo: 544, revision: 1, capturedVia: "photo",
  slip: { openedAt: SAST("2026-10-15T17:02:12"), closedAt: SAST("2026-10-16T16:59:43"), totalCents: 2137500, format: "printed", windowSource: "printed" } };
const T500 = { batchKey: "500", batchNo: 500, revision: 1, capturedVia: "typed",
  declaredTotal: { cents: 100000, byUid: "junid", byEmail: "gunidmoh@gmail.com", at: SAST("2026-10-16T17:51:42") },
  slip: { openedAt: SAST("2026-10-15T17:12:54"), closedAt: SAST("2026-10-16T17:51:42"), totalCents: 100000, format: "typed", windowSource: "typed-span" } };

function world(extraUsers = {}) {
  return makeFakeDb({
    config: { cardTerminals: TERMINALS },
    users: {
      [YASMIN.uid]: { cardSlipTills: { pe: { "till-2": true } } },
      [AMANDA.uid]: { cardSlipTills: { trophy: { "till-2": true } } },
      ...extraUsers,
    },
    card_batches: { pe: { [MT2]: { 544: M544 } }, trophy: { [TT2]: { 500: T500 } } },
  });
}
const bucket = () => ({ saved: [], deleted: [], file(p) { const self = this; return { save: async () => { self.saved.push(p); }, delete: async () => { self.deleted.push(p); } }; } });
const send = (db, auth, tid, { total, now, b = bucket() } = {}) =>
  handleSlip(db, { auth, data: { action: "slip", pickedTid: tid, photos: [PHOTO], ...(total !== undefined ? { declaredTotal: total } : {}) } }, { now: () => now, bucket: b });
const node = async (db, p) => (await db.ref(p).once("value")).val();
const log = async (db, storeId, tid, dayYmd) => Object.values((await node(db, staffSlipDayPath({ storeId, tid, dayYmd }))) || {});
const tills = (db, auth, now) => handleSlipTills(db, { auth, data: { action: "slipTills" } }, { now: () => now });

// ── the rule, pure ───────────────────────────────────────────────────────────

test("the trading day: before 06:00 SAST is the evening before; 06:00 on is that day", () => {
  assert.equal(slipTradingDay(SAST("2026-10-17T16:24:00")), "2026-10-17");
  assert.equal(slipTradingDay(SAST("2026-10-17T19:30:00")), "2026-10-17");
  assert.equal(slipTradingDay(SAST("2026-10-17T23:59:59")), "2026-10-17");
  assert.equal(slipTradingDay(SAST("2026-10-18T00:30:00")), "2026-10-17");
  assert.equal(slipTradingDay(SAST("2026-10-18T05:59:59")), "2026-10-17");
  assert.equal(slipTradingDay(SAST("2026-10-18T06:00:00")), "2026-10-18");
  assert.equal(batchCloseOf("2026-10-17"), SAST("2026-10-17T18:50:00"));
  assert.equal(batchCloseOf("17 Oct"), null);
  assert.throws(() => staffSlipDayPath({ storeId: "pe", tid: "../x", dayYmd: "2026-10-17" }));
});

test("a staff slip after midnight goes beside the evening's report, not into tomorrow", () => {
  const inForce = { key: "544", record: M544 };
  assert.equal(shouldAttach(inForce, SAST("2026-10-16T19:00:00")), true);
  assert.equal(shouldAttach(inForce, SAST("2026-10-17T00:30:00")), true, "00:30 is still the 16th's trading day");
  assert.equal(shouldAttach(inForce, SAST("2026-10-17T07:00:00")), false, "a new trading day: the slip is its own record");
});

// ── the photo-only till (Marathon PE Till 2) ─────────────────────────────────

test("Yasmin's photo at 16:24: a receipt, and the log entry is written with the job — the till shows as sent", async () => {
  const db = world();
  const now = SAST("2026-10-17T16:24:30");
  const before = await tills(db, YASMIN, now);
  assert.deepEqual(before.tills.map((t) => [t.tid, t.sent]), [[MT2, null]], "nothing yet today");
  const b = bucket();
  const out = assertSent(await send(db, YASMIN, MT2, { now, b }));
  assert.deepEqual(out.receipt, { at: now, dayYmd: "2026-10-17" });
  const [entry] = await log(db, "pe", MT2, "2026-10-17");
  assert.equal(entry.kind, "received");
  assert.equal(entry.byUid, YASMIN.uid);
  assert.equal(entry.byEmail, "yasmin@marathon.internal");
  assert.equal(entry.at, now);
  assert.equal(entry.tillId, "till-2");
  assert.equal(entry.placeStoreId, "pe");
  assert.deepEqual(entry.photos, b.saved, "the photo Junid opens is the photo stored");
  const job = await node(db, `card_batch_jobs/${entry.jobId}`);
  assert.equal(job.status, "queued", "the log names the job that will read it");
  assert.equal(job.dayYmd, "2026-10-17");
  const after = await tills(db, YASMIN, now + 60000);
  assert.deepEqual(after.tills.map((t) => [t.tid, t.sent]), [[MT2, { at: now }]]);
  assert.equal(after.dayYmd, "2026-10-17");
  assert.doesNotMatch(JSON.stringify(after), /cents|total|batch|variance|job/i, "when, never what");
});

test("a manager's own receive (the Card Recon screen) is not a staff slip and is not logged", async () => {
  const { handleReceive } = require("../cardRecon/cardRecon.js");
  const db = world({ "u-mgr": { permFlags: { card_recon: true } } });
  const now = SAST("2026-10-17T17:05:00");
  assertSent(await handleReceive(db, { auth: { uid: "u-mgr", token: { email: "mgr@marathon.internal" } }, data: { action: "receive", pickedTid: MT2, photos: [PHOTO] } }, { now: () => now, bucket: bucket() }));
  assert.equal(await node(db, "card_batch_overrides/staff_slips"), null);
});

test("a refused slip leaves no log entry and no receipt", async () => {
  const db = world();
  const now = SAST("2026-10-17T16:24:30");
  await assert.rejects(() => send(db, AMANDA, MT2, { now }), (e) => e.code === "permission-denied");
  await assert.rejects(() => send(db, AMANDA, TT2, { now }), (e) => e.code === "invalid-argument", "Trophy Till 2 needs the typed total");
  assert.equal(await node(db, "card_batch_overrides/staff_slips"), null);
});

// ── the typed-total till (Trophy Till 2) ─────────────────────────────────────

test("Amanda at 15:43, before the batch closes: filed against the batch closing at 18:50 today, and logged", async () => {
  const db = world();
  const now = SAST("2026-10-17T15:43:46");
  const out = assertSent(await send(db, AMANDA, TT2, { total: "2,400.00", now }));
  assert.equal(out.receipt.dayYmd, "2026-10-17");
  const rec = await node(db, `card_batches/trophy/${TT2}/501`);
  assert.equal(rec.slip.openedAt, T500.slip.closedAt, "opens where the last batch closed");
  assert.equal(rec.slip.closedAt, SAST("2026-10-17T18:50:00"), "closes at the FNB cut-off, so the card sales after 15:43 are this batch's");
  assert.equal(rec.slip.printedAt, now, "when she sent it is kept");
  assert.ok(rec.warnings.some((w) => /FNB cut-off \(18:50 on 2026-10-17\); the slip was sent at 15:43/.test(w)));
  const [entry] = await log(db, "trophy", TT2, "2026-10-17");
  assert.deepEqual([entry.kind, entry.batchKey, entry.byUid, entry.placeStoreId, entry.tillId], ["record", "501", AMANDA.uid, "trophy", "till-2"]);
  assert.deepEqual(entry.photos, Array.isArray(rec.photos) ? rec.photos : Object.values(rec.photos));
  assert.deepEqual((await tills(db, AMANDA, now)).tills.map((t) => t.sent), [{ at: now }]);
  // The next day's slip opens where the bank's batch did.
  const next = SAST("2026-10-18T16:00:00");
  assertSent(await send(db, AMANDA, TT2, { total: "1,000.00", now: next }));
  const r502 = await node(db, `card_batches/trophy/${TT2}/502`);
  assert.equal(r502.slip.openedAt, SAST("2026-10-17T18:50:00"));
  assert.equal(r502.slip.closedAt, SAST("2026-10-18T18:50:00"));
  assert.deepEqual((await tills(db, AMANDA, next)).tills.map((t) => t.sent), [{ at: next }], "the 18th has its own answer");
});

test("sent at 19:30 and again at 00:30: the same trading day, a correction — never a second batch", async () => {
  const db = world();
  assertSent(await send(db, AMANDA, TT2, { total: "2,400.00", now: SAST("2026-10-17T19:30:00") }));
  const out = assertSent(await send(db, AMANDA, TT2, { total: "2,450.00", now: SAST("2026-10-18T00:30:00") }));
  assert.equal(out.receipt.dayYmd, "2026-10-17");
  const recs = await node(db, `card_batches/trophy/${TT2}`);
  assert.deepEqual(Object.keys(recs).sort(), ["500", "501", "501-r2"]);
  assert.equal(recs["501"].slip.closedAt, SAST("2026-10-17T18:50:00"), "a slip sent after the close is that batch's");
  assert.equal(recs["501-r2"].slip.closedAt, SAST("2026-10-17T18:50:00"));
  assert.equal((await log(db, "trophy", TT2, "2026-10-17")).length, 2);
  assert.equal(await node(db, staffSlipDayPath({ storeId: "trophy", tid: TT2, dayYmd: "2026-10-18" })), null);
});

test("Junid corrects her slip at 18:40, before the cut-off: his figure is the record in force", async () => {
  const db = world();
  assertSent(await send(db, AMANDA, TT2, { total: "2,400.00", now: SAST("2026-10-17T15:43:00") }));
  const at = SAST("2026-10-17T18:40:00");
  const drafted = await handleTypedCapture(db, { auth: JUNID, data: { declaredTotal: "2,500.00", correction: true } }, { picked: TT2, terminal: TERMINALS[TT2], nowMs: at });
  assert.equal(drafted.ok, true, drafted.reason);
  const done = await handleSubmit(db, { auth: JUNID, data: { action: "submit", draftId: drafted.draftId } });
  assert.equal(done.ok, true, done.reason);
  const r2 = await node(db, `card_batches/trophy/${TT2}/501-r2`);
  assert.equal(r2.slip.closedAt, SAST("2026-10-17T18:50:00"), "a correction never closes before what it corrects");
  // Her next slip goes beside his figure.
  assertSent(await send(db, AMANDA, TT2, { total: "2,450.00", now: SAST("2026-10-17T18:45:00") }));
  const recs = await node(db, `card_batches/trophy/${TT2}`);
  assert.deepEqual(Object.keys(recs).sort(), ["500", "501", "501-r2"]);
  const kept = Object.values(recs["501-r2"].supportingSlips).find((s) => s.cents === 245000);
  assert.equal(kept.dayYmd, "2026-10-17");
  const entries = await log(db, "trophy", TT2, "2026-10-17");
  assert.deepEqual(entries.map((e) => e.kind).sort(), ["record", "supporting"]);
  const sup = entries.find((e) => e.kind === "supporting");
  assert.deepEqual([sup.batchKey, sup.slipId], ["501-r2", kept.slipId]);
  assert.deepEqual(sup.photos, kept.photos);
  assert.equal(latestStaffSlip(Object.fromEntries(entries.map((e, i) => [i, e]))).kind, "supporting");
});

test("a log that cannot be written never un-sends a slip the record already holds", async () => {
  const db = world();
  const realRef = db.ref.bind(db);
  db.ref = (p) => {
    const r = realRef(p);
    if (String(p || "").startsWith("card_batch_overrides/staff_slips")) {
      return { ...r, push: () => ({ key: "x", set: async () => { throw new Error("PERMISSION_DENIED"); } }) };
    }
    return r;
  };
  const out = assertSent(await send(db, AMANDA, TT2, { total: "2,400.00", now: SAST("2026-10-17T15:43:00") }));
  assert.equal(out.receipt.dayYmd, "2026-10-17");
  assert.ok(await node(db, `card_batches/trophy/${TT2}/501`), "the record stands");
});

// ── review fixes (Sonnet architect, #743) ────────────────────────────────────

test("the machine's report of the same batch outranks a staff slip filed at 18:50, whatever its close", async () => {
  const { readLastBatchFor } = require("../cardRecon/cardRecon.js");
  const staff = { batchKey: "545", batchNo: 545, revision: 1, capturedVia: "typed",
    declaredTotal: { cents: 100000, via: "staff-slip", byUid: YASMIN.uid, byEmail: "yasmin@marathon.internal", at: SAST("2026-10-17T16:24:00") },
    slip: { openedAt: M544.slip.closedAt, closedAt: SAST("2026-10-17T18:50:00"), totalCents: 100000, format: "typed" } };
  const machine = { batchKey: "545-r2", batchNo: 545, revision: 2, supersedes: "545", autoSuperseded: true, capturedVia: "photo",
    slip: { openedAt: M544.slip.closedAt, closedAt: SAST("2026-10-17T18:49:58"), totalCents: 105000, format: "printed" } };
  const db = makeFakeDb({ config: { cardTerminals: TERMINALS }, users: {}, card_batches: { pe: { [MT2]: { 544: M544, 545: staff, "545-r2": machine } } } });
  const last = await readLastBatchFor(db, "pe", MT2);
  assert.equal(last.key, "545-r2");
  assert.equal(shouldAttach({ key: last.key, record: last.record }, SAST("2026-10-17T19:30:00")), true, "her next slip goes beside the machine's figure");
});

test("a staff slip after a later close (a report at 19:00, the slip at 19:30) never gets a window that ends before it starts", () => {
  const { planTypedCapture } = require("../lib/card-recon.cjs");
  const now = SAST("2026-10-17T19:30:00");
  const plan = planTypedCapture({ tid: TT2, totalText: "10.00", nowMs: now, lastBatchNo: 500, lastOpenedAt: SAST("2026-10-16T19:00:00"),
    lastClosedAt: SAST("2026-10-17T19:00:00"), lastWasTyped: false, closeAtMs: batchCloseOf("2026-10-17") });
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(plan.extraction.openedAt, SAST("2026-10-17T19:00:00"));
  assert.equal(plan.extraction.closedAt, now);
});

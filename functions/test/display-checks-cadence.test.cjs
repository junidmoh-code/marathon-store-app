// ─── DISPLAY CHECKS SWEEP CADENCE — five runs a day, trading hours ────────────
// Run: cd functions && node --test
//
// The sweep used to run every 5 minutes round the clock: 288 dispatches a day,
// 200-odd of them against an index that could not have changed because the shop
// was shut. Owner decision 2026-09-19: 09:00, 11:00, 13:00, 15:00 and 16:00
// SAST, nothing outside that window.
//
// This file pins the three claims that make that safe:
//
//   1. the SCHEDULE — exactly those five hours, timeZone explicit
//   2. NOTHING IS LOST, only deferred — a check held at 16:30, overnight or
//      over a weekend is woken by the next 09:00 run, because the sweep's
//      decision is a function of the RECORD and the STOCK CELL, never of how
//      many sweeps preceded it
//   3. the per-sale trigger is INDEPENDENT — onClothingSale is an
//      onValueCreated RTDB trigger, so sales still raise and bump checks at
//      20:00 and on a Sunday
//
// (1) and (3) are asserted against the SOURCE, following the house pattern in
// refill-cadence.test.cjs: requiring the module initialises firebase-admin,
// which needs credentials this suite does not have. A schedule is declarative
// config, so the source IS the artefact under test.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runWakeSweep } = require("../displayChecks/wakeHeldChecks.js");
const { saDateStringFromMs, wakeTransition, wakeDelayMs, resolveSale } = require("../displayChecks/lib.cjs");

const SRC = readFileSync(join(__dirname, "..", "displayChecks", "wakeHeldChecks.js"), "utf8");
const SALE_SRC = readFileSync(join(__dirname, "..", "displayChecks", "onClothingSale.js"), "utf8");

// ── 1. THE SCHEDULE ──────────────────────────────────────────────────────────
const SCHEDULE = /schedule:\s*"([^"]+)"/.exec(SRC)?.[1];

test("the sweep runs at 09:00, 11:00, 13:00, 15:00 and 16:00 — and nowhere else", () => {
  assert.equal(SCHEDULE, "0 9,11,13,15,16 * * *");
  const [minute, hour, dom, mon, dow] = SCHEDULE.split(/\s+/);
  assert.equal(minute, "0", "on the hour");
  assert.deepEqual(hour.split(",").map(Number), [9, 11, 13, 15, 16]);
  assert.deepEqual([dom, mon, dow], ["*", "*", "*"], "every day");
});

test("the round-the-clock form is gone", () => {
  // 288 dispatches a day, most of them after close.
  assert.doesNotMatch(SRC, /schedule:\s*"every 5 minutes"/);
  assert.doesNotMatch(SCHEDULE, /^every /, "not an interval form at all");
});

test("the last run is 16:00 and nothing fires after it", () => {
  const hours = SCHEDULE.split(/\s+/)[1].split(",").map(Number);
  assert.equal(Math.max(...hours), 16, "16:00 is the final run");
  assert.equal(Math.min(...hours), 9, "09:00 is the first");
  assert.ok(hours.every((h) => h >= 9 && h <= 16), "nothing outside the window");
});

test("the gaps are 2 hours, except the short last leg", () => {
  const hours = SCHEDULE.split(/\s+/)[1].split(",").map(Number);
  const gaps = hours.slice(1).map((h, i) => h - hours[i]);
  assert.deepEqual(gaps, [2, 2, 2, 1], "09→11→13→15 two-hourly, then 15→16");
});

test("timeZone is set EXPLICITLY to Africa/Johannesburg", () => {
  // Load-bearing now that the schedule names hours. On the UTC default the
  // "09:00" run would fire at 11:00 SAST and the last at 18:00.
  assert.match(SRC, /timeZone:\s*"Africa\/Johannesburg"/);
});

test("the scoped-deploy instruction survives", () => {
  // The project is shared with the POS app; a bare `--only functions` deploys
  // their functions too.
  assert.match(SRC, /--only functions:wakeHeldChecks/);
});

// ── 2. THE PER-SALE TRIGGER IS INDEPENDENT ───────────────────────────────────
test("onClothingSale is an RTDB trigger, not a scheduled job", () => {
  // If this ever became scheduled, the window above would start dropping sales.
  assert.match(SALE_SRC, /onValueCreated\(/);
  assert.doesNotMatch(SALE_SRC, /onSchedule\(/);
  assert.doesNotMatch(SALE_SRC, /schedule:/);
});

test("the sweep does not raise or bump checks — that is the trigger's job", () => {
  // The claim "a sale at 20:00 still lands" only holds if the sweep is not on
  // the raise path at all.
  assert.doesNotMatch(SRC, /bumpCheck/);
});

// ── 3. NOTHING HELD IS LOST, ONLY DEFERRED ───────────────────────────────────
// wakeTransition is the whole decision. It takes the record, the cell and now —
// no sweep count, no last-sweep time — so a 16-hour gap and a 5-minute gap
// reach the same verdict on the same state.
const SA_1000 = Date.parse("2026-07-16T08:00:00.000Z");   // 10:00 SAST
const held = (over = {}) => ({ status: "held", createdAt: SA_1000 - 864e5, ...over });

test("the wake decision is a function of state, not of elapsed sweeps", () => {
  const delayMs = wakeDelayMs({});
  const rec = held({ stockSeenAt: SA_1000 });
  // Five minutes past the grace (the old cadence) and sixteen hours past it (a
  // hold taken at 16:30, decided at 09:00) must reach the same verdict.
  const soon = wakeTransition(rec, { qty: 3, nowMs: SA_1000 + delayMs + 5 * 60e3, delayMs });
  const overnight = wakeTransition(rec, { qty: 3, nowMs: SA_1000 + 16 * 3600e3, delayMs });
  assert.deepEqual(soon, overnight,
    "the same record and the same stock must wake the same way after any gap");
  assert.equal(overnight.action, "activate");
});

test("a check held past the last run is still held, not dropped, at the next 09:00", () => {
  // 16:30 — after the final sweep of the day. Stock is there.
  const AFTER_LAST = Date.parse("2026-07-16T14:30:00.000Z");  // 16:30 SAST
  const NEXT_FIRST = Date.parse("2026-07-17T07:00:00.000Z");  // 09:00 SAST next day
  const t = wakeTransition(held({ stockSeenAt: AFTER_LAST }), { qty: 2, nowMs: NEXT_FIRST, delayMs: wakeDelayMs({}) });
  assert.equal(t.action, "activate", "the overnight hold wakes on the first run of the next day");
});

test("a weekend-long gap wakes the check too — a hold has no expiry", () => {
  const FRI_LAST = Date.parse("2026-07-17T14:00:00.000Z");   // Fri 16:00 SAST
  const MON_FIRST = Date.parse("2026-07-20T07:00:00.000Z");  // Mon 09:00 SAST
  const t = wakeTransition(held({ stockSeenAt: FRI_LAST }), { qty: 1, nowMs: MON_FIRST, delayMs: wakeDelayMs({}) });
  assert.equal(t.action, "activate", "nothing ages a held check out");
});

test("a check whose stock never appeared is untouched, never discarded", () => {
  // The long gap must not be read as "this one has waited long enough, bin it".
  const t = wakeTransition(held(), { qty: 0, nowMs: SA_1000 + 72 * 3600e3, delayMs: wakeDelayMs({}) });
  assert.equal(t, null, "a no-op, not a deletion");
});

test("stock gone by the next run re-holds rather than losing the check", () => {
  // The conservative branch: a previous sweep saw stock, it is gone when this
  // one looks. The grace clock is cleared; the record stays held.
  const t = wakeTransition(held({ stockSeenAt: SA_1000 }), { qty: 0, nowMs: SA_1000 + 16 * 3600e3, delayMs: wakeDelayMs({}) });
  assert.equal(t.action, "re_held");
  assert.equal(t.clearedStockSeenAt, SA_1000);
});

test("the grace window still holds inside it — a 2-hour gap does not skip the clock", () => {
  const delayMs = wakeDelayMs({});
  const t = wakeTransition(held({ stockSeenAt: SA_1000 }), { qty: 5, nowMs: SA_1000 + delayMs - 1, delayMs });
  assert.equal(t, null, "one millisecond short of the grace is still short");
});

// ── 4. END TO END OVER THE REAL SWEEP ────────────────────────────────────────
// Drives runWakeSweep itself across the overnight gap, so what this asserts is
// the real sweep's writes rather than a restatement of the decision.
//
// SCOPE OF THE FAKE, honestly: transaction() always runs the callback twice —
// a cold null pass, then the server value — which models the RETRY-PATH latch
// guardedTransaction.cjs relies on. It does NOT model a real RTDB transaction
// committing on the first round trip, which is the single-round-trip
// resurrection gap that guardedTransaction.cjs's own header marks as still
// open. No test here exercises the reap path, so nothing below depends on that
// gap — but do not read these tests as coverage of it.
function fakeDb(initial) {
  const state = structuredClone(initial);
  let pushSeq = 0;
  const api = { state };
  const get = (p) => (p === "" ? state : p.split("/").reduce((n, k) => (n == null ? n : n[k]), state));
  const set = (p, v) => {
    const parts = p.split("/"); const last = parts.pop();
    let n = state; for (const k of parts) { if (n[k] == null || typeof n[k] !== "object") n[k] = {}; n = n[k]; }
    if (v === null) delete n[last]; else n[last] = v;
  };
  api.ref = (path = "") => ({
    async once() { return { val: () => structuredClone(get(path) ?? null) }; },
    async get() { const v = structuredClone(get(path) ?? null); return { val: () => v, exists: () => v != null }; },
    async set(v) { set(path, structuredClone(v)); },
    push() { return { key: `ev_${++pushSeq}` }; },
    async update(patch) { for (const [k, v] of Object.entries(patch)) set(k, v); },
    async transaction(fn) {
      const cold = fn(null);                      // cold-cache null pass, as the CF sees it
      if (cold === undefined) return { committed: false, snapshot: { val: () => get(path) ?? null } };
      const server = get(path) ?? null;
      const final = fn(server);
      if (final === undefined) return { committed: false, snapshot: { val: () => server } };
      set(path, final);
      return { committed: true, snapshot: { val: () => final } };
    },
  });
  return api;
}

const DK = "p1__M";
const HELD_AT = Date.parse("2026-07-16T14:30:00.000Z");   // 16:30 SAST — after the last run
const NEXT_FIRST = Date.parse("2026-07-17T07:00:00.000Z"); // 09:00 SAST next day
const record = (over = {}) => ({
  checkId: "c1", productId: "p1", productName: "Boss Tee", size: "M", sizeKey: "M", dedupeKey: DK,
  status: "held", heldAt: HELD_AT - 3600e3, createdAt: HELD_AT - 3600e3, saleCount: 1, ...over,
});
const seeded = (over = {}) => fakeDb({
  displayChecks_active: { "marathon-pe": { [DK]: record(over) } },
  stock: { "marathon-pe": { p1: { M: { qty: 4 } } } },
});
const node = (db) => db.state.displayChecks_active?.["marathon-pe"]?.[DK];

test("a hold whose grace elapsed overnight is ACTIVATED by the 09:00 run", async () => {
  // stockSeenAt stamped at 16:30 by the last sweep of the previous day; the
  // 20-minute grace elapsed while nothing was running.
  const db = seeded({ stockSeenAt: HELD_AT, wakeAt: HELD_AT + wakeDelayMs({}) });
  const r = await runWakeSweep({ db, nowMs: NEXT_FIRST });
  assert.deepEqual(r, { stockSeen: 0, activated: 1, reHeld: 0, reaped: 0 },
    "the overnight gap is made up in one run");
  assert.equal(node(db).status, "open");
  assert.equal(node(db).activatedAt, NEXT_FIRST);
  assert.equal(node(db).activatedSaDate, saDateStringFromMs(NEXT_FIRST));
});

test("a hold that never saw stock starts its clock at 09:00 and wakes at 11:00", async () => {
  // Two runs, two hours apart — the whole lifecycle inside the new window.
  const db = seeded();
  const first = await runWakeSweep({ db, nowMs: NEXT_FIRST });
  assert.deepEqual(first, { stockSeen: 1, activated: 0, reHeld: 0, reaped: 0 });
  assert.equal(node(db).status, "held", "grace clock started, not yet open");
  assert.equal(node(db).stockSeenAt, NEXT_FIRST);

  const second = await runWakeSweep({ db, nowMs: NEXT_FIRST + 2 * 3600e3 });   // 11:00
  assert.deepEqual(second, { stockSeen: 0, activated: 1, reHeld: 0, reaped: 0 });
  assert.equal(node(db).status, "open");
});

test("a second sweep over unchanged state changes nothing — 5 runs a day is as safe as 288", async () => {
  const db = seeded({ stockSeenAt: HELD_AT, wakeAt: HELD_AT + wakeDelayMs({}) });
  await runWakeSweep({ db, nowMs: NEXT_FIRST });
  const after = JSON.stringify(db.state.displayChecks_active);
  const again = await runWakeSweep({ db, nowMs: NEXT_FIRST + 2 * 3600e3 });
  assert.deepEqual(again, { stockSeen: 0, activated: 0, reHeld: 0, reaped: 0 });
  assert.equal(JSON.stringify(db.state.displayChecks_active), after);
});

test("the sweep NEVER drops a held check it cannot act on", async () => {
  // No stock, three days of nothing running. The record must survive intact.
  const db = fakeDb({
    displayChecks_active: { "marathon-pe": { [DK]: record() } },
    stock: { "marathon-pe": { p1: { M: { qty: 0 } } } },
  });
  const before = JSON.stringify(node(db));
  const r = await runWakeSweep({ db, nowMs: HELD_AT + 72 * 3600e3 });
  assert.deepEqual(r, { stockSeen: 0, activated: 0, reHeld: 0, reaped: 0 });
  assert.equal(JSON.stringify(node(db)), before, "byte-identical — nothing expires a hold");
});

// ── 5. THE HONEST COSTS OF A 2-HOUR GAP ──────────────────────────────────────
// The first version of this file only ever held qty CONSTANT across the gap, so
// it could not see any of the three changes below. A cadence test that only
// tests the case the cadence cannot hurt is not a test (adversarial review).

// The honest way to test "transient stock is invisible" is DIFFERENTIALLY: run
// the SAME stock timeline past both cadences and show they disagree. Writing a
// qty and overwriting it on the next line proves nothing — no sweep ever reads
// it, and the test passes identically with the write deleted (proven by
// mutation, adversarial review).
const SA = (hhmm) => Date.parse(`2026-07-17T${String(Number(hhmm.slice(0, 2)) - 2).padStart(2, "0")}:${hhmm.slice(2)}:00.000Z`);
const OLD_CADENCE = [];                                   // every 5 minutes, 09:00 → 13:00
for (let t = SA("0900"); t <= SA("1300"); t += 5 * 60e3) OLD_CADENCE.push(t);
const NEW_CADENCE = [SA("0900"), SA("1100"), SA("1300"), SA("1500"), SA("1600")];

// Stock lands at 09:10 and is sold out by 10:40 — a 90-minute blip that sits
// entirely between the 09:00 and 11:00 sweeps.
const blip = (t) => (t >= SA("0910") && t < SA("1040") ? 3 : 0);

async function driveCadence(sweepTimes, qtyAt) {
  const db = fakeDb({
    displayChecks_active: { "marathon-pe": { [DK]: record({ heldAt: SA("0800"), createdAt: SA("0800") }) } },
    stock: { "marathon-pe": { p1: { M: { qty: 0 } } } },
  });
  for (const t of sweepTimes) {
    db.state.stock["marathon-pe"].p1.M.qty = qtyAt(t);    // the shelf as it is AT that sweep
    await runWakeSweep({ db, nowMs: t });
  }
  return node(db);
}

test("DIFFERENTIAL: a 90-minute stock blip woke a check at 5-minute sweeps and does NOT at 2-hourly", async () => {
  const old = await driveCadence(OLD_CADENCE, blip);
  assert.equal(old.status, "open", "the old cadence sampled the blip and opened the check");

  const now = await driveCadence(NEW_CADENCE, blip);
  assert.equal(now.status, "held", "the new cadence never sees it — this is the real cost");
  assert.equal(now.stockSeenAt, undefined, "no grace clock was ever started");

  assert.notEqual(old.status, now.status,
    "if these ever agree, either the cadence or the wake rule changed and this file is stale");
});

test("DIFFERENTIAL: stock that OUTLASTS a sweep gap opens the check on BOTH cadences", async () => {
  // The control. Without it the test above would also pass if the sweep were
  // broken outright, which is the failure it must not be confused with.
  const lasting = (t) => (t >= SA("0910") ? 3 : 0);
  const old = await driveCadence(OLD_CADENCE, lasting);
  const now = await driveCadence(NEW_CADENCE, lasting);
  assert.equal(old.status, "open");
  assert.equal(now.status, "open", "the new cadence is not simply broken — durable stock still wakes");
});

test("the blip is invisible because of SAMPLING, not because the check was consumed", async () => {
  // After the blip has come and gone, the check must still be wakeable — stock
  // arriving the next day opens it normally.
  const nextDay = [...NEW_CADENCE, Date.parse("2026-07-18T07:00:00.000Z"), Date.parse("2026-07-18T09:00:00.000Z")];
  const rec = await driveCadence(nextDay, (t) => (blip(t) || (t >= Date.parse("2026-07-18T07:00:00.000Z") ? 4 : 0)));
  assert.equal(rec.status, "open", "the check survived the missed blip and woke the next day");
});

test("stock that LASTS a gap still wakes the check — the contrast that gives the test above meaning", async () => {
  const NINE = Date.parse("2026-07-17T07:00:00.000Z");
  const ELEVEN = Date.parse("2026-07-17T09:00:00.000Z");
  const THIRTEEN = Date.parse("2026-07-17T11:00:00.000Z");
  const db = fakeDb({
    displayChecks_active: { "marathon-pe": { [DK]: record({ heldAt: NINE - 3600e3, createdAt: NINE - 3600e3 }) } },
    stock: { "marathon-pe": { p1: { M: { qty: 0 } } } },
  });
  await runWakeSweep({ db, nowMs: NINE });
  db.state.stock["marathon-pe"].p1.M.qty = 3;                       // arrives and STAYS
  assert.deepEqual(await runWakeSweep({ db, nowMs: ELEVEN }), { stockSeen: 1, activated: 0, reHeld: 0, reaped: 0 });
  assert.deepEqual(await runWakeSweep({ db, nowMs: THIRTEEN }), { stockSeen: 0, activated: 1, reHeld: 0, reaped: 0 });
  assert.equal(node(db).status, "open");
});

test("stock present at one sweep and gone by the next is RE-HELD, never dropped", async () => {
  const NINE = Date.parse("2026-07-17T07:00:00.000Z");
  const ELEVEN = Date.parse("2026-07-17T09:00:00.000Z");
  const db = fakeDb({
    displayChecks_active: { "marathon-pe": { [DK]: record({ heldAt: NINE - 3600e3, createdAt: NINE - 3600e3 }) } },
    stock: { "marathon-pe": { p1: { M: { qty: 2 } } } },
  });
  await runWakeSweep({ db, nowMs: NINE });                 // stamps stockSeenAt
  assert.equal(node(db).stockSeenAt, NINE);
  db.state.stock["marathon-pe"].p1.M.qty = 0;              // sold out before 11:00
  const at11 = await runWakeSweep({ db, nowMs: ELEVEN });
  assert.deepEqual(at11, { stockSeen: 0, activated: 0, reHeld: 1, reaped: 0 });
  assert.equal(node(db).status, "held", "back to held, still in the index");
  assert.equal(node(db).stockSeenAt, undefined, "grace clock cleared, ready to start again");
});

test("wakeDelayMinutes is now a DEAD dial: every value under the sweep gap behaves the same", () => {
  // Documented so nobody tunes it expecting an effect. The sweep gap is 2 hours;
  // the grace is compared against the sweep's clock, so anything shorter than
  // the gap has already elapsed by the time the next sweep looks.
  const SEEN = Date.parse("2026-07-17T07:00:00.000Z");     // stamped at the 09:00 sweep
  const NEXT_SWEEP = Date.parse("2026-07-17T09:00:00.000Z"); // 11:00
  const rec = held({ stockSeenAt: SEEN });
  for (const minutes of [0, 5, 20, 60, 119]) {
    const t = wakeTransition(rec, { qty: 2, nowMs: NEXT_SWEEP, delayMs: wakeDelayMs({ wakeDelayMinutes: minutes }) });
    assert.equal(t.action, "activate", `wakeDelayMinutes=${minutes} must behave identically`);
  }
  // Only a value ABOVE the gap still does anything.
  const long = wakeTransition(rec, { qty: 2, nowMs: NEXT_SWEEP, delayMs: wakeDelayMs({ wakeDelayMinutes: 180 }) });
  assert.equal(long, null, "3 hours still holds across a 2-hour gap — the dial is not gone, just mostly inert");
});

test("the prior-day tombstone reap now happens after the FIRST SWEEP, not after midnight", () => {
  // Was within five minutes of midnight, because a sweep ran then. The first
  // sweep is now 09:00, so any sale before it still meets yesterday's
  // tombstone. Asserted against the schedule itself rather than a hard-coded
  // opening time: the store's hours are not a constant in this repo, so a test
  // that pins "08:30" would give false confidence if they changed.
  const firstSweep = Math.min(...SCHEDULE.split(/\s+/)[1].split(",").map(Number));
  assert.equal(firstSweep, 9, "the reap cannot happen before this hour");
  assert.ok(firstSweep > 0, "nothing reaps at midnight any more — that sweep is gone");

  // What a pre-sweep sale then produces. THIS is the part that pins behaviour.
  const YESTERDAY_DONE = Date.parse("2026-07-16T13:00:00.000Z");  // 15:00 SAST yesterday
  const SALE = Date.parse("2026-07-17T06:45:00.000Z");            // 08:45 SAST, before the 09:00 sweep
  const t = resolveSale(
    { dedupeKey: DK, checkId: "c1", status: "completed", result: "no_stock", completedAt: YESTERDAY_DONE },
    DK, SALE,
  );
  assert.equal(t.kind, "create");
  assert.equal(t.overwrite, true);
  assert.equal(t.archiveCheckId, "c1", "archived before overwrite — the compliance record is not lost");
  assert.equal(t.repeat.logType, "contradiction_detected");
  assert.ok(t.repeat.repeatWithinMinutes > 600,
    `a cross-day gap (${t.repeat.repeatWithinMinutes} min) is what makes this alarm false`);

  // Same slot, same day: a genuine contradiction, small gap. The contrast is
  // what makes the assertion above mean something.
  const sameDay = resolveSale(
    { dedupeKey: DK, checkId: "c2", status: "completed", result: "no_stock", completedAt: SALE - 20 * 60e3 },
    DK, SALE,
  );
  assert.equal(sameDay.repeat.logType, "contradiction_detected");
  assert.equal(sameDay.repeat.repeatWithinMinutes, 20, "a real contradiction is minutes old, not hours");
});

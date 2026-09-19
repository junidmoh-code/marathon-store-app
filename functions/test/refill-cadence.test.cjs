// ─── REFILL SCAN CADENCE — ONCE A DAY, 18:00 SAST ────────────────────────────
// Run: cd functions && node --test
//
// Pins the three things PR "refill-scan cadence" changed, so a revert to the
// 96-runs-a-day schedule or the 45-day ledger window fails here rather than
// showing up on a bill six weeks later:
//
//   1. the SCHEDULE — "0 18 * * *", Africa/Johannesburg: ONE run a day, and
//      nothing that reintroduces a multi-run-per-day cadence
//   2. the WINDOW — held at 45, with the max() guard intact, and a regression
//      test for the in-flight ledger evidence that forced it to stay
//   3. IDEMPOTENCY ACROSS A FULL DAY'S GAP — the 18:00 run produces exactly
//      the plan the 95 skipped runs of the day would have produced, a morning
//      sale is picked up at 18:00, and an open intent is not duplicated
//   4. DUE SLACK — a 24h cooldown must not silently become 48h at one run/day
//
// (1) and (2) are asserted against the SOURCE, following the house pattern in
// UserManagement.gate.test.jsx / DisplayRegister.gate.test.jsx: requiring
// refill-scan.cjs initialises firebase-admin, which needs credentials this
// suite does not have. The schedule is declarative config, so the source IS the
// artefact under test.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { computeRefillPlan, dueSlackFor } = require("../lib/refill-engine.cjs");

const SRC = readFileSync(join(__dirname, "..", "refill-scan.cjs"), "utf8");

// ── 1. THE SCHEDULE ──────────────────────────────────────────────────────────
test("schedule is ONCE a day at 18:00, not a repeating interval", () => {
  assert.match(SRC, /schedule:\s*"0 18 \* \* \*"/);
  // The two forms this replaces — 96 runs/day and 49 runs/day.
  assert.doesNotMatch(SRC, /schedule:\s*"every 15 minutes"\s*,/);
  assert.doesNotMatch(SRC, /schedule:\s*"every 15 minutes from 07:00 to 19:00"/);
});

test("the schedule fires exactly once a day", () => {
  // A cron with a list, step or range in the hour or minute field would fire
  // more than once — the whole point of this change is one dispatch per day.
  const scheduleValue = /schedule:\s*"([^"]+)"/.exec(SRC)?.[1];
  assert.ok(scheduleValue, "the schedule must be a literal string");
  const [minute, hour, dom, mon, dow] = scheduleValue.split(/\s+/);
  assert.equal(minute, "0");
  assert.equal(hour, "18");
  assert.deepEqual([dom, mon, dow], ["*", "*", "*"], "every day");
  for (const f of [minute, hour]) assert.doesNotMatch(f, /[,\/-]/, "no list, step or range");
});

test("timeZone is set EXPLICITLY to Africa/Johannesburg", () => {
  // Cloud Scheduler defaults to UTC. SAST is UTC+2 with no DST, so relying on
  // the default would fire the one daily run at 20:00 local, after close.
  assert.match(SRC, /timeZone:\s*"Africa\/Johannesburg"/);
});

test("confidence is written on EVERY run, not behind an hourly minute gate", () => {
  // The old minute-of-hour throttle turned 4 runs/hour into 1. With one run a
  // day it is a coin toss: a dispatch 16 minutes late would skip
  // /stock_confidence for the whole day. Asserted on the CODE, so this comment
  // cannot trip its own test.
  assert.doesNotMatch(SRC, /if\s*\(new Date\(nowMs\)\.getUTCMinutes\(\)/);
  assert.match(SRC, /computeConfidence\(/);
});

test("the scoped-deploy instruction survives next to the schedule", () => {
  // The project is shared with the POS app; a bare `--only functions` deploys
  // their functions too.
  assert.match(SRC, /--only functions:refillHealthScan/);
});

// ── 2. THE LEDGER WINDOW ─────────────────────────────────────────────────────
test("MOVEMENTS_WINDOW_DAYS is held at 45", () => {
  // Deliberately NOT 31. ledgerTouched() has no time bound of its own and uses
  // this slice to prove a pick is in flight; nothing closes an open intent for
  // age, so narrowing the slice can silently strip that protection from an
  // intent older than the window. See the block comment in refill-scan.cjs.
  assert.match(SRC, /const MOVEMENTS_WINDOW_DAYS = 45;/);
  assert.doesNotMatch(SRC, /const MOVEMENTS_WINDOW_DAYS = 31;/);
});

test("the window still covers the 30-day confidence lookback", () => {
  // Read the CONSTANT out of the source. `assert.ok(45 > 30)` compares two
  // literals baked into this file and stays green however the production value
  // is edited — it proves nothing (Sonnet review, PR #616).
  const windowDays = Number(/const MOVEMENTS_WINDOW_DAYS = (\d+);/.exec(SRC)?.[1]);
  assert.ok(Number.isFinite(windowDays), "MOVEMENTS_WINDOW_DAYS must be a literal in the source");
  assert.ok(windowDays > 30,
    `the ledger slice must outlast the 30-day confidence lookback, got ${windowDays}`);
});

test("the window records WHY it cannot simply be narrowed", () => {
  // A future reader will see 45 and 14 unused days and reach for 31 again.
  assert.match(SRC, /ledgerTouched/);
  assert.match(SRC, /in-flight/i);
});

test("the max() guard still lifts the window when confirmedOutDays is raised", () => {
  // Mirrors refill-scan.cjs: max(MOVEMENTS_WINDOW_DAYS, confirmedOutDays + 1).
  const windowFor = (confirmedOutDays) => Math.max(45, (Number(confirmedOutDays) || 14) + 1);
  assert.equal(windowFor(undefined), 45, "default (14) → the constant wins");
  assert.equal(windowFor(14), 45, "documented default → 45");
  assert.equal(windowFor(30), 45, "still covered");
  assert.equal(windowFor(60), 61, "a raised gate must widen the window, not be silently truncated");
  assert.equal(windowFor(90), 91);
});

test("the guard expression is still present in the source", () => {
  assert.match(SRC, /Math\.max\(MOVEMENTS_WINDOW_DAYS,\s*\(Number\(config\.confirmedOutDays\)\s*\|\|\s*14\)\s*\+\s*1\)/);
});

// ── 3. THE DEAD DIAL ─────────────────────────────────────────────────────────
test("scanIntervalMinutes is still read by nothing", () => {
  // It is not wired up on purpose (see the comment in refill-scan.cjs). The
  // only mentions permitted are the warning and its own comment block — never
  // an assignment that would make it look live.
  assert.doesNotMatch(SRC, /schedule:\s*[^"]*scanIntervalMinutes/);
  assert.doesNotMatch(SRC, /const\s+\w+\s*=\s*config\.scanIntervalMinutes/);
});

test("a present scanIntervalMinutes announces itself as dead", () => {
  assert.match(SRC, /scanIntervalMinutes is DEAD and controls nothing/);
});

// ── 4. IDEMPOTENCY ACROSS A FULL DAY'S GAP ───────────────────────────────────
// The claim: dropping from 96 runs a day to ONE loses nothing, because the plan
// is a pure function of STATE, never of how many runs preceded it.
// computeRefillPlan takes a snapshot and no run history, so a single 18:00 run
// over the day's state produces exactly what a day of runs would have
// converged on.
const CONFIG = {
  enabled: true,
  routes: { "marathon-pe": "hub2", hub2: "central" },
  mode: { "marathon-pe": "live", hub2: "live" },
  productTypes: { clothing: true },
  defaultRunByStore: { "marathon-pe": { M: 2, L: 2 } },
  maxIntentsPerRun: 75,
  maxUnitsPerIntent: 20,
  ruleBasedTargets: true,
  confirmedOutDays: 14,
};
const PRODUCTS = {
  p1: { id: "p1", name: "Test Hoodie", productType: "clothing", category: "Clothing", sizes: ["M", "L"] },
};
const snapshot = (nowMs, over = {}) => ({
  nowMs, config: CONFIG, products: PRODUCTS,
  targets: {}, targetDecisions: {}, openIndex: {}, refillRequests: {}, orders: {},
  rejectStreak: {}, retryState: {}, movements: [],
  stock: { "marathon-pe": { p1: { M: { qty: 0 }, L: { qty: 0 } } },
           hub2:          { p1: { M: { qty: 10 }, L: { qty: 10 } } },
           central:       { p1: { M: { qty: 10 }, L: { qty: 10 } } } },
  ...over,
});

const YDAY_RUN = Date.parse("2026-08-04T16:00:00.000Z");  // 18:00 SAST, the previous run
const TODAY_RUN = Date.parse("2026-08-05T16:00:00.000Z"); // 18:00 SAST, the only run today
const shape = (p) => JSON.stringify({
  intents: (p.intents || []).map((i) => [i.dest, i.productId, i.sizeKey, i.qty]).sort(),
  exceptions: Object.keys(p.exceptions || {}).sort(),
});

test("the 18:00 plan equals what the 95 skipped runs of the day would have produced", () => {
  // Every 15 minutes across the whole 24h since the previous run, on UNCHANGED
  // state — what the old cadence would have done.
  const skipped = [];
  for (let t = YDAY_RUN; t <= TODAY_RUN; t += 15 * 60_000) skipped.push(computeRefillPlan(snapshot(t)));
  const evening = computeRefillPlan(snapshot(TODAY_RUN));
  for (const p of skipped) assert.equal(shape(p), shape(evening));
  assert.ok(skipped.length >= 96, `expected a full day of skipped runs, got ${skipped.length}`);
});

test("the plan is a function of state, not of elapsed runs", () => {
  const once = computeRefillPlan(snapshot(TODAY_RUN));
  const again = computeRefillPlan(snapshot(TODAY_RUN));
  assert.deepEqual(again.intents, once.intents);
  assert.deepEqual(again.exceptions, once.exceptions);
});

test("a MORNING sale is picked up by the 18:00 run", () => {
  // The one thing the gap defers: a sale that empties a cell at 09:00 is no
  // longer seen at 09:15. It changes STATE, so the 18:00 run sees it —
  // deferred by hours, never lost.
  const beforeSale = snapshot(TODAY_RUN, {
    stock: { "marathon-pe": { p1: { M: { qty: 2 }, L: { qty: 2 } } },   // at target
             hub2:          { p1: { M: { qty: 10 }, L: { qty: 10 } } },
             central:       { p1: { M: { qty: 10 }, L: { qty: 10 } } } },
  });
  const atTarget = computeRefillPlan(beforeSale);
  assert.equal((atTarget.intents || []).length, 0, "a cell at target asks for nothing");

  // 09:00 — both sizes sell out. Nothing runs until 18:00.
  const afterSale = computeRefillPlan(snapshot(TODAY_RUN));
  const asked = (afterSale.intents || []).filter((i) => i.dest === "marathon-pe" && i.productId === "p1");
  assert.equal(asked.length, 2, "the 18:00 run must raise the morning's deficit for both sizes");
  assert.deepEqual(asked.map((i) => i.sizeKey).sort(), ["L", "M"]);
});

test("an already-open intent is not duplicated by the next day's run", () => {
  // Idempotency guard: one open lock per (dest, product, size). If yesterday's
  // 18:00 run created an intent, today's must not create it again — a full day
  // of elapsed time must not weaken the lock.
  const withOpen = snapshot(TODAY_RUN, {
    // NESTED, as the engine reads it: openIndex[dest][pid][sizeKey].
    openIndex: { "marathon-pe": { p1: { M: { qty: 2, createdAt: YDAY_RUN }, L: { qty: 2, createdAt: YDAY_RUN } } } },
  });
  const plan = computeRefillPlan(withOpen);
  const dupes = (plan.intents || []).filter((i) => i.dest === "marathon-pe" && i.productId === "p1");
  assert.equal(dupes.length, 0, "an open intent must suppress a second one for the same cell");
});

// ── 5. DUE SLACK — a 24h cooldown must not become 48h ────────────────────────
// At 15-minute cadence a window that missed by minutes was re-checked minutes
// later. At one run a day, a cell REJECTED AFTER 18:00 is a few minutes short
// of its 24h cooldown when the next run looks, so without slack it rests a
// second full day. dueSlackMinutes (default 120) treats a window that will
// elapse before the next scan as elapsed now — capped at a QUARTER of the
// window so the 30-minute re-check contract is left intact.
const REJ_EVENING = Date.parse("2026-08-04T16:30:00.000Z"); // 18:30 SAST — AFTER yesterday's run
// Both windows pinned to 24h so the test exercises the LONG window whichever
// branch the denier's stock count selects.
const LONG_WINDOWS = { rejectCooldownHours: 24, recheckCooldownMinutes: 1440 };
const rejectedSnapshot = (nowMs, cfg = {}) => snapshot(nowMs, {
  config: { ...CONFIG, ...cfg },
  refillRequests: {
    rr1: {
      status: "cancelled", requestingLocation: "marathon-pe", productId: "p1", size: "M",
      source: "hub2", resolvedAt: new Date(REJ_EVENING).toISOString(),
    },
  },
});
const askedM = (plan) => (plan.intents || []).find((i) => i.dest === "marathon-pe" && i.sizeKey === "M");

test("a cell rejected at 18:30 is re-asked at the NEXT 18:00 run, not the one after", () => {
  // 23h30m elapsed. Without slack this is short of 24h, so the cell would rest
  // until the run AFTER next — a 24h cooldown silently served as 48h.
  const plan = computeRefillPlan(rejectedSnapshot(TODAY_RUN, LONG_WINDOWS));
  assert.ok(askedM(plan), "23h30m + 2h slack must clear the 24h cooldown");
});

test("without the slack the same cell would still be parked — the fix is load-bearing", () => {
  // dueSlackMinutes clamps to a quarter of the window, so 1 minute of slack is
  // as close to "off" as the dial goes. The cell must then rest.
  const plan = computeRefillPlan(rejectedSnapshot(TODAY_RUN, { ...LONG_WINDOWS, dueSlackMinutes: 1 }));
  assert.equal(askedM(plan), undefined, "this is what the 48h doubling looked like");
});

test("the slack does not collapse a window: a fresh rejection still rests", () => {
  // Same rejection, looked at only 30 minutes later. 0h30m + 2h is nowhere near
  // 24h, so the cell must still be parked.
  const plan = computeRefillPlan(rejectedSnapshot(REJ_EVENING + 30 * 60_000, LONG_WINDOWS));
  assert.equal(askedM(plan), undefined, "a fresh rejection must still rest out its window");
});

test("the 30-minute RE-CHECK contract survives: the slack is capped at a QUARTER of the window", () => {
  // A flat 2h slack would swallow the 30-minute recheck window whole and
  // silently delete the 2026-07-19 contract. 15 minutes in, with the default
  // 30-minute recheck (hub2 still counts stock), the cell must still rest.
  const plan = computeRefillPlan(rejectedSnapshot(REJ_EVENING + 15 * 60_000));
  assert.equal(askedM(plan), undefined, "15min + 7.5min slack < 30min recheck → still resting");
  // …and 45 minutes in it re-asks, exactly as before this change.
  const after = computeRefillPlan(rejectedSnapshot(REJ_EVENING + 45 * 60_000));
  assert.ok(askedM(after), "past the recheck window → re-asks, unchanged");
});

test("dueSlackMinutes is clamped to 12h AND to a quarter of the window", () => {
  // Drives the REAL exported helper. Re-declaring the arithmetic in the test
  // was vacuous: removing the quarter-of-window cap in production left this
  // green, because it only ever checked the test's own copy of the maths
  // (proven by mutation, Sonnet review, PR #616).
  const DAY = 24 * 3600e3;
  assert.equal(dueSlackFor({}, DAY), 120 * 60e3, "default 2h on a 24h window");
  assert.equal(dueSlackFor({ dueSlackMinutes: 0 }, DAY), 120 * 60e3, "0 is not an off switch");
  assert.equal(dueSlackFor({ dueSlackMinutes: -5 }, DAY), 120 * 60e3, "a negative must not mean zero slack");
  assert.equal(dueSlackFor({ dueSlackMinutes: "60" }, DAY), 120 * 60e3, "a STRING is not a number here");
  assert.equal(dueSlackFor({ dueSlackMinutes: NaN }, DAY), 120 * 60e3);
  assert.equal(dueSlackFor(undefined, DAY), 120 * 60e3, "absent config");
  assert.equal(dueSlackFor({ dueSlackMinutes: 60 }, DAY), 60 * 60e3, "an honest dial is honoured");

  // The 12h absolute clamp, seen on a window big enough not to bind first.
  assert.equal(dueSlackFor({ dueSlackMinutes: 99999 }, 14 * 86400e3), 12 * 3600e3);

  // The proportional cap — this is the one that protects the recheck contract.
  assert.equal(dueSlackFor({}, 30 * 60e3), 7.5 * 60e3, "30min window → 7.5min, not 2h");
  assert.equal(dueSlackFor({ dueSlackMinutes: 99999 }, 30 * 60e3), 7.5 * 60e3,
    "the proportional cap survives a silly dial");
  assert.equal(dueSlackFor({}, 0), 0, "a zero window gets no slack");
  assert.equal(dueSlackFor({}, -1), 0, "a negative window gets no slack, never a negative one");
});

test("the slack is a fraction of the window, so it can never reach the window itself", () => {
  // The property that makes this safe: slack < window for every positive
  // window, so a cooldown can never be declared elapsed at the moment it starts.
  for (const w of [1, 60e3, 30 * 60e3, 3600e3, 24 * 3600e3, 14 * 86400e3, 365 * 86400e3]) {
    const slack = dueSlackFor({}, w);
    assert.ok(slack < w, `slack ${slack} must stay under the window ${w}`);
    assert.ok(slack <= w * 0.25 + 1e-9, "never more than a quarter");
  }
});

test("the engine source carries the due-slack guard, not a bare elapsed check", () => {
  const ENGINE = readFileSync(join(__dirname, "..", "lib", "refill-engine.cjs"), "utf8");
  assert.match(ENGINE, /function dueSlackFor\(/);
  assert.match(ENGINE, /const slackFor = \(windowMs\) => dueSlackFor\(config, windowMs\);/);
  assert.match(ENGINE, /const windowElapsed =/);
  // The three re-ask gates must all go through it.
  assert.doesNotMatch(ENGINE, /nowMs - rejTs < effWindowMs/);
  assert.doesNotMatch(ENGINE, /nowMs - srcRej\.ts < effWindowMs/);
  assert.match(ENGINE, /Date\.parse\(rt\.nextRetryAt\) > nowMs \+ slackFor\(cooldownMs\)/);
});

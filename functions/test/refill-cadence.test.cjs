// ─── REFILL SCAN CADENCE — trading hours only ────────────────────────────────
// Run: cd functions && node --test
//
// Pins the three things PR "refill-scan cadence" changed, so a revert to the
// 96-runs-a-day schedule or the 45-day ledger window fails here rather than
// showing up on a bill six weeks later:
//
//   1. the SCHEDULE — 07:00→19:00 inclusive, Africa/Johannesburg, and NOT the
//      unix-cron form that would overshoot past 19:00
//   2. the WINDOW — 31 days, with the max() guard still covering a raised
//      confirmedOutDays
//   3. IDEMPOTENCY ACROSS THE OVERNIGHT GAP — the 07:00 run produces exactly
//      the plan the skipped 19:00–07:00 runs would have produced
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
const { computeRefillPlan } = require("../lib/refill-engine.cjs");

const SRC = readFileSync(join(__dirname, "..", "refill-scan.cjs"), "utf8");

// ── 1. THE SCHEDULE ──────────────────────────────────────────────────────────
test("schedule runs 07:00 to 19:00 inclusive, not around the clock", () => {
  assert.match(SRC, /schedule:\s*"every 15 minutes from 07:00 to 19:00"/);
  // The bare form this replaces — 96 runs/day, ~31 MB each.
  assert.doesNotMatch(SRC, /schedule:\s*"every 15 minutes"\s*,/);
});

test("timeZone is set EXPLICITLY to Africa/Johannesburg", () => {
  // Cloud Scheduler defaults to UTC. SAST is UTC+2 with no DST, so relying on
  // the default would run the "morning sweep" at 09:00 local and leave
  // 05:00–07:00 uncovered.
  assert.match(SRC, /timeZone:\s*"Africa\/Johannesburg"/);
});

test("does NOT use the unix-cron form, which overshoots past 19:00", () => {
  // `*/15 7-19 * * *` also fires at 19:15, 19:30 and 19:45 — inside the window
  // this change exists to close. Asserted on the schedule VALUE, not on the
  // whole file: the comment above the schedule cites that cron form as the
  // thing being avoided, and must not trip its own test.
  const scheduleValue = /schedule:\s*"([^"]+)"/.exec(SRC)?.[1];
  assert.ok(scheduleValue, "the schedule must be a literal string");
  assert.doesNotMatch(scheduleValue, /[*\/]/, "the schedule must not be unix-cron");
});

test("the scoped-deploy instruction survives next to the schedule", () => {
  // The project is shared with the POS app; a bare `--only functions` deploys
  // their functions too.
  assert.match(SRC, /--only functions:refillHealthScan/);
});

// ── 2. THE LEDGER WINDOW ─────────────────────────────────────────────────────
test("MOVEMENTS_WINDOW_DAYS is 31", () => {
  assert.match(SRC, /const MOVEMENTS_WINDOW_DAYS = 31;/);
});

test("31 days still covers the 30-day confidence lookback", () => {
  const WINDOW = 31;
  const CONFIDENCE_LOOKBACK_DAYS = 30;   // computeConfidence's window
  assert.ok(WINDOW > CONFIDENCE_LOOKBACK_DAYS,
    "the ledger slice must outlast the confidence lookback, or arrivals stop counting as lift evidence");
});

test("the max() guard still lifts the window when confirmedOutDays is raised", () => {
  // Mirrors refill-scan.cjs: max(MOVEMENTS_WINDOW_DAYS, confirmedOutDays + 1).
  const windowFor = (confirmedOutDays) => Math.max(31, (Number(confirmedOutDays) || 14) + 1);
  assert.equal(windowFor(undefined), 31, "default (14) → the constant wins");
  assert.equal(windowFor(14), 31, "documented default → 31");
  assert.equal(windowFor(30), 31, "still covered");
  assert.equal(windowFor(45), 46, "a raised gate must widen the window, not be silently truncated");
  assert.equal(windowFor(60), 61);
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

// ── 4. IDEMPOTENCY ACROSS THE OVERNIGHT GAP ──────────────────────────────────
// The claim: skipping 19:00→07:00 loses nothing, because the plan is a pure
// function of STATE, never of how many runs preceded it. computeRefillPlan
// takes a snapshot and no run history, so a single 07:00 run over the morning's
// state produces exactly what a night of runs would have converged on.
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

const CLOSE = Date.parse("2026-08-04T15:30:00.000Z");  // 17:30 SAST
const OPEN  = Date.parse("2026-08-05T05:00:00.000Z");  // 07:00 SAST next day

test("the 07:00 plan equals what the skipped overnight runs would have produced", () => {
  // Every 15 minutes from 19:00 to 07:00, on UNCHANGED state — what the old
  // cadence would have done.
  const skipped = [];
  for (let t = Date.parse("2026-08-04T17:00:00.000Z"); t <= OPEN; t += 15 * 60_000) {
    skipped.push(computeRefillPlan(snapshot(t)));
  }
  const morning = computeRefillPlan(snapshot(OPEN));
  const shape = (p) => JSON.stringify({
    intents: (p.intents || []).map((i) => [i.dest, i.productId, i.sizeKey, i.qty]).sort(),
    exceptions: Object.keys(p.exceptions || {}).sort(),
  });
  // Every skipped run would have produced the same plan as the morning run.
  for (const p of skipped) assert.equal(shape(p), shape(morning));
  assert.ok(skipped.length >= 48, `expected a full night of skipped runs, got ${skipped.length}`);
});

test("the plan is a function of state, not of elapsed runs", () => {
  const once = computeRefillPlan(snapshot(OPEN));
  const again = computeRefillPlan(snapshot(OPEN));
  assert.deepEqual(again.intents, once.intents);
  assert.deepEqual(again.exceptions, once.exceptions);
});

test("an overnight transfer is picked up by the 07:00 run", () => {
  // The one thing the gap can defer: an evening movement. It changes STATE, so
  // the morning run sees it — deferred, never lost.
  const evening = snapshot(OPEN, {
    stock: { "marathon-pe": { p1: { M: { qty: 2 }, L: { qty: 0 } } },
             hub2:          { p1: { M: { qty: 10 }, L: { qty: 10 } } },
             central:       { p1: { M: { qty: 10 }, L: { qty: 10 } } } },
  });
  const before = computeRefillPlan(snapshot(CLOSE));
  const after = computeRefillPlan(evening);
  assert.notDeepEqual(after.intents, before.intents,
    "a stock change between close and open must alter the morning plan");
});

test("an already-open intent is not duplicated by the morning run", () => {
  // Idempotency guard: one open lock per (dest, product, size). If the evening
  // run had created an intent, the morning run must not create it again.
  const withOpen = snapshot(OPEN, {
    // NESTED, as the engine reads it: openIndex[dest][pid][sizeKey].
    openIndex: { "marathon-pe": { p1: { M: { qty: 2, createdAt: CLOSE }, L: { qty: 2, createdAt: CLOSE } } } },
  });
  const plan = computeRefillPlan(withOpen);
  const dupes = (plan.intents || []).filter((i) => i.dest === "marathon-pe" && i.productId === "p1");
  assert.equal(dupes.length, 0, "an open intent must suppress a second one for the same cell");
});

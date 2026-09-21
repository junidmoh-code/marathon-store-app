// ─── THE WALLET WATCHDOG ─────────────────────────────────────────────────────
// Built from the real ledger at /aiAssistant/usage, which held $146.54 of spend
// from 21 Aug to 12 Sept 2026 and then stopped — the day before the social feed
// went dark and six days before photo capture failed at every till.
//
// The test that matters most is the COST FIELD one: summing only `costUSD`
// reports $0.0456 across all of that and makes an emptied wallet look untouched.
// That mistake was actually made while building this.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  costOf, spendSince, assessCredit, creditAlarmDecision, creditAlarmLine,
  LOW_BALANCE_USD, LOW_DAYS, REMINDER_MS,
} = require("../lib/ai-credit.cjs");

const DAY = 86400000;
const NOW = Date.parse("2026-09-19T15:00:00Z");

// ── costOf ───────────────────────────────────────────────────────────────────

test("every field name a usage row has ever carried a figure in is read", () => {
  // The three that exist in the live ledger today.
  assert.equal(costOf({ costUSD: 0.0013 }), 0.0013, "card recon OCR");
  assert.equal(costOf({ estimatedCostUSD: 0.9578 }), 0.9578, "socialDailyAutopilot");
  assert.equal(costOf({ estCostUSD: 4.88 }), 4.88);
});

test("a row with no figure costs nothing, and nothing throws", () => {
  for (const row of [null, undefined, {}, "nope", 7, { costUSD: "abc" }, { costUSD: null }]) {
    assert.equal(costOf(row), 0);
  }
});

test("a row carrying two names is ONE charge, not their sum", () => {
  // The same figure written twice is not two charges. Summing would silently
  // double a day's spend and bring the alarm forward for no reason.
  assert.equal(costOf({ costUSD: 1.5, estimatedCostUSD: 1.5 }), 1.5);
});

// ── spendSince ───────────────────────────────────────────────────────────────

/** A usage node shaped exactly like the live one: day key → pushKey → row. */
const usage = (rows) => {
  const out = {};
  for (const [at, cost, field = "estimatedCostUSD"] of rows) {
    const day = new Date(at).toISOString().slice(0, 10);
    out[day] = out[day] || {};
    out[day][`k${at}`] = { at, kind: "socialDailyAutopilot", [field]: cost };
  }
  return out;
};

test("spend is summed across mixed field names", () => {
  const node = usage([
    [NOW - 3 * DAY, 0.95, "estimatedCostUSD"],
    [NOW - 2 * DAY, 0.0013, "costUSD"],
    [NOW - 1 * DAY, 5.31, "estCostUSD"],
  ]);
  const s = spendSince(node, NOW - 10 * DAY, NOW);
  assert.equal(s.spendUSD, 6.2613);
  assert.equal(s.rows, 3);
});

test("the ROW'S OWN STAMP decides, not the day key it is filed under", () => {
  // The ledger is keyed by SA date and a top-up is a moment. A top-up at
  // midday must not be credited with that morning's spend.
  const morning = Date.parse("2026-09-19T06:00:00Z");
  const evening = Date.parse("2026-09-19T18:00:00Z");
  const node = usage([[morning, 4], [evening, 1]]);
  const s = spendSince(node, Date.parse("2026-09-19T12:00:00Z"), NOW + DAY);
  assert.equal(s.spendUSD, 1, "only the evening row belongs to this wallet");
});

test("spend before the top-up belongs to another wallet and is ignored", () => {
  const node = usage([[NOW - 30 * DAY, 146.54], [NOW - 1 * DAY, 2]]);
  assert.equal(spendSince(node, NOW - 7 * DAY, NOW).spendUSD, 2);
});

test("the burn rate never divides by less than a day", () => {
  // $3 in the hour after a top-up is not $72/day. The first hours after a
  // top-up are when the owner has just acted and least needs shouting at.
  const node = usage([[NOW - 60000, 3]]);
  const s = spendSince(node, NOW - 3600000, NOW);
  assert.equal(s.days, 1);
  assert.equal(s.burnPerDayUSD, 3);
});

test("array-coerced days with null holes are walked, not counted", () => {
  const node = { "2026-09-18": [null, { at: NOW - DAY, costUSD: 1.25 }, null] };
  assert.equal(spendSince(node, 0, NOW).spendUSD, 1.25);
});

test("an empty or unreadable ledger is zero, not a crash", () => {
  for (const node of [null, {}, { "2026-09-18": null }]) {
    assert.equal(spendSince(node, 0, NOW).spendUSD, 0);
  }
});

// ── assessCredit ─────────────────────────────────────────────────────────────

const spendOf = (usd, days = 10) => ({ spendUSD: usd, rows: 1, days, burnPerDayUSD: +(usd / days).toFixed(4), lastSpendAt: NOW });

test("a healthy wallet is ok, with a remaining balance and a runway", () => {
  const s = assessCredit({ toppedUpUSD: 50, toppedUpAt: NOW - 10 * DAY, spend: spendOf(10), nowMs: NOW });
  assert.equal(s.level, "ok");
  assert.equal(s.remainingUSD, 40);
  assert.equal(s.burnPerDayUSD, 1);
  assert.equal(s.daysLeft, 40);
});

test("under the dollar floor is LOW", () => {
  const s = assessCredit({ toppedUpUSD: 50, toppedUpAt: NOW - 10 * DAY, spend: spendOf(46), nowMs: NOW });
  assert.ok(s.remainingUSD < LOW_BALANCE_USD);
  assert.equal(s.level, "low");
});

test("plenty of money but under a week of runway is ALSO low", () => {
  // A product-photo day runs $5-9, so a dollar floor alone would say "fine"
  // with three days left. Both floors, whichever trips first.
  const s = assessCredit({ toppedUpUSD: 100, toppedUpAt: NOW - 10 * DAY, spend: spendOf(80), nowMs: NOW });
  assert.equal(s.remainingUSD, 20);
  assert.ok(s.daysLeft < LOW_DAYS, `${s.daysLeft} days`);
  assert.equal(s.level, "low");
});

test("spent past the top-up is EMPTY", () => {
  const s = assessCredit({ toppedUpUSD: 50, toppedUpAt: NOW - 10 * DAY, spend: spendOf(50), nowMs: NOW });
  assert.equal(s.level, "empty");
});

test("NO TOP-UP RECORDED is 'unknown' and never 'ok'", () => {
  // A silent watchdog and a happy one must not look alike.
  for (const c of [{}, { toppedUpUSD: 0, toppedUpAt: NOW }, { toppedUpUSD: 50 }, { toppedUpAt: NOW }]) {
    const s = assessCredit({ ...c, spend: spendOf(1), nowMs: NOW });
    assert.equal(s.level, "unknown");
    assert.equal(s.known, false);
    assert.equal(s.remainingUSD, null);
  }
});

test("THE CANARY OVERRIDES THE PROJECTION — the wallet answers for itself", () => {
  // The projection says $45 left; the API says 402. Spend nobody metered is
  // invisible to the sum and fatal to the estimate, so the wallet wins.
  const s = assessCredit({
    toppedUpUSD: 50, toppedUpAt: NOW - 10 * DAY, spend: spendOf(5),
    canaryExhausted: true, nowMs: NOW,
  });
  assert.equal(s.level, "empty");
  assert.equal(s.remainingUSD, 45, "the projection is still reported, it just does not decide");
});

test("the canary alone raises the alarm when nothing was ever recorded", () => {
  // The state the estate was actually in on 19 Sept: no top-up on file.
  const s = assessCredit({ spend: spendOf(0), canaryExhausted: true, nowMs: NOW });
  assert.equal(s.level, "empty");
  assert.equal(s.known, false);
});

test("a zero burn rate yields no runway rather than infinity", () => {
  const s = assessCredit({ toppedUpUSD: 50, toppedUpAt: NOW - DAY, spend: spendOf(0, 1), nowMs: NOW });
  assert.equal(s.daysLeft, null);
  assert.equal(s.level, "ok");
});

// ── creditAlarmDecision ──────────────────────────────────────────────────────

const low = assessCredit({ toppedUpUSD: 50, toppedUpAt: NOW - 10 * DAY, spend: spendOf(46), nowMs: NOW });
const empty = assessCredit({ toppedUpUSD: 50, toppedUpAt: NOW - 10 * DAY, spend: spendOf(51), nowMs: NOW });
const ok = assessCredit({ toppedUpUSD: 50, toppedUpAt: NOW - 10 * DAY, spend: spendOf(5), nowMs: NOW });

test("the first time a level is reached, it mails", () => {
  assert.equal(creditAlarmDecision(low, null, NOW).alarm, true);
});

test("an hourly scan does NOT mail hourly", () => {
  const last = { at: NOW - 60 * 60 * 1000, signature: "low" };
  assert.equal(creditAlarmDecision(low, last, NOW).alarm, false);
});

test("…but it reminds every six hours while it lasts", () => {
  const last = { at: NOW - REMINDER_MS - 1000, signature: "low" };
  assert.equal(creditAlarmDecision(low, last, NOW).alarm, true);
});

test("LOW escalating to EMPTY mails at once, without waiting out the reminder", () => {
  const last = { at: NOW - 60000, signature: "low" };
  assert.equal(creditAlarmDecision(empty, last, NOW).alarm, true);
});

test("a top-up is a recovery, and it clears the memory", () => {
  const d = creditAlarmDecision(ok, { at: NOW - 60000, signature: "empty" }, NOW);
  assert.equal(d.alarm, false);
  assert.equal(d.recovered, true);
});

test("'unknown' does not mail — the canary covers that case, and it is not news", () => {
  const unknown = assessCredit({ spend: spendOf(1), nowMs: NOW });
  assert.equal(creditAlarmDecision(unknown, null, NOW).alarm, false);
});

// ── creditAlarmLine ──────────────────────────────────────────────────────────

test("the email names the shared blast radius, not just a number", () => {
  // The whole reason this exists: nobody connected a dark social feed to a
  // failing till. The sentence has to make that connection for them.
  const line = creditAlarmLine(empty);
  assert.match(line, /^AI_CREDIT_ALARM /);
  assert.match(line, /card-recon slip OCR/);
  assert.match(line, /social/i);
  assert.match(line, /photo capture at every till stops/);
  assert.match(line, /aistudio\.google\.com/);
});

test("a LOW email states the runway; an EMPTY one states that it is empty", () => {
  assert.match(creditAlarmLine(low), /LOW: \$4\.00 left of \$50\.00/);
  assert.match(creditAlarmLine(low), /about .* day/);
  assert.match(creditAlarmLine(empty), /projected EMPTY/);
});

test("a canary-confirmed empty says the API refused, not that we estimated it", () => {
  const confirmed = assessCredit({
    toppedUpUSD: 50, toppedUpAt: NOW - DAY, spend: spendOf(1), canaryExhausted: true, nowMs: NOW,
  });
  const line = creditAlarmLine(confirmed);
  assert.match(line, /EMPTY — the API is refusing every call \(HTTP 402\)/);
  assert.doesNotMatch(line, /projected/);
});

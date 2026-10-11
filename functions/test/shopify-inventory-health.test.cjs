// ─── THE STOCK-TRUTH WATCHDOG'S DECISIONS — every awkward case, as data ──────
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assessInventoryHealth, alarmLine, PASS_STALE_MS, SWEEP_STALE_MS, REALARM_MS,
} = require("../lib/shopify-inventory-health.cjs");

// 2026-10-12 10:00 SAST — inside the reconciler's day.
const DAY = Date.parse("2026-10-12T08:00:00Z");
// 2026-10-12 23:00 SAST — outside it.
const NIGHT = Date.parse("2026-10-12T21:00:00Z");
const freshSweep = (over = {}) => ({ at: DAY - 8 * 3600e3, commit: true, listed: 1832, corrected: 0, found: { oversellableUnits: 0, unlimitedVariants: 0, worst: [] }, residual: null, commitFailures: [], refused: null, ...over });

test("a fresh pass and a clean sweep are healthy and silent", () => {
  const v = assessInventoryHealth({ nowMs: DAY, health: { lastPassAt: DAY - 3 * 60000, lastSweep: freshSweep() } });
  assert.equal(v.ok, true);
  assert.deepEqual(v.alarms, []);
});

test("no clean pass for 15 minutes in trading hours alarms — once per outage", () => {
  const health = { lastPassAt: DAY - PASS_STALE_MS, lastSweep: freshSweep() };
  const first = assessInventoryHealth({ nowMs: DAY, health });
  assert.deepEqual(first.alarms.map((a) => a.kind), ["pass"]);
  assert.match(alarmLine(first.alarms[0]), /^SHOPIFY_STOCK_ALARM \[pass\] .*15 minutes/);
  const again = assessInventoryHealth({ nowMs: DAY + 5 * 60000, health: { ...health, watchdog: { lastAlarms: first.state.lastAlarms } } });
  assert.deepEqual(again.alarms, []);
  const later = assessInventoryHealth({ nowMs: DAY + REALARM_MS, health: { ...health, watchdog: { lastAlarms: first.state.lastAlarms } } });
  assert.deepEqual(later.alarms.map((a) => a.kind), ["pass"]);
});

test("14 minutes is not yet an outage", () => {
  const v = assessInventoryHealth({ nowMs: DAY, health: { lastPassAt: DAY - PASS_STALE_MS + 60000, lastSweep: freshSweep() } });
  assert.deepEqual(v.alarms, []);
});

test("a pass that has NEVER happened alarms in trading hours", () => {
  const v = assessInventoryHealth({ nowMs: DAY, health: { lastSweep: freshSweep() } });
  assert.equal(v.alarms[0].kind, "pass");
  assert.equal(v.alarms[0].signature, "never");
});

test("a quiet night is the schedule, not an outage", () => {
  const v = assessInventoryHealth({ nowMs: NIGHT, health: { lastPassAt: NIGHT - 4 * 3600e3, lastSweep: freshSweep({ at: NIGHT - 3600e3 }) } });
  assert.deepEqual(v.alarms, []);
});

test("the first quarter hour of the day is given room", () => {
  const sevenOhFive = Date.parse("2026-10-12T05:05:00Z");
  const v = assessInventoryHealth({ nowMs: sevenOhFive, health: { lastPassAt: sevenOhFive - 10 * 3600e3, lastSweep: freshSweep({ at: sevenOhFive - 3 * 3600e3 }) } });
  assert.deepEqual(v.alarms, []);
});

test("recovery clears the pass alarm so the next outage is new", () => {
  const prev = { pass: { at: DAY - 3600e3, signature: "123" } };
  const v = assessInventoryHealth({ nowMs: DAY, health: { lastPassAt: DAY - 60000, lastSweep: freshSweep(), watchdog: { lastAlarms: prev } } });
  assert.equal(v.state.lastAlarms.pass, null);
});

test("a sweep that found oversellable stock emails what it found AND what it corrected", () => {
  const sweep = freshSweep({
    corrected: 54, rollbackFile: "/Users/marathonclub/marathon-rollbacks/stock-truth-x.json",
    found: { oversellableUnits: 3, unlimitedVariants: 337, worst: [{ pid: "p1787221095186", sizes: ["6: unlimited (app 0)"] }] },
  });
  const v = assessInventoryHealth({ nowMs: DAY, health: { lastPassAt: DAY, lastSweep: sweep } });
  assert.deepEqual(v.alarms.map((a) => a.kind), ["sweep"]);
  const line = alarmLine(v.alarms[0]);
  assert.match(line, /3 unit\(s\) on Shopify above what the app holds/);
  assert.match(line, /337 size\(s\) Shopify was not limiting/);
  assert.match(line, /Auto-corrected: 54 listing\(s\)/);
  assert.match(line, /p1787221095186/);
  // The same sweep is not announced twice.
  const again = assessInventoryHealth({ nowMs: DAY + 60000, health: { lastPassAt: DAY, lastSweep: sweep, watchdog: { lastAlarms: v.state.lastAlarms } } });
  assert.deepEqual(again.alarms, []);
});

test("a refused correction and a residual after correcting both alarm", () => {
  const refused = assessInventoryHealth({ nowMs: DAY, health: { lastPassAt: DAY, lastSweep: freshSweep({ refused: "would take 40% off sale" }) } });
  assert.match(refused.alarms[0].message, /REFUSED/);
  const residual = assessInventoryHealth({ nowMs: DAY, health: { lastPassAt: DAY, lastSweep: freshSweep({ residual: { oversellableUnits: 0, unlimitedVariants: 2 } }) } });
  assert.match(residual.alarms[0].message, /STILL WRONG/);
});

test("a dry-run sweep says so in the email", () => {
  const v = assessInventoryHealth({ nowMs: DAY, health: { lastPassAt: DAY, lastSweep: freshSweep({ commit: false, found: { oversellableUnits: 1, unlimitedVariants: 0, worst: [] } }) } });
  assert.match(v.alarms[0].message, /DRY RUN/);
});

test("no sweep for 26 hours alarms even when everything else is fine", () => {
  const v = assessInventoryHealth({ nowMs: DAY, health: { lastPassAt: DAY, lastSweep: freshSweep({ at: DAY - SWEEP_STALE_MS }) } });
  assert.deepEqual(v.alarms.map((a) => a.kind), ["sweepStale"]);
  const never = assessInventoryHealth({ nowMs: NIGHT, health: {} });
  assert.deepEqual(never.alarms.map((a) => a.kind), ["sweepStale"]);
});

test("a fractional serverNowMs heartbeat is still a heartbeat", () => {
  const v = assessInventoryHealth({ nowMs: DAY, health: { lastPassAt: DAY - 60000.37, lastSweep: freshSweep() } });
  assert.equal(v.ok, true);
});

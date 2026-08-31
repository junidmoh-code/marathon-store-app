// ─── THE POLLER WATCHDOG'S DECISIONS — every awkward case, as data ───────────
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { assessPollerHealth, POLLER_STALE_MS, POLLER_REALARM_MS } = require("../lib/poller-health.cjs");

const NOW = 10_000_000_000;

test("a fresh heartbeat is healthy and never alarms", () => {
  const v = assessPollerHealth({ nowMs: NOW, lastRunAt: NOW - 2 * 60000, lastAlarm: null });
  assert.equal(v.ok, true);
  assert.equal(v.alarm, false);
});

test("a stale heartbeat alarms exactly once for the same outage", () => {
  const lastRunAt = NOW - POLLER_STALE_MS - 60000;
  const first = assessPollerHealth({ nowMs: NOW, lastRunAt, lastAlarm: null });
  assert.equal(first.ok, false);
  assert.equal(first.alarm, true);
  assert.equal(first.signature, String(lastRunAt));
  // The next check, same outage, already alerted: quiet.
  const second = assessPollerHealth({ nowMs: NOW + 10 * 60000, lastRunAt, lastAlarm: { at: NOW, signature: first.signature } });
  assert.equal(second.ok, false);
  assert.equal(second.alarm, false);
});

test("a continuing outage re-alarms after six hours — a weekend death is not one email", () => {
  const lastRunAt = NOW - POLLER_STALE_MS - 60000;
  const later = NOW + POLLER_REALARM_MS + 60000;
  const v = assessPollerHealth({ nowMs: later, lastRunAt, lastAlarm: { at: NOW, signature: String(lastRunAt) } });
  assert.equal(v.alarm, true);
});

test("no heartbeat node at all is an outage with the constant signature", () => {
  const v = assessPollerHealth({ nowMs: NOW, lastRunAt: null, lastAlarm: null });
  assert.equal(v.ok, false);
  assert.equal(v.alarm, true);
  assert.equal(v.signature, "never");
  assert.equal(v.staleMinutes, null);
  // …and it too alerts once, not every ten minutes.
  const quiet = assessPollerHealth({ nowMs: NOW + 20 * 60000, lastRunAt: null, lastAlarm: { at: NOW, signature: "never" } });
  assert.equal(quiet.alarm, false);
});

test("a new outage after recovery is a NEW signature and alarms again", () => {
  const oldRun = NOW - 40 * 60000;
  const newRun = NOW - POLLER_STALE_MS - 1000; // recovered in between, then died again
  const v = assessPollerHealth({ nowMs: NOW, lastRunAt: newRun, lastAlarm: { at: NOW - 30 * 60000, signature: String(oldRun) } });
  assert.equal(v.alarm, true);
  assert.equal(v.signature, String(newRun));
});

test("recovery is reported so the log tells a whole story", () => {
  const v = assessPollerHealth({ nowMs: NOW, lastRunAt: NOW - 60000, lastAlarm: { at: NOW - 3600000, signature: "x" } });
  assert.equal(v.ok, true);
  assert.equal(v.recovered, true);
});

test("a FRACTIONAL heartbeat (serverNowMs carries RTDB's float offset) is a beat, not 'never'", () => {
  const v = assessPollerHealth({ nowMs: NOW, lastRunAt: NOW - 120000.4180001, lastAlarm: null });
  assert.equal(v.ok, true);
  assert.equal(v.alarm, false);
});

test("exact boundaries: 15 minutes IS stale; six hours IS reminder time", () => {
  const atBoundary = assessPollerHealth({ nowMs: NOW, lastRunAt: NOW - POLLER_STALE_MS, lastAlarm: null });
  assert.equal(atBoundary.ok, false);
  assert.equal(atBoundary.alarm, true);
  const lastRunAt = NOW - POLLER_STALE_MS - 60000;
  const reminder = assessPollerHealth({ nowMs: NOW + POLLER_REALARM_MS, lastRunAt, lastAlarm: { at: NOW, signature: String(lastRunAt) } });
  assert.equal(reminder.alarm, true);
});

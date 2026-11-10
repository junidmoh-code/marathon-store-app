// npx vitest run scripts/social/socialAlarmCore.test.mjs
import { test } from "vitest";
import assert from "node:assert/strict";
import { MAIL_TO, dedupe, fixFor, healthAlert, healthStaleAlert, publisherAlerts, runErrorAlert, tokenAlerts } from "./socialAlarmCore.mjs";

const T = (iso) => Date.parse(iso);
// Real reason lines from socialHealthScan, 9 Nov 2026.
const morning = {
  ok: false, severity: "silent", checkedAt: T("2026-11-09T05:10:06Z"),
  reasons: [
    "the 06:00 generator made nothing — all 1 skipped (AI credits depleted or rate-limited (429) — check Gemini billing)",
    "the 07:00 still made nothing (Junid has not approved the new house models yet — the current style also failed: AI credits depleted or rate-limited (429) — check Gemini billing)",
  ],
};
const afternoon = { ...morning, reasons: ["the 15:30 story has not landed", "the 15:30 feed post has not landed (20 min past the slot)", ...morning.reasons] };
const evening = { ...morning, reasons: ["the 19:00 reel has not landed", ...afternoon.reasons] };

test("mail goes to the inbox Junid reads", () => assert.equal(MAIL_TO, "gunidmoh@gmail.com"));

test("the 9 Nov outage mails once that day, at 07:10, with the top-up link", () => {
  const a = healthAlert(morning, "2026-11-09");
  assert.match(a.body, /aistudio\.google\.com\/app\/billing/);
  // The 15:30 and 19:00 misses are consequences of the same cause: same key.
  assert.equal(healthAlert(afternoon, "2026-11-09").key, a.key);
  assert.equal(healthAlert(evening, "2026-11-09").key, a.key);
  // The next day is a new reminder.
  assert.notEqual(healthAlert(morning, "2026-11-10").key, a.key);
});

test("a missed slot with no upstream cause mails per slot", () => {
  const d1 = { ok: false, severity: "silent", reasons: ["the 15:30 feed post has not landed (20 min past the slot)"] };
  const d2 = { ok: false, severity: "silent", reasons: ["the 15:30 feed post has not landed (35 min past the slot)"] };
  const d3 = { ok: false, severity: "silent", reasons: ["the 19:00 reel has not landed", "the 15:30 feed post has not landed (20 min past the slot)"] };
  assert.equal(healthAlert(d1, "d").key, healthAlert(d2, "d").key);
  assert.notEqual(healthAlert(d1, "d").key, healthAlert(d3, "d").key);
});

test("ok and degraded days do not mail", () => {
  assert.equal(healthAlert({ ok: true, severity: "ok" }, "d"), null);
  assert.equal(healthAlert({ ok: false, severity: "degraded", reasons: ["1 post(s) are in failed"] }, "d"), null);
  assert.equal(healthAlert(null, "d"), null);
});

test("a stale health check mails after 07:40, not before", () => {
  assert.equal(healthStaleAlert(null, T("2026-11-10T05:30:00Z")), null);   // 07:30
  assert.ok(healthStaleAlert(null, T("2026-11-10T06:00:00Z")));            // 08:00, nothing written
  assert.equal(healthStaleAlert({ checkedAt: T("2026-11-10T09:40:00Z") }, T("2026-11-10T10:00:00Z")), null);
  assert.ok(healthStaleAlert({ checkedAt: T("2026-11-10T09:00:00Z") }, T("2026-11-10T10:00:00Z")));
});

test("a run that threw mails once", () => {
  assert.equal(runErrorAlert({ finishedAt: 1, created: 0 }, "06:00 reel run", "d"), null);
  const a = runErrorAlert({ finishedAt: 1, error: "gemini HTTP 402: credits are depleted" }, "06:00 reel run", "d");
  assert.match(a.body, /prepaid/);
});

test("publisher failures from the real log format", () => {
  const log = [
    "2026/11/10, 15:30:17  ── run start ──",
    "2026/11/10, 15:30:17     meta: ready — Page \"Marathon Club\"",
    "2026/11/10, 15:30:34       instagram: FAILED media container expired",
    "2026/11/10, 15:31:15     done: 1 posted, 1 failed, 0 skipped",
    "2026/11/10, 15:31:15  ── run complete ──",
    "2026/11/10, 19:01:13  ── run start ──",
    "2026/11/10, 19:03:56     done: 2 posted, 0 failed, 0 skipped",
    "2026/11/09, 19:03:56     done: 0 posted, 3 failed, 0 skipped",
  ].join("\n");
  const out = publisherAlerts(log, { consecutiveFailures: 0 }, "2026-11-10");
  assert.equal(out.length, 1);
  assert.match(out[0].body, /container expired/);
  assert.equal(publisherAlerts(log, { consecutiveFailures: 2 }, "2026-11-10").length, 2);
});

test("token: never-expiring page token, data access warned 7 days ahead", () => {
  // The live token on 10 Nov 2026.
  const live = { type: "PAGE", is_valid: true, expires_at: 0, data_access_expires_at: 1799943433 };  // 14 Jan 2027
  assert.deepEqual(tokenAlerts(live, T("2026-11-10T10:00:00Z")), []);
  const near = tokenAlerts(live, T("2027-01-08T10:00:00Z"));
  assert.equal(near.length, 1);
  assert.match(near[0].subject, /loses data access in 7 day/);
  assert.equal(tokenAlerts({ is_valid: false, error: { message: "Session has expired" } }, T("2027-01-20T10:00:00Z"))[0].key.startsWith("token-invalid"), true);
});

test("dedupe sends each key once and prunes old ones", () => {
  const now = T("2026-11-10T10:00:00Z");
  const a = { key: "k1" }, b = { key: "k2" };
  const r = dedupe([a, b, a], { k1: now - 1000, old: now - 30 * 86400000 }, now);
  assert.deepEqual(r.toSend, [b]);
  assert.deepEqual(Object.keys(r.sent), ["k1"]);
});

test("fix lines", () => {
  assert.match(fixFor("AI credits depleted (402) — top up Gemini prepaid credits"), /auto-reload/);
  assert.equal(fixFor("something else"), null);
});

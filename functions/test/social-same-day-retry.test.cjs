// Same-day retry after a provider refusal (5–10 Nov 2026 outage).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const r = require("../lib/social-recovery.cjs");

const NOW = Date.UTC(2026, 10, 10, 8, 0);       // 10:00 SAST
const CUT = Date.UTC(2026, 10, 10, 16, 0);      // 18:00 SAST
const credits = "AI credits depleted (402) — top up Gemini prepaid credits";

// The exact records written on 10 Nov 2026.
const daily10Nov = { created: 0, estCostUSD: 0, feedTwins: 0, finishedAt: 1794283234277, skipReasons: ["AI credits depleted or rate-limited (429) — check Gemini billing"], skipped: 1, startedAt: 1794283207583, storyTwins: 0 };
const still10Nov = { costUSD: 0, day: "tue", fallback: false, finishedAt: 1794286813212, planned: "current", reason: "the current style also failed: AI credits depleted or rate-limited (429) — check Gemini billing", scheduledAt: 1794317400000, startedAt: 1794286808432 };
const still9NovLookbook = { ...still10Nov, planned: "lookbook", gate: "models-pending", reason: "Junid has not approved the new house models yet — the current style also failed: " + credits };

test("the 10 Nov daily record is retried before its cutoff", () => {
  const c = r.sameDayRetryClaim(daily10Nov, { kind: "daily", nowMs: NOW, cutoffMs: CUT });
  assert.equal(c.startedAt, NOW);
  assert.equal(c.retries, 1);
  assert.equal(c.retryOf, daily10Nov.finishedAt);
});

test("the 10 Nov still record and a lookbook-day fallback are retried", () => {
  assert.ok(r.sameDayRetryClaim(still10Nov, { kind: "still", nowMs: NOW, cutoffMs: CUT }));
  const c = r.sameDayRetryClaim(still9NovLookbook, { kind: "still", nowMs: NOW, cutoffMs: CUT });
  assert.equal(c.refusedWith, credits);
});

test("never at or after the cutoff, so a slot cannot slip into tomorrow", () => {
  assert.equal(r.sameDayRetryClaim(daily10Nov, { kind: "daily", nowMs: CUT, cutoffMs: CUT }), undefined);
  assert.equal(r.sameDayRetryClaim(daily10Nov, { kind: "daily", nowMs: NOW, cutoffMs: -Infinity }), undefined);
});

test("bounded number of retries", () => {
  const cur = { ...daily10Nov, retries: r.SAME_DAY_RETRY_LIMIT };
  assert.equal(r.sameDayRetryClaim(cur, { kind: "daily", nowMs: NOW, cutoffMs: CUT }), undefined);
});

test("not retried when something was made, the run threw, or it is still running", () => {
  const o = { kind: "daily", nowMs: NOW, cutoffMs: CUT };
  assert.equal(r.sameDayRetryClaim({ ...daily10Nov, created: 1 }, o), undefined);
  assert.equal(r.sameDayRetryClaim({ ...daily10Nov, error: "boom" }, o), undefined);
  assert.equal(r.sameDayRetryClaim({ startedAt: NOW - 1000 }, o), undefined);
  assert.equal(r.sameDayRetryClaim(null, o), undefined);
  const s = { kind: "still", nowMs: NOW, cutoffMs: CUT };
  assert.equal(r.sameDayRetryClaim({ ...still10Nov, posted: "current", postId: "x" }, s), undefined);
  assert.equal(r.sameDayRetryClaim({ ...still10Nov, off: true }, s), undefined);
});

test("not retried for causes a retry cannot fix", () => {
  const o = { kind: "daily", nowMs: NOW, cutoffMs: CUT };
  for (const why of ["daily image-generation cap reached (4)", "No house Style Kit references — add & enable refs", "the stylist found no flat-lay in live stock"]) {
    assert.equal(r.sameDayRetryClaim({ ...daily10Nov, skipReasons: [why] }, o), undefined, why);
  }
  // A mix: one refusal and one other cause is not retried either.
  assert.equal(r.sameDayRetryClaim({ ...daily10Nov, skipReasons: [credits, "No house Style Kit references"] }, o), undefined);
  // A lookbook gate alone (nothing about the provider) is not a refusal.
  assert.equal(r.sameDayRetryClaim({ ...still10Nov, reason: "Junid has not approved the new house models yet" }, { ...o, kind: "still" }), undefined);
});

test("5xx and rate limits count as refusals; RTDB-object skipReasons are read", () => {
  const o = { kind: "daily", nowMs: NOW, cutoffMs: CUT };
  assert.ok(r.sameDayRetryClaim({ ...daily10Nov, skipReasons: { 0: "2x AI service error (5xx) — try again" } }, o));
  assert.ok(r.sameDayRetryClaim({ ...daily10Nov, skipReasons: ["AI rate-limited or over quota (429) — check Gemini billing"] }, o));
});

test("402 and 429 give the budget unit back; only 5xx falls back to Flash", () => {
  assert.equal(r.isUnbilledRefusal('gemini HTTP 402: {"error":{"code":402}}'), true);
  assert.equal(r.isUnbilledRefusal("gemini HTTP 429: slow down"), true);
  assert.equal(r.isUnbilledRefusal("gemini HTTP 503: busy"), true);
  assert.equal(r.isUnbilledRefusal("gemini HTTP 400: bad"), false);
  assert.equal(r.isUnbilledRefusal("timed out"), false);
  assert.equal(r.isUnbilledProviderError("gemini HTTP 402: x"), false);
});

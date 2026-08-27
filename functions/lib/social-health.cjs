// ─── SOCIAL HEALTH — DID THE DAY ACTUALLY HAPPEN? ─────────────────────────────
//
// The social engine's worst failure mode is not an error. It is a QUIET day:
// every moving part reports success, nothing is logged as failed, and simply
// nothing goes out. It happened on 2026-08-27 — the launchd agent was alive
// and ticking every two minutes, socialDailyAutopilot fired at 06:00 exactly
// as scheduled, the Meta token was valid, and the queue held no failures. The
// only trace anywhere was six lines in a Cloud Functions log saying Gemini had
// answered 429 "prepayment credits are depleted", so the day's reel and its
// three stories were never GENERATED. Nothing was due, so nothing failed to
// publish, so nothing complained.
//
// That is the shape this module exists to catch, and it is why "did anything
// publish today?" is NOT sufficient on its own as the test. On that same day a
// leftover post from the backlog published at 11:00 and both platforms
// returned ok — a publish-only check would have gone green on the day the
// engine stopped producing.
//
// So the day is assessed on FOUR independent questions, and any one of them
// can raise the alarm:
//
//   1. GENERATION — did the 06:00 autopilot run, and did it make what the
//      policy asked for? A run that made 0 of 6 is the 2026-08-27 failure.
//   2. PUBLISHING — is anything approved, due, past its grace period, and
//      still sitting there? That is a publisher that has stopped.
//   3. SILENCE — was anything due today at all, and did nothing publish?
//   4. HEARTBEAT — is the Mac mini's publisher still ticking? This is the one
//      check that fires BEFORE the damage: a dead agent is visible within
//      minutes, rather than at the end of a day with nothing on it.
//
// PURE. No RTDB, no network, no clock of its own — every input is passed in.
// The caller (socialHealthScan in index.js) does the reading and the alerting;
// everything decided here is decided from arguments, so the whole verdict is
// testable against a fabricated day.

"use strict";

const { saDateStringFromMs, SAST_OFFSET_MS } = require("./sa-time.cjs");

const DAY_MS = 86400000;

// How long past a post's slot before "not published yet" becomes "something is
// wrong". The publisher ticks every 120s, so a healthy post goes out within
// about two minutes of its slot. Twenty minutes is ten ticks of margin — long
// enough that a slow Meta call, a sleeping mini waking up, or a retry can
// never raise a false alarm, short enough that a real stoppage is caught the
// same evening rather than the next day.
const PUBLISH_GRACE_MS = 20 * 60 * 1000;

// How long the publisher may go without a tick before it counts as stopped.
// Six times its 120s interval — a reboot, a wake-from-sleep or a single long
// run cannot trip it, but a genuinely dead launchd agent shows up in a quarter
// of an hour instead of at the end of a silent week.
const HEARTBEAT_STALE_MS = 15 * 60 * 1000;

/**
 * A heartbeat value, or null if it is not a timestamp.
 *
 * TYPE-CHECKED rather than coerced, which is not pedantry — `Number([])` and
 * `Number("")` are both 0, so a corrupt heartbeat of `[]` would be read as
 * "ticked at the epoch" and reported as 29 million minutes stale. That is the
 * right verdict for the wrong reason, and the next such value might coerce to
 * something that reads as healthy instead. A numeric STRING is accepted on
 * purpose: RTDB does not always round-trip a number as a number, and
 * "1787836263000" is a timestamp by any honest reading.
 */
function timestampOrNull(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Midnight SAST of the SA day containing `ms`, as epoch ms. */
function sastMidnight(ms) {
  return Math.floor((ms + SAST_OFFSET_MS) / DAY_MS) * DAY_MS - SAST_OFFSET_MS;
}

/**
 * Everything a post's platform results say about whether it actually landed.
 *
 * A post is "published" only if at least one platform came back ok. A post
 * whose every platform failed is NOT published, however "posted" its status
 * says — the status is set by the publisher's own bookkeeping and a partial
 * failure must not be able to count as a good day.
 */
function landedSomewhere(post) {
  const r = post && post.results;
  if (!r || typeof r !== "object") return false;
  return Object.values(r).some((x) => x && x.state === "ok");
}

/**
 * Total items the policy asks for in a day. Mirrors loadSocialPolicy's shape
 * (three named lists of times) but does NOT clamp — clamping is the
 * generator's business, and this only needs to know what was asked.
 */
function policyTotal(policy) {
  if (!policy) return 0;
  const len = (v) => (Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0);
  return len(policy.reels) + len(policy.photos) + len(policy.stories);
}

/**
 * Assess one SA day.
 *
 * @param {object}  a
 * @param {number}  a.nowMs             when the assessment is being made
 * @param {object}  a.policy            { reels:[], photos:[], stories:[] } — what the day was meant to produce
 * @param {object}  a.autopilotLog      the /social_autopilot_log/{saDate} record, or null if absent
 * @param {object[]}a.posts             every /social_posts record (with its id), unfiltered
 * @param {number}  a.publisherTickAt   epoch ms of the publisher's last tick, or null if it has never written one
 *
 * @returns {{ ok, severity, reasons, counts, saDate }}
 *   severity is "silent" when the day produced nothing at all, "degraded" when
 *   it produced less than it should have, and "ok" otherwise. The distinction
 *   is what lets the alert say "the engine has stopped" rather than "something
 *   is a bit off" — two different messages for two genuinely different nights.
 */
function assessSocialDay({ nowMs, policy, autopilotLog, posts, publisherTickAt }) {
  const saDate = saDateStringFromMs(nowMs);
  const dayStart = sastMidnight(nowMs);
  const dayEnd = dayStart + DAY_MS;
  const all = Array.isArray(posts) ? posts.filter(Boolean) : [];

  const reasons = [];

  // ── 1. GENERATION ─────────────────────────────────────────────────────────
  const wanted = policyTotal(policy);
  const made = Number(autopilotLog && autopilotLog.created) || 0;
  const skipped = Number(autopilotLog && autopilotLog.skipped) || 0;
  if (wanted > 0) {
    if (!autopilotLog) {
      reasons.push("the 06:00 generator has no record of running today");
    } else if (autopilotLog.error) {
      reasons.push(`the 06:00 generator failed: ${String(autopilotLog.error).slice(0, 200)}`);
    } else if (!autopilotLog.finishedAt) {
      // Only worth saying once the run cannot plausibly still be going. The
      // function's own ceiling is 30 minutes; past that with no finishedAt it
      // was killed rather than slow.
      if (nowMs - Number(autopilotLog.startedAt || 0) > 40 * 60 * 1000) {
        reasons.push("the 06:00 generator started and never finished");
      }
    } else if (made === 0) {
      reasons.push(`the 06:00 generator made nothing — all ${skipped || wanted} skipped`);
    } else if (made < wanted) {
      reasons.push(`the 06:00 generator made ${made} of ${wanted}`);
    }
  }

  // ── 2. PUBLISHING ─────────────────────────────────────────────────────────
  // Anything approved whose slot passed more than the grace period ago and
  // which has not landed. Deliberately NOT limited to today: a post stranded
  // yesterday is still stranded, and a check that forgets it every midnight
  // would let a permanent stoppage read as a series of unremarkable days.
  const overdue = all.filter((p) =>
    p.status === "approved" &&
    Number.isFinite(Number(p.scheduledAt)) &&
    Number(p.scheduledAt) < nowMs - PUBLISH_GRACE_MS);
  if (overdue.length) {
    reasons.push(`${overdue.length} approved post(s) are past due and still unpublished`);
  }

  const failed = all.filter((p) => p.status === "failed");
  if (failed.length) {
    reasons.push(`${failed.length} post(s) are in failed`);
  }

  // ── 3. SILENCE ────────────────────────────────────────────────────────────
  // Was anything meant to go out today, and did anything actually go out?
  // "Meant to" counts BOTH what the policy asked the generator for and what
  // was already sitting approved for a slot today — a day with an empty policy
  // but a scheduled backlog post is still a day that owes a post.
  const dueToday = all.filter((p) =>
    Number.isFinite(Number(p.scheduledAt)) &&
    Number(p.scheduledAt) >= dayStart && Number(p.scheduledAt) < dayEnd);
  const publishedToday = all.filter((p) =>
    Number.isFinite(Number(p.postedAt)) &&
    Number(p.postedAt) >= dayStart && Number(p.postedAt) < dayEnd &&
    landedSomewhere(p));
  // Only meaningful once the day's earliest slot has actually come and gone —
  // at 07:00 a day with nothing published yet is a normal morning, not an
  // outage. The grace period is applied to the earliest slot that was due.
  const earliestDue = dueToday
    .map((p) => Number(p.scheduledAt))
    .filter((n) => n < nowMs - PUBLISH_GRACE_MS)
    .sort((a, b) => a - b)[0];
  if (earliestDue !== undefined && publishedToday.length === 0) {
    reasons.push("nothing has published today");
  }

  // ── 4. HEARTBEAT ──────────────────────────────────────────────────────────
  // The value is VALIDATED, not merely compared. Arithmetic against a
  // non-number yields NaN, every comparison with NaN is false, and the check
  // would then pass silently on a heartbeat that is not a timestamp — a
  // corrupt write, a string, a half-finished migration. That is the precise
  // failure mode this module exists to prevent, in the one check meant to fire
  // BEFORE a day is lost, so anything that is not a finite number is treated
  // the same as no heartbeat at all.
  const tickAt = timestampOrNull(publisherTickAt);
  const haveTick = tickAt !== null;
  if (!haveTick) {
    reasons.push("the publisher has never recorded a tick");
  } else if (nowMs - tickAt > HEARTBEAT_STALE_MS) {
    const mins = Math.round((nowMs - tickAt) / 60000);
    reasons.push(`the publisher has not ticked for ${mins} minutes`);
  }

  // ── THE VERDICT ───────────────────────────────────────────────────────────
  // "silent" is reserved for a day that produced NOTHING — no publish, and
  // either no generation or a dead publisher. Everything else that is wrong is
  // "degraded". The two get different words in the alert because "the engine
  // has stopped" and "the engine is limping" are different nights.
  const nothingPublished = earliestDue !== undefined && publishedToday.length === 0;
  const publisherDead = !haveTick || nowMs - tickAt > HEARTBEAT_STALE_MS;
  const severity = reasons.length === 0
    ? "ok"
    : (nothingPublished || publisherDead) ? "silent" : "degraded";

  return {
    saDate,
    ok: reasons.length === 0,
    severity,
    reasons,
    counts: {
      wanted, made, skipped,
      dueToday: dueToday.length,
      publishedToday: publishedToday.length,
      overdue: overdue.length,
      failed: failed.length,
    },
  };
}

/**
 * One line, no jargon, for a person reading it on a phone.
 *
 * Kept here rather than at the call site so the wording is tested with the
 * verdict that produced it — an alert whose text drifts from its own reasons
 * is worse than no alert.
 */
function alarmMessage(verdict) {
  if (!verdict || verdict.ok) return null;
  const head = verdict.severity === "silent"
    ? `Social engine SILENT on ${verdict.saDate}.`
    : `Social engine degraded on ${verdict.saDate}.`;
  return `${head} ${verdict.reasons.join("; ")}.`;
}

module.exports = {
  assessSocialDay, alarmMessage,
  policyTotal, landedSomewhere,
  PUBLISH_GRACE_MS, HEARTBEAT_STALE_MS,
};

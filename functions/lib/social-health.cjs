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
// So the day is assessed on FIVE independent questions, and any one of them
// can raise the alarm:
//
//   1. GENERATION — did the 06:00 autopilot run, and did it make what the
//      policy asked for? A run that made 0 of 6 is the 2026-08-27 failure.
//   1b. SURFACES — did each surface get what the day owed it? Since
//      2026-09-19 that is a DIFFERENT question from check 1: two reel slots
//      owe two reels AND two stories, because each reel is also posted as a
//      story from the same encoded video. A run that made both pictures and
//      twinned neither passes check 1 and leaves the account with no stories.
//   2. PUBLISHING — is anything approved, due, past its grace period, and
//      still sitting there? That is a publisher that has stopped.
//   3. SILENCE — was anything due today at all, and did nothing publish?
//   4. HEARTBEAT — is the Mac mini's publisher still ticking? This is the one
//      check that fires BEFORE the damage: a dead agent is visible within
//      minutes, rather than at the end of a day with nothing on it.
//   4b. THE DAILY STILL — did the 07:00 still run and post, which format, and
//      is the lookbook quietly falling back to the current style?
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

// The 06:00 run normally finishes by 06:05. By 06:40 (its own 30 min timeout
// plus margin) a missing record means it did not run, not that it is slow.
const GENERATOR_DUE_BY_MS = (6 * 60 + 40) * 60 * 1000;

// ── HOW FAR BACK THE SCAN READS ──────────────────────────────────────────────
// socialHealthScan reads /social_posts by KEY RANGE, not the whole node. Push
// keys sort by creation time, so "keys from three weeks ago onward" is a
// bounded read that needs no .indexOn rule. The node has no index, so an
// orderByChild query would download everything anyway. Three weeks covers
// every post a day can owe: the autopilot slots at most a day ahead, and a
// manual post is scheduled within the fortnight assignSlots walks.
// KNOWN LIMIT: a post created more than three weeks ago is not seen. If an
// old draft is approved and published today it does not cover its slot (a
// false page), and an old post stuck in approved or failed stops being
// reported. Reading by status instead would need .indexOn, which
// /social_posts does not have. Without it an orderByChild query downloads
// the whole node. Suggested rule: "social_posts": { ".indexOn": ["status", "scheduledAt"] }
const SCAN_WINDOW_MS = 21 * DAY_MS;

const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
/**
 * The 8-character time prefix of a Firebase push key made at `ms`. Every key
 * pushed at or after `ms` sorts at or after it, so it is a startAt() bound.
 */
function pushKeyPrefixForMs(ms) {
  let t = Math.max(0, Math.floor(ms));
  let out = "";
  for (let i = 0; i < 8; i++) { out = PUSH_CHARS.charAt(t % 64) + out; t = Math.floor(t / 64); }
  return out;
}

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

/**
 * The autopilot's own account of why it skipped, as one short clause.
 *
 * Bounded to two distinct reasons: this ends up in an email subject line and
 * in the alerted signature, and a six-clause sentence is one nobody finishes
 * reading. Absent, malformed or empty gives null, and the caller says nothing
 * rather than "(undefined)".
 */
function skipSummary(autopilotLog) {
  const list = autopilotLog && autopilotLog.skipReasons;
  const rows = Array.isArray(list)
    ? list
    : list && typeof list === "object" ? Object.values(list) : [];
  const clean = rows.filter((r) => typeof r === "string" && r.trim()).slice(0, 2);
  return clean.length ? clean.join("; ") : null;
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

/** How many entries a policy list holds, whatever shape RTDB gave it back. */
function listLen(v) {
  return Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0;
}

/**
 * Total items the policy asks for in a day. Mirrors loadSocialPolicy's shape
 * (three named lists of times) but does NOT clamp — clamping is the
 * generator's business, and this only needs to know what was asked.
 */
function policyTotal(policy) {
  if (!policy) return 0;
  return listLen(policy.reels) + listLen(policy.photos) + listLen(policy.stories);
}

// A post record's format, defaulting to "feed". A MIRROR of formatOf in
// src/components/social/socialCore.js, which this CJS module cannot import.
// Copied rather than shared because the alternative — a fourth file whose only
// job is one ternary — buys nothing, and social-health.test.cjs pins the
// vocabulary it depends on.
const FORMATS = ["feed", "story", "reel"];
function formatOfPost(post) {
  const f = post && post.format;
  return FORMATS.includes(f) ? f : "feed";
}

/**
 * WHAT THE DAY OWES, PER SURFACE.
 *
 * `policyTotal` counts GENERATIONS — one picture made per slot — and for a
 * long time that was the same number as the posts, so one count did both
 * jobs. It is not the same number any more, and the gap is the whole point of
 * the 2026-09-19 rhythm:
 *
 *   2 reel slots  →  2 generations  →  2 reels AND 2 stories.
 *
 * The stories are free — each is its reel's own encoded video, sent again —
 * so a check that judged the day on generations alone would be satisfied by a
 * morning that made two pictures and twinned neither, and the account would
 * simply have no stories on it with nothing complaining.
 *
 * The retired slots fall out of this rather than being special-cased: `photos`
 * and `stories` ask for no times, so the day owes no feed posts and no
 * standalone stories, and a check that finds none cannot alarm about them. Put
 * a time back in the Policy tab and the obligation follows it the same day.
 *
 * @param policy  { reels, photos, stories } — lists of times
 * @param flags   the two twin switches, mirroring functions/index.js
 * @returns { generations, byFormat: { reel, feed, story } }
 */
function dayObligation(policy, { reelAlsoPostsToStory = true, storyAlsoPostsToFeed = true } = {}) {
  const reels = listLen(policy && policy.reels);
  const photos = listLen(policy && policy.photos);
  const stories = listLen(policy && policy.stories);
  return {
    generations: reels + photos + stories,
    byFormat: {
      reel: reels,
      // A story's feed twin is a feed post that was never a photo slot.
      feed: photos + (storyAlsoPostsToFeed ? stories : 0),
      // A reel's story twin is a story that was never a story slot.
      story: stories + (reelAlsoPostsToStory ? reels : 0),
    },
  };
}

/**
 * Assess one SA day.
 *
 * @param {object}  a
 * @param {number}  a.nowMs             when the assessment is being made
 * @param {object}  a.policy            { reels:[], photos:[], stories:[] } — what the day was meant to produce
 * @param {object}  a.autopilotLog      the /social_autopilot_log/{saDate} record, or null if absent
 * @param {object[]}a.posts             /social_posts records (with ids) created within SCAN_WINDOW_MS
 * @param {boolean} a.autopilotEnabled  the deployed SOCIAL_AUTOPILOT_ENABLED; false says "switched off"
 * @param {number}  a.publisherTickAt   epoch ms of the publisher's last tick, or null if it has never written one
 *
 * @returns {{ ok, severity, reasons, counts, saDate }}
 *   severity is "silent" when the day produced nothing at all, "degraded" when
 *   it produced less than it should have, and "ok" otherwise. The distinction
 *   is what lets the alert say "the engine has stopped" rather than "something
 *   is a bit off" — two different messages for two genuinely different nights.
 */
/**
 * The newest failure's own words, so an alarm about a rejected publish says
 * WHY (an expired Meta token, a rejected container) instead of only a count.
 * Uses failedReason, else the first platform error in results.
 */
function latestFailureCause(failed) {
  const newest = [...failed].sort((a, b) =>
    (Number(b.postedAt || b.scheduledAt) || 0) - (Number(a.postedAt || a.scheduledAt) || 0))[0];
  if (!newest) return "";
  let why = newest.failedReason;
  if (!why && newest.results && typeof newest.results === "object") {
    const bad = Object.entries(newest.results).find(([, r]) => r && r.state !== "ok" && r.error);
    if (bad) why = `${bad[0]}: ${bad[1].error}`;
  }
  return why ? ` (latest: ${String(why).slice(0, 160)})` : "";
}

/** "19:00" -> ms after SAST midnight, or null for a malformed time. */
function slotOffsetMs(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return (h * 60 + mi) * 60000;
}

function listOf(v) {
  return Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : [];
}

/**
 * THE SLOTS THE DAY HAS ALREADY PASSED, PER SURFACE: the times a post was
 * owed whose grace period is over. A reel slot also owes a story (its twin),
 * and a story slot also owes a feed post. These are the same twin rules as
 * dayObligation, laid out by time instead of counted.
 */
function passedSlots(policy, dayStart, nowMs, { reelAlsoPostsToStory = true, storyAlsoPostsToFeed = true } = {}, still = null) {
  const by = { reel: [], story: [], feed: [] };
  // A slot whose time was already past when the policy was saved was never
  // owed. Adding a 10:00 slot at 14:00 must not page about 10:00.
  const savedAt = Number(policy && policy.updatedAt) || 0;
  const add = (format, list) => {
    for (const t of listOf(list)) {
      const off = slotOffsetMs(t);
      if (off === null) continue;
      const slot = dayStart + off;
      if (slot < savedAt) continue;
      if (slot + PUBLISH_GRACE_MS < nowMs) by[format].push(String(t).trim());
    }
  };
  add("reel", policy && policy.reels);
  add("feed", policy && policy.photos);
  add("story", policy && policy.stories);
  if (reelAlsoPostsToStory) add("story", policy && policy.reels);
  if (storyAlsoPostsToFeed) add("feed", policy && policy.stories);
  // The daily still (socialStillAutopilot) is a story, twinned onto the feed.
  if (stillActive(still) && still.slot) {
    add("story", [still.slot]);
    if (storyAlsoPostsToFeed) add("feed", [still.slot]);
  }
  // By time, not by label: "9:00" sorts after "12:00" as a string.
  for (const f of Object.keys(by)) by[f].sort((a, b) => slotOffsetMs(a) - slotOffsetMs(b));
  return by;
}

// ── THE DAILY STILL ──────────────────────────────────────────────────────────
// socialStillAutopilot runs at 07:00 and writes social_still_log/{saDate}. By
// 07:40 (its own 30-minute ceiling plus margin) a missing record means it did
// not run.
const STILL_DUE_BY_MS = (7 * 60 + 40) * 60 * 1000;

/**
 * What the still did today and whether the lookbook is failing quietly.
 *
 * A lookbook day that falls back still POSTS (the current style), so every
 * other check stays green. That is exactly the quiet failure the owner asked
 * to see within 48 hours. So:
 *   · a fallback today is a reason (degraded: visible on the day record);
 *   · yesterday's fallback is still a reason today, so a non-lookbook day
 *     after a failed one does not read as clean;
 *   · two lookbook days running that both fell back PAGE. On Mon/Wed/Fri
 *     the second is 48 h after the first (72 h across a weekend).
 *
 * @param still { enabled, slot, log, recent: { [saDate]: log } }
 * @returns { reasons, silent, report }
 */
function assessStill(still, { nowMs, dayStart, saDate }) {
  const out = { reasons: [], silent: false, report: null };
  if (!still || !still.enabled) return out;
  const log = still.log || null;
  // Owed only once the still has ever run: the deploy day, deployed after
  // 07:00, has no record and must not page about it (architect review, S5).
  if (!stillActive(still)) return out;
  out.report = {
    planned: (log && log.planned) || null,
    posted: (log && log.posted) || null,
    fallback: Boolean(log && log.fallback),
    gate: (log && log.gate) || null,
    reason: (log && log.reason) || null,
  };
  if (!log) {
    if (nowMs - dayStart > STILL_DUE_BY_MS) { out.reasons.push("the 07:00 still has no record of running today"); out.silent = true; }
  } else if (log.error) {
    out.reasons.push(`the 07:00 still failed: ${String(log.error).slice(0, 200)}`); out.silent = true;
  } else if (log.finishedAt && !log.posted && !log.off) {
    out.reasons.push(`the 07:00 still made nothing${log.reason ? ` (${String(log.reason).slice(0, 200)})` : ""}`); out.silent = true;
  } else if (!log.finishedAt && nowMs - Number(log.startedAt || 0) > 40 * 60 * 1000) {
    out.reasons.push("the 07:00 still started and never finished"); out.silent = true;
  }
  if (log && log.fallback) {
    out.reasons.push(`today's lookbook fell back to the current style (${log.gate || "?"}: ${String(log.reason || "no reason recorded").slice(0, 160)})`);
  }
  // The previous lookbook day, from the last few days' records.
  const prior = Object.keys(still.recent || {})
    .filter((d) => d < saDate)
    .sort()
    .reverse()
    .map((d) => ({ d, l: still.recent[d] }))
    .find((x) => x.l && x.l.planned === "lookbook");
  if (prior && prior.l.fallback) {
    const ageDays = Math.round((Date.parse(`${saDate}T00:00:00Z`) - Date.parse(`${prior.d}T00:00:00Z`)) / DAY_MS);
    const todayIsLookbook = Boolean(log && log.planned === "lookbook");
    if (todayIsLookbook && log.fallback) {
      out.reasons.push(`the lookbook has fallen back on two lookbook days running (${prior.d} and ${saDate})`);
      out.silent = true;
    } else if (!todayIsLookbook && ageDays <= 2) {
      // Only on the days in between: a lookbook that worked today supersedes
      // the one before it (architect review, S3).
      out.reasons.push(`the last lookbook (${prior.d}) fell back to the current style (${prior.l.gate || "?"}: ${String(prior.l.reason || "").slice(0, 120)})`);
    }
  }
  return out;
}

/** Has the daily still ever run (a record today or in the recent window)? */
function stillActive(still) {
  return Boolean(still && still.enabled && (still.log || Object.keys(still.recent || {}).length));
}

function assessSocialDay({ nowMs, policy, autopilotLog, posts, publisherTickAt, twins, autopilotEnabled = true, still = null, rhythm = null }) {
  const saDate = saDateStringFromMs(nowMs);
  const dayStart = sastMidnight(nowMs);
  const dayEnd = dayStart + DAY_MS;
  const all = Array.isArray(posts) ? posts.filter(Boolean) : [];

  const reasons = [];

  // ── 1. GENERATION ─────────────────────────────────────────────────────────
  const obligation = dayObligation(policy, twins || {});
  const wanted = obligation.generations;
  const made = Number(autopilotLog && autopilotLog.created) || 0;
  const skipped = Number(autopilotLog && autopilotLog.skipped) || 0;
  // Switched off in the deployed build is its own reason, and it comes first.
  // "No record of running" was all 4–7 Oct ever said, and it sends the reader
  // to Cloud Scheduler when the answer is one line in functions/index.js.
  const generatorOff = wanted > 0 && autopilotEnabled === false;
  if (generatorOff) {
    reasons.push("the 06:00 generator is switched OFF in the deployed functions (SOCIAL_AUTOPILOT_ENABLED) — nothing new is being made");
  }
  if (wanted > 0 && !generatorOff) {
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
      // ── THE REASON TRAVELS WITH THE ALARM ─────────────────────────────────
      // "made nothing — all 6 skipped" is a symptom and every cause looks the
      // same in it: depleted credits, a revoked key, an empty style library,
      // a catalogue with nothing in stock. The autopilot now records WHY
      // (skipReasons on its own run record), so the sentence that reaches a
      // phone can say "check Gemini billing" instead of sending its reader to
      // a Cloud Logging console they may not have access to.
      const why = skipSummary(autopilotLog);
      reasons.push(`the 06:00 generator made nothing — all ${skipped || wanted} skipped${why ? ` (${why})` : ""}`);
    } else if (made < wanted) {
      reasons.push(`the 06:00 generator made ${made} of ${wanted}`);
    }
  }

  // ── 1b. WHAT THE DAY OWES EACH SURFACE ────────────────────────────────────
  // Check 1 asks whether the PICTURES were made. This asks whether the POSTS
  // exist, which since 2026-09-19 is a different question: two reel slots owe
  // two reels AND two stories, and the stories cost nothing because each is
  // its reel's own encoded video. A run that made both pictures and twinned
  // neither satisfies check 1 completely and leaves the account with no
  // stories on it.
  //
  // COUNTED BY createdAt, NOT BY scheduledAt. What a slot is set to is the
  // autopilot's choice and it rolls forward: a reclaimed run at 13:00 assigns
  // the 12:00 reel to TOMORROW's 12:00, and counting by slot would then report
  // a missing reel on a day the generator did its job. createdAt is when the
  // record was made, which is the thing being judged.
  //
  // Only once the run has FINISHED. Mid-run the counts are honestly
  // incomplete, and an alarm at 06:01 about a batch still being written is the
  // false alarm that teaches you to ignore the real one. A run that never
  // finishes is already check 1's business.
  const madeToday = all.filter((p) =>
    Number.isFinite(Number(p.createdAt)) &&
    Number(p.createdAt) >= dayStart && Number(p.createdAt) < dayEnd &&
    p.status !== "discarded");
  const short = [];
  // The still's story and its feed twin are owed once the still has run and
  // posted. Before that they are check 4b's business, not a surface short.
  const owedByFormat = { ...obligation.byFormat };
  if (still && still.enabled && still.log && still.log.finishedAt && still.log.posted) {
    owedByFormat.story += 1;
    if (!twins || twins.storyAlsoPostsToFeed !== false) owedByFormat.feed += 1;
  }
  if (autopilotLog && autopilotLog.finishedAt && made > 0) {
    for (const [format, owed] of Object.entries(owedByFormat)) {
      if (owed <= 0) continue;                       // a retired slot owes nothing
      const have = madeToday.filter((p) => formatOfPost(p) === format).length;
      // "storys" is what `${format}s` produces, and a watchdog that cannot
      // spell is a watchdog nobody quotes.
      const PLURAL = { reel: "reels", story: "stories", feed: "feed posts" };
      if (have < owed) short.push(`${have} of ${owed} ${owed === 1 ? format : PLURAL[format] || `${format}s`}`);
    }
  }
  if (short.length) {
    reasons.push(`today owes ${short.join(" and ")} — ${short.length === 1 ? "that surface is" : "those surfaces are"} short`);
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
    reasons.push(`${failed.length} post(s) are in failed${latestFailureCause(failed)}`);
  }

  // ── 3. SILENCE ────────────────────────────────────────────────────────────
  // Was anything meant to go out today, and did anything actually go out?
  // "Meant to" counts BOTH what the policy asked the generator for and what
  // was already sitting approved for a slot today — a day with an empty policy
  // but a scheduled backlog post is still a day that owes a post.
  // A DRAFT was never approved and a DISCARDED post was thrown away — neither
  // is owed, however recent its slot. Counting them meant a single discarded
  // post with a slot earlier today was enough to make earliestDue defined, so
  // a day on which nothing was ever going to publish reported "nothing has
  // published today". A false alarm is not a cautious alarm; it is the thing
  // that teaches you to ignore the real one.
  const OWED_STATUSES = new Set(["approved", "posting", "posted", "failed"]);
  const dueToday = all.filter((p) =>
    OWED_STATUSES.has(p.status) &&
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

  // ── 3b. EVERY SLOT, ONCE ITS TIME HAS PASSED ──────────────────────────────
  // Check 3 asks whether ANYTHING published, and only about posts already in
  // the queue. An empty queue owes it nothing, so a generator that stopped
  // writing posts can never trip it (4–7 Oct). This asks the policy instead:
  // the 12:00 reel slot has passed by 20 minutes, so has a reel landed today?
  // A slot is only met by a post that actually landed on a platform.
  //
  // Matched by WHEN IT LANDED, not by scheduledAt: the autopilot rolls a slot
  // forward when it is taken, and Post now moves one to the present, so
  // scheduledAt is not a reliable label. Each landed post covers the latest
  // still-open slot at or before the moment it landed (a late 12:00 reel at
  // 13:10 covers 12:00, a 19:01 reel covers 19:00 and not 12:00). A post that
  // landed before every open slot, posted early, covers the earliest one.
  const slots = passedSlots(policy, dayStart, nowMs, twins || {}, still);
  const missed = [];
  let missedSlotCount = 0;
  for (const [format, times] of Object.entries(slots)) {
    if (!times.length) continue;
    const slotMs = times.map((t) => dayStart + slotOffsetMs(t));
    const covered = new Array(times.length).fill(false);
    const landings = publishedToday
      .filter((p) => formatOfPost(p) === format)
      .map((p) => Number(p.postedAt))
      .sort((a, b) => a - b);
    for (const when of landings) {
      let pick = -1;
      for (let i = times.length - 1; i >= 0; i--) if (!covered[i] && slotMs[i] <= when) { pick = i; break; }
      if (pick === -1) pick = covered.indexOf(false);
      if (pick === -1) break;
      covered[pick] = true;
    }
    const uncovered = times.filter((_, i) => !covered[i]);
    missedSlotCount += uncovered.length;
    if (uncovered.length) {
      const label = format === "feed" ? "feed post" : format;
      const names = [...new Set(uncovered)];
      const n = uncovered.length;
      const plural = n > 1 ? `s${names.length < n ? ` (${n})` : ""} have` : " has";
      missed.push(`the ${names.join(" and ")} ${label}${plural} not landed`);
    }
  }
  if (missed.length) {
    reasons.unshift(`${missed.join("; ")} (${Math.round(PUBLISH_GRACE_MS / 60000)} min past the slot)`);
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

  // ── 4b. THE DAILY STILL ───────────────────────────────────────────────────
  const stillVerdict = assessStill(still, { nowMs, dayStart, saDate });
  reasons.push(...stillVerdict.reasons);

  // ── 4c. THE RHYTHM ────────────────────────────────────────────────────────
  // Owner brief, 2026-10-18: exactly one reel and one photo post a day. A
  // policy that asks for more or fewer reels, or a still that is switched
  // off, still makes posts and so passes every check above; this says so.
  // Degraded, not paged: it is a configuration, not an outage.
  const reelsPlanned = listLen(policy && policy.reels);
  const stillsPlanned = still && still.enabled ? 1 : 0;
  const reelsMade = madeToday.filter((p) => formatOfPost(p) === "reel").length;
  const stillsMade = madeToday.filter((p) => p.updatedBy === "cron:socialStillAutopilot" && !p.twinOf).length;
  if (rhythm) {
    if (reelsPlanned !== rhythm.reels) {
      reasons.push(`the policy asks for ${reelsPlanned} reel${reelsPlanned === 1 ? "" : "s"} a day; the rhythm is ${rhythm.reels} reel + ${rhythm.stills} photo post`);
    }
    if (stillsPlanned !== rhythm.stills && autopilotEnabled !== false) {
      reasons.push(`the daily photo post is switched off; the rhythm is ${rhythm.reels} reel + ${rhythm.stills} photo post`);
    }
    // And what was actually MADE: more than the rhythm is a cost, not an outage.
    if (reelsMade > rhythm.reels) reasons.push(`${reelsMade} reels were made today; the rhythm is ${rhythm.reels}`);
    if (stillsMade > rhythm.stills) reasons.push(`${stillsMade} photo posts were made today; the rhythm is ${rhythm.stills}`);
  }

  // ── THE VERDICT ───────────────────────────────────────────────────────────
  // "silent" is reserved for a day that produced NOTHING — no publish, and
  // either no generation or a dead publisher. Everything else that is wrong is
  // "degraded". The two get different words in the alert because "the engine
  // has stopped" and "the engine is limping" are different nights.
  const nothingPublished = earliestDue !== undefined && publishedToday.length === 0;
  const publisherDead = !haveTick || nowMs - tickAt > HEARTBEAT_STALE_MS;
  // ── A GENERATOR THAT MADE NOTHING IS "DOWN", NOT "A BIT OFF" ───────────────
  // Only "silent" reaches a phone (see socialHealthScan's own note on why
  // "degraded" was demoted). "The 06:00 generator made nothing" was landing on
  // the degraded side, and that is exactly how the 2026-09-13 outage ran for
  // six days without an email: Gemini's prepayment credits were depleted, the
  // autopilot made 0 of 6 every morning, and the publisher went on draining a
  // backlog — so something published most days, the mini kept ticking, and
  // the one check that had noticed was the one that had been told not to
  // shout. Two of those six days paged, and only because they ALSO tripped a
  // different check.
  //
  // An engine that cannot make tomorrow's posts is down today, whatever is
  // still going out of yesterday's queue. The backlog is what hides it, not
  // what excuses it.
  const generatorProducedNothing = wanted > 0 && Boolean(autopilotLog) &&
    (Boolean(autopilotLog.error) || (Boolean(autopilotLog.finishedAt) && made === 0));
  // A surface that is short PAGES. Owner brief, 2026-09-19: "it must alarm if
  // either is missed." Two reels a day means one missing reel is half the
  // day's output, not a rounding error — and its story goes with it, because
  // the twin is made from the reel.
  const owesMore = short.length > 0;
  // A generator with no record past 06:40 did not run. It is the same outage
  // as one that ran and made nothing, so it pages the same way. Before this
  // it was "degraded" and four silent days paged nobody.
  const generatorMissing = wanted > 0 && !autopilotLog && nowMs - dayStart > GENERATOR_DUE_BY_MS;
  const slotMissed = missed.length > 0;
  const severity = reasons.length === 0
    ? "ok"
    : (nothingPublished || publisherDead || generatorProducedNothing || owesMore ||
       generatorOff || generatorMissing || slotMissed || stillVerdict.silent) ? "silent" : "degraded";

  return {
    saDate,
    ok: reasons.length === 0,
    severity,
    reasons,
    // Which still format was planned and posted today, and whether it fell
    // back: null when there is no daily still.
    still: stillVerdict.report,
    counts: {
      wanted, made, skipped,
      // What each surface owed and what it got — the numbers the new rhythm
      // is judged on, recorded so the day's record explains its own verdict.
      owed: owedByFormat,
      madeByFormat: {
        reel: madeToday.filter((p) => formatOfPost(p) === "reel").length,
        story: madeToday.filter((p) => formatOfPost(p) === "story").length,
        feed: madeToday.filter((p) => formatOfPost(p) === "feed").length,
      },
      // One reel + one photo post: what was planned, what is expected, and
      // which still format actually posted (current / lookbook / null).
      rhythm: {
        reelsPlanned, stillsPlanned, reelsMade, stillsMade,
        reelsExpected: rhythm ? rhythm.reels : null,
        stillsExpected: rhythm ? rhythm.stills : null,
        stillFormat: (stillVerdict.report && stillVerdict.report.posted) || null,
        stillFallback: Boolean(stillVerdict.report && stillVerdict.report.fallback),
      },
      missedSlots: missedSlotCount,
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
  assessSocialDay, alarmMessage, assessStill,
  policyTotal, dayObligation, landedSomewhere, passedSlots, pushKeyPrefixForMs,
  PUBLISH_GRACE_MS, HEARTBEAT_STALE_MS, GENERATOR_DUE_BY_MS, SCAN_WINDOW_MS, STILL_DUE_BY_MS,
};

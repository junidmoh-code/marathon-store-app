// ─── ONE BAD MINUTE MUST NOT COST THE DAY'S REEL ─────────────────────────────
//
// 7 Oct 2026: the first autopilot run after the four-day outage made nothing.
// One reel was lost to a single Gemini 503 ("This model is currently
// experiencing high demand ... try again later") and the other to the outfit
// kind finding no bottom in live stock. Neither is a reason to post nothing.
// The run is once a day, so a skip lasts all day.
//
//   · TRANSIENT (a provider 5xx, a timeout) — the same request is retried
//     after a backoff. The provider's own message says to.
//   · NO STOCK FOR THIS KIND (nothing was picked, nothing was spent) — the
//     next kind is tried. A pairing or a single from the same stock is a
//     perfectly good reel, and the rotation exists for variety, not as a
//     rule that a day must be skipped.
//   · ANYTHING ELSE (credits depleted, the daily cap, no style refs) — stop.
//     Retrying a 429 burns the time the provider asked for, and the
//     watchdog's alarm carries the reason.
//
// PURE apart from the `run` and `sleep` it is handed, so the whole policy is
// testable without a database or a clock.

"use strict";

// Two retries, 30 s then 90 s. A 503 comes back in about a second, so the
// usual cost of a retry is the backoff alone. The worst case is NOT bounded by
// arithmetic here: with the Flash fallback one attempt can take two 180 s
// timeouts. So the run passes a deadline, and a retry that could not finish
// before it is not started (see generateWithRecovery).
const RETRY_BACKOFF_MS = [30000, 90000];
// The longest one attempt can take: Pro then Flash, each at GEMINI_FETCH_TIMEOUT_MS,
// plus a minute for photographs, render, caption and upload.
const WORST_ATTEMPT_MS = 2 * 180000 + 60000;

/**
 * A skip worth repeating as-is: the provider answered 5xx and nothing was
 * charged. A TIMEOUT is not retried, because a timed-out request may have been
 * billed and its unit is kept, so retrying could spend three of the day's four
 * units on one slot. A skip that spent money (costUSD > 0, an image made and a
 * later step failed) is never retried either: that would pay for it twice.
 */
function isTransientSkip(skipped) {
  return Boolean(skipped) && skipped.costUSD === 0 &&
    /AI service error \(5xx\)/i.test(String(skipped.reason || ""));
}

/** An error message from the provider that charged nothing (a 5xx makes no image). */
function isUnbilledProviderError(message) {
  return /gemini HTTP 5\d\d/i.test(String(message || ""));
}

/**
 * A provider refusal that made no image and billed nothing: a 5xx, a 402
 * (prepaid credits depleted) or a 429 (rate limit). Used to give the day's
 * budget unit back. 5–10 Nov 2026: every 402 kept its unit, so a day the
 * provider refused outright still counted two of the four as spent.
 * Deliberately separate from isUnbilledProviderError, which also decides the
 * Pro→Flash fallback, and that fallback is for overload (5xx) only.
 */
function isUnbilledRefusal(message) {
  return /gemini HTTP (5\d\d|402|429)/i.test(String(message || ""));
}

/** A skip from pickForKind: nothing was picked, so nothing was spent. generateOnePost marks it. */
function isNoStockSkip(skipped) {
  return Boolean(skipped) && skipped.noStock === true;
}

/**
 * The kinds to try for one slot, the requested one first. A story stays a
 * single (one hero product reads fastest in two seconds); a reel or photo
 * falls through the rest of the rotation, ending on single, which needs one
 * product in stock and so almost never comes up empty.
 */
function kindsToTry(kind, format, rotation) {
  if (format === "story") return ["single"];
  const rest = rotation.filter((k) => k !== kind && k !== "single");
  return [kind, ...rest, ...(kind === "single" ? [] : ["single"])];
}

/**
 * Generate one slot with recovery.
 *
 * @param {object}   a
 * @param {string}   a.kind       the kind the rotation asked for
 * @param {string}   a.format     "reel" | "feed" | "story"
 * @param {string[]} a.rotation   AUTOPILOT_KINDS
 * @param {function} a.run        (kind) => Promise<{ ok, created?, skipped? }>, i.e. generateOnePost
 * @param {function} a.sleep      (ms) => Promise
 * @returns the last result, with `attempts` (what was tried, in order) added
 */
async function generateWithRecovery({
  kind, format, rotation, run, sleep, backoffMs = RETRY_BACKOFF_MS,
  deadlineMs = Infinity, now = Date.now,
}) {
  const attempts = [];
  let result = null;
  for (const k of kindsToTry(kind, format, rotation)) {
    for (let i = 0; ; i++) {
      result = await run(k);
      attempts.push(result.ok ? `${k}:ok` : `${k}:${String(result.skipped && result.skipped.reason || "skipped").slice(0, 60)}`);
      if (result.ok || !isTransientSkip(result.skipped) || i >= backoffMs.length) break;
      // A retry that could not finish before the run's deadline is not started.
      // A killed run leaves a claim with no finishedAt and loses the whole day.
      if (now() + backoffMs[i] + WORST_ATTEMPT_MS > deadlineMs) { attempts.push("no time left to retry"); break; }
      await sleep(backoffMs[i]);
    }
    if (result.ok || !isNoStockSkip(result.skipped)) break;
  }
  return { ...result, attempts };
}

/**
 * The transaction body that gives a reserved generation back. Used only when
 * the provider refused with a 5xx: no image was made and nothing was billed,
 * so the unit was never spent, and keeping it would let one bad minute of 503s
 * use up the day's cap of four before a single picture existed. Anything that
 * is not a positive count is left alone. A counter nobody can read is not
 * ours to lower.
 */
function releaseGeneration(cur) {
  // The cold-cache null must NOT abort (social-budget.cjs, reserveGeneration):
  // returning it unchanged makes Firebase re-run this against the server's
  // real value. Aborting on it meant the first release on 7 Oct gave nothing
  // back, and three 503s used up the day's cap with no picture made.
  if (cur === null || cur === undefined) return null;
  if (typeof cur !== "number" || !Number.isFinite(cur) || cur <= 0) return undefined;
  return cur - 1;
}

// ─── A DAY THE PROVIDER REFUSED IS WON BACK THE SAME DAY (10 Nov 2026) ───────
// 5–10 Nov: Gemini's prepaid credits ran out. The 06:00 and 07:00 runs each
// recorded "made nothing" and finished, and a finished run is never run again
// that day. A top-up at 10:00 would therefore still have cost the day's reel
// and photo, and nobody should have to re-run a job by hand after paying a
// bill. So a FINISHED run that made nothing, and failed ONLY because the
// provider refused (credits, quota, 5xx), may be claimed again, but only:
//   · before its cutoff (an hour before the first slot it fills), so a retry
//     can never push a slot into tomorrow and change the posting rhythm;
//   · a bounded number of times;
//   · never after a run that threw, made something, or failed for any other
//     reason (the daily cap, no stock, no style refs).
// socialAutopilotRetry fires the real scheduled job only once a free probe
// shows the provider answering again, so a retry is not attempted into a 402.
const PROVIDER_REFUSAL_RE = /AI credits depleted|rate-limited|over quota|AI service error \(5xx\)/i;
const SAME_DAY_RETRY_LIMIT = 6;
const PAID_IMAGE_USD = 0.05;

/** The provider's part of a reason: the still records "<lookbook gate> — the current style also failed: <why>". */
function refusalPart(reason) {
  const s = String(reason || "");
  const i = s.lastIndexOf("also failed: ");
  return i >= 0 ? s.slice(i + "also failed: ".length) : s;
}

function isProviderRefusal(reason) {
  return PROVIDER_REFUSAL_RE.test(refusalPart(reason));
}

/** Did this run record make nothing, and why? Reads both run logs' shapes. */
function refusedRun(cur, kind) {
  if (!cur || !cur.finishedAt || cur.error) return null;
  // NO PAYING TWICE (architect review). The daily run's refusals come from the
  // image call itself, which bills nothing when refused; what it did spend
  // (style tags, the stylist) is cached and not bought again. The still is
  // different: a lookbook day may pay for hero images and THEN fail a gate,
  // and a retry would pay for them again. A hero costs ~$0.13+, tags and the
  // stylist cost pennies, so a still that spent PAID_IMAGE_USD or more is
  // never retried.
  if (kind === "still" && (Number(cur.costUSD) || 0) >= PAID_IMAGE_USD) return null;
  if (kind === "daily") {
    if (Number(cur.created) !== 0) return null;
    const reasons = Array.isArray(cur.skipReasons) ? cur.skipReasons : Object.values(cur.skipReasons || {});
    return reasons.length ? reasons : null;
  }
  if (cur.posted || cur.postId || cur.off) return null;
  return cur.reason ? [cur.reason] : null;
}

/**
 * The claim-transaction branch for a same-day retry. Returns the new claim, or
 * undefined (no retry). kind: "daily" | "still".
 */
function sameDayRetryClaim(cur, { kind, nowMs, cutoffMs, maxRetries = SAME_DAY_RETRY_LIMIT }) {
  const reasons = refusedRun(cur, kind);
  if (!reasons || !reasons.every(isProviderRefusal)) return undefined;
  if (!(Number.isFinite(cutoffMs) && nowMs < cutoffMs)) return undefined;
  const retries = Number(cur.retries || 0);
  if (retries >= maxRetries) return undefined;
  return {
    startedAt: nowMs, retries: retries + 1, retryOf: cur.finishedAt,
    refusedWith: refusalPart(reasons[0]).slice(0, 200),
  };
}

/** A run claimed and not yet finished (and not yet stale): something is generating right now. */
function inFlight(cur, nowMs, staleMs = 40 * 60 * 1000) {
  return Boolean(cur && cur.startedAt && !cur.finishedAt && nowMs - Number(cur.startedAt) < staleMs);
}

module.exports = {
  inFlight,
  RETRY_BACKOFF_MS, WORST_ATTEMPT_MS, isTransientSkip, isUnbilledProviderError, isUnbilledRefusal, isNoStockSkip,
  kindsToTry, generateWithRecovery, releaseGeneration,
  SAME_DAY_RETRY_LIMIT, isProviderRefusal, refusalPart, sameDayRetryClaim,
};

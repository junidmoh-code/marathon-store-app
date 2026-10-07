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

module.exports = {
  RETRY_BACKOFF_MS, WORST_ATTEMPT_MS, isTransientSkip, isUnbilledProviderError, isNoStockSkip,
  kindsToTry, generateWithRecovery, releaseGeneration,
};

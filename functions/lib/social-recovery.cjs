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

// Two retries, 30 s then 90 s. Each attempt is bounded by the 180 s Gemini
// timeout, so a reel's worst case is 3 × 180 + 120 = 660 s, and two reels
// stay inside socialDailyAutopilot's 1800 s ceiling. A 503 comes back in
// about a second, so the usual cost of a retry is the backoff alone.
const RETRY_BACKOFF_MS = [30000, 90000];

/** A skip worth repeating as-is: the provider failed, not the request. */
function isTransientSkip(reason) {
  return /AI service error \(5xx\)|AI request timed out/i.test(String(reason || ""));
}

/** An error message from the provider that charged nothing (a 5xx makes no image). */
function isUnbilledProviderError(message) {
  return /gemini HTTP 5\d\d/i.test(String(message || ""));
}

/** A skip from pickForKind: nothing was picked, so nothing was spent. */
function isNoStockSkip(skipped) {
  return Boolean(skipped) && skipped.costUSD === undefined && !isTransientSkip(skipped.reason);
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
async function generateWithRecovery({ kind, format, rotation, run, sleep, backoffMs = RETRY_BACKOFF_MS }) {
  const attempts = [];
  let result = null;
  for (const k of kindsToTry(kind, format, rotation)) {
    for (let i = 0; ; i++) {
      result = await run(k);
      attempts.push(result.ok ? `${k}:ok` : `${k}:${String(result.skipped && result.skipped.reason || "skipped").slice(0, 60)}`);
      if (result.ok || !isTransientSkip(result.skipped && result.skipped.reason) || i >= backoffMs.length) break;
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
  RETRY_BACKOFF_MS, isTransientSkip, isUnbilledProviderError, isNoStockSkip,
  kindsToTry, generateWithRecovery, releaseGeneration,
};

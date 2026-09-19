// ─── THE DAILY IMAGE-GENERATION CAP ──────────────────────────────────────────
//
// Owner brief, 2026-09-19: "a hard cap of 4 image generations per calendar day
// (SAST), counted durably so it survives restarts. Retries count against it. At
// the cap, skip and log; never exceed it."
//
// A NORMAL DAY IS TWO. Two reels, one picture each, and each reel's story is
// the same video encoded once — so the cap is not the budget, it is the fence
// around it. It exists for the days that are not normal: a Cloud Scheduler
// retry, a manual Generate-tab run on top of the autopilot, a reclaimed
// half-finished morning, a policy somebody widened by hand. Four leaves room
// for one whole extra day's worth and no more.
//
// ── WHY IT IS COUNTED BEFORE THE CALL, NOT AFTER ─────────────────────────────
// "Retries count against it" is the requirement, and it is the one that
// decides the shape. A counter incremented on SUCCESS cannot see the money
// spent by a generation that succeeded at Gemini and then died on the upload —
// and that is precisely the failure that retries, and precisely the one that
// runs a bill up. The reservation is taken first: whatever happens next, the
// money is assumed spent.
//
// The cost of that choice is honest and small: a generation refused by Gemini
// for free (a 429 on depleted credits, say) still burns a unit of the day's
// cap. On a broken day that means the engine stops trying after four attempts
// instead of six, which is the right way round.
//
// ── WHY IT IS A DATABASE COUNTER AND NOT AN IN-PROCESS ONE ───────────────────
// "Survives restarts" rules out anything in memory. A Cloud Function instance
// is recycled between invocations and there can be several at once — the
// autopilot at 06:00 and Junid tapping Generate at 06:01 are two processes that
// must share one budget, or the cap is four per process and means nothing.
//
// PURE. The arithmetic and the wording live here so they can be tested without
// a database; index.js owns the transaction that makes it durable.

"use strict";

// Four, and the reasoning is in the header: two is a normal day, four is a
// fence with a whole spare day inside it. Raising this is a decision about
// money and belongs in a commit message, which is why it is a constant here
// rather than an environment variable somebody can move without a trace.
const MAX_IMAGE_GENERATIONS_PER_DAY = 4;

/**
 * The transaction body for the day's counter.
 *
 * `cur` is whatever RTDB hands the transaction, which includes the routine
 * COLD-CACHE NULL: the client has not seen the node yet and is guessing. That
 * null must NOT abort — returning `undefined` on it is the bug this project
 * has hit repeatedly — it must return a value, so Firebase re-runs the
 * function against the real server value and the cap is applied to THAT.
 *
 * So: null reserves the first unit optimistically; a real value at or over the
 * cap aborts. A cold-cache null on a day that is already at four therefore
 * re-runs, sees four, and aborts — which is the whole reason it is written
 * this way round.
 *
 * Rubbish in the node (a string, a negative, NaN) is treated as "no reliable
 * count", and the SAFE reading of that is the cap, not zero: a counter nobody
 * can read is not a licence to spend.
 *
 * @returns the new count, or undefined to abort.
 */
function reserveGeneration(cur, cap = MAX_IMAGE_GENERATIONS_PER_DAY) {
  if (cur === null || cur === undefined) return 1;
  if (typeof cur !== "number" || !Number.isFinite(cur) || cur < 0) return undefined;
  if (cur >= cap) return undefined;
  return cur + 1;
}

/**
 * What to say when the cap refuses a generation.
 *
 * One sentence, in the skip reason and in the log, naming the number and the
 * day — because "skipped" with no reason is exactly the shape that hid the
 * 2026-09-13 outage for six days.
 */
function capReachedReason(saDate, cap = MAX_IMAGE_GENERATIONS_PER_DAY) {
  return `the daily image-generation cap of ${cap} was already reached on ${saDate} — nothing generated, nothing charged`;
}

module.exports = { MAX_IMAGE_GENERATIONS_PER_DAY, reserveGeneration, capReachedReason };

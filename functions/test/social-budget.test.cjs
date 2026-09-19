// ─── THE DAILY IMAGE-GENERATION CAP ──────────────────────────────────────────
// Four a day, SAST, durable, and retries count. The three ways a cap like this
// is usually wrong are all tested here rather than argued in a comment:
//
//   · it aborts on the routine cold-cache null and therefore never counts;
//   · it fails OPEN when the counter cannot be read;
//   · it counts successes instead of attempts, so the exact generation that
//     costs money and then dies is the one it cannot see.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const {
  MAX_IMAGE_GENERATIONS_PER_DAY, reserveGeneration, capReachedReason,
} = require("../lib/social-budget.cjs");

const INDEX = readFileSync(require("node:path").join(__dirname, "../index.js"), "utf8");

describe("the cap itself", () => {
  test("is four a day", () => {
    assert.equal(MAX_IMAGE_GENERATIONS_PER_DAY, 4);
  });

  test("a normal day of two reels sits comfortably inside it", () => {
    // Two reels, one picture each; each reel's story is the same encoded video.
    assert.ok(MAX_IMAGE_GENERATIONS_PER_DAY >= 2);
  });
});

describe("reserveGeneration — the transaction body", () => {
  test("an empty day reserves the first unit", () => {
    assert.equal(reserveGeneration(null), 1);
    assert.equal(reserveGeneration(undefined), 1);
    assert.equal(reserveGeneration(0), 1);
  });

  test("it counts up to the cap and then refuses", () => {
    assert.equal(reserveGeneration(1), 2);
    assert.equal(reserveGeneration(2), 3);
    assert.equal(reserveGeneration(3), 4);
    assert.equal(reserveGeneration(4), undefined);   // abort
    assert.equal(reserveGeneration(5), undefined);   // and never climbs back
    assert.equal(reserveGeneration(99), undefined);
  });

  test("NEVER exceeds the cap, walked one generation at a time", () => {
    // The requirement is "never exceed it", so it is walked rather than
    // spot-checked: whatever the loop does, the counter stops at four.
    let count = null;
    let allowed = 0;
    for (let attempt = 0; attempt < 50; attempt++) {
      const next = reserveGeneration(count);
      if (next === undefined) continue;
      count = next;
      allowed++;
    }
    assert.equal(allowed, MAX_IMAGE_GENERATIONS_PER_DAY);
    assert.equal(count, MAX_IMAGE_GENERATIONS_PER_DAY);
  });

  // ── THE COLD-CACHE NULL IS NOT A REFUSAL ──────────────────────────────────
  // RTDB routinely hands a transaction null on its first attempt because the
  // client has not cached the node yet. Aborting on it — returning undefined —
  // is the bug this project has hit repeatedly, and here it would be silent in
  // the worst way: every reservation refused, so nothing is ever generated
  // again and the day reads exactly like a depleted-credits day.
  test("a cold-cache null returns a value so Firebase re-runs against the truth", () => {
    assert.notEqual(reserveGeneration(null), undefined);
  });

  test("…and the re-run against a full day is what actually refuses", () => {
    // The sequence RTDB really produces: null (guess), then the server value.
    assert.equal(reserveGeneration(null), 1);            // optimistic
    assert.equal(reserveGeneration(4), undefined);       // the truth refuses
  });

  test("a counter that cannot be trusted refuses — a cap must not fail open", () => {
    for (const junk of ["3", -1, NaN, Infinity, {}, [], true, "lots"]) {
      assert.equal(reserveGeneration(junk), undefined, `${String(junk)} must not be spendable`);
    }
  });

  test("the cap is a parameter, so it can be walked at other values", () => {
    assert.equal(reserveGeneration(1, 2), 2);
    assert.equal(reserveGeneration(2, 2), undefined);
  });
});

describe("what it says when it refuses", () => {
  test("it names the number and the day, and says nothing was charged", () => {
    const r = capReachedReason("2026-09-19");
    assert.match(r, /cap of 4/);
    assert.match(r, /2026-09-19/);
    assert.match(r, /nothing charged/);
  });
});

// ── THE PROPERTIES THAT ONLY THE CALL SITE CAN CARRY ─────────────────────────
// reserveGeneration is pure, so "is it taken before the money is spent" and
// "is there exactly one paid call" are facts about index.js, not about it.
describe("where the cap sits in the generator", () => {
  test("there is exactly ONE paid image call in the social generator", () => {
    // "Exactly one image generation per reel" rests on this. A second call
    // site is a second place the cap would have to be remembered.
    const calls = INDEX.match(/await generateSocialScene\(/g) || [];
    assert.equal(calls.length, 1);
  });

  test("the reservation is taken BEFORE that call, not after it", () => {
    // After it, a generation that succeeded at Gemini and then died on the
    // upload would spend money the counter never saw — which is exactly the
    // failure that retries.
    const claimAt = INDEX.indexOf("await claimImageGeneration(db,");
    const payAt = INDEX.indexOf("await generateSocialScene(");
    assert.ok(claimAt > -1, "the generator must reserve a unit");
    assert.ok(claimAt < payAt, "the reservation must precede the paid call");
  });

  test("both callers share one day's budget", () => {
    // The autopilot at 06:00 and a Generate-tab run at 06:01 are two processes
    // on one counter. A per-caller budget is four EACH and means nothing.
    assert.match(INDEX, /saDate: saDateForUsage\(nowMs\)/);
    assert.match(INDEX, /updatedBy: "cron:socialDailyAutopilot",\s*\n\s*saDate,/);
  });

  test("the counter lives in the database, not in the instance", () => {
    // "Durable so it survives restarts" rules out anything in memory.
    assert.match(INDEX, /social_generation_budget\/\$\{saDate\}\/count/);
  });

  // ── OUR OWN CAP MUST NOT BE REPORTED AS A BILLING PROBLEM ─────────────────
  // The cap's message contains "generated", and "generated" contains "rate" —
  // so a bare /rate/ in the error classifier matched it and told the reader to
  // go and check Gemini billing for a limit that is in this repository.
  test("the cap's own message is not classified as a provider 429", () => {
    const capMessage = capReachedReason("2026-09-19");
    assert.doesNotMatch(capMessage, /\brate[ -]?limit/i);
    assert.match(INDEX, /if \(\/daily image-generation cap\/i\.test\(m\)\) return m\.slice\(0, 140\);/);
    // And the provider branch is anchored to a real rate limit.
    assert.doesNotMatch(INDEX, /HTTP 429\|credits are depleted\|rate\|quota/);
  });
});

// ─── WHEN THE READER SAYS NO, THE REASON MUST SURVIVE THE JOURNEY ────────────
// 18 Sep 2026: a manager could not capture a slip for two days. The photo
// reached the server every time. The server called Gemini and got HTTP 429 —
// "your prepayment credits are depleted" — and three layers each discarded what
// the layer below knew:
//
//   runSlipOcr    threw `gemini HTTP 429` and dropped the response body, so the
//                 log itself never said why.
//   the handler   turned every OCR failure into "try again", which for an
//                 exhausted account is advice that cannot work.
//   the screen    turned the rejection into "check the signal", which sent
//                 everybody to look at the phone.
//
// This pins the two server halves. The client half is
// src/components/cardrecon/captureFailure.test.js.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const SRC = readFileSync(resolve(__dirname, "../cardRecon/cardRecon.js"), "utf8");
const code = SRC.replace(/^\s*\/\/.*$/gm, "");

test("a failed Gemini call keeps the response BODY, which is where the cause is", () => {
  // `gemini HTTP 429` names a category. "Your prepayment credits are depleted"
  // names the cause, ends the investigation, and was being thrown away.
  const from = code.indexOf("if (!res.ok)");
  assert.ok(from > -1, "the Gemini response check has moved — this scan must follow it");
  const block = code.slice(from, from + 600);
  assert.match(block, /res\.text\(\)/, "the body is read");
  assert.match(block, /slice\(0, 400\)/, "…and bounded, because this is a log line");
  assert.match(block, /err\.status = res\.status/, "…and the status is kept for the branch below");
});

test("429 is told apart from every other OCR failure, and does not say 'try again'", () => {
  const from = code.indexOf("cardBatchCapture: OCR failed:");
  assert.ok(from > -1, "the OCR catch has moved — this scan must follow it");
  const block = code.slice(from, from + 1400);

  assert.match(block, /err\.status === 429/, "the exhausted case is branched on the status, not on message text");
  assert.match(block, /"resource-exhausted"/, "…and raised as its own callable code, so the client can tell");
  assert.match(block, /out of credit/, "…and says what is actually wrong");
  assert.match(block, /EMAIL/i, "…and that the emailed path is unaffected, so nobody declares the estate down");

  // The generic branch survives for everything else, and no longer promises
  // that trying again is the answer to every failure.
  assert.match(block, /"unavailable"/);
  const exhausted = block.slice(block.indexOf("resource-exhausted"), block.indexOf('"unavailable"'));
  assert.ok(!/try again/i.test(exhausted),
    "the exhausted-credit sentence must not tell a manager to retry something that cannot succeed");
});

test("the refusals a manager can act on are still RESOLVED, not thrown", () => {
  // The distinction the client depends on: `reject()` resolves with
  // {ok:false, reason} and always showed correctly; a `throw` REJECTS the
  // promise and was the path that lost its sentence. Anything thrown must
  // therefore carry a code the client can classify.
  const throws = [...code.matchAll(/throw new HttpsError\(\s*"([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(throws.length > 0, "the callable does throw HttpsErrors");
  for (const kind of throws) {
    assert.ok(
      ["invalid-argument", "permission-denied", "unauthenticated", "failed-precondition",
       "resource-exhausted", "unavailable", "deadline-exceeded", "internal", "not-found",
       "already-exists", "aborted", "out-of-range", "unimplemented", "data-loss", "cancelled"].includes(kind),
      `HttpsError code "${kind}" is not one the client's vocabulary knows (captureFailure.js)`,
    );
  }
});

// The autopilot's recovery policy: 7 Oct's run lost one reel to a single
// Gemini 503 and the other to an outfit with no bottom in stock.
const test = require("node:test");
const assert = require("node:assert/strict");
const r = require("../lib/social-recovery.cjs");

const ROT = ["single", "pairing", "outfit", "flatlay"];
const ok = (k) => ({ ok: true, created: { kind: k } });
const s503 = (k) => ({ ok: false, skipped: { kind: k, reason: "AI service error (5xx) — try again", costUSD: 0 } });
const noStock = (k) => ({ ok: false, skipped: { kind: k, reason: "not enough of an outfit in live stock — nothing available for: bottom" } });
const s429 = (k) => ({ ok: false, skipped: { kind: k, reason: "AI credits depleted or rate-limited (429) — check Gemini billing", costUSD: 0 } });

function harness(script) {
  const calls = [], sleeps = [];
  let i = 0;
  return {
    calls, sleeps,
    run: async (k) => { calls.push(k); return script[i++](k); },
    sleep: async (ms) => { sleeps.push(ms); },
  };
}

test("a 503 is retried with backoff and the second attempt's reel is kept", async () => {
  const h = harness([s503, ok]);
  const res = await r.generateWithRecovery({ kind: "pairing", format: "reel", rotation: ROT, run: h.run, sleep: h.sleep });
  assert.equal(res.ok, true);
  assert.deepEqual(h.calls, ["pairing", "pairing"]);
  assert.deepEqual(h.sleeps, [30000]);
});

test("three 503s in a row give up, after exactly two backoffs, without trying other kinds", async () => {
  const h = harness([s503, s503, s503]);
  const res = await r.generateWithRecovery({ kind: "pairing", format: "reel", rotation: ROT, run: h.run, sleep: h.sleep });
  assert.equal(res.ok, false);
  assert.deepEqual(h.calls, ["pairing", "pairing", "pairing"]);
  assert.deepEqual(h.sleeps, [30000, 90000]);
  assert.equal(res.attempts.length, 3);
});

test("an outfit with no stock falls through to the next kind, then single", async () => {
  const h = harness([noStock, noStock, ok]);
  const res = await r.generateWithRecovery({ kind: "outfit", format: "reel", rotation: ROT, run: h.run, sleep: h.sleep });
  assert.equal(res.ok, true);
  assert.deepEqual(h.calls, ["outfit", "pairing", "flatlay"]);
  assert.deepEqual(h.sleeps, [], "no-stock costs no wait");
});

test("a 429 (credits) stops at once: no retry, no other kind", async () => {
  const h = harness([s429]);
  const res = await r.generateWithRecovery({ kind: "single", format: "reel", rotation: ROT, run: h.run, sleep: h.sleep });
  assert.equal(res.ok, false);
  assert.deepEqual(h.calls, ["single"]);
  assert.match(res.skipped.reason, /429/);
});

test("kindsToTry: requested first, single last, no duplicates; a story is single only", () => {
  assert.deepEqual(r.kindsToTry("outfit", "reel", ROT), ["outfit", "pairing", "flatlay", "single"]);
  assert.deepEqual(r.kindsToTry("single", "reel", ROT), ["single", "pairing", "outfit", "flatlay"]);
  assert.deepEqual(r.kindsToTry("single", "story", ROT), ["single"]);
});

test("a skip that spent money is never treated as no-stock", () => {
  assert.equal(r.isNoStockSkip({ reason: "caption write failed", costUSD: 0.134 }), false);
  assert.equal(r.isNoStockSkip({ reason: "nothing available for: bottom" }), true);
});

test("only a Gemini 5xx is an unbilled provider error", () => {
  assert.equal(r.isUnbilledProviderError('gemini HTTP 503: {"error":{"code":503}}'), true);
  assert.equal(r.isUnbilledProviderError("gemini HTTP 429: credits"), false);
  assert.equal(r.isUnbilledProviderError("gemini request timed out after 180s"), false, "a timeout may have been billed");
});

test("releaseGeneration lowers a positive count and leaves anything else alone", () => {
  assert.equal(r.releaseGeneration(3), 2);
  assert.equal(r.releaseGeneration(1), 0);
  assert.equal(r.releaseGeneration(0), undefined);
  assert.equal(r.releaseGeneration(null), undefined);
  assert.equal(r.releaseGeneration("3"), undefined);
});

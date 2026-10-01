// THE SLACK ON A DERIVED WINDOW — the 25 Sept 2026 Pine Till 1 false gaps.
//
// A banking report's window is the span of its own transactions. The till
// writes a leg minutes after the terminal approves the card, so the last sales'
// legs land after the window closes. These pin that a leg in the slack which
// answers one of the report's transactions is counted, and that nothing else
// about a gap changes: money on the terminal with no leg at any time is still
// short, and a slack leg nothing claims is never counted.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { expectedCardFromEvents, DERIVED_WINDOW_SLACK_MS } = require("../lib/card-expected.cjs");

const T = (hms) => Date.parse(`2026-09-25T${hms}+02:00`);
const OPEN = T("09:19:14");
const CLOSE = T("17:36:18");   // the print time — the derived close
const leg = (at, amount, over = {}) => ({ method: "card", storeId: "pine", tillId: "till-1", at, amount, kind: "sale", ...over });
const line = (at, amountCents) => ({ at, amountCents });
const scope = (over = {}) => ({ storeId: "pine", tillId: "till-1", startMs: OPEN, endMs: CLOSE, edgeMs: 2 * 60 * 1000, ...over });

// Batch 104 in miniature: one mid-day sale, and the two whose legs landed late.
const LINES = [line(T("12:00:00"), 50000), line(T("17:33:20"), 80000), line(T("17:34:50"), 25000)];
const LEGS = [leg(T("12:04:00"), 50000), leg(T("17:37:51"), 80000), leg(T("17:39:20"), 25000)];

test("ten minutes, and it is the constant the callable uses", () => {
  assert.equal(DERIVED_WINDOW_SLACK_MS, 10 * 60 * 1000);
});

test("without slack the two late legs fall out — the bug, reproduced", () => {
  const r = expectedCardFromEvents(LEGS, scope());
  assert.equal(r.cardCents, 50000);
});

test("with slack, a late leg that answers the report's own transaction is counted", () => {
  const r = expectedCardFromEvents(LEGS, scope({ slackMs: DERIVED_WINDOW_SLACK_MS, lines: LINES }));
  assert.equal(r.cardCents, 155000);   // the report's total: the variance closes
  assert.equal(r.slackLegs, 2);
  assert.equal(r.slackCents, 105000);
  assert.equal(r.nearEdgeLegs, 0, "a claimed leg is not also reported as a near miss");
  assert.equal(r.byKind.sale.cents, 155000);
});

test("A REAL GAP IS NOT WEAKENED: terminal money with no leg at any time stays short", () => {
  // The R250 was never rung up at all.
  const legs = [leg(T("12:04:00"), 50000), leg(T("17:37:51"), 80000)];
  const r = expectedCardFromEvents(legs, scope({ slackMs: DERIVED_WINDOW_SLACK_MS, lines: LINES }));
  assert.equal(r.cardCents, 130000);
  assert.equal(155000 - r.cardCents, 25000, "the R250 is still missing");
});

test("a slack leg of an amount the report does not carry is NOT counted", () => {
  // A sale rung after the report printed, for the NEXT batch.
  const legs = [...LEGS, leg(T("17:40:00"), 99900)];
  const r = expectedCardFromEvents(legs, scope({ slackMs: DERIVED_WINDOW_SLACK_MS, lines: LINES }));
  assert.equal(r.cardCents, 155000);
});

test("a slack leg of an amount already answered inside the window is NOT counted", () => {
  // R500 was sold at 12:00 and its leg is in the window; a second R500 after
  // the print belongs to the next batch and must not be counted twice.
  const legs = [...LEGS, leg(T("17:38:00"), 50000)];
  const r = expectedCardFromEvents(legs, scope({ slackMs: DERIVED_WINDOW_SLACK_MS, lines: LINES }));
  assert.equal(r.cardCents, 155000);
});

test("a leg beyond the slack is never counted, however well it would match", () => {
  const legs = [leg(T("12:04:00"), 50000), leg(T("17:37:51"), 80000), leg(CLOSE + DERIVED_WINDOW_SLACK_MS + 1000, 25000)];
  const r = expectedCardFromEvents(legs, scope({ slackMs: DERIVED_WINDOW_SLACK_MS, lines: LINES }));
  assert.equal(r.cardCents, 130000);
});

test("another till's leg in the slack is not this till's", () => {
  const legs = [leg(T("12:04:00"), 50000), leg(T("17:37:51"), 80000), leg(T("17:39:20"), 25000, { tillId: "till-2" })];
  const r = expectedCardFromEvents(legs, scope({ slackMs: DERIVED_WINDOW_SLACK_MS, lines: LINES }));
  assert.equal(r.cardCents, 130000);
});

test("slack at the OPEN end works the same way", () => {
  const lines = [line(OPEN, 30000)];
  const r = expectedCardFromEvents([leg(OPEN - 60 * 1000, 30000)], scope({ slackMs: DERIVED_WINDOW_SLACK_MS, lines }));
  assert.equal(r.cardCents, 30000);
});

test("no lines (a summary-only photo) → no slack is claimed at all", () => {
  const r = expectedCardFromEvents(LEGS, scope({ slackMs: DERIVED_WINDOW_SLACK_MS, lines: [] }));
  assert.equal(r.cardCents, 50000);
});

test("the callable gives the slack to derived windows only", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../cardRecon/cardRecon.js"), "utf8");
  assert.match(src, /windowSource !== "printed"\s*\n?\s*\? \{ slackMs: DERIVED_WINDOW_SLACK_MS/);
  assert.equal((src.match(/\.\.\.slackFor\(extraction\)/g) || []).length, 3, "extract (photo + pdf) and submit");
});

test("AMOUNT ALONE NEVER CLAIMS: a noon line with no leg is not answered by the next batch's same-amount sale at close", () => {
  // CodeRabbit, PR #649. The R250 at noon was never rung up — a real gap. A
  // R250 sale for the NEXT batch lands 4 minutes after this report's close.
  const lines = [line(T("12:00:00"), 25000), line(T("17:33:20"), 80000)];
  const legs = [leg(T("17:37:51"), 80000), leg(T("17:40:00"), 25000)];
  const r = expectedCardFromEvents(legs, scope({ slackMs: DERIVED_WINDOW_SLACK_MS, lines }));
  assert.equal(r.cardCents, 80000, "the R250 gap stays a gap");
  assert.equal(r.slackLegs, 1);
});

test("an in-window leg answers its OWN line, leaving the edge line for the slack", () => {
  // Two R250 sales: noon (leg in the window) and 17:34 (leg in the slack).
  const lines = [line(T("12:00:00"), 25000), line(T("17:34:50"), 25000)];
  const legs = [leg(T("12:03:00"), 25000), leg(T("17:39:20"), 25000)];
  const r = expectedCardFromEvents(legs, scope({ slackMs: DERIVED_WINDOW_SLACK_MS, lines }));
  assert.equal(r.cardCents, 50000);
});

test("…but if the NOON leg is the missing one, the edge sale's late leg still cannot cover for it", () => {
  // Noon R250 has no leg; the 17:34 R250 has an in-window leg at 17:35 AND a
  // stray next-batch R250 turns up at 17:41. Only one R250 is really in POS.
  const lines = [line(T("12:00:00"), 25000), line(T("17:34:50"), 25000)];
  const legs = [leg(T("17:35:30"), 25000), leg(T("17:41:00"), 25000)];
  const r = expectedCardFromEvents(legs, scope({ slackMs: DERIVED_WINDOW_SLACK_MS, lines }));
  assert.equal(r.cardCents, 25000, "the noon R250 is still missing");
});

// Tests for cardRecon/cardRecon.js's pure seams — the model-output →
// extraction mapping — plus the dedupeLines rule the extract path applies to
// overlapping detail photos.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { toExtraction } = require("../cardRecon/cardRecon.js");
const { dedupeLines, validateExtraction } = require("../lib/card-recon.cjs");

const MODEL_OUTPUT = {
  mid: "000000004977890", tid: "0000hp1x", batchNo: "#494",
  opened: "2026/08/26 18:50:04", closed: "2026/08/27 18:50:04", printed: "2026/08/28 08:52:38",
  txnCount: 2,
  purchases: "R50,355.00", cash: "R0.00", refunds: "R48.00", total: "R50,307.00",
  reconLine: "500 - Reconciled, in balance",
  confidence: { tid: 0.99, batchNo: 0.98, total: 0.97, opened: 0.96, closed: 0.96, purchases: 0.95, refunds: 0.9, txnCount: 0.95, mid: 0.99 },
  transactions: [
    { date: "2026/08/26", time: "19:02:11", uti: "U1", rrn: "R1", authCode: "A1", tsn: 101, pan: "************1111", amount: "R50,355.00", type: "purchase" },
    { date: "2026/08/27", time: "09:15:00", uti: "U2", rrn: "R2", authCode: "A2", tsn: 102, pan: "************2222", amount: "R48.00", type: "refund" },
  ],
};

test("toExtraction parses money to cents, times to epoch ms, and signs refund lines", () => {
  const ex = toExtraction(MODEL_OUTPUT);
  assert.equal(ex.tid, "0000HP1X");
  assert.equal(ex.purchasesCents, 5035500);
  assert.equal(ex.refundsCents, 4800);      // magnitude by contract
  assert.equal(ex.totalCents, 5030700);
  assert.equal(ex.lines[1].amountCents, -4800); // refund line normalised negative
  assert.ok(ex.openedAt < ex.closedAt);
  assert.equal(ex.confidence.totalCents, 0.97); // model's "total" → lib's "totalCents"
  // The full extraction then survives validation, arithmetic included.
  const v = validateExtraction(ex);
  assert.equal(v.ok, true, v.reason);
});

test("toExtraction leaves unparseable figures null so validation refuses them", () => {
  const ex = toExtraction({ ...MODEL_OUTPUT, total: "R5O,307.00" }); // letter O
  assert.equal(ex.totalCents, null);
  assert.equal(validateExtraction(ex).ok, false);
});

test("a refund line already printed negative is not double-negated", () => {
  const ex = toExtraction({
    ...MODEL_OUTPUT,
    transactions: [{ tsn: 1, amount: "-R48.00", type: "refund" }],
  });
  assert.equal(ex.lines[0].amountCents, -4800);
});

// ── overlap dedupe (extract path) ────────────────────────────────────────────
const L = (tsn, over = {}) => ({ tsn, amountCents: 1000, rrn: `R${tsn}`, uti: `U${tsn}`, ...over });

test("the same printed line in two overlapping photos collapses to one", () => {
  const r = dedupeLines([L(1), L(2), L(2), L(3)]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.lines.map((l) => l.tsn), [1, 2, 3]);
});

test("one TSN with conflicting readings is a refusal, not a pick", () => {
  const r = dedupeLines([L(1), L(2), L(2, { amountCents: 2000 })]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /TSN 2.*different/);
});

test("the fuller of two consistent readings wins", () => {
  const sparse = { tsn: 5, amountCents: 700, rrn: null, uti: null, pan: null };
  const full = { tsn: 5, amountCents: 700, rrn: "R5", uti: "U5", pan: "****1", authCode: "A", date: "d", time: "t", at: 1 };
  const r = dedupeLines([sparse, full]);
  assert.equal(r.ok, true);
  assert.equal(r.lines[0].rrn, "R5");
});

test("a line without a TSN refuses", () => {
  assert.equal(dedupeLines([{ amountCents: 100 }]).ok, false);
});

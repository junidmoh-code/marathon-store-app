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

test("a garbled non-empty refunds or cash string stays null — refused downstream, never zero", () => {
  const exR = toExtraction({ ...MODEL_OUTPUT, refunds: "R14O.00" }); // letter O
  assert.equal(exR.refundsCents, null);
  assert.equal(validateExtraction(exR).ok, false);
  const exC = toExtraction({ ...MODEL_OUTPUT, cash: "Rl0.00" }); // letter l
  assert.equal(exC.cashCents, null);
  assert.equal(validateExtraction(exC).ok, false);
  // Absence stays zero: slips without those lines must not be refused.
  const exAbsent = toExtraction({ ...MODEL_OUTPUT, cash: "", refunds: "" });
  assert.equal(exAbsent.cashCents, 0);
  assert.equal(exAbsent.refundsCents, 0);
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

// ─── ONE PATH PER SUBMISSION, AND WHICH ONE ──────────────────────────────────
// chooseCaptureSource answers both questions the callable asks of the input:
// which handler runs, and what `capturedVia` records. They are the same answer
// by construction, which is the point of testing it here rather than trusting
// two literals to stay in step.
const { chooseCaptureSource, readPdfPayload } = require("../lib/card-recon.cjs");

test("a PDF and photos together is refused — never merged into one record", () => {
  const r = chooseCaptureSource({ photos: [{ base64: "x" }], pdf: { base64: "y" }, maxPhotos: 6 });
  assert.equal(r.source, undefined);
  assert.match(r.err, /not both/);
});

test("neither a PDF nor photos is refused", () => {
  assert.match(chooseCaptureSource({ photos: [], pdf: null, maxPhotos: 6 }).err, /photograph the slip/);
  assert.match(chooseCaptureSource({ photos: undefined, pdf: { base64: "" }, maxPhotos: 6 }).err, /photograph the slip/);
});

test("a PDF routes to the pdf source; photos route to photo — this IS capturedVia", () => {
  assert.equal(chooseCaptureSource({ photos: [], pdf: { base64: "y" }, maxPhotos: 6 }).source, "pdf");
  assert.equal(chooseCaptureSource({ photos: [{}], pdf: null, maxPhotos: 6 }).source, "photo");
});

test("more photos than the cap is refused, and the cap is the one passed in", () => {
  const r = chooseCaptureSource({ photos: [1, 2, 3], pdf: null, maxPhotos: 2 });
  assert.equal(r.source, undefined);
  assert.match(r.err, /2 at most/);
});

// ── readPdfPayload: the file is what it claims, or it is refused by name ─────
const b64 = (s) => Buffer.from(s, "latin1").toString("base64");

test("a real PDF header passes and the bytes come back whole", () => {
  const r = readPdfPayload(b64("%PDF-1.4 body"), 1000);
  assert.equal(r.err, undefined);
  assert.equal(r.buffer.toString("latin1"), "%PDF-1.4 body");
});

test("a renamed photo is refused on its bytes, not its name", () => {
  const jpeg = readPdfPayload(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64"), 1000);
  assert.match(jpeg.err, /not a PDF/);
  assert.equal(jpeg.reject, true, "a wrong file is a refusal on screen, not a transport error");
  assert.equal(jpeg.buffer, undefined);
});

test("a data: URL prefix and stray whitespace are tolerated", () => {
  const r = readPdfPayload("data:application/pdf;base64," + b64("%PDF-1.7 x").replace(/(.)/g, "$1 "), 1000);
  assert.equal(r.err, undefined);
  assert.equal(r.buffer.toString("latin1"), "%PDF-1.7 x");
});

test("a truncated or non-base64 payload is refused as not intact", () => {
  assert.match(readPdfPayload("!!!!not base64!!!!", 1000).err, /did not arrive intact/);
  assert.match(readPdfPayload("QUJD", 1000).err ? readPdfPayload("QUJDR", 1000).err : "", /did not arrive intact/);
  assert.match(readPdfPayload("", 1000).err, /did not arrive intact/);
});

test("a file larger than the cap is refused with its own size, in MB", () => {
  const big = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(3 * 1048576)]);
  const r = readPdfPayload(big.toString("base64"), 2 * 1048576);
  assert.match(r.err, /3\.0MB — too large/);
  assert.equal(r.buffer, undefined);
});

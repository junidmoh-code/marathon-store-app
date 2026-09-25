// A TOTAL DECLARED BY HAND — the one human number the card recon accepts.
//
// Trophy Till 2's printer prints half the slip, so the TOTAL is not on the
// paper and no reader can find it. Junid — and only Junid — may type it beside
// the photo. These tests pin the contract: the parse is strict, the gate is one
// identity, the photo is still required, everything else on the slip is still
// checked, and the record says the figure was typed, by whom and when.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  parseSlipTimestamp, validateExtraction, buildBatchRecord,
  hasDeclaredTotal, readDeclaredTotal, mayDeclareTotal, DECLARED_TOTAL_EMAIL,
} = require("../lib/card-recon.cjs");

// ── the parse ────────────────────────────────────────────────────────────────
test("a typed total parses with the slip's own strict parser", () => {
  assert.deepEqual(readDeclaredTotal("12,345.67"), { cents: 1234567 });
  assert.deepEqual(readDeclaredTotal("R12 345.67"), { cents: 1234567 });
  assert.deepEqual(readDeclaredTotal(" 950 "), { cents: 95000 });
  assert.deepEqual(readDeclaredTotal("0"), { cents: 0 });
});

test("a mangled typed total is refused, never coerced", () => {
  for (const bad of ["12,34.5", "abc", "12.345", "1e5", "R", "12,345.678"]) {
    assert.ok(readDeclaredTotal(bad).err, `${bad} must be refused`);
  }
});

test("a typed total must arrive as TEXT — a JSON number would skip the shape check", () => {
  assert.ok(readDeclaredTotal(12345.67).err);
  assert.ok(readDeclaredTotal({ cents: 1 }).err);
});

test("a negative or absurd typed total is refused", () => {
  assert.ok(readDeclaredTotal("-500.00").err);
  assert.ok(readDeclaredTotal("(500.00)").err);
  assert.ok(readDeclaredTotal("1,000,000.01").err);
  assert.deepEqual(readDeclaredTotal("1,000,000.00"), { cents: 100000000 });
});

test("absent, null and blank all mean no total was declared", () => {
  assert.equal(hasDeclaredTotal(undefined), false);
  assert.equal(hasDeclaredTotal(null), false);
  assert.equal(hasDeclaredTotal("  "), false);
  assert.equal(hasDeclaredTotal("0"), true);
  // A non-string is still an ATTEMPT to declare — it must reach the refusal,
  // not be waved through as "no total".
  assert.equal(hasDeclaredTotal(123), true);
});

// ── the gate ─────────────────────────────────────────────────────────────────
test("only Junid's own token may declare a total", () => {
  assert.equal(DECLARED_TOTAL_EMAIL, "gunidmoh@gmail.com");
  assert.equal(mayDeclareTotal({ email: "gunidmoh@gmail.com" }), true);
  // His git address is NOT his Firebase admin identity.
  assert.equal(mayDeclareTotal({ email: "junidmoh@gmail.com" }), false);
  assert.equal(mayDeclareTotal({ email: "manager@marathon.co.za", card_recon: true }), false);
  assert.equal(mayDeclareTotal({ email: "GUNIDMOH@gmail.com" }), false);
  assert.equal(mayDeclareTotal(null), false);
  assert.equal(mayDeclareTotal({}), false);
});

// ── validation ───────────────────────────────────────────────────────────────
const CONF = { tid: 0.99, batchNo: 0.98, totalCents: 0.97, openedAt: 0.95, closedAt: 0.95, purchasesCents: 0.95, txnCount: 0.95 };
// A half-printed slip: the header read, the totals block did not.
function halfSlip(overrides = {}) {
  return {
    tid: "0000HP1X", mid: null, batchNo: "58",
    openedAt: parseSlipTimestamp("2026/09/24 18:50:04"),
    closedAt: parseSlipTimestamp("2026/09/25 18:50:04"),
    printedAt: null,
    txnCount: NaN,
    purchasesCents: null, cashCents: 0, refundsCents: 0, totalCents: 4353000,
    confidence: { ...CONF, totalCents: 0, purchasesCents: 0, txnCount: 0 },
    lines: [],
    ...overrides,
  };
}

test("a declared total passes where the slip's totals block did not print", () => {
  const v = validateExtraction(halfSlip(), { summaryOnly: true, declaredTotal: true });
  assert.equal(v.ok, true, v.reason);
});

test("the SAME half slip without a declared total is still refused", () => {
  const v = validateExtraction(halfSlip(), { summaryOnly: true });
  assert.equal(v.ok, false);
});

test("TID, batch number and the window are still gated on a declared-total capture", () => {
  for (const [f, conf] of [["tid", 0.3], ["batchNo", 0.3], ["openedAt", 0.3], ["closedAt", 0.3]]) {
    const v = validateExtraction(halfSlip({ confidence: { ...halfSlip().confidence, [f]: conf } }),
      { summaryOnly: true, declaredTotal: true });
    assert.equal(v.ok, false, `${f} at low confidence must still refuse`);
  }
  assert.equal(validateExtraction(halfSlip({ openedAt: null }), { summaryOnly: true, declaredTotal: true }).ok, false);
  assert.equal(validateExtraction(halfSlip({ batchNo: "x" }), { summaryOnly: true, declaredTotal: true }).ok, false);
});

test("a declared total must itself be an amount", () => {
  const v = validateExtraction(halfSlip({ totalCents: null }), { summaryOnly: true, declaredTotal: true });
  assert.equal(v.ok, false);
});

test("a declared total is only ever recorded summary-only", () => {
  const v = validateExtraction(halfSlip({ txnCount: 0 }), { summaryOnly: false, declaredTotal: true });
  assert.equal(v.ok, false);
  assert.match(v.reason, /summary-only/);
});

test("a confident printed block that disagrees with the typed total is WARNED, not refused", () => {
  const v = validateExtraction(
    halfSlip({ purchasesCents: 4000000, cashCents: 0, refundsCents: 0,
      confidence: { ...halfSlip().confidence, purchasesCents: 0.9 } }),
    { summaryOnly: true, declaredTotal: true });
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some((w) => /declared by hand/.test(w) && /R40,000\.00/.test(w) && /R43,530\.00/.test(w)), v.warnings.join("|"));
});

// ── the record ───────────────────────────────────────────────────────────────
const recordArgs = (extra = {}) => ({
  extraction: halfSlip(), terminal: { storeId: "trophy", tillId: "till-2", label: "Trophy Till 2" },
  tid: "0000HP1X", batchKey: "58", revision: 1, supersedes: null,
  photoPaths: ["cardRecon/d1/photo-0.jpg"], summaryOnly: true, warnings: [],
  expected: { cardCents: 4353000, legs: 12, byKind: {} }, cashiers: [],
  submittedBy: { uid: "owner", email: "gunidmoh@gmail.com" }, submittedAt: 5, draftId: "d1",
  ...extra,
});

test("the record says the total was declared by hand, with who and when", () => {
  const declaredTotal = { cents: 4353000, ocrReadCents: null, byUid: "owner", byEmail: "gunidmoh@gmail.com", at: 1234 };
  const rec = buildBatchRecord(recordArgs({ declaredTotal }));
  assert.deepEqual(rec.declaredTotal, declaredTotal);
  assert.equal(rec.slip.totalCents, 4353000);
  assert.deepEqual(rec.photos, ["cardRecon/d1/photo-0.jpg"]);
  // Unread stays unread — never a fabricated zero or NaN.
  assert.equal(rec.slip.purchasesCents, null);
  assert.equal(rec.slip.txnCount, null);
  // The calculation is untouched: the typed figure is the total, like any other.
  assert.equal(rec.varianceCents, 0);
});

test("an ordinary record carries no declaredTotal key at all", () => {
  const rec = buildBatchRecord(recordArgs({ extraction: halfSlip({ txnCount: 3, purchasesCents: 4353000 }) }));
  assert.equal("declaredTotal" in rec, false);
});

// ── the callable, read from source (its handlers live behind a database) ─────
const SRC = readFileSync(join(__dirname, "../cardRecon/cardRecon.js"), "utf8");
const extractBody = SRC.slice(SRC.indexOf("async function handleExtract("), SRC.indexOf("// ─── THE PDF PATH"));
const submitBody = SRC.slice(SRC.indexOf("async function handleSubmit("), SRC.indexOf("exports.cardBatchCapture"));

test("the owner gate and the photo requirement run BEFORE any OCR is paid for", () => {
  const gate = extractBody.indexOf("mayDeclareTotal(request.auth?.token)");
  const noPhoto = extractBody.indexOf("A typed total is refused without a photo");
  const ocr = extractBody.indexOf("runSlipOcr(");
  assert.ok(gate > -1 && noPhoto > -1 && ocr > -1);
  assert.ok(gate < ocr && noPhoto < ocr);
  assert.match(extractBody, /channel === "email" \|\| pdf/);
});

test("the typed figure replaces the TOTAL only, after the TID has been checked", () => {
  const tidCheck = extractBody.indexOf("not the till you picked");
  const replace = extractBody.indexOf("extraction.totalCents = declared.cents");
  assert.ok(tidCheck > -1 && replace > -1);
  assert.ok(tidCheck < replace, "the slip must prove its till before the typed figure goes on it");
  // The TID refusal reads extraction.tid, which the typed total never touches;
  // the replacement sits before validation so the gate sees the typed figure.
  assert.ok(replace < extractBody.indexOf("validateExtraction("));
  assert.equal((extractBody.match(/extraction\.\w+ = declared/g) || []).length, 1);
});

test("submit re-checks the owner and the draft's figure at the moment of record", () => {
  assert.match(submitBody, /mayDeclareTotal\(request\.auth\?\.token\)/);
  assert.match(submitBody, /declaredTotal\.cents === extraction\.totalCents/);
  assert.match(submitBody, /draft\.photoPaths\.length > 0/);
  assert.match(submitBody, /declaredTotal: !!declaredTotal/);
});

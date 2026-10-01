// ─── FIX 1: ONE BANK TRANSACTION, ONE SPENDABLE RECORD ───────────────────────
// The 9 Sep hole: "Resend proof of payment" makes the payer's bank send a NEW
// email (new Message-ID) for the SAME money. The pool keyed on the email, so
// the resend became a second live record and both could be spent — at one
// till twice, or at two tills at once. These tests replay that exact shape
// against the real decisions, BEFORE (email identity only) and AFTER (the
// bank's own transaction id, claimed at ingest and re-checked at consume).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  paymentFingerprint, normaliseBankRef, fingerprintClaimStep,
  consumeFingerprintCheck, claimHolderCheck, backfillSpentStep,
} = require("../lib/eft-fingerprint.cjs");
const { settleDecision, releaseHoldDecision, markUsedOutsidePosDecision } = require("../lib/eft-settle.cjs");

// An RTDB stand-in: serialised compare-and-swap, re-run on contention, and a
// cold-cache null first call — the Admin SDK's real behaviour.
function makeDb() {
  const data = {};
  return {
    data,
    transaction(path, update) {
      let first = true;
      for (let tries = 0; tries < 25; tries++) {
        const before = first ? null : (data[path] ?? null);
        first = false;
        const next = update(before);
        if (next === undefined) return { committed: false };
        if ((data[path] ?? null) !== before) continue; // CAS failed — re-run with the real value
        data[path] = next;
        return { committed: true };
      }
      throw new Error("livelock");
    },
  };
}

const original = {
  outcome: "recorded", status: "unmatched", at: 1000, amountCents: 50000,
  reference: "JUNID1234", payer: "J SOAP", reader: "fnb", bankRef: "5TG59DVQ",
};
// The resend: same payment, same Trace ID, a different email → different key.
const resend = { ...original, at: 2000 };
const KEY_A = "a".repeat(40);
const KEY_B = "b".repeat(40);

const settlement = (fp, over = {}) => ({
  attemptId: "P-1", at: 5000, cashierUid: "u1", cashierName: "Ahmed",
  customerId: "c1", customerName: "Mr Dlamini", customerResolved: true, confirmedCustomerId: "c1",
  appliedCents: 50000, fingerprint: fp, ...over,
});

test("the fingerprint is the bank's id, namespaced by bank, blind to case and spacing", () => {
  const fp = paymentFingerprint(original);
  assert.match(fp, /^[0-9a-f]{40}$/);
  assert.equal(paymentFingerprint({ reader: "fnb", bankRef: "5tg5 9dvq" }), fp);
  assert.notEqual(paymentFingerprint({ reader: "absa", bankRef: "5TG59DVQ" }), fp, "one bank's id says nothing about another's");
  assert.equal(paymentFingerprint({ reader: "fnb", bankRef: null }), null);
  assert.equal(paymentFingerprint({ reader: "fnb", bankRef: "12" }), null, "too short to identify anything");
  assert.equal(paymentFingerprint({ reader: null, bankRef: "5TG59DVQ" }), null);
  assert.equal(normaliseBankRef(" 80d2-f2ab5a-1 "), "80D2F2AB5A1");
});

test("BEFORE: keyed on the email, the resend is a second spendable record", () => {
  // The old shape — two keys, each settle its own transaction, no shared fact.
  const pool = { [KEY_A]: { ...original }, [KEY_B]: { ...resend } };
  const legacy = (cur, s) => settleDecision(cur, { ...s, fingerprintExempt: true });
  const a = legacy(pool[KEY_A], settlement(null));
  const b = legacy(pool[KEY_B], settlement(null, { attemptId: "P-2" }));
  assert.equal(a.ok && b.ok, true, "both copies of one payment settle — R1,000 spent from R500");
});

test("AFTER, at ingest: the resend finds the claim held by the original and is not live", () => {
  const db = makeDb();
  const fp = paymentFingerprint(original);
  let first = null;
  db.transaction(`fp/${fp}`, fingerprintClaimStep(KEY_A, 1000, (d) => { first = d; }));
  assert.equal(first.holder, KEY_A);
  let second = null;
  db.transaction(`fp/${fp}`, fingerprintClaimStep(KEY_B, 2000, (d) => { second = d; }));
  assert.equal(second.holder, KEY_A, "the claim is never moved to the resend");
  assert.deepEqual(db.data[`fp/${fp}`], { poolKey: KEY_A, at: 1000 });
  // A replay of the ORIGINAL message (same key) finds its own claim — fine.
  let replay = null;
  db.transaction(`fp/${fp}`, fingerprintClaimStep(KEY_A, 3000, (d) => { replay = d; }));
  assert.equal(replay.holder, KEY_A);
  assert.deepEqual(db.data[`fp/${fp}`], { poolKey: KEY_A, at: 1000 }, "never rewritten");
});

test("AFTER, at consume: a copy whose claim names another record is refused", () => {
  assert.equal(claimHolderCheck({ poolKey: KEY_B, holder: KEY_A }).code, "duplicate");
  assert.equal(claimHolderCheck({ poolKey: KEY_A, holder: KEY_A }).ok, true);
  assert.equal(claimHolderCheck({ poolKey: KEY_A, holder: null }).ok, false, "a corrupt claim lets nobody spend");
});

test("AFTER, at consume: a PRE-FIX duplicate of an already-used payment is refused (no claim exists)", () => {
  const usedOriginal = { ...original, status: "used", used: { attemptId: "P-0" } };
  const verdict = consumeFingerprintCheck({ poolKey: KEY_B, record: resend, siblings: [[KEY_A, usedOriginal], [KEY_B, resend]] });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "duplicate-used");
  // An unrelated used payment does not block it.
  const other = { ...original, bankRef: "ZZZZ9999", status: "used" };
  assert.equal(consumeFingerprintCheck({ poolKey: KEY_B, record: resend, siblings: [[KEY_A, other]] }).ok, true);
});

test("AFTER: two tills, the two copies, the same instant — exactly one settles", () => {
  // Pre-fix duplicates (no claim yet). Each callable checks siblings (neither
  // used), then claims; the claim transaction serialises them.
  const db = makeDb();
  const fp = paymentFingerprint(original);
  const results = [];
  for (const key of [KEY_A, KEY_B]) {
    const check = consumeFingerprintCheck({ poolKey: key, record: original, siblings: [[KEY_A, original], [KEY_B, resend]] });
    assert.equal(check.ok, true);
    let claim = null;
    db.transaction(`fp/${fp}`, fingerprintClaimStep(key, 5000, (d) => { claim = d; }));
    results.push(claimHolderCheck({ poolKey: key, holder: claim.holder }).ok);
  }
  assert.deepEqual(results, [true, false]);
});

test("AFTER, inside the settle transaction: the fingerprint must be the one the callable checked", () => {
  const fp = paymentFingerprint(original);
  assert.equal(settleDecision(original, settlement(fp)).ok, true);
  assert.equal(settleDecision(original, settlement(null)).code, "fingerprint-unchecked");
  assert.equal(settleDecision(original, settlement("f".repeat(40))).code, "fingerprint-unchecked");
});

test("NO bank transaction id: never spendable on its own", () => {
  const noId = { ...original, bankRef: null };
  assert.equal(consumeFingerprintCheck({ poolKey: KEY_A, record: noId, siblings: [] }).code, "no-bank-id");
  assert.equal(settleDecision(noId, settlement(null)).code, "no-bank-id");
});

test("the owner can release a no-bank-id hold — with a reason, on the record — and it then settles", () => {
  const held = { ...original, bankRef: null, outcome: "held-no-bankref", status: undefined };
  assert.equal(releaseHoldDecision(held, { at: 9, by: "owner", reason: "" }).code, "bad-reason");
  const r = releaseHoldDecision(held, { at: 9, by: "gunidmoh@gmail.com", reason: "on FNB statement 1 Oct" });
  assert.equal(r.ok, true);
  assert.equal(r.value.outcome, "recorded");
  assert.equal(r.value.status, "unmatched");
  assert.deepEqual(r.value.releasedFromHold, { at: 9, by: "gunidmoh@gmail.com", reason: "on FNB statement 1 Oct", from: "held-no-bankref" });
  assert.equal(consumeFingerprintCheck({ poolKey: KEY_A, record: r.value, siblings: [] }).ok, true);
  assert.equal(settleDecision(r.value, settlement(null)).ok, true);
});

test("a held DUPLICATE is never released, and nothing else is releasable", () => {
  assert.equal(releaseHoldDecision({ ...resend, outcome: "held-duplicate" }, { at: 9, by: "o", reason: "looks fine" }).code, "duplicate-never-released");
  assert.equal(releaseHoldDecision(original, { at: 9, by: "o", reason: "looks fine" }).code, "not-held");
  assert.equal(releaseHoldDecision({ outcome: "refused-auth" }, { at: 9, by: "o", reason: "looks fine" }).code, "not-held");
});

test("held outcomes are never a payment to the settle decision", () => {
  for (const outcome of ["held-duplicate", "held-no-bankref"]) {
    assert.equal(settleDecision({ ...original, outcome }, settlement(paymentFingerprint(original))).code, "not-a-payment");
  }
});

test("mark-as-used pays nothing out, so a no-bank-id payment can still be closed off", () => {
  const noId = { ...original, bankRef: null };
  const d = markUsedOutsidePosDecision(noId, { at: 7, actorUid: "u", actorName: "Junid", reason: "refunded in cash" });
  assert.equal(d.ok, true);
});

test("a payment RECORDED before fix 1 with no bank id is releasable too — never stranded", () => {
  const legacy = { ...original, bankRef: null };
  const r = releaseHoldDecision(legacy, { at: 9, by: "gunidmoh@gmail.com", reason: "on the statement" });
  assert.equal(r.ok, true);
  assert.equal(r.value.releasedFromHold.from, "recorded-before-fix");
  assert.equal(releaseHoldDecision(r.value, { at: 10, by: "o", reason: "again" }).code, "not-held", "once released, not again");
  assert.equal(releaseHoldDecision(original, { at: 9, by: "o", reason: "has an id" }).code, "not-held");
});

// CodeRabbit (this PR): a payment USED before fix 1 has no claim; once it
// scrolls out of the settle's sibling window a resend could claim and spend.
test("BACKFILL: a spent pre-fix payment stamps spentBy, and every other copy then refuses", () => {
  const db = makeDb();
  const fp = paymentFingerprint(original);
  // The resend arrived and claimed first (the original is outside the window).
  db.transaction(`fp/${fp}`, fingerprintClaimStep(KEY_B, 2000));
  db.transaction(`fp/${fp}`, backfillSpentStep(KEY_A, 3000));
  assert.deepEqual(db.data[`fp/${fp}`], { poolKey: KEY_B, at: 2000, spentBy: KEY_A, backfilledAt: 3000 }, "holder never moved; spentBy added");
  let claim = null;
  db.transaction(`fp/${fp}`, fingerprintClaimStep(KEY_B, 4000, (d) => { claim = d; }));
  assert.equal(claimHolderCheck({ poolKey: KEY_B, holder: claim.holder, spentBy: claim.spentBy }).code, "duplicate-used");
  // A fresh fingerprint is created already spent.
  const db2 = makeDb();
  db2.transaction("fp/x", backfillSpentStep(KEY_A, 5));
  assert.deepEqual(db2.data["fp/x"], { poolKey: KEY_A, at: 5, spentBy: KEY_A, backfilledAt: 5 });
  // The spender itself is not refused, and a second backfill pass changes nothing.
  assert.equal(claimHolderCheck({ poolKey: KEY_A, holder: KEY_A, spentBy: KEY_A }).ok, true);
  assert.equal(backfillSpentStep(KEY_B, 9)({ poolKey: KEY_A, spentBy: KEY_A }), undefined);
});

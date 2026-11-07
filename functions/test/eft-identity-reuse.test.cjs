// ─── ONE PAYMENT IS ITS IDENTITY, NOT ITS REFERENCE + AMOUNT (7 Nov 2026) ────
// A repeat customer pays R870 under the same reference ("Soccer T shirt") for
// order after order. One manual entry of that reference and amount, used on a
// slip on 29 Oct, blocked every later one: a genuinely new bank payment with
// its own transaction id was refused at the till as "already used on slip
// S-50363", and the owner had to type it by hand as "SOCCER T SHIRT 2".
//
// These tests pin the identity rules:
//   · two different payments that share a reference and an amount are both
//     usable, each exactly once;
//   · the same transaction id (or Absa's full synthetic identity) is used once
//     and never re-floats;
//   · an Absa pair with no transaction id that differ only by day are two
//     payments;
//   · a manual entry's twin is the same day's payment — the anti-reuse block
//     between a hand entry and the bank's notice of the SAME money stays.
// Names, ids and numbers are stand-ins (public repo).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  manualEntryKeyOf, manualEntryRecord, manualDuplicateOf, bankTwinOfEntry,
  manualTwinSettleCheck, isPaymentTwin,
} = require("../lib/eft-manual.cjs");
const { paymentFingerprint, consumeFingerprintCheck, claimHolderCheck, fingerprintClaimStep, syntheticIdentityOf } = require("../lib/eft-fingerprint.cjs");
const { searchEftPool } = require("../lib/eft-pool.cjs");
const { approvedTwinSettleCheck } = require("../lib/eft-manual-approved.cjs");

const SAST = 2 * 60 * 60 * 1000;
const sast = (iso) => Date.parse(`${iso}Z`) - SAST; // "2026-11-07T09:45:00" read as SAST
const HOUR = 60 * 60 * 1000;
const ACTOR = { uid: "owner-uid", email: "owner@example.com" };

/** A bank-confirmed Absa R870 "(Soccer T shirt)" with its own transaction id. */
const absa = ({ txn = "80AAAAAAA1-1", day = "2026-11-07", arrived = `${day}T09:45:00`, status = "unmatched", slip = null, reference = "(Soccer T shirt)", payer = "MR A PAYER" } = {}) => ({
  outcome: "recorded", status, reader: "absa", amountCents: 87000, reference, payer,
  bankRef: txn, bankTs: sast(`${day}T00:00:00`), receivedAt: sast(arrived), at: sast(arrived) + 2000, accountTail: "6625",
  ...(status === "used" ? { used: { at: sast(arrived) + HOUR, sale: { receiptNumber: slip } } } : {}),
});
/** Junid's hand entry, typed at `typed` (SAST). */
const manual = ({ entryId, typed, reference = "SOCCER T SHIRT", status = "unmatched", slip = null }) => {
  const at = sast(typed);
  const rec = manualEntryRecord({ entryId, key: manualEntryKeyOf(entryId), reference, amountCents: 87000, note: null, actor: ACTOR, at });
  return status === "used" ? { ...rec, status: "used", used: { at: at + 60000, sale: { receiptNumber: slip } } } : rec;
};

// ─── THE REAL CASE ───────────────────────────────────────────────────────────
test("the till no longer blocks a NEW payment because an older same-reference+amount payment was used on another slip", () => {
  const oldKey = manualEntryKeyOf("ME-oct29-0001");
  const old = manual({ entryId: "ME-oct29-0001", typed: "2026-10-29T10:43:00", status: "used", slip: "S-50363" });
  const fresh = absa({ txn: "80D0000000-4" }); // 7 Nov, its own transaction id
  const tail = { [oldKey]: old, fresh };
  // The settle's guards, in the order checkPaymentFingerprint runs them.
  assert.equal(consumeFingerprintCheck({ poolKey: "fresh", record: fresh, siblings: Object.entries(tail) }).ok, true);
  const twin = manualTwinSettleCheck({ poolKey: "fresh", record: fresh, siblings: Object.entries(tail) });
  assert.equal(twin.ok, true, twin.message);
  assert.equal(approvedTwinSettleCheck({ poolKey: "fresh", record: fresh, siblings: Object.entries(tail) }).ok, true);
  // …and the till's search answers with it, with no "already used on slip S-50363" warning.
  const hit = searchEftPool(tail, "soccer t shirt").results.find((r) => r.key === "fresh");
  assert.ok(hit, "the new payment is offered");
  assert.equal(hit.sameUsed, undefined);
  assert.equal(isPaymentTwin(fresh, old), false);
});

test("the owner no longer has to rename a reference: an earlier day's same entry does not block a new one", () => {
  const oldKey = manualEntryKeyOf("ME-oct29-0001");
  const old = manual({ entryId: "ME-oct29-0001", typed: "2026-10-29T10:43:00", status: "used", slip: "S-50363" });
  const dup = manualDuplicateOf({ reference: "Soccer T shirt", amountCents: 87000, entryId: "ME-nov07-0001", at: sast("2026-11-07T11:57:00") }, [[oldKey, old]]);
  assert.equal(dup, null, "a repeat customer's next payment, typed with its own reference");
});

// ─── TWO DIFFERENT PAYMENTS, SAME REFERENCE + AMOUNT ─────────────────────────
test("two DIFFERENT confirmed payments sharing reference and amount (different txn ids) are BOTH usable, each once", () => {
  const a = absa({ txn: "80AAAAAAA1-1", day: "2026-11-07", arrived: "2026-11-07T09:45:00" });
  const b = absa({ txn: "80BBBBBBB2-2", day: "2026-11-07", arrived: "2026-11-07T14:10:00" });
  assert.notEqual(paymentFingerprint(a), paymentFingerprint(b));
  // A is used; B is still usable.
  const aUsed = { ...a, status: "used", used: { at: 1, sale: { receiptNumber: "S-1" } } };
  const tail = { a: aUsed, b };
  assert.equal(consumeFingerprintCheck({ poolKey: "b", record: b, siblings: Object.entries(tail) }).ok, true);
  assert.equal(manualTwinSettleCheck({ poolKey: "b", record: b, siblings: Object.entries(tail) }).ok, true);
  assert.equal(approvedTwinSettleCheck({ poolKey: "b", record: b, siblings: Object.entries(tail) }).ok, true);
  // Each claims its OWN fingerprint: neither claim stands in the other's way.
  let ca = null; let cb = null;
  fingerprintClaimStep("a", 1, (d) => { ca = d; })(null);
  fingerprintClaimStep("b", 2, (d) => { cb = d; })(null);
  assert.equal(claimHolderCheck({ poolKey: "a", holder: ca.holder }).ok, true);
  assert.equal(claimHolderCheck({ poolKey: "b", holder: cb.holder }).ok, true);
  // Both are offered while both wait; the search does not collapse them.
  const both = searchEftPool({ a, b }, "soccer t shirt").results.map((r) => r.key).sort();
  assert.deepEqual(both, ["a", "b"]);
});

test("the SAME txn id cannot be used twice, and a resent copy never re-floats", () => {
  const original = absa({ txn: "80AAAAAAA1-1", status: "used", slip: "S-1" });
  const resend = absa({ txn: "80AAAAAAA1-1", arrived: "2026-11-07T09:46:00" });
  const tail = { original, resend };
  const c = consumeFingerprintCheck({ poolKey: "resend", record: resend, siblings: Object.entries(tail) });
  assert.equal(c.ok, false);
  assert.equal(c.code, "duplicate-used");
  // The claim: the original holds it, so the resend cannot.
  const claim = fingerprintClaimStep("original", 1)(null);
  let seen = null;
  assert.equal(fingerprintClaimStep("resend", 2, (d) => { seen = d; })(claim), undefined, "create-only: the claim is never overwritten");
  assert.equal(claimHolderCheck({ poolKey: "resend", holder: seen.holder, spentBy: "original" }).code, "duplicate-used");
});

// ─── NO TRANSACTION ID: THE FULL SYNTHETIC IDENTITY ──────────────────────────
test("a no-txn-id Absa pair differing only by day are two payments, both usable; the same day is one", () => {
  const parse = (day) => ({ ok: true, payer: "MR A PAYER", accountMask: "XXXXXXX6625", bankTs: sast(`${day}T00:00:00`), amountCents: 87000, reference: "Soccer T shirt", bankRef: null });
  const rec = (day, status = "unmatched") => ({
    outcome: "recorded", status, reader: "absa", amountCents: 87000, reference: "Soccer T shirt", payer: "MR A PAYER",
    bankRef: null, syntheticRef: syntheticIdentityOf(parse(day), "absa"), bankTs: sast(`${day}T00:00:00`), receivedAt: sast(`${day}T09:00:00`), at: sast(`${day}T09:00:00`),
    ...(status === "used" ? { used: { at: 1, sale: { receiptNumber: "S-1" } } } : {}),
  });
  const mon = rec("2026-11-02", "used");
  const tue = rec("2026-11-03");
  assert.ok(paymentFingerprint(mon) && paymentFingerprint(tue));
  assert.notEqual(paymentFingerprint(mon), paymentFingerprint(tue), "the day is part of the identity");
  assert.equal(consumeFingerprintCheck({ poolKey: "tue", record: tue, siblings: [["mon", mon], ["tue", tue]] }).ok, true);
  assert.equal(manualTwinSettleCheck({ poolKey: "tue", record: tue, siblings: [["mon", mon], ["tue", tue]] }).ok, true);
  assert.equal(approvedTwinSettleCheck({ poolKey: "tue", record: tue, siblings: [["mon", mon], ["tue", tue]] }).ok, true);
  // The same day, payer, account, amount and reference: one payment, used once.
  const monAgain = rec("2026-11-02");
  assert.equal(paymentFingerprint(monAgain), paymentFingerprint(mon));
  assert.equal(consumeFingerprintCheck({ poolKey: "again", record: monAgain, siblings: [["mon", mon], ["again", monAgain]] }).code, "duplicate-used");
});

// ─── THE ANTI-REUSE BLOCK BETWEEN A HAND ENTRY AND ITS OWN BANK NOTICE STAYS ─
test("a manual entry and the bank notice of the SAME money (same day) are still one payment, paid out once", () => {
  const mKey = manualEntryKeyOf("ME-same-0001");
  // Junid types it at 10:00; the bank's notice lands at 10:20 the same day.
  const typed = manual({ entryId: "ME-same-0001", typed: "2026-11-07T10:00:00", reference: "Soccer T shirt", status: "used", slip: "S-77" });
  const notice = absa({ txn: "80CCCCCCC3-3", arrived: "2026-11-07T10:20:00" });
  const t = manualTwinSettleCheck({ poolKey: "n", record: notice, siblings: [[mKey, typed], ["n", notice]] });
  assert.equal(t.ok, false);
  assert.equal(t.code, "twin-used");
  assert.match(t.message, /slip S-77/);
  // The reverse: the notice was used, the hand entry cannot be.
  const noticeUsed = { ...notice, status: "used", used: { at: 1, sale: { receiptNumber: "S-78" } } };
  const typedWaiting = manual({ entryId: "ME-same-0001", typed: "2026-11-07T10:00:00", reference: "Soccer T shirt" });
  assert.equal(manualTwinSettleCheck({ poolKey: mKey, record: typedWaiting, siblings: [[mKey, typedWaiting], ["n", noticeUsed]] }).code, "twin-used");
  // A bank payment made the same day BEFORE the entry was typed is the same money too.
  const earlierSameDay = absa({ txn: "80DDDDDDD4-4", arrived: "2026-11-07T08:00:00" });
  assert.equal(isPaymentTwin(earlierSameDay, typed), true);
});

test("a late notice across midnight (within 24 h after the entry) is still the entry's twin; two days later it is not", () => {
  const typed = manual({ entryId: "ME-late-0001", typed: "2026-11-07T23:50:00", status: "used", slip: "S-80" });
  const late = { ...absa({ txn: "80EEEEEEE5-5", day: "2026-11-08", arrived: "2026-11-08T00:10:00" }), reference: "SOCCER T SHIRT" };
  assert.equal(isPaymentTwin(late, typed), true);
  const later = { ...absa({ txn: "80FFFFFFF6-6", day: "2026-11-09", arrived: "2026-11-09T09:00:00" }), reference: "SOCCER T SHIRT" };
  assert.equal(isPaymentTwin(later, typed), false);
});

test("the same money typed twice the SAME day is still refused; the bank's notice already waiting today still redirects", () => {
  const firstKey = manualEntryKeyOf("ME-twice-001");
  const first = manual({ entryId: "ME-twice-001", typed: "2026-11-07T10:00:00" });
  const again = manualDuplicateOf({ reference: "soccer t-shirt", amountCents: 87000, entryId: "ME-twice-002", at: sast("2026-11-07T16:00:00") }, [[firstKey, first]]);
  assert.equal(again?.key, firstKey);
  // The bank's own notice of today's payment is waiting: use that one.
  const waiting = absa({ txn: "80GGGGGGG7-7", arrived: "2026-11-07T09:45:00", reference: "Soccer T shirt" });
  assert.equal(bankTwinOfEntry({ reference: "SOCCER T SHIRT", amountCents: 87000, at: sast("2026-11-07T11:57:00") }, [["w", waiting]])?.key, "w");
  // …but last week's unused payment with the same reference is somebody's other payment.
  const lastWeek = absa({ txn: "80HHHHHHH8-8", day: "2026-10-31", arrived: "2026-10-31T09:00:00", reference: "Soccer T shirt" });
  assert.equal(bankTwinOfEntry({ reference: "SOCCER T SHIRT", amountCents: 87000, at: sast("2026-11-07T11:57:00") }, [["lw", lastWeek]]), null);
});

// ─── APPROVED PROOFS: THE TRANSACTION ID DECIDES ─────────────────────────────
test("an approved proof blocks only its OWN payment: same txn id refused, a different txn id usable", () => {
  const approved = { ...absa({ txn: "80AAAAAAA1-1", status: "used", slip: "S-1" }), manualApproved: { by: "Junid", at: sast("2026-10-29T10:00:00") } };
  const sameTxn = absa({ txn: "80AAAAAAA1-1", arrived: "2026-11-07T09:45:00" });
  const otherTxn = absa({ txn: "80BBBBBBB2-2", arrived: "2026-11-07T09:45:00" });
  assert.equal(approvedTwinSettleCheck({ poolKey: "x", record: sameTxn, siblings: [["ap", approved], ["x", sameTxn]] }).code, "twin-used");
  assert.equal(approvedTwinSettleCheck({ poolKey: "y", record: otherTxn, siblings: [["ap", approved], ["y", otherTxn]] }).ok, true);
});

test("an approved proof with no txn id matches on the full identity: same day + payer + account; another day or payer is another payment", () => {
  const approved = { ...absa({ txn: null, day: "2026-11-07", status: "used", slip: "S-1" }), manualApproved: { by: "Junid", at: sast("2026-11-07T10:00:00") } };
  const notice = absa({ txn: "80AAAAAAA1-1", day: "2026-11-07", arrived: "2026-11-07T10:30:00" });
  assert.equal(approvedTwinSettleCheck({ poolKey: "n", record: notice, siblings: [["ap", approved]] }).code, "twin-used", "the notice printed the id the proof left blank");
  const nextDay = absa({ txn: "80AAAAAAA1-2", day: "2026-11-08", arrived: "2026-11-08T10:30:00" });
  assert.equal(approvedTwinSettleCheck({ poolKey: "d", record: nextDay, siblings: [["ap", approved]] }).ok, true);
  const otherPayer = absa({ txn: "80AAAAAAA1-3", day: "2026-11-07", payer: "MRS B OTHER" });
  assert.equal(approvedTwinSettleCheck({ poolKey: "p", record: otherPayer, siblings: [["ap", approved]] }).ok, true);
});

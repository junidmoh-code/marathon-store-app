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
  // A is used — and was even approved from its proof — B is still usable.
  const aUsed = { ...a, status: "used", used: { at: 1, sale: { receiptNumber: "S-1" } }, manualApproved: { by: "Junid", at: a.at } };
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
  // Monday's was used AND approved from its proof; Tuesday's is two days from
  // nothing that matches — the guards below all see a real candidate.
  const mon = { ...rec("2026-10-30", "used"), manualApproved: { by: "Junid", at: sast("2026-10-30T09:00:00") } };
  const tue = rec("2026-11-03");
  // (30 Oct vs 3 Nov: outside the approved-proof clearing window too.)
  assert.ok(paymentFingerprint(mon) && paymentFingerprint(tue));
  assert.notEqual(paymentFingerprint(mon), paymentFingerprint(tue), "the day is part of the identity");
  assert.equal(consumeFingerprintCheck({ poolKey: "tue", record: tue, siblings: [["mon", mon], ["tue", tue]] }).ok, true);
  const monTyped = { ...manual({ entryId: "ME-mon-00001", typed: "2026-10-30T09:30:00", reference: "Soccer T shirt", status: "used", slip: "S-2" }) };
  assert.equal(manualTwinSettleCheck({ poolKey: "tue", record: tue, siblings: [["mon", mon], ["mt", monTyped], ["tue", tue]] }).ok, true);
  assert.equal(approvedTwinSettleCheck({ poolKey: "tue", record: tue, siblings: [["mon", mon], ["tue", tue]] }).ok, true);
  // The same day, payer, account, amount and reference: one payment, used once.
  const monAgain = rec("2026-10-30");
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

test("a payment the bank dates just after the typing (clock skew) is still the twin; a payment made the next day is not", () => {
  const typed = manual({ entryId: "ME-late-0001", typed: "2026-11-07T23:50:00", status: "used", slip: "S-80" });
  const skew = { ...absa({ txn: "80EEEEEEE5-5", day: "2026-11-08", arrived: "2026-11-08T00:10:00" }), reference: "SOCCER T SHIRT" };
  assert.equal(isPaymentTwin(skew, typed), true, "dated 00:00, ten minutes after the 23:50 entry");
  const later = { ...absa({ txn: "80FFFFFFF6-6", day: "2026-11-09", arrived: "2026-11-09T09:00:00" }), reference: "SOCCER T SHIRT" };
  assert.equal(isPaymentTwin(later, typed), false);
});

// ─── FABLE SPEC REVIEW: THE DOUBLE-PAY WINDOWS STAY SHUT ─────────────────────
test("a Saturday payment typed by hand on Monday and its notice landing Tuesday are ONE payment", () => {
  const mKey = manualEntryKeyOf("ME-wknd-0001");
  const typed = manual({ entryId: "ME-wknd-0001", typed: "2026-11-09T09:00:00", reference: "Soccer T shirt", status: "used", slip: "S-95" });
  const notice = absa({ txn: "80LLLLLLL2-2", day: "2026-11-07", arrived: "2026-11-10T10:00:00" });
  const t = manualTwinSettleCheck({ poolKey: "n", record: notice, siblings: [[mKey, typed], ["n", notice]] });
  assert.equal(t.code, "twin-used");
  assert.equal(searchEftPool({ [mKey]: typed, n: notice }, "soccer t shirt").results.find((r) => r.key === "n").sameUsed.receiptNumber, "S-95");
});

test("a repeat customer's next-day payment is NOT blocked by yesterday's hand entry", () => {
  const typed = manual({ entryId: "ME-rept-0001", typed: "2026-11-09T15:00:00", reference: "Soccer T shirt", status: "used", slip: "S-96" });
  const tuesday = absa({ txn: "80MMMMMMM3-3", day: "2026-11-10", arrived: "2026-11-10T10:00:00" });
  assert.equal(isPaymentTwin(tuesday, typed), false);
});

test("Friday's unused notice still redirects a Monday hand entry of the same money (entry time)", () => {
  const friday = absa({ txn: "80NNNNNNN4-4", day: "2026-11-06", arrived: "2026-11-06T16:00:00", reference: "Soccer T shirt" });
  assert.equal(bankTwinOfEntry({ reference: "SOCCER T SHIRT", amountCents: 87000, at: sast("2026-11-09T09:00:00") }, [["f", friday]])?.key, "f");
});

test("the same money typed twice the SAME day is still refused; the bank's notice already waiting today still redirects", () => {
  const firstKey = manualEntryKeyOf("ME-twice-001");
  const first = manual({ entryId: "ME-twice-001", typed: "2026-11-07T10:00:00" });
  const again = manualDuplicateOf({ reference: "soccer t-shirt", amountCents: 87000, entryId: "ME-twice-002", at: sast("2026-11-07T16:00:00") }, [[firstKey, first]]);
  assert.equal(again?.key, firstKey);
  // The bank's own notice of today's payment is waiting: use that one.
  const waiting = absa({ txn: "80GGGGGGG7-7", arrived: "2026-11-07T09:45:00", reference: "Soccer T shirt" });
  assert.equal(bankTwinOfEntry({ reference: "SOCCER T SHIRT", amountCents: 87000, at: sast("2026-11-07T11:57:00") }, [["w", waiting]])?.key, "w");
  // …but an unused payment from more than a week ago with the same reference is somebody's other payment.
  const lastWeek = absa({ txn: "80HHHHHHH8-8", day: "2026-10-29", arrived: "2026-10-29T09:00:00", reference: "Soccer T shirt" });
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

test("an approved proof with no txn id matches on the full identity: day (−1..+3) + payer + account; further apart or another payer is another payment", () => {
  const approved = { ...absa({ txn: null, day: "2026-11-07", status: "used", slip: "S-1" }), manualApproved: { by: "Junid", at: sast("2026-11-07T10:00:00") } };
  const notice = absa({ txn: "80AAAAAAA1-1", day: "2026-11-07", arrived: "2026-11-07T10:30:00" });
  assert.equal(approvedTwinSettleCheck({ poolKey: "n", record: notice, siblings: [["ap", approved]] }).code, "twin-used", "the notice printed the id the proof left blank");
  // One document prints the transaction date, the other the processing date.
  const nextDay = absa({ txn: "80AAAAAAA1-2", day: "2026-11-08", arrived: "2026-11-08T10:30:00" });
  assert.equal(approvedTwinSettleCheck({ poolKey: "d", record: nextDay, siblings: [["ap", approved]] }).code, "twin-used");
  const twoDays = absa({ txn: "80AAAAAAA1-4", day: "2026-11-11", arrived: "2026-11-11T10:30:00" });
  assert.equal(approvedTwinSettleCheck({ poolKey: "t", record: twoDays, siblings: [["ap", approved]] }).ok, true);
  // The same payer formatted differently is the same payer (architect review).
  const titled = absa({ txn: "80AAAAAAA1-5", day: "2026-11-07", payer: "A PAYER" });
  assert.equal(approvedTwinSettleCheck({ poolKey: "f", record: titled, siblings: [["ap", approved]] }).code, "twin-used");
  const otherPayer = absa({ txn: "80AAAAAAA1-3", day: "2026-11-07", payer: "MRS B OTHER" });
  assert.equal(approvedTwinSettleCheck({ poolKey: "p", record: otherPayer, siblings: [["ap", approved]] }).ok, true);
});

// ─── ARCHITECT REVIEW (Sonnet) ───────────────────────────────────────────────
test("a hand entry of money already approved from its proof is refused: MANUAL-… is not a bank id", () => {
  const approved = { ...absa({ txn: "80AAAAAAA1-1", day: "2026-11-07", status: "used", slip: "S-1" }), reference: "SOCCER T SHIRT", manualApproved: { by: "Junid", at: sast("2026-11-07T10:00:00") } };
  const typed = manual({ entryId: "ME-appr-0001", typed: "2026-11-07T11:00:00" });
  const key = manualEntryKeyOf("ME-appr-0001");
  assert.match(typed.bankRef, /^MANUAL-/);
  assert.equal(approvedTwinSettleCheck({ poolKey: key, record: typed, siblings: [["ap", approved], [key, typed]] }).code, "twin-used");
  // …but a hand entry four days later is not that approval's money.
  const later = manual({ entryId: "ME-appr-0002", typed: "2026-11-11T11:00:00" });
  assert.equal(approvedTwinSettleCheck({ poolKey: "l", record: later, siblings: [["ap", approved]] }).ok, true);
});

test("the same money typed at 23:55 and again at 00:05 is still a duplicate (12-hour rolling window)", () => {
  const firstKey = manualEntryKeyOf("ME-midn-0001");
  const first = manual({ entryId: "ME-midn-0001", typed: "2026-11-07T23:55:00" });
  assert.equal(manualDuplicateOf({ reference: "SOCCER T SHIRT", amountCents: 87000, entryId: "ME-midn-0002", at: sast("2026-11-08T00:05:00") }, [[firstKey, first]])?.key, firstKey);
  // The next day's payment, typed more than 12 hours later, is a new payment.
  assert.equal(manualDuplicateOf({ reference: "SOCCER T SHIRT", amountCents: 87000, entryId: "ME-midn-0003", at: sast("2026-11-08T14:00:00") }, [[firstKey, first]]), null);
});

test("a notice with no bank date that lands after the entry is still its twin (pre-fix-8 records)", () => {
  const typed = manual({ entryId: "ME-nots-0001", typed: "2026-11-07T10:00:00", status: "used", slip: "S-90" });
  const undated = { ...absa({ txn: "80IIIIIII9-9", arrived: "2026-11-09T10:00:00" }), reference: "SOCCER T SHIRT", bankTs: null };
  assert.equal(isPaymentTwin(undated, typed), true);
});

// ─── SUBSTITUTE LINE REVIEW (CodeRabbit spending cap) ────────────────────────
test("the bank-clock tolerance ends at one hour after the typing", () => {
  const typed = manual({ entryId: "ME-edge-0001", typed: "2026-11-07T10:00:00", status: "used", slip: "S-91" });
  const at = (ms) => ({ ...absa({ txn: "80JJJJJJJ0-0", arrived: "2026-11-07T12:00:00" }), reference: "SOCCER T SHIRT", bankTs: typed.manualEntry.at + ms });
  // Same day either way, so the clock rule is what decides here.
  assert.equal(isPaymentTwin(at(60 * 60 * 1000), typed), true);
  assert.equal(isPaymentTwin(at(60 * 60 * 1000 + 1), typed), false);
});

test("an approved proof and a notice from DIFFERENT readers with different ids fall back to the identity", () => {
  const approved = { ...absa({ txn: "PROOF-0001", day: "2026-11-07", status: "used", slip: "S-1" }), reader: "capitec", manualApproved: { by: "Junid", at: sast("2026-11-07T10:00:00") } };
  const notice = absa({ txn: "80KKKKKKK1-1", day: "2026-11-07" });
  assert.equal(approvedTwinSettleCheck({ poolKey: "n", record: notice, siblings: [["ap", approved]] }).code, "twin-used");
  // A Monday clearing date for a Friday proof (weekend) is the same money; five days later is not.
  const monday = absa({ txn: "80KKKKKKK1-2", day: "2026-11-10" });
  assert.equal(approvedTwinSettleCheck({ poolKey: "m", record: monday, siblings: [["ap", approved]] }).code, "twin-used");
  const later = absa({ txn: "80KKKKKKK1-3", day: "2026-11-12" });
  assert.equal(approvedTwinSettleCheck({ poolKey: "l", record: later, siblings: [["ap", approved]] }).ok, true);
});

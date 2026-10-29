// ─── ABSA WITHOUT A TRANSACTION NUMBER — synthetic identity + collision rule ─
// Junid, 29 Oct 2026. THE FIXTURE IS THE REAL R1,900 PAYMENT of 2026-10-27
// (ibreply@absa.co.za, DKIM pass for absa.co.za): the exact lines pdfText.js
// extracted from its PDF, SANITISED for a public repo (the payer's name, the
// reference, the destination account, the branch code and the phone numbers),
// structure verbatim — INCLUDING the bare "Transaction number:" label with
// nothing after it and the next label on the following line, and the
// space-grouped amount "1 900.00". The 28 and 29 Oct notices (R1,000 and
// R610, same payer, same reference) print the same way.
//
// What is pinned:
//   · the Absa reader reads every field and invents NO transaction id;
//   · the pool gives such a notice a synthetic identity (payer + account +
//     day + amount + reference) and confirms it ONCE, with the date-phased
//     immediate rule applied unchanged;
//   · a second notice with the SAME identity is held-possible-duplicate —
//     never auto-confirmed, never auto-floated — and the owner can release
//     it, after which it is spendable once on an identity of its own;
//   · two notices differing in amount or day are two payments;
//   · a notice for money Junid already approved by hand from its proof
//     (eftPoolManualApprove) is held as the bank's copy — for Absa's synthetic
//     identity AND for a transaction-id bank — and never re-floats.
import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
import { EFT_READERS, selectReader, selectReaderByContent } from "./eftBanks.mjs";
import {
  eftPoolRecord, destinationVerdict, immediacyVerdict, paymentDateVerdict, parsePaymentDateCutoff,
  applyFingerprintHold, refusalFingerprint, applyRefusalFingerprint, syntheticIdentityOf, paymentFingerprint,
  fingerprintClaimStep, HELD_OUTCOMES, eftRetryPlan, sastDate,
} from "./eftCore.mjs";
import { eftVerdict, failedCheck } from "./verdictMailCore.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { releaseHoldDecision, settleDecision } = require("./lib/eft-settle.cjs");
const { consumeFingerprintCheck, claimHolderCheck, absaSyntheticRef, isSyntheticIdentity } = require("./lib/eft-fingerprint.cjs");
const banksCjs = require("./lib/eft-banks.cjs");

const REAL_ABSA_NO_TXN_LINES = [
  "27 October 2026",
  "Notice of Payment",
  "Dear Marathon Club",
  "Subject: Notice Of Payment: Marathon Club",
  "Please be advised that MRS S SOAP made a payment to your account as indicated below.",
  "Transaction number:",
  "Payment date:",
  "2026-10-27",
  "Payment made by: MRS S SOAP",
  "Payment made to:",
  "Marathon Club",
  "Beneficiary bank name: FIRST NATIONAL BANK",
  "Beneficiary account number: 62900004321",
  "Bank branch code: 250655",
  "For the amount of: 1 900.00",
  "Immediate payment:",
  "Y",
  "Reference on beneficiary statement: zanele",
  "View your account to confirm that you have received this payment as the following applies to online banking",
  "payments into non-ABSA and Absa Vehicle and Asset Finance bank accounts.",
  "• Payments made on weekdays before 15:30 will be credited to the receiving bank account by midnight of the same day.",
  "• Payments made on weekdays after 15:30 will be credited by midnight of the following day.",
  "If you have made an incorrect internet banking payment, please send an email to digital@absa.co.za",
  "Yours sincerely",
  "General Manager: Digital Channels",
  "Absa Bank Limited Reg No 1986/000000/06 Authorised Financial Services and Registered Credit Provider Reg No NCRCP7 Company Information: www.absa.co.za",
];

const absa = EFT_READERS.find((r) => r.id === "absa");
const VERDICT = { pass: true, fromDomain: "absa.co.za", dkimDomain: "absa.co.za", detail: "dkim=pass" };
const CUTOFF = parsePaymentDateCutoff("2026-10-20");
const ALLOWED = ["62900004321"];
// 27 Oct 2026 12:00 SAST — the notification's arrival, after the bank date.
const ARRIVED = Date.UTC(2026, 9, 27, 10, 0, 0);

/** The poller's whole decision for one message, as data. */
function poolRecord(lines, { receivedAt = ARRIVED, messageId = "<m1@absa>" } = {}) {
  const parsed = absa.parse(lines);
  const message = { messageId, from: "ibreply@absa.co.za", subject: "Notice of payment: Marathon Club", receivedAt };
  const account = parsed.ok ? destinationVerdict({ accountMask: parsed.accountMask, destBankName: parsed.destBankName, allowedAccounts: ALLOWED, configured: true }) : null;
  const timing = parsed.ok ? immediacyVerdict({ parsed, reader: "absa", receivedAt }) : null;
  const dated = parsed.ok ? paymentDateVerdict({ parsed, cutoff: CUTOFF }) : null;
  return eftPoolRecord({ message, verdict: VERDICT, parsed, account, timing, dated, reader: "absa", rawText: lines.join("\n"), at: receivedAt + 1000 });
}

/** The claim as the poller runs it: an in-memory /eft_pool_fingerprints. */
function claimer() {
  const node = {};
  return {
    node,
    claim(fingerprint, poolKey, at = 1) {
      let seen = null;
      const step = fingerprintClaimStep(poolKey, at, (d) => { seen = d; });
      const out = step(node[fingerprint] ?? null);
      if (out !== undefined && node[fingerprint] == null) node[fingerprint] = out;
      return seen;
    },
  };
}
const KEY_A = "a".repeat(40), KEY_B = "b".repeat(40), KEY_C = "c".repeat(40), KEY_APPROVED = "d".repeat(40);

describe("the Absa reader on a notice with a BLANK transaction number (real R1,900 of 27 Oct 2026)", () => {
  it("is claimed by the Absa reader, by content, and by nobody else", () => {
    expect(selectReader({ fromDomain: "ibreply.absa.co.za", lines: REAL_ABSA_NO_TXN_LINES })?.id).toBe("absa");
    expect(selectReaderByContent(REAL_ABSA_NO_TXN_LINES)?.id).toBe("absa");
    for (const other of EFT_READERS.filter((r) => r.id !== "absa")) expect(other.detect(REAL_ABSA_NO_TXN_LINES), other.id).toBe(false);
    expect(selectReaderByContent(["Dear customer", "nothing here"])).toBe(null);
  });

  it("the ESM module and the CommonJS module are ONE set of readers", () => {
    expect(EFT_READERS).toBe(banksCjs.EFT_READERS);
    expect(selectReaderByContent).toBe(banksCjs.selectReaderByContent);
  });

  it("reads the fields Junid listed, invents no transaction id, and reads the space-grouped amount exactly", () => {
    const p = absa.parse(REAL_ABSA_NO_TXN_LINES);
    expect(p).toMatchObject({
      ok: true,
      amountCents: 190000,            // "1 900.00"
      bankRef: null,                  // "Transaction number:" is blank — NOT the next label's text
      payer: "MRS S SOAP",            // Payment made by
      beneficiaryName: "Marathon Club", // Payment made to
      accountMask: "62900004321",     // Beneficiary account number
      destBankName: "FIRST NATIONAL BANK",
      reference: "zanele",            // Reference on beneficiary statement
      paymentType: "Y",
      immediate: true,                // Immediate payment: Y
    });
    expect(sastDate(p.bankTs)).toBe("2026-10-27"); // Payment date: day only
    expect(new Date(p.bankTs).toISOString()).toBe("2026-10-26T22:00:00.000Z"); // start of that SAST day
  });

  it("a notice that prints a transaction number keeps the bank's id — the synthetic identity is only the fallback", () => {
    const withId = REAL_ABSA_NO_TXN_LINES.map((l) => (l === "Transaction number:" ? "Transaction number: 80D2F2AB5A-9" : l));
    const p = absa.parse(withId);
    expect(p.bankRef).toBe("80D2F2AB5A-9");
    expect(syntheticIdentityOf(p, "absa")).toBe(null);
    expect(paymentFingerprint({ reader: "absa", bankRef: p.bankRef })).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("the synthetic identity: payer + account + day + amount + reference", () => {
  it("is built from the parse and carried on the recorded payment, which then has a fingerprint", () => {
    const r = poolRecord(REAL_ABSA_NO_TXN_LINES);
    expect(r.outcome).toBe("recorded");
    expect(r.status).toBe("unmatched");
    expect(r.bankRef).toBe(null);
    expect(r.syntheticRef).toBe("ABSA|MRSSSOAP|4321|2026-10-27|190000|ZANELE");
    expect(isSyntheticIdentity(r)).toBe(true);
    expect(paymentFingerprint(r)).toMatch(/^[0-9a-f]{40}$/);
    expect(paymentFingerprint(r)).toBe(paymentFingerprint({ reader: "absa", bankRef: null, syntheticRef: r.syntheticRef }));
  });

  it("is Absa-only: another reader's id-less document stays held-no-bankref", () => {
    const p = absa.parse(REAL_ABSA_NO_TXN_LINES);
    expect(syntheticIdentityOf(p, "capitec")).toBe(null);
    expect(syntheticIdentityOf({ ...p, ok: false }, "absa")).toBe(null);
  });

  it("fails closed without a payer, a day, an amount or an account", () => {
    const base = { payer: "MRS S SOAP", accountMask: "62900004321", bankTs: ARRIVED, amountCents: 190000, reference: "zanele" };
    expect(absaSyntheticRef(base)).toBe("ABSA|MRSSSOAP|4321|2026-10-27|190000|ZANELE");
    expect(absaSyntheticRef({ ...base, payer: null })).toBe(null);
    expect(absaSyntheticRef({ ...base, bankTs: null })).toBe(null);
    expect(absaSyntheticRef({ ...base, amountCents: 0 })).toBe(null);
    expect(absaSyntheticRef({ ...base, accountMask: "XX" })).toBe(null);
    expect(absaSyntheticRef({ ...base, reference: null })).toBe("ABSA|MRSSSOAP|4321|2026-10-27|190000|", "an empty reference is still one payment");
  });

  it("the date-phased immediate rule is applied unchanged: 27 Oct+ confirms whatever the flag; 20–26 Oct needs Y", () => {
    const notImmediate = REAL_ABSA_NO_TXN_LINES.map((l, i, a) => (a[i - 1] === "Immediate payment:" ? "N" : l));
    expect(poolRecord(notImmediate).outcome).toBe("recorded"); // bank date 2026-10-27: immediacy no longer required
    const earlier = (lines) => lines.map((l) => (l === "2026-10-27" ? "2026-10-25" : l));
    expect(poolRecord(earlier(REAL_ABSA_NO_TXN_LINES)).outcome).toBe("recorded"); // 25 Oct, Y: confirmed
    const refused = poolRecord(earlier(notImmediate));
    expect(refused.outcome).toBe("refused-not-immediate"); // 25 Oct, N: refused
    // …and the refusal claims the synthetic identity too, so a copy resent
    // later is held, never fresh.
    expect(refused.syntheticRef).toBe("ABSA|MRSSSOAP|4321|2026-10-25|190000|ZANELE");
    expect(refusalFingerprint(refused)).toMatch(/^[0-9a-f]{40}$/);
    const stale = poolRecord(REAL_ABSA_NO_TXN_LINES.map((l) => (l === "2026-10-27" ? "2026-10-10" : l)));
    expect(stale.outcome).toBe("refused-stale-date");
    expect(refusalFingerprint(stale)).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("the collision rule: first confirms, a second identical notice is held for the owner", () => {
  it("the FIRST notice is confirmed live with its fingerprint; the SECOND is held-possible-duplicate, never auto-floated", () => {
    const c = claimer();
    const first = poolRecord(REAL_ABSA_NO_TXN_LINES, { messageId: "<first@absa>" });
    const fp = paymentFingerprint(first);
    const a = applyFingerprintHold(first, { fingerprint: fp, poolKey: KEY_A, ...c.claim(fp, KEY_A) });
    expect(a).toMatchObject({ outcome: "recorded", status: "unmatched", fingerprint: fp });

    const second = poolRecord(REAL_ABSA_NO_TXN_LINES, { messageId: "<second@absa>", receivedAt: ARRIVED + 3600_000 });
    expect(paymentFingerprint(second)).toBe(fp);
    const b = applyFingerprintHold(second, { fingerprint: fp, poolKey: KEY_B, ...c.claim(fp, KEY_B) });
    expect(b.outcome).toBe("held-possible-duplicate");
    expect(b.status).toBe(undefined);
    expect(b.duplicateOf).toBe(KEY_A);
    expect(b.fingerprint).toBe(fp);
    expect(b.reason).toMatch(/possible|cannot be told apart|owner can release/i);
    expect(HELD_OUTCOMES).toContain("held-possible-duplicate");
    // Held means held everywhere: the retry script refuses it, the verdict
    // mail reports it REJECTED under its own label, the settle refuses it.
    expect(eftRetryPlan({ poolKey: KEY_B, record: b, seenRow: { state: "done" }, at: 1 }).ok).toBe(false);
    expect(eftVerdict(b)).toBe("REJECTED");
    expect(failedCheck(b)).toMatch(/Possible duplicate/);
    expect(settleDecision(b, { attemptId: "x", cashierUid: "u", cashierName: "n", appliedCents: 190000, at: 1 }).code).toBe("not-a-payment");
    // A third copy is held against the first again.
    const third = poolRecord(REAL_ABSA_NO_TXN_LINES, { messageId: "<third@absa>" });
    const t = applyFingerprintHold(third, { fingerprint: fp, poolKey: KEY_C, ...c.claim(fp, KEY_C) });
    expect(t).toMatchObject({ outcome: "held-possible-duplicate", duplicateOf: KEY_A });
  });

  it("a transaction-id bank's second copy is still held-duplicate (final), not a possible duplicate", () => {
    const c = claimer();
    const withId = REAL_ABSA_NO_TXN_LINES.map((l) => (l === "Transaction number:" ? "Transaction number: 80D2F2AB5A-9" : l));
    const first = poolRecord(withId, { messageId: "<a@absa>" }), second = poolRecord(withId, { messageId: "<b@absa>" });
    const fp = paymentFingerprint(first);
    expect(applyFingerprintHold(first, { fingerprint: fp, poolKey: KEY_A, ...c.claim(fp, KEY_A) }).outcome).toBe("recorded");
    const b = applyFingerprintHold(second, { fingerprint: fp, poolKey: KEY_B, ...c.claim(fp, KEY_B) });
    expect(b).toMatchObject({ outcome: "held-duplicate", duplicateOf: KEY_A });
    expect(releaseHoldDecision(b, { at: 5, by: "owner", reason: "checked" }).code).toBe("duplicate-never-released");
  });

  it("two notices differing only in AMOUNT, or only in DAY, are two payments — both confirm", () => {
    const c = claimer();
    const a = poolRecord(REAL_ABSA_NO_TXN_LINES, { messageId: "<a@absa>" });
    const otherAmount = poolRecord(REAL_ABSA_NO_TXN_LINES.map((l) => (l.startsWith("For the amount of:") ? "For the amount of: 1 000.00" : l)), { messageId: "<b@absa>" });
    const otherDay = poolRecord(REAL_ABSA_NO_TXN_LINES.map((l) => (l === "2026-10-27" ? "2026-10-28" : l)), { messageId: "<c@absa>", receivedAt: ARRIVED + 86400_000 });
    expect(otherAmount.syntheticRef).toBe("ABSA|MRSSSOAP|4321|2026-10-27|100000|ZANELE");
    expect(otherDay.syntheticRef).toBe("ABSA|MRSSSOAP|4321|2026-10-28|190000|ZANELE");
    const fps = [a, otherAmount, otherDay].map(paymentFingerprint);
    expect(new Set(fps).size).toBe(3);
    const out = [[a, KEY_A], [otherAmount, KEY_B], [otherDay, KEY_C]].map(([r, k]) =>
      applyFingerprintHold(r, { fingerprint: paymentFingerprint(r), poolKey: k, ...c.claim(paymentFingerprint(r), k) }));
    expect(out.map((r) => r.outcome)).toEqual(["recorded", "recorded", "recorded"]);
  });

  it("a different payer or reference is a different payment too", () => {
    const a = poolRecord(REAL_ABSA_NO_TXN_LINES);
    const payer = poolRecord(REAL_ABSA_NO_TXN_LINES.map((l) => l.replace("MRS S SOAP", "MR T BLOGGS")));
    const ref = poolRecord(REAL_ABSA_NO_TXN_LINES.map((l) => (l.startsWith("Reference on beneficiary statement:") ? "Reference on beneficiary statement: zanele 2" : l)));
    expect(new Set([a, payer, ref].map(paymentFingerprint)).size).toBe(3);
  });
});

describe("the owner releases a possible duplicate — a genuine second payment floated by hand", () => {
  function heldSecond() {
    const c = claimer();
    const first = poolRecord(REAL_ABSA_NO_TXN_LINES, { messageId: "<first@absa>" });
    const fp = paymentFingerprint(first);
    const a = applyFingerprintHold(first, { fingerprint: fp, poolKey: KEY_A, ...c.claim(fp, KEY_A) });
    const second = poolRecord(REAL_ABSA_NO_TXN_LINES, { messageId: "<second@absa>" });
    const b = applyFingerprintHold(second, { fingerprint: fp, poolKey: KEY_B, ...c.claim(fp, KEY_B) });
    return { c, a, b, fp };
  }

  it("release makes it a recorded, unmatched payment with an identity of its OWN; the first keeps the base identity", () => {
    const { a, b, fp } = heldSecond();
    const rel = releaseHoldDecision(b, { at: 7_000, by: "gunidmoh@gmail.com", reason: "two R1,900 credits on the 27 Oct statement" });
    expect(rel.ok).toBe(true);
    const r = rel.value;
    expect(r).toMatchObject({ outcome: "recorded", status: "unmatched", duplicateOf: KEY_A, heldFingerprint: fp });
    expect(r.releasedFromHold).toMatchObject({ at: 7_000, from: "held-possible-duplicate", reason: "two R1,900 credits on the 27 Oct statement" });
    expect(r.syntheticRef).toBe("ABSA|MRSSSOAP|4321|2026-10-27|190000|ZANELE|RELEASED:7000");
    expect(paymentFingerprint(r)).not.toBe(fp);
    expect(r.fingerprint).toBe(paymentFingerprint(r));
    expect(paymentFingerprint(a)).toBe(fp);
    // Spendable once, like any payment: the consume check sees no used copy
    // of ITS fingerprint even when the first was spent, and the claim on its
    // fresh fingerprint names it.
    const firstUsed = { ...a, status: "used", used: { at: 1 } };
    const check = consumeFingerprintCheck({ poolKey: KEY_B, record: r, siblings: [[KEY_A, firstUsed]] });
    expect(check).toEqual({ ok: true, fingerprint: paymentFingerprint(r) });
    const c2 = claimer();
    const claim = c2.claim(check.fingerprint, KEY_B);
    expect(claimHolderCheck({ poolKey: KEY_B, holder: claim.holder, spentBy: claim.spentBy }).ok).toBe(true);
    const settled = settleDecision(r, { attemptId: "t1", at: 8_000, cashierUid: "u", cashierName: "Ahmed", appliedCents: 190000, fingerprint: check.fingerprint, customerId: null, wholePaymentMatched: true });
    expect(settled.ok).toBe(true);
    expect(settled.value.status).toBe("used");
  });

  it("an UNRELEASED possible duplicate cannot be settled, and the base identity still belongs to the first", () => {
    const { a, b, fp } = heldSecond();
    expect(settleDecision(b, { attemptId: "t", at: 1, cashierUid: "u", cashierName: "n", appliedCents: 190000, fingerprint: fp }).code).toBe("not-a-payment");
    const c = claimer();
    c.claim(fp, KEY_A);
    const claim = c.claim(fp, KEY_B);
    expect(claimHolderCheck({ poolKey: KEY_B, holder: claim.holder, spentBy: claim.spentBy }).code).toBe("duplicate");
    expect(consumeFingerprintCheck({ poolKey: KEY_A, record: a, siblings: [[KEY_B, b]] }).ok).toBe(true);
  });

  it("the no-bankref release and the legacy release are unchanged", () => {
    const idless = { ...poolRecord(REAL_ABSA_NO_TXN_LINES), syntheticRef: null };
    const held = applyFingerprintHold(idless, { fingerprint: null, holder: null, poolKey: KEY_A });
    expect(held.outcome).toBe("held-no-bankref");
    const rel = releaseHoldDecision(held, { at: 1, by: "o", reason: "checked" });
    expect(rel.value).toMatchObject({ outcome: "recorded", status: "unmatched", releasedFromHold: { from: "held-no-bankref" } });
    expect(rel.value.syntheticRef).toBe(null);
    expect(paymentFingerprint(rel.value)).toBe(null);
  });
});

describe("money Junid already approved by hand from its proof (eftPoolManualApprove) — the bank's copy never re-floats", () => {
  const SB_LINES = [
    "Dear MARATHON CLUB", "Immediate Payment Confirmation",
    "We confirm that the following payment has been made into your account from J SOAP:",
    "Reference number 4149999999", "Beneficiary name ATUGAR TRADING", "Bank name FIRST NATIONAL BANK",
    "Beneficiary account number XXXXXXXXXXXX4321", "Beneficiary branch number 25065500",
    "Beneficiary reference OM82", "Amount R100.00", "Payment date and time 2026-10-27 09h48",
  ];
  const sb = EFT_READERS.find((r) => r.id === "standardbank");

  function approvedClaim(fp) {
    // What eftPoolManualApprove writes: the claim names the approval record
    // as holder AND spender, flagged manualApproved.
    const node = { [fp]: { poolKey: KEY_APPROVED, at: 1, spentBy: KEY_APPROVED, manualApproved: true } };
    let seen = null;
    fingerprintClaimStep(KEY_B, 2, (d) => { seen = d; })(node[fp]);
    return seen;
  }

  it("an Absa notice (synthetic identity) arriving after the approval is held-duplicate naming the approval — never a possible duplicate the owner could float", () => {
    const r = poolRecord(REAL_ABSA_NO_TXN_LINES);
    const fp = paymentFingerprint(r);
    const claim = approvedClaim(fp);
    expect(claim).toEqual({ holder: KEY_APPROVED, spentBy: KEY_APPROVED, manualApproved: true });
    const held = applyFingerprintHold(r, { fingerprint: fp, poolKey: KEY_B, holder: claim.holder, manualApproved: claim.manualApproved });
    expect(held).toMatchObject({ outcome: "held-duplicate", duplicateOf: KEY_APPROVED, approvedByHand: KEY_APPROVED });
    expect(held.status).toBe(undefined);
    expect(held.reason).toMatch(/approved by hand/);
    expect(releaseHoldDecision(held, { at: 9, by: "o", reason: "try" }).code).toBe("duplicate-never-released");
    expect(eftVerdict(held)).toBe("REJECTED");
  });

  it("a transaction-id bank's notice (Standard Bank) arriving after the approval is held the same way", () => {
    const parsed = sb.parse(SB_LINES);
    expect(parsed.ok).toBe(true);
    const message = { messageId: "<sb@sb>", from: "x@standardbank.co.za", subject: "Payment confirmation", receivedAt: ARRIVED };
    const rec = eftPoolRecord({
      message, verdict: { ...VERDICT, fromDomain: "standardbank.co.za", dkimDomain: "standardbank.co.za" }, parsed,
      account: destinationVerdict({ accountMask: parsed.accountMask, destBankName: parsed.destBankName, allowedAccounts: ALLOWED, configured: true }),
      timing: immediacyVerdict({ parsed, reader: "standardbank", receivedAt: ARRIVED }),
      dated: paymentDateVerdict({ parsed, cutoff: CUTOFF }), reader: "standardbank", rawText: SB_LINES.join("\n"), at: ARRIVED,
    });
    expect(rec.outcome).toBe("recorded");
    expect(rec.syntheticRef).toBe(null);
    const fp = paymentFingerprint(rec);
    expect(fp).toBe(paymentFingerprint({ reader: "standardbank", bankRef: "4149999999" }));
    const claim = approvedClaim(fp);
    const held = applyFingerprintHold(rec, { fingerprint: fp, poolKey: KEY_B, holder: claim.holder, manualApproved: claim.manualApproved });
    expect(held).toMatchObject({ outcome: "held-duplicate", duplicateOf: KEY_APPROVED, approvedByHand: KEY_APPROVED });
    // …and even if such a record were ever recorded, the settle's claim check
    // refuses it: the approval spent the money.
    expect(claimHolderCheck({ poolKey: KEY_B, holder: claim.holder, spentBy: claim.spentBy }).code).toBe("duplicate-used");
  });

  it("a REFUSED notice for approved money names the approval too, and stays refused", () => {
    const stale = poolRecord(REAL_ABSA_NO_TXN_LINES.map((l) => (l === "2026-10-27" ? "2026-10-10" : l)));
    const fp = refusalFingerprint(stale);
    const claim = approvedClaim(fp);
    const r = applyRefusalFingerprint(stale, { fingerprint: fp, holder: claim.holder, poolKey: KEY_B });
    expect(r).toMatchObject({ outcome: "refused-stale-date", fingerprint: fp, duplicateOf: KEY_APPROVED });
  });
});

describe("architect review (Sonnet, PR #810): the edges it found, pinned", () => {
  it("a very long payer or reference is clipped into the identity, and a released copy still fingerprints", () => {
    const long = REAL_ABSA_NO_TXN_LINES.map((l) => l
      .replace("MRS S SOAP", "MRS " + "S".repeat(120))
      .replace("Reference on beneficiary statement: zanele", "Reference on beneficiary statement: " + "z".repeat(120)));
    const r = poolRecord(long);
    expect(r.outcome).toBe("recorded");
    expect(r.syntheticRef.length).toBeLessThan(200);
    const fp = paymentFingerprint(r);
    expect(fp).toMatch(/^[0-9a-f]{40}$/);
    const c = claimer();
    c.claim(fp, KEY_A);
    const held = applyFingerprintHold(r, { fingerprint: fp, poolKey: KEY_B, ...c.claim(fp, KEY_B) });
    expect(held.outcome).toBe("held-possible-duplicate");
    const rel = releaseHoldDecision(held, { at: 1_793_000_000_000, by: "o", reason: "two on the statement" });
    expect(rel.ok).toBe(true);
    expect(rel.value.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    expect(rel.value.fingerprint).not.toBe(fp);
    // A re-keyed identity that could not fingerprint would be refused, never released id-less.
    const broken = { ...held, syntheticRef: "x".repeat(300) };
    expect(releaseHoldDecision(broken, { at: 1, by: "o", reason: "try" }).code).toBe("no-identity");
  });

  it("after the owner releases the second copy, a THIRD notice of the base identity is still held against the first — nothing releases itself", () => {
    const c = claimer();
    const first = poolRecord(REAL_ABSA_NO_TXN_LINES, { messageId: "<a@absa>" });
    const fp = paymentFingerprint(first);
    applyFingerprintHold(first, { fingerprint: fp, poolKey: KEY_A, ...c.claim(fp, KEY_A) });
    const second = applyFingerprintHold(poolRecord(REAL_ABSA_NO_TXN_LINES, { messageId: "<b@absa>" }), { fingerprint: fp, poolKey: KEY_B, ...c.claim(fp, KEY_B) });
    const released = releaseHoldDecision(second, { at: 5000, by: "o", reason: "two on the statement" }).value;
    c.claim(paymentFingerprint(released), KEY_B); // the settle claims its fresh fingerprint
    const third = applyFingerprintHold(poolRecord(REAL_ABSA_NO_TXN_LINES, { messageId: "<c@absa>" }), { fingerprint: fp, poolKey: KEY_C, ...c.claim(fp, KEY_C) });
    expect(third).toMatchObject({ outcome: "held-possible-duplicate", duplicateOf: KEY_A });
    // The released copy's own identity is claimed by it; a replay of the RELEASED record's fingerprint cannot come from a notice (notices carry the base identity).
    expect(c.node[paymentFingerprint(released)].poolKey).toBe(KEY_B);
  });

  it("the retry script's refusal for a possible duplicate says the owner releases it", () => {
    const c = claimer();
    const first = poolRecord(REAL_ABSA_NO_TXN_LINES, { messageId: "<a@absa>" });
    const fp = paymentFingerprint(first);
    c.claim(fp, KEY_A);
    const held = applyFingerprintHold(poolRecord(REAL_ABSA_NO_TXN_LINES, { messageId: "<b@absa>" }), { fingerprint: fp, poolKey: KEY_B, ...c.claim(fp, KEY_B) });
    expect(eftRetryPlan({ poolKey: KEY_B, record: held, seenRow: {}, at: 1 }).why).toMatch(/possible duplicate/);
  });
});

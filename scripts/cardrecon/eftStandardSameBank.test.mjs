// NOTE (8 Nov 2026): Concrete's Standard Bank account no longer has its tag
// enforced (eftConcreteNonImmediate.test.mjs). This file's chain passes the tag
// straight in, so it pins immediacyVerdict for an account whose tag IS enforced.
// ─── STANDARD BANK TO STANDARD BANK IS SAME-BANK, AND SAME-BANK IS IMMEDIATE ──
// Junid, 6 Nov 2026. The ATUGAR Standard Bank account takes immediate payments
// only (":standardbank:immediate"). A customer paid R400 into it from her own
// Standard Bank account and was refused: Standard Bank prints the "Immediate
// Payment Confirmation" heading only for its paid inter-bank real-time
// service, so a same-bank transfer — which settles at once — carries no
// heading at all. The notification comes from the PAYER's bank, so a
// DKIM-verified standardbank.co.za notice paying a Standard Bank account IS
// Standard-to-Standard: accepted like FNB-to-FNB. A payment into the account
// from any other bank still needs that bank's immediate signal.
//
// …and that R400 was floated BY HAND by Junid before this rule went live, so
// its notice must never float a second R400 (the second half of this file).
//
// Each case runs the poller's own chain (email-poller.mjs). The fixture is a
// sanitised copy of the real 6 Nov notice (payer, reference and every number
// replaced; the layout — no heading, the footer — exactly as received).
// Account numbers are stand-ins: this repo is public.
import { describe, it, expect } from "vitest";
import { selectReader } from "./eftBanks.mjs";
import {
  authenticationVerdict, destinationVerdict, immediacyVerdict, paymentDateVerdict, parsePaymentDateCutoff,
  parseAccountPolicies, eftPoolRecord, eftMessageKey, eftPaymentKey, groupEftPayments,
  paymentFingerprint, fingerprintClaimStep, applyFingerprintHold, refusalFingerprint, applyRefusalFingerprint,
  settledFingerprintPlan, settledClaimStep, settledByHandStep, eftRetryPlan,
} from "./eftCore.mjs";

const FNB = "62900004321";
const SB = "10100008534";
const POLICIES = parseAccountPolicies(`${FNB}, 62000009092, ${SB}:standardbank:immediate`);
const RECEIVED = Date.parse("2026-11-06T09:37:28Z");

// The real same-bank layout of 6 Nov 2026: NO heading line at all.
const SAME_BANK = ({ heading = null, bank = "STANDARD BANK", account = "XXXXXXXXXXXX8534", date = "2026-11-06 11h31", amount = "R400.00" } = {}) => [
  "Internet Banking",
  "Standard Bank Centre",
  "5 Simmonds Street, Johannesburg, 2001",
  "Website: www.standardbank.co.za",
  "Dear CONCRETE",
  ...(heading ? [heading] : []),
  "We confirm that the following payment has been made into your account from A CUSTOMER:",
  "Reference number 4200000008",
  "Beneficiary name CONCRETE",
  `Bank name ${bank}`,
  `Beneficiary account number ${account}`,
  "Beneficiary branch number 000826",
  "Beneficiary reference CUSTREF",
  `Amount ${amount}`,
  `Payment date and time ${date}`,
  "If you need more information or have any questions about this payment, please contact:",
  "A CUSTOMER",
  "Payments to Standard Bank accounts may take up to one business day to reflect.",
  "Payments to other banks may take up to three business days.",
  "Please check your account to confirm you have received this payment.",
  "The Internet Banking Team",
];
const capitec = ({ type, bank = "Standard Bank", account = SB } = {}) => [
  "Payment Notification", "Capitec Bank",
  "Please take note that A Customer made a payment to your account.",
  "Notification number 600001", "Payment date 06/11/2026 09:30",
  "Beneficiary name ATUGAR", `Bank name ${bank}`, `Account number ${account}`, "Branch 051001",
  `Payment type ${type}`, "Amount R300.00", "Payment reference CUSTREF",
];

const authFor = (domain, from, dkim = "pass") => authenticationVerdict({
  fromAddress: from,
  headerLines: [
    { key: "authentication-results", line: `Authentication-Results: mx.google.com;\r\n       dkim=${dkim} header.i=@${domain} header.s=s1 header.b=x;\r\n       spf=pass smtp.mailfrom=${domain};\r\n       dmarc=${dkim} (p=REJECT) header.from=${domain}` },
    { key: "from", line: `From: <${from}>` },
  ],
});

function decide(domain, from, lines, { receivedAt = RECEIVED, dkim = "pass" } = {}) {
  const reader = selectReader({ fromDomain: domain, lines });
  const parsed = reader.parse(lines);
  expect(parsed.ok, parsed.reason).toBe(true);
  const account = destinationVerdict({ accountMask: parsed.accountMask, destBankName: parsed.destBankName, allowedAccounts: POLICIES, configured: true });
  const timing = immediacyVerdict({ parsed, reader: reader.id, receivedAt, immediateOnly: account?.ok === true && account.immediateOnly === true });
  return {
    parsed, reader, account, timing,
    record: eftPoolRecord({
      message: { messageId: "<m@myupdates1.standardbank.co.za>", from, subject: "Payment confirmation 8310", receivedAt },
      verdict: authFor(domain, from, dkim), parsed, account, timing,
      dated: paymentDateVerdict({ parsed, cutoff: parsePaymentDateCutoff(undefined) }),
      reader: reader.id, rawText: lines.join("\n"), at: receivedAt,
    }),
  };
}
const sb = (o, opts) => decide("standardbank.co.za", "noreply@standardbank.co.za", SAME_BANK(o), opts);
const cap = (o) => decide("capitecbank.co.za", "noreply@capitecbank.co.za", capitec(o));

describe("a same-bank Standard-to-Standard payment into the immediate-only account", () => {
  it("the real 6 Nov layout (no heading) reads as not-flagged-immediate…", () => {
    const { parsed, account } = sb();
    expect(parsed.immediate).toBe(null);
    expect(parsed.destBankName).toBe("STANDARD BANK");
    expect(account).toMatchObject({ ok: true, bank: "standardbank", immediateOnly: true });
  });

  it("…and now CONFIRMS: recorded, spendable", () => {
    const { record } = sb();
    expect(record).toMatchObject({ outcome: "recorded", status: "unmatched", amountCents: 40000, reader: "standardbank" });
  });

  it("a same-bank payment with the plain \"Payment Confirmation\" heading confirms too", () => {
    expect(sb({ heading: "Payment Confirmation" }).record.outcome).toBe("recorded");
  });

  it("an IMMEDIATE Standard Bank payment into it still confirms", () => {
    expect(sb({ heading: "Immediate Payment Confirmation" }).record.outcome).toBe("recorded");
  });

  it("a same-bank payment dated BEYOND the next business day is still refused (scheduled)", () => {
    // Notice of Fri 6 Nov: Fridays open the window (7 Nov 2026 evening), so
    // Monday 9 Nov settles; Tuesday 10 Nov is beyond it.
    expect(sb({ date: "2026-11-09 09h00" }).record.outcome).toBe("recorded");
    const r = sb({ date: "2026-11-10 09h00" }).record;
    expect(r.outcome).toBe("refused-not-immediate");
    expect(r.reason).toMatch(/beyond the next business day/);
  });

  it("a Standard Bank heading out of shape (two, split, below the sentence) still refuses", () => {
    const sentence = "We confirm that the following payment has been made into your account from A CUSTOMER:";
    const both = SAME_BANK({ heading: "Immediate Payment Confirmation" }).flatMap((l) => (l === "Immediate Payment Confirmation" ? [l, "Payment Confirmation"] : [l]));
    const split = SAME_BANK({ heading: "Immediate Payment Confirmation" }).flatMap((l) => (l === "Immediate Payment Confirmation" ? ["Immediate", "Payment Confirmation"] : [l]));
    const below = SAME_BANK().flatMap((l) => (l === sentence ? [l, "Payment Confirmation"] : [l]));
    for (const [name, lines] of [["two", both], ["split", split], ["below", below]]) {
      const r = decide("standardbank.co.za", "noreply@standardbank.co.za", lines).record;
      expect(r.outcome, name).toBe("refused-not-immediate");
    }
  });

  it("the same-bank pass also covers a Standard Bank account under the date-phased rule, 20–26 Oct (inert: none exists)", () => {
    const parsed = { bankTs: Date.parse("2026-10-24T08:00:00Z"), destBankName: "STANDARD BANK", immediate: null, paymentType: null };
    expect(immediacyVerdict({ parsed, reader: "standardbank", receivedAt: Date.parse("2026-10-24T09:00:00Z") })).toEqual({ ok: true });
  });

  it("a forged Standard Bank notice (DKIM fails) is still refused — the rule rests on the bank's signature", () => {
    expect(sb({}, { dkim: "fail" }).record.outcome).toBe("refused-auth");
  });

  it("the destination checks are unchanged: another Standard Bank account, or our number at another bank, refuses", () => {
    expect(sb({ account: "10199998534" }).record.outcome).toBe("refused-account");
    expect(sb({ account: "XXXXXXX04321" }).record.outcome).toBe("refused-account");
    expect(sb({ bank: "FIRST NATIONAL BANK", account: SB }).record.outcome).toBe("refused-account");
  });
});

describe("a payment into it FROM ANOTHER BANK must still be immediate", () => {
  it("Capitec \"Regular Payment\" into the Standard Bank account is REFUSED", () => {
    const r = cap({ type: "Regular Payment" }).record;
    expect(r.outcome).toBe("refused-not-immediate");
    expect(r.reason).toMatch(/IMMEDIATE payments only/);
  });

  it("Capitec \"Immediate Payment\" into it confirms", () => {
    expect(cap({ type: "Immediate Payment" }).record.outcome).toBe("recorded");
  });

  it("every other bank's reader naming a Standard Bank destination is NOT same-bank", () => {
    const parsed = { bankTs: Date.parse("2026-11-06T08:00:00Z"), destBankName: "STANDARD BANK", immediate: false, paymentType: "regular" };
    for (const reader of ["capitec", "absa", "nedbank"]) {
      const v = immediacyVerdict({ parsed, reader, receivedAt: RECEIVED, immediateOnly: true });
      expect(v.ok, reader).toBe(false);
      expect(v.reason, reader).toMatch(/IMMEDIATE payments only/);
    }
    // An FNB notice is FNB-to-FNB only — into Standard Bank it is not.
    expect(immediacyVerdict({ parsed, reader: "fnb", receivedAt: RECEIVED, immediateOnly: true }).ok).toBe(false);
    // An unknown reader cannot claim it either.
    expect(immediacyVerdict({ parsed, reader: "tymebank", receivedAt: RECEIVED, immediateOnly: true }).ok).toBe(false);
  });

  it("a Standard Bank notice paying ANOTHER bank is not same-bank: its own immediate signal decides", () => {
    const pre27 = { bankTs: Date.parse("2026-10-24T08:00:00Z"), destBankName: "FIRST NATIONAL BANK", immediate: null };
    expect(immediacyVerdict({ parsed: pre27, reader: "standardbank", receivedAt: Date.parse("2026-10-24T09:00:00Z") }).ok).toBe(false);
    expect(immediacyVerdict({ parsed: { ...pre27, immediate: false }, reader: "standardbank", receivedAt: Date.parse("2026-10-24T09:00:00Z"), immediateOnly: true }).ok).toBe(false);
  });
});

describe("every other account keeps the date-phased rule (unchanged)", () => {
  const fnbParsed = (iso, immediate) => ({ bankTs: Date.parse(iso), destBankName: "FIRST NATIONAL BANK", immediate });
  it("on/after 27 Oct a regular payment into the FNB account confirms", () => {
    expect(cap({ type: "Regular Payment", bank: "First National Bank", account: FNB }).record.outcome).toBe("recorded");
    expect(immediacyVerdict({ parsed: fnbParsed("2026-11-06T08:00:00Z", false), reader: "capitec", receivedAt: RECEIVED })).toEqual({ ok: true });
  });
  it("20–26 Oct a regular payment into the FNB account is refused", () => {
    const v = immediacyVerdict({ parsed: fnbParsed("2026-10-24T08:00:00Z", false), reader: "capitec", receivedAt: Date.parse("2026-10-24T09:00:00Z") });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/before 2026-10-27 must be immediate/);
  });
});

// ─── THE R400 FLOATED BY HAND — ITS NOTICE NEVER FLOATS ──────────────────────
// Live state on 6 Nov 2026: two copies of the notice, both refused
// not-immediate; the first holds the bank id's claim, the second is its
// duplicate; Junid's manual entry (status unmatched) floats the R400.
// claim-settled-bank-fingerprint.mjs then marks the claim spentBy his entry
// and stamps each refusal settledByHand. Replayed here against an in-memory
// /eft_pool_fingerprints exactly as the poller's write loop uses it.
describe("a notice settled by hand never auto-floats, even now that the rule would pass it", () => {
  const ingest = (messageId, uid) => {
    const lines = SAME_BANK();
    const { record } = sb();
    const reader = selectReader({ fromDomain: "standardbank.co.za", lines });
    const [group] = groupEftPayments([{ d: { text: lines.join("\n") }, r: reader, p: reader.parse(lines) }]);
    const baseKey = eftMessageKey({ messageId, from: "noreply@standardbank.co.za", subject: "Payment confirmation 8310", date: RECEIVED, size: 1000, uid, uidValidity: 7, authPass: true });
    return { poolKey: eftPaymentKey(baseKey, group, 1), record };
  };
  /** The poller's write loop (email-poller.mjs) against `claims`. */
  const claimAndDecide = (claims, { poolKey, record }) => {
    let holder = null, spentBy = null, manualApproved = false;
    const fp = record.outcome === "recorded" ? paymentFingerprint({ reader: record.reader, bankRef: record.bankRef }) : refusalFingerprint(record);
    const next = fingerprintClaimStep(poolKey, 1, (d) => { holder = d.holder; spentBy = d.spentBy ?? null; manualApproved = d.manualApproved === true; })(claims.has(fp) ? claims.get(fp) : null);
    if (next !== undefined) claims.set(fp, next);
    return record.outcome === "recorded"
      ? applyFingerprintHold(record, { fingerprint: fp, holder, poolKey, manualApproved, spentBy })
      : applyRefusalFingerprint(record, { fingerprint: fp, holder, poolKey });
  };

  const first = ingest("<copy-1@myupdates1.standardbank.co.za>", 1);
  const second = ingest("<copy-2@myupdates1.standardbank.co.za>", 2);
  const fp = paymentFingerprint({ reader: "standardbank", bankRef: first.record.bankRef });
  // As refused before this change (the live records' outcome).
  const { status: _s, ...asRecorded } = first.record;
  const refusedFirst = { ...asRecorded, outcome: "refused-not-immediate" };
  const MANUAL_KEY = "m".repeat(40);
  const manual = { outcome: "recorded", status: "unmatched", reader: "manual", manualEntry: { at: 1 }, amountCents: 40000, reference: "custref" };

  // The live claim, as the refusal wrote it, then marked by the script.
  const claims = new Map([[fp, { poolKey: first.poolKey, at: 1 }]]);
  const plan = settledFingerprintPlan({ refusedKey: first.poolKey, refused: refusedFirst, spenderKey: MANUAL_KEY, spender: manual });
  it("the script accepts Junid's floated (unmatched) manual entry as the spender", () => {
    expect(plan).toEqual({ ok: true, fingerprint: fp });
    claims.set(fp, settledClaimStep({ spenderKey: MANUAL_KEY, refusedKey: first.poolKey, at: 2 })(claims.get(fp)));
    expect(claims.get(fp)).toMatchObject({ poolKey: first.poolKey, spentBy: MANUAL_KEY, settledByHandFor: first.poolKey });
  });

  it("under the new rule the notice WOULD pass on its own…", () => {
    expect(first.record).toMatchObject({ outcome: "recorded", status: "unmatched" });
  });

  it("…but a re-run of the FIRST refusal (the claim's own holder) lands HELD, never spendable", () => {
    const written = claimAndDecide(claims, first);
    expect(written.outcome).toBe("held-duplicate");
    expect(written.status).toBeUndefined();
    expect(written.approvedByHand).toBe(MANUAL_KEY);
  });

  it("…a re-run of the second copy, or any resent copy, lands HELD (not the holder — the pre-existing branch)", () => {
    expect(claimAndDecide(claims, second).outcome).toBe("held-duplicate");
    const resent = ingest("<resent@myupdates2.standardbank.co.za>", 3);
    const w = claimAndDecide(claims, resent);
    expect(w.outcome).toBe("held-duplicate");
    expect(w.status).toBeUndefined();
  });

  it("the stamped refusal is never re-run by the retry tool", () => {
    const stamped = settledByHandStep({ spenderKey: MANUAL_KEY, at: 3 })({ ...refusedFirst, messageId: "<m@x>" });
    expect(stamped.settledByHand).toEqual({ spentBy: MANUAL_KEY, at: 3 });
    expect(stamped.outcome).toBe("refused-not-immediate");
    const r = eftRetryPlan({ poolKey: "a".repeat(40), record: stamped, seenRow: { done: true }, at: 9 });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/settled BY HAND/);
  });

  it("settledByHandStep stamps only a refusal, once, and never creates a record", () => {
    const step = settledByHandStep({ spenderKey: MANUAL_KEY, at: 3 });
    expect(step(null)).toBe(null);                                        // empty cache / gone: no-op
    expect(step({ ...refusedFirst, settledByHand: { spentBy: "x", at: 1 } })).toBeUndefined();
    expect(step({ ...first.record })).toBeUndefined();                    // recorded: never
    expect(step({ ...refusedFirst, outcome: "held-duplicate" })).toBeUndefined();
    expect(step("garbage")).toBeUndefined();
  });

  it("an owner proof-approval stamped over a refusal's claim also holds that refusal's re-run", () => {
    // eftPoolManualApprove stampOver: holder is the refusal, spentBy the approval.
    const w = applyFingerprintHold(first.record, { fingerprint: fp, holder: first.poolKey, poolKey: first.poolKey, manualApproved: true, spentBy: "a".repeat(40) });
    expect(w.outcome).toBe("held-duplicate");
    expect(w.status).toBeUndefined();
  });

  it("a claim this record spent itself is untouched (a normal used payment re-read)", () => {
    expect(applyFingerprintHold(first.record, { fingerprint: fp, holder: first.poolKey, poolKey: first.poolKey, spentBy: first.poolKey }))
      .toMatchObject({ outcome: "recorded", status: "unmatched" });
  });
});

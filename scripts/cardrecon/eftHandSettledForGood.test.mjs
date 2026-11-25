// ─── THE R5,900 ABSA "STD S.A." PAYMENT: FLOATED BY HAND, ITS NOTICE NEVER ───
// Junid, 25 Nov 2026: he floats the R5,900 himself ("Enter an EFT payment by
// hand", typed "SHARLEEN"; the notice prints "sharlene"). The bank's notice —
// refused twice as "Wrong destination account" before the alias fix — must
// never float or be spent by any path, now that the fix WOULD accept it.
// claim-settled-bank-fingerprint.mjs spends the bank id (and, for Absa, the
// blank-number identity) by his entry; replayed here against an in-memory
// /eft_pool_fingerprints exactly as the poller's write loop uses it.
//
// ACCOUNT NUMBERS AND NAMES HERE ARE STAND-INS (this repo is public).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { selectReader } from "./eftBanks.mjs";
import {
  authenticationVerdict, destinationVerdict, enforcesImmediateOnly, immediacyVerdict, paymentDateVerdict, parsePaymentDateCutoff,
  parseAccountPolicies, eftPoolRecord, paymentFingerprint, fingerprintClaimStep, applyFingerprintHold, applyRefusalFingerprint,
  refusalFingerprint, settledFingerprintPlan, settledSyntheticPlan, settledClaimStep, settledByHandStep, eftRetryPlan,
} from "./eftCore.mjs";

const require = createRequire(import.meta.url);
const { SB_POLICY, absaStdSa } = require("../../functions/test/fixtures/absa-std-sa-2026-11-25.cjs");
const { approvedClaimDecision } = require("../../functions/lib/eft-manual-approved.cjs");
const { releaseHoldDecision } = require("../../functions/lib/eft-settle.cjs");

const POLICIES = parseAccountPolicies(`62900004321, ${SB_POLICY}`);
const ARRIVED = Date.parse("2026-11-25T17:57:37+02:00");
const FROM = "ibreply@absa.co.za";
const auth = authenticationVerdict({
  fromAddress: FROM,
  headerLines: [
    { key: "authentication-results", line: "Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@absa.co.za header.s=s1 header.b=x;\r\n       spf=pass smtp.mailfrom=absa.co.za;\r\n       dmarc=pass (p=REJECT) header.from=absa.co.za" },
    { key: "from", line: `From: <${FROM}>` },
  ],
});
/** The poller's chain on the fixed code (aliases known). */
function ingest(lines) {
  const reader = selectReader({ fromDomain: "absa.co.za", lines });
  const parsed = reader.parse(lines);
  const account = destinationVerdict({ accountMask: parsed.accountMask, destBankName: parsed.destBankName, destBranchCode: parsed.destBranchCode, allowedAccounts: POLICIES, configured: true });
  const timing = immediacyVerdict({ parsed, reader: reader.id, receivedAt: ARRIVED, immediateOnly: account?.ok === true && enforcesImmediateOnly(account) });
  const dated = paymentDateVerdict({ parsed, cutoff: parsePaymentDateCutoff(undefined) });
  return eftPoolRecord({ message: { messageId: "<n@absa>", from: FROM, subject: "Notice of payment: CONCRETE", receivedAt: ARRIVED }, verdict: auth, parsed, account, timing, dated, reader: reader.id, rawText: "", at: ARRIVED });
}
/** The poller's write loop (email-poller.mjs) against `claims`. */
function claimAndDecide(claims, poolKey, record) {
  let holder = null, spentBy = null, manualApproved = false;
  const fp = record.outcome === "recorded" ? paymentFingerprint(record) : refusalFingerprint(record);
  const next = fingerprintClaimStep(poolKey, 1, (d) => { holder = d.holder; spentBy = d.spentBy ?? null; manualApproved = d.manualApproved === true; })(claims.has(fp) ? claims.get(fp) : null);
  if (next !== undefined) claims.set(fp, next);
  return record.outcome === "recorded"
    ? applyFingerprintHold(record, { fingerprint: fp, holder, poolKey, manualApproved, spentBy })
    : applyRefusalFingerprint(record, { fingerprint: fp, holder, poolKey });
}

describe("the R5,900 notice Junid floats by hand never floats, by any path", () => {
  const FIRST = "9".repeat(40), SECOND = "7".repeat(40), MANUAL = "2".repeat(40);
  // As the live records stand: refused-account (before the alias fix), the
  // 17:48 copy holding the bank id's claim, no reference stored.
  const { status: _s, reference: _r, ...base } = ingest(absaStdSa());
  const refused = { ...base, outcome: "refused-account", reason: 'This payment was made to "STD S.A.", which is not a bank the shop is paid into' };
  const manual = { outcome: "recorded", status: "unmatched", reader: "manual", manualEntry: { at: 1 }, amountCents: 590000, reference: "CUSTOMR" };
  const fp = refusalFingerprint(refused);
  // The live claim as the 17:48 refusal wrote it — fresh for each test.
  const unspent = () => new Map([[fp, { poolKey: FIRST, at: 1 }]]);

  it("the plan refuses a different spelling unless Junid's word is given, and needs the notice's reference", () => {
    expect(settledFingerprintPlan({ refusedKey: FIRST, refused, spenderKey: MANUAL, spender: manual }).ok).toBe(false);
    expect(settledFingerprintPlan({ refusedKey: FIRST, refused, spenderKey: MANUAL, spender: manual, referenceDiffersOk: true }).ok).toBe(false);
    expect(settledFingerprintPlan({ refusedKey: FIRST, refused, spenderKey: MANUAL, spender: { ...manual, amountCents: 590001 }, noticeReference: "customer", referenceDiffersOk: true }).ok).toBe(false);
    // The same spelling needs no flag.
    expect(settledFingerprintPlan({ refusedKey: FIRST, refused, spenderKey: MANUAL, spender: { ...manual, reference: "CUSTOMER" }, noticeReference: "customer" })).toEqual({ ok: true, fingerprint: fp });
  });

  const plan = settledFingerprintPlan({ refusedKey: FIRST, refused, spenderKey: MANUAL, spender: manual, noticeReference: "customer", referenceDiffersOk: true });
  const synthetic = settledSyntheticPlan({ refused, payer: "MRS A PAYER", paymentDate: "2026-11-25", reference: "customer" });
  const step = settledClaimStep({ spenderKey: MANUAL, refusedKey: FIRST, at: 2, referenceDiffers: plan.referenceDiffers });
  /** The claims after the script ran: bank id and blank-number identity spent by Junid's entry. */
  const settled = () => {
    const claims = unspent();
    claims.set(fp, step(claims.get(fp)));
    claims.set(synthetic.fingerprint, step(null));
    return claims;
  };

  it("Junid's entry spends the bank id AND the blank-number identity, once, naming the difference", () => {
    expect(plan).toEqual({ ok: true, fingerprint: fp, referenceDiffers: { notice: "customer", entry: "CUSTOMR" } });
    expect(synthetic.ok).toBe(true);
    const claims = settled();
    expect(claims.get(fp)).toMatchObject({ poolKey: FIRST, spentBy: MANUAL, settledByHandFor: FIRST, referenceDiffers: { notice: "customer" } });
    expect(claims.get(synthetic.fingerprint)).toMatchObject({ poolKey: MANUAL, spentBy: MANUAL });
    // Run again: never a second spender, never overwritten.
    expect(step(claims.get(fp))).toBeUndefined();
    expect(settledClaimStep({ spenderKey: "x".repeat(40), refusedKey: FIRST, at: 3 })(claims.get(fp))).toBeUndefined();
  });

  it("the fixed code WOULD accept the notice on its own…", () => {
    expect(ingest(absaStdSa()).outcome).toBe("recorded");
  });

  it("…but a re-run of the first refusal, a re-run of the second, and a RE-SENT copy all land HELD, naming his entry", () => {
    const claims = settled();
    for (const key of [FIRST, SECOND, "3".repeat(40)]) {
      const w = claimAndDecide(claims, key, ingest(absaStdSa()));
      expect(w.outcome, key).toBe("held-duplicate");
      expect(w.status).toBeUndefined();
      expect(w.approvedByHand).toBe(MANUAL);
    }
  });

  it("a copy that leaves the transaction number BLANK is held too (its Absa identity is spent)", () => {
    const claims = settled();
    const blank = ingest(absaStdSa({ txn: "" }));
    expect(blank.bankRef).toBe(null);
    expect(blank.syntheticRef).toBe(synthetic.syntheticRef);
    const w = claimAndDecide(claims, "4".repeat(40), blank);
    expect(w.outcome).toBe("held-duplicate");
    expect(w.approvedByHand).toBe(MANUAL);
  });

  it("a held copy is never released; Upload approved proof finds it already used", () => {
    const claims = settled();
    const held = claimAndDecide(claims, "5".repeat(40), ingest(absaStdSa()));
    expect(releaseHoldDecision(held, { at: 9, by: "Junid", reason: "checked on the statement" }).ok).toBe(false);
    const d = approvedClaimDecision({ approvedKey: "a".repeat(40), claim: claims.get(fp), holderRecord: refused, now: 9 });
    expect(d).toMatchObject({ action: "refuse", code: "already-used", key: MANUAL });
  });

  it("the stamped refusals are never re-run by the retry tool, and the stamp names the difference", () => {
    const stamped = settledByHandStep({ spenderKey: MANUAL, at: 2, referenceDiffers: plan.referenceDiffers })({ ...refused, messageId: "<n@absa>" });
    expect(stamped.settledByHand).toEqual({ spentBy: MANUAL, at: 2, referenceDiffers: { notice: "customer", entry: "CUSTOMR" } });
    expect(stamped.outcome).toBe("refused-account");
    expect(eftRetryPlan({ poolKey: FIRST, record: stamped, seenRow: { done: true }, at: 9 }).why).toMatch(/settled BY HAND/);
  });

  it("the blank-number plan is Absa-only and needs a date", () => {
    expect(settledSyntheticPlan({ refused: { ...refused, reader: "fnb" }, payer: "X", paymentDate: "2026-11-25" }).ok).toBe(false);
    expect(settledSyntheticPlan({ refused, payer: "MRS A PAYER", paymentDate: "25/11/2026" }).ok).toBe(false);
  });
});

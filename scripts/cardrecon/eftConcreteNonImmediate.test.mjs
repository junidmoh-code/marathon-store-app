// ─── CONCRETE'S STANDARD BANK ACCOUNT CONFIRMS NON-IMMEDIATE EFTs (8 Nov 2026) ─
// Junid: the immediate-only rule on this account was rejecting real customers.
// It now confirms under exactly the rules of Marathon's FNB account. Its
// EFT_ALLOWED_ACCOUNTS entry keeps the ":immediate" tag; the poller waives the
// tag for this one account (enforcesImmediateOnly). Each case runs the
// poller's chain: reader → destination → timing → date → pool record.
//
// ACCOUNT NUMBERS HERE ARE STAND-INS (this repo is public).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { selectReader } from "./eftBanks.mjs";
import {
  applyFingerprintHold, authenticationVerdict, destinationVerdict, enforcesImmediateOnly, immediacyVerdict,
  paymentDateVerdict, parsePaymentDateCutoff, parseAccountPolicies, eftPoolRecord,
} from "./eftCore.mjs";

const FNB = "62900004321";
const SB = "10100008534";
const POLICIES = parseAccountPolicies(`${FNB}, 62000009092, ${SB}:standardbank:immediate`);
const sast = (s) => Date.parse(`${s}+02:00`);
const MONDAY = sast("2026-11-02T12:00:00");
const SATURDAY = sast("2026-11-07T11:00:00");

const auth = (domain, from) => authenticationVerdict({
  fromAddress: from,
  headerLines: [
    { key: "authentication-results", line: `Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@${domain} header.s=s1 header.b=x;\r\n       spf=pass smtp.mailfrom=${domain};\r\n       dmarc=pass (p=REJECT) header.from=${domain}` },
    { key: "from", line: `From: <${from}>` },
  ],
});

const CAPITEC_FROM = "noreply@capitecbank.co.za";
const capitec = ({ type = "Regular Payment", bank = "Standard Bank", account = SB, date = "02/11/2026 09:30" } = {}) => [
  "Payment Notification", "Capitec Bank",
  "Please take note that A Customer made a payment to your account.",
  "Notification number 600001",
  `Payment date ${date}`,
  "Beneficiary name ATUGAR",
  `Bank name ${bank}`,
  `Account number ${account}`,
  "Branch 051001",
  `Payment type ${type}`,
  "Amount R300.00",
  "Payment reference CUSTREF",
];
const toMarathon = (o) => capitec({ bank: "First National Bank", account: FNB, ...o });

/** The poller's chain, including its own use of enforcesImmediateOnly. */
function decide(lines, { receivedAt = MONDAY, signedBy = "capitecbank.co.za", policies = POLICIES } = {}) {
  const reader = selectReader({ fromDomain: "capitecbank.co.za", lines });
  const parsed = reader.parse(lines);
  expect(parsed.ok, parsed.reason).toBe(true);
  const account = destinationVerdict({ accountMask: parsed.accountMask, destBankName: parsed.destBankName, allowedAccounts: policies, configured: true });
  const timing = immediacyVerdict({ parsed, reader: reader.id, receivedAt, immediateOnly: account?.ok === true && enforcesImmediateOnly(account) });
  const dated = paymentDateVerdict({ parsed, cutoff: parsePaymentDateCutoff(undefined) });
  return eftPoolRecord({
    message: { messageId: "<m@x>", from: CAPITEC_FROM, subject: "Payment", receivedAt },
    verdict: auth(signedBy, CAPITEC_FROM), parsed, account, timing, dated, reader: reader.id, rawText: lines.join("\n"), at: receivedAt,
  });
}

describe("into Concrete's Standard Bank account", () => {
  it("a non-immediate EFT dated today (a business day) CONFIRMS and records that it was not immediate", () => {
    const r = decide(capitec());
    expect(r.outcome).toBe("recorded");
    expect(r.status).toBe("unmatched");
    expect(r.accountTail).toBe("8534");
    expect(r.immediate).toBe(false);
    expect(r.paymentType).toBe("Regular Payment");
  });

  it("an immediate payment still CONFIRMS and records that it was immediate", () => {
    const r = decide(capitec({ type: "Immediate Payment" }));
    expect(r.outcome).toBe("recorded");
    expect(r.immediate).toBe(true);
    expect(r.paymentType).toBe("Immediate Payment");
  });

  it("a payment dated a later business day is still REJECTED", () => {
    const r = decide(capitec({ date: "03/11/2026 09:30" }));
    expect(r.outcome).toBe("refused-not-immediate");
    expect(r.reason).not.toMatch(/IMMEDIATE payments only/);
  });

  it("a payment timestamped later the same day than its notice is still REJECTED", () => {
    expect(decide(capitec({ date: "02/11/2026 18:30" })).outcome).toBe("refused-not-immediate");
  });

  it("a weekend payment dated Monday is ACCEPTED; dated beyond Monday it is not", () => {
    expect(decide(capitec({ date: "09/11/2026 00:00" }), { receivedAt: SATURDAY }).outcome).toBe("recorded");
    expect(decide(capitec({ date: "10/11/2026 00:00" }), { receivedAt: SATURDAY }).outcome).toBe("refused-not-immediate");
  });

  it("the 2026-10-20 floor still refuses, and 20–26 Oct still needs an immediate payment", () => {
    expect(decide(capitec({ type: "Immediate Payment", date: "19/10/2026 09:30" }), { receivedAt: sast("2026-10-19T12:00:00") }).outcome).toBe("refused-stale-date");
    const r = decide(capitec({ date: "24/10/2026 09:30" }), { receivedAt: sast("2026-10-24T12:00:00") });
    expect(r.outcome).toBe("refused-not-immediate");
    expect(r.reason).toMatch(/before 2026-10-27 must be immediate/);
  });

  it("a notice that fails DKIM for the sender's domain is still refused", () => {
    expect(decide(capitec(), { signedBy: "forged.example" }).outcome).toBe("refused-auth");
  });

  it("a resent copy of a non-immediate payment is still held, not floated twice", () => {
    const r = decide(capitec());
    const held = applyFingerprintHold(r, { fingerprint: "fp-1", holder: "the-first-record", poolKey: "this-record" });
    expect(held.outcome).toBe("held-duplicate");
    expect(held.status).toBeUndefined();
  });

  it("a different Standard Bank account ending in other digits is still not the shop's", () => {
    expect(decide(capitec({ account: "10199990000" })).outcome).toBe("refused-account");
  });

  it("decides every date and type exactly as Marathon's FNB account does", () => {
    const cases = [
      ["02/11/2026 09:30", MONDAY], ["03/11/2026 09:30", MONDAY], ["02/11/2026 18:30", MONDAY],
      ["09/11/2026 00:00", SATURDAY], ["10/11/2026 00:00", SATURDAY],
      ["24/10/2026 09:30", sast("2026-10-24T12:00:00")], ["19/10/2026 09:30", sast("2026-10-19T12:00:00")],
    ];
    for (const type of ["Regular Payment", "Immediate Payment"]) {
      for (const [date, receivedAt] of cases) {
        const concrete = decide(capitec({ type, date }), { receivedAt });
        const marathon = decide(toMarathon({ type, date }), { receivedAt });
        expect([concrete.outcome, concrete.reason], `${type} ${date}`).toEqual([marathon.outcome, marathon.reason]);
      }
    }
  });

  it("an FNB notice paying it now follows the date rule too", () => {
    const parsed = { bankTs: MONDAY - 3600_000, destBankName: "STANDARD BANK", immediate: null };
    const account = destinationVerdict({ accountMask: SB, destBankName: "STANDARD BANK", allowedAccounts: POLICIES, configured: true });
    expect(immediacyVerdict({ parsed, reader: "fnb", receivedAt: MONDAY, immediateOnly: enforcesImmediateOnly(account) })).toEqual({ ok: true });
  });
});

describe("only that one account changed", () => {
  it("the allowlist entry still reads with its tag; the waiver is what releases it", () => {
    const atugar = destinationVerdict({ accountMask: SB, destBankName: "Standard Bank", allowedAccounts: POLICIES, configured: true });
    expect(atugar).toEqual({ ok: true, tail: "8534", bank: "standardbank", immediateOnly: true });
    expect(enforcesImmediateOnly(atugar)).toBe(false);
    expect(enforcesImmediateOnly(POLICIES[2])).toBe(false);
  });

  it("any other account given the tag is still held to immediate-only", () => {
    expect(enforcesImmediateOnly({ account: "10100007777", bank: "standardbank", immediateOnly: true })).toBe(true);
    expect(enforcesImmediateOnly({ tail: "7777", bank: "standardbank", immediateOnly: true })).toBe(true);
    // The waiver is bank AND tail: an FNB account ending the same stays held.
    expect(enforcesImmediateOnly({ account: "62900008534", bank: "fnb", immediateOnly: true })).toBe(true);
    const other = parseAccountPolicies(`${FNB}, 10100007777:standardbank:immediate`);
    const r = decide(capitec({ account: "10100007777" }), { policies: other });
    expect(r.outcome).toBe("refused-not-immediate");
    expect(r.reason).toMatch(/IMMEDIATE payments only/);
  });

  it("an untagged account is never immediate-only", () => {
    expect(enforcesImmediateOnly(POLICIES[0])).toBe(false);
    expect(enforcesImmediateOnly(null)).toBe(false);
  });

  it("a Marathon FNB record is exactly the shape it was: no immediate field added", () => {
    const r = decide(toMarathon());
    expect(r.outcome).toBe("recorded");
    expect(Object.keys(r).sort()).toEqual([
      "accountTail", "amountCents", "at", "auth", "bankRef", "bankTs", "destination", "from", "messageId", "outcome",
      "payer", "rawText", "reader", "receivedAt", "reference", "status", "subject", "syntheticRef",
    ]);
  });

  it("the poller's start-up line and heartbeat count the accounts really enforced", () => {
    const src = readFileSync(new URL("./email-poller.mjs", import.meta.url), "utf8");
    expect(src.match(/cfg\.eftAccounts\.filter\(\(p\) => enforcesImmediateOnly\(p\)\)/g)).toHaveLength(2);
    expect(src).not.toMatch(/filter\(\(p\) => p\.immediateOnly\)/);
  });
});

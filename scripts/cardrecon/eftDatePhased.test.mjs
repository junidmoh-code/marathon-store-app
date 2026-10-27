// ─── DATE-PHASED IMMEDIACY (Junid, 27 Oct 2026) ──────────────────────────────
// Keyed on the BANK's printed payment date as a SAST calendar day:
//   >= 2026-10-27   accepted, immediate OR regular
//   20..26 Oct      accepted only if immediate (a reader with no signal refuses)
//   <  2026-10-20   refused by the cutoff
// Run through the poller's own chain — reader → 7a → 7b → fix 8 → pool record
// — on a Capitec "Payment Notification" (the bank that prints both "Immediate
// Payment" and "Regular Payment", and a time, so the SAST midnight boundary is
// testable to the minute) and on the real Nedbank layout (date only).
import { describe, it, expect } from "vitest";
import { selectReader } from "./eftBanks.mjs";
import {
  authenticationVerdict, destinationVerdict, immediacyVerdict, paymentDateVerdict,
  parsePaymentDateCutoff, parseAllowedAccounts, eftPoolRecord, immediacyRequiredFor,
  IMMEDIATE_NOT_REQUIRED_FROM, DEFAULT_EFT_PAYMENT_DATE_CUTOFF,
} from "./eftCore.mjs";

const ALLOWED = parseAllowedAccounts("62900004321");
// Arrival well after every payment date used here, so none is "future-dated".
const RECEIVED = Date.parse("2026-10-28T08:00:00Z");

const auth = (domain, from) => authenticationVerdict({
  fromAddress: from,
  headerLines: [
    { key: "authentication-results", line: `Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@${domain} header.s=s1 header.b=x;\r\n       spf=pass smtp.mailfrom=${domain};\r\n       dmarc=pass (p=REJECT) header.from=${domain}` },
    { key: "from", line: `From: <${from}>` },
  ],
});

// Capitec layout (eftBanks.mjs), sanitised; date, time and type vary.
const capitec = (date, type) => [
  "Payment Notification",
  "Capitec Bank",
  "Please take note that A Customer made a payment to your account.",
  "Notification number 600001",
  `Payment date ${date}`,
  "Beneficiary name Marathon",
  "Bank name First National Bank",
  "Account number 62900004321",
  "Branch 250655",
  `Payment type ${type}`,
  "Amount R300.00",
  "Payment reference CUSTREF",
];
// Nedbank layout (eftNedbank.test.mjs), sanitised; date and channel vary.
const nedbank = (date, channel) => [
  "Notification of Payment",
  "Nedbank Limited confirms that the following payment has been made:",
  `Date of Payment : ${date}`,
  "Reference Number : 1a2b3c4d-1111-2222-a333-0b0c0d0e0f1",
  "Recipient : Marathon",
  "Amount : R1410.00",
  "Recipient Reference : Custref",
  "Bank FIRST NATIONAL BANK",
  "Account Number ...004321",
  `Channel ${channel}`,
  "Paid from Account Holder : A CUSTOMER",
];

/** The poller's chain for one document, to the record it would write. */
function decide(domain, from, lines) {
  const reader = selectReader({ fromDomain: domain, lines });
  const parsed = reader.parse(lines);
  const account = destinationVerdict({ accountMask: parsed.accountMask, destBankName: parsed.destBankName, allowedAccounts: ALLOWED, configured: true });
  const timing = immediacyVerdict({ parsed, reader: reader.id, receivedAt: RECEIVED });
  const dated = paymentDateVerdict({ parsed, cutoff: parsePaymentDateCutoff(undefined) });
  return eftPoolRecord({
    message: { messageId: "<m@x>", from, subject: "Payment Notification", receivedAt: RECEIVED },
    verdict: auth(domain, from), parsed, account, timing, dated, reader: reader.id, rawText: lines.join("\n"), at: RECEIVED,
  });
}
const cap = (date, type) => decide("capitecbank.co.za", "noreply@capitecbank.co.za", capitec(date, type));
const ned = (date, channel) => decide("nedbank.co.za", "Notification@nedbank.co.za", nedbank(date, channel));

describe("the rule's constants", () => {
  it("immediacy stops being required on 2026-10-27; the go-live floor stays 2026-10-20", () => {
    expect(IMMEDIATE_NOT_REQUIRED_FROM).toBe("2026-10-27");
    expect(DEFAULT_EFT_PAYMENT_DATE_CUTOFF).toBe("2026-10-20");
  });
});

describe("bank date on or after 2026-10-27: immediate OR regular is accepted", () => {
  it("2026-10-27 regular → accepted", () => {
    expect(cap("27/10/2026 10:15", "Regular Payment")).toMatchObject({ outcome: "recorded", status: "unmatched" });
    expect(ned("27/10/2026", "Internet payment")).toMatchObject({ outcome: "recorded", status: "unmatched" });
  });
  it("2026-10-27 immediate → accepted", () => {
    expect(cap("27/10/2026 10:15", "Immediate Payment").outcome).toBe("recorded");
    expect(ned("27/10/2026", "Immediate payment").outcome).toBe("recorded");
  });
});

describe("bank date 2026-10-20 .. 2026-10-26: immediate only", () => {
  it("2026-10-26 immediate → accepted", () => {
    expect(cap("26/10/2026 10:15", "Immediate Payment").outcome).toBe("recorded");
    expect(ned("26/10/2026", "Immediate payment").outcome).toBe("recorded");
  });
  it("2026-10-26 regular → refused (not immediate)", () => {
    const c = cap("26/10/2026 10:15", "Regular Payment");
    expect(c.outcome).toBe("refused-not-immediate");
    expect(c.reason).toMatch(/before 2026-10-27 must be immediate/);
    expect(ned("26/10/2026", "Internet payment").outcome).toBe("refused-not-immediate");
  });
  it("2026-10-20 (the first live day) immediate → accepted, regular → refused", () => {
    expect(cap("20/10/2026 00:00", "Immediate Payment").outcome).toBe("recorded");
    expect(cap("20/10/2026 00:00", "Regular Payment").outcome).toBe("refused-not-immediate");
  });
});

describe("bank date before 2026-10-20: everything refused (unchanged floor)", () => {
  it("immediate → refused by the cutoff", () => {
    expect(cap("19/10/2026 23:59", "Immediate Payment")).toMatchObject({ outcome: "refused-stale-date", cutoff: "2026-10-20" });
  });
  it("regular → refused", () => {
    expect(cap("19/10/2026 10:15", "Regular Payment").outcome).toMatch(/^refused-/);
    expect(ned("19/10/2026", "Internet payment").outcome).toMatch(/^refused-/);
  });
});

describe("the SAST midnight boundary — the bank's date, to the minute", () => {
  it("2026-10-26 23:59 SAST regular → refused", () => {
    expect(cap("26/10/2026 23:59", "Regular Payment").outcome).toBe("refused-not-immediate");
  });
  it("2026-10-27 00:00 SAST regular → accepted", () => {
    expect(cap("27/10/2026 00:00", "Regular Payment").outcome).toBe("recorded");
  });
  it("is the SAST day, not the UTC one: 27 Oct 00:30 SAST is still 26 Oct in UTC", () => {
    const ts = Date.parse("2026-10-27T00:30:00+02:00");
    expect(new Date(ts).toISOString().slice(0, 10)).toBe("2026-10-26");
    expect(immediacyRequiredFor(ts)).toBe(false);
    expect(immediacyRequiredFor(Date.parse("2026-10-26T23:59:59+02:00"))).toBe(true);
  });
  it("no bank date at all is never treated as 27-or-later", () => {
    expect(immediacyRequiredFor(null)).toBe(true);
    expect(immediacyRequiredFor(undefined)).toBe(true);
  });
});

describe("a reader with no immediate signal: pre-27 refused, 27+ accepted", () => {
  const parsed = (iso) => ({ ok: true, amountCents: 30000, bankTs: Date.parse(iso), bankRef: "X1234", destBankName: "FIRST NATIONAL BANK", accountMask: "...004321" });
  it("a bank whose format carries no immediate field (not in IMMEDIATE_SIGNAL_READERS)", () => {
    const pre = immediacyVerdict({ parsed: parsed("2026-10-26T12:00:00+02:00"), reader: "tymebank", receivedAt: RECEIVED });
    expect(pre).toMatchObject({ ok: false, needsSample: true });
    expect(immediacyVerdict({ parsed: parsed("2026-10-27T12:00:00+02:00"), reader: "tymebank", receivedAt: RECEIVED })).toEqual({ ok: true });
  });
  it("a known reader whose signal could not be read (immediate: null)", () => {
    expect(ned("26/10/2026", "App payment").outcome).toBe("refused-not-immediate");
    expect(ned("27/10/2026", "App payment").outcome).toBe("recorded");
  });
});

describe("every other check is unchanged on a 27+ payment", () => {
  it("future-dated (dated after its notification arrived) still refuses", () => {
    expect(cap("30/10/2026 10:15", "Regular Payment").outcome).toBe("refused-not-immediate");
  });
  it("wrong account still refuses", () => {
    const lines = capitec("27/10/2026 10:15", "Regular Payment").map((l) => (l.startsWith("Account number") ? "Account number 62900009999" : l));
    expect(decide("capitecbank.co.za", "noreply@capitecbank.co.za", lines).outcome).toBe("refused-account");
  });
  it("failed DKIM still refuses", () => {
    const lines = capitec("27/10/2026 10:15", "Regular Payment");
    const reader = selectReader({ fromDomain: "capitecbank.co.za", lines });
    const parsed = reader.parse(lines);
    const forged = authenticationVerdict({ fromAddress: "noreply@capitecbank.co.za", headerLines: [
      { key: "authentication-results", line: "Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@evil.example header.s=s1 header.b=x;\r\n       spf=fail smtp.mailfrom=evil.example;\r\n       dmarc=fail (p=REJECT) header.from=capitecbank.co.za" },
      { key: "from", line: "From: <noreply@capitecbank.co.za>" },
    ] });
    expect(forged.pass).toBe(false);
    expect(eftPoolRecord({ message: { messageId: "<m@x>", from: "x", subject: "s", receivedAt: RECEIVED }, verdict: forged, parsed, account: null, timing: null, dated: null, reader: reader.id, rawText: "", at: RECEIVED }).outcome).toBe("refused-auth");
  });
});

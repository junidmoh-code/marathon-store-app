// ─── NEXT-BUSINESS-DAY SETTLEMENT (Junid, 7 Nov 2026) ────────────────────────
// A non-immediate EFT made on a weekend is dated by the payer's bank for the
// day it settles. RICHARD CHETTY's two Nedbank "Internet payment"s of Saturday
// 7 Nov 2026 — R1500 into the FNB account and R2450 into Concrete's
// immediate-only Standard Bank account — both print "Date of Payment :
// 09/11/2026" (Monday). They were DKIM-signed by nedbank.co.za and paid into
// the shop's own accounts, and were refused only as future-dated.
//
// Each case runs the poller's own chain (email-poller.mjs): reader → account
// (7a) → immediacy/date (7b) → cutoff (fix 8) → pool record → fingerprint.
// The fixture is the real notices' layout with the payer, reference, ids and
// account digits replaced (this repo is public).
import { describe, it, expect } from "vitest";
import { selectReader } from "./eftBanks.mjs";
import {
  authenticationVerdict, destinationVerdict, immediacyVerdict, paymentDateVerdict, parsePaymentDateCutoff,
  parseAccountPolicies, eftPoolRecord, applyFingerprintHold, paymentFingerprint, fingerprintClaimStep,
  nextBusinessDay, sastDate,
} from "./eftCore.mjs";

const FNB = "62900006625";
const SB = "10100008534";
const POLICIES = parseAccountPolicies(`${FNB}, ${SB}:standardbank:immediate`);
const sast = (iso) => Date.parse(`${iso}+02:00`);
const SATURDAY = sast("2026-11-07T14:22:21"); // when the R1500 notice arrived

const nedbank = ({ date = "09/11/2026", bank = "FIRST NATIONAL BANK", account = "...XX6625", amount = "R1500.00", channel = "Internet payment", id = "aaaaaaaa-1111-2222-a333-0b0c0d0e0f1" } = {}) => [
  "Notification of Payment",
  "Nedbank Limited confirms that the following payment has been made:",
  `Date of Payment : ${date}`,
  `Reference Number : ${id}`,
  "Beneficiary details",
  "Recipient : SHOP",
  `Amount : ${amount}`,
  "Recipient Reference : CUSTREF",
  ":",
  `Bank ${bank}`,
  ":",
  `Account Number ${account}`,
  ":",
  `Channel ${channel}`,
  "Payer details",
  "Paid from Account Holder : A CUSTOMER",
  "Payments may take up to three business days. Please check your account to verify the existence of the funds.",
];
const toConcrete = (o = {}) => nedbank({ bank: "STANDARD BANK OF SOUTH AFRICA", account: "...XX8534", amount: "R2450.00", id: "bbbbbbbb-1111-2222-a333-0b0c0d0e0f1", ...o });

const authFor = (dkim = "pass", domain = "nedbank.co.za") => authenticationVerdict({
  fromAddress: "Notification@nedbank.co.za",
  headerLines: [
    { key: "authentication-results", line: `Authentication-Results: mx.google.com;\r\n       dkim=${dkim} header.i=@${domain} header.s=s1 header.b=x;\r\n       spf=${dkim} smtp.mailfrom=${domain};\r\n       dmarc=${dkim} (p=REJECT) header.from=nedbank.co.za` },
    { key: "from", line: "From: \"Nedbank\" <Notification@nedbank.co.za>" },
  ],
});

/** The poller's chain for one notice. */
function decide(lines, { received = SATURDAY, auth = authFor(), cutoff } = {}) {
  const reader = selectReader({ fromDomain: "nedbank.co.za", lines });
  const parsed = reader.parse(lines);
  expect(parsed.ok, parsed.reason).toBe(true);
  const account = destinationVerdict({ accountMask: parsed.accountMask, destBankName: parsed.destBankName, allowedAccounts: POLICIES, configured: true });
  const timing = immediacyVerdict({ parsed, reader: reader.id, receivedAt: received, immediateOnly: account?.ok === true && account.immediateOnly === true });
  const dated = paymentDateVerdict({ parsed, cutoff: parsePaymentDateCutoff(cutoff) });
  const record = eftPoolRecord({
    message: { messageId: "<m@statements.nedbank.co.za>", from: "\"Nedbank\" <Notification@nedbank.co.za>", subject: "Payment Notification", receivedAt: received },
    verdict: auth, parsed, account, timing, dated, reader: reader.id, rawText: lines.join("\n"), at: received + 5000,
  });
  return { parsed, account, timing, record };
}

describe("the next business day", () => {
  it("refuses a date that is no date, and an unjudgeable payment fails closed", async () => {
    expect(nextBusinessDay("2026-02-31")).toBe(null);
    const { settlementDateVerdict } = await import("./eftCore.mjs");
    expect(settlementDateVerdict(null, SATURDAY).ok).toBe(false);
  });

  it("skips Saturday and Sunday", () => {
    expect(nextBusinessDay("2026-11-06")).toBe("2026-11-09"); // Friday → Monday
    expect(nextBusinessDay("2026-11-07")).toBe("2026-11-09"); // Saturday → Monday
    expect(nextBusinessDay("2026-11-08")).toBe("2026-11-09"); // Sunday → Monday
    expect(nextBusinessDay("2026-11-09")).toBe("2026-11-10"); // Monday → Tuesday
  });
});

describe("a Saturday notice dated the following Monday CONFIRMS", () => {
  it("Marathon FNB (…6625): R1500, Internet payment, dated 09/11", () => {
    const { account, record } = decide(nedbank());
    expect(account).toMatchObject({ ok: true, bank: "fnb", immediateOnly: false });
    expect(record).toMatchObject({ outcome: "recorded", status: "unmatched", amountCents: 150000, reader: "nedbank" });
    expect(sastDate(record.bankTs)).toBe("2026-11-09");
  });

  it("Concrete Standard (…8534, immediate-only): R2450, Internet payment, dated 09/11", () => {
    const { account, record } = decide(toConcrete(), { received: sast("2026-11-07T15:32:21") });
    expect(account).toMatchObject({ ok: true, bank: "standardbank", immediateOnly: true });
    expect(record).toMatchObject({ outcome: "recorded", status: "unmatched", amountCents: 245000 });
  });

  it("a Sunday notice and a FRIDAY notice dated Monday confirm too (Fridays allowed, 7 Nov 2026 evening)", () => {
    expect(decide(nedbank(), { received: sast("2026-11-08T10:00:00") }).record.outcome).toBe("recorded");
    expect(decide(toConcrete(), { received: sast("2026-11-06T18:00:00") }).record.outcome).toBe("recorded");
    // …but a Friday notice dated Tuesday is beyond the next business day.
    expect(decide(toConcrete({ date: "10/11/2026" }), { received: sast("2026-11-06T18:00:00") }).record.reason).toMatch(/beyond the next business day/);
  });
});

describe("dated the same day or earlier", () => {
  it("into the FNB account: confirms (regular payments allowed since 27 Oct)", () => {
    expect(decide(nedbank({ date: "07/11/2026" })).record.outcome).toBe("recorded");
    expect(decide(nedbank({ date: "06/11/2026" })).record.outcome).toBe("recorded");
  });

  it("an IMMEDIATE payment still confirms, into either account", () => {
    expect(decide(nedbank({ date: "07/11/2026", channel: "Immediate payment" })).record.outcome).toBe("recorded");
    expect(decide(toConcrete({ date: "07/11/2026", channel: "Immediate payment" })).record.outcome).toBe("recorded");
  });

  it("into Concrete's immediate-only account a NON-immediate payment dated the same day still refuses (the relaxation is the next-business-day window only)", () => {
    const { record } = decide(toConcrete({ date: "07/11/2026" }));
    expect(record.outcome).toBe("refused-not-immediate");
    expect(record.reason).toMatch(/IMMEDIATE payments only/);
  });
});

describe("dated BEYOND the next business day: REJECTED, saying so", () => {
  it("a week out — both accounts, the plain message", () => {
    for (const lines of [nedbank({ date: "14/11/2026" }), toConcrete({ date: "14/11/2026" })]) {
      const { timing, record } = decide(lines);
      expect(timing).toEqual({ ok: false, reason: "Payment dated 2026-11-14 — beyond the next business day, not treated as settled." });
      expect(record.outcome).toBe("refused-not-immediate");
      expect(record.reason).toBe("Payment dated 2026-11-14 — beyond the next business day, not treated as settled.");
    }
  });

  it("a Saturday notice dated Tuesday (one day past the next business day) refuses", () => {
    expect(decide(nedbank({ date: "10/11/2026" })).record.reason).toMatch(/^Payment dated 2026-11-10 — beyond the next business day/);
  });

  it("an immediate channel does not excuse a date beyond the next business day", () => {
    expect(decide(toConcrete({ date: "14/11/2026", channel: "Immediate payment" })).record.outcome).toBe("refused-not-immediate");
  });
});

describe("everything else is unchanged", () => {
  it("a DKIM-failed / forwarded copy is still refused, whatever its date", () => {
    expect(decide(nedbank(), { auth: authFor("fail") }).record.outcome).toBe("refused-auth");
    expect(decide(nedbank(), { auth: authFor("pass", "evil.example") }).record.outcome).toBe("refused-auth");
  });

  it("another account's digits refuse at the destination", () => {
    expect(decide(nedbank({ account: "...XX9999" })).record.outcome).toBe("refused-account");
  });

  it("the 2026-10-20 floor: a payment the bank dates before the cutoff refuses", () => {
    // Immediate, so that only the floor decides (before 27 Oct immediacy was required too).
    const { record } = decide(nedbank({ date: "19/10/2026", channel: "Immediate payment" }), { received: sast("2026-10-19T10:00:00"), cutoff: "2026-10-20" });
    expect(record.outcome).toBe("refused-stale-date");
  });

  it("dedupe: the same notice twice is one payment — the copy is HELD, never spendable", () => {
    const store = new Map();
    const ingest = (poolKey, record) => {
      const fp = paymentFingerprint(record);
      let holder = null;
      const next = fingerprintClaimStep(poolKey, record.at, (c) => { holder = c.holder; })(store.get(fp) ?? null);
      if (next !== undefined) store.set(fp, next);
      return applyFingerprintHold(record, { fingerprint: fp, holder, poolKey });
    };
    expect(ingest("a".repeat(40), decide(nedbank()).record)).toMatchObject({ outcome: "recorded", status: "unmatched" });
    const copy = ingest("b".repeat(40), decide(nedbank(), { received: SATURDAY + 60000 }).record);
    expect(copy.outcome).toBe("held-duplicate");
    expect(copy.status).toBeUndefined();
  });
});

// ─── SONNET ARCHITECT REVIEW OF #866 ─────────────────────────────────────────
describe("the window is for a later DATE; a same-day later TIME is still scheduled", () => {
  it("a timestamped payment dated hours after its notice the SAME day refuses", () => {
    const parsed = { ok: true, bankTs: SATURDAY + 4 * 60 * 60 * 1000, destBankName: "FIRST NATIONAL BANK", immediate: true, paymentType: "Immediate Payment" };
    const v = immediacyVerdict({ parsed, reader: "capitec", receivedAt: SATURDAY });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/scheduled for later today/);
    // Inside the 15-minute clock tolerance it passes, as before.
    expect(immediacyVerdict({ parsed: { ...parsed, bankTs: SATURDAY + 5 * 60 * 1000 }, reader: "capitec", receivedAt: SATURDAY }).ok).toBe(true);
  });

  it("narrowed (Junid, 7 Nov 2026): a WEEKDAY notice dated tomorrow is REFUSED as scheduled (Tuesday → Wednesday)", () => {
    const tuesday = sast("2026-11-10T10:00:00");
    for (const lines of [nedbank({ date: "11/11/2026" }), toConcrete({ date: "11/11/2026" }), nedbank({ date: "12/11/2026" })]) {
      const r = decide(lines, { received: tuesday }).record;
      expect(r.outcome).toBe("refused-not-immediate");
      expect(r.reason).toMatch(/a later day than 2026-11-10, a business day: a scheduled payment, not treated as settled/);
    }
    // Same day and earlier are still accepted on a weekday.
    expect(decide(nedbank({ date: "10/11/2026" }), { received: tuesday }).record.outcome).toBe("recorded");
    expect(decide(nedbank({ date: "09/11/2026" }), { received: tuesday }).record.outcome).toBe("recorded");
  });
});

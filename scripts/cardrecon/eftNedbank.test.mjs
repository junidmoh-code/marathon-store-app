// ─── NEDBANK — THE READER, AND THE 27 OCT R350 THAT MUST NEVER RE-FLOAT ─────
// The fixture is the real Nedbank Proof_Of_Payment.pdf of 2026-10-27 11:19
// SAST, line for line as the poller's PDF extraction gave it, sanitised of
// personal data (payer, reference, bank transaction id and account digits
// replaced; the layout, labels, stray colons, channel, footer, amount and date
// kept). It runs through the confirmer's own decision chain, exactly as the
// poller calls it, to the record it would write — and then through the
// fingerprint claim the poller makes and the check the settle makes.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { selectReader, EFT_READERS } from "./eftBanks.mjs";
import {
  authenticationVerdict, destinationVerdict, immediacyVerdict, paymentDateVerdict,
  parsePaymentDateCutoff, parseAllowedAccounts, eftPoolRecord, applyFingerprintHold,
  applyRefusalFingerprint, refusalFingerprint, paymentFingerprint, fingerprintClaimStep,
  rereadRefusal, settledFingerprintPlan, settledClaimStep, redactAccountDigits, sastDate,
} from "./eftCore.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { claimHolderCheck } = require("./lib/eft-fingerprint.cjs");

const REAL_NEDBANK_2710 = [
  "Notification of Payment",
  "Nedbank Limited confirms that the following payment has been made:",
  "Date of Payment : 27/10/2026",
  "Reference Number : 1a2b3c4d-1111-2222-a333-0b0c0d0e0f1",
  "Beneficiary details",
  "Recipient : Marathon",
  "Amount : R350.00",
  "Recipient Reference : Custref",
  ":",
  "Bank FIRST NATIONAL BANK",
  ":",
  "Account Number ...004321",
  ":",
  "Channel Internet payment",
  "Payer details",
  "Paid from Account Holder : A CUSTOMER",
  "Nedbank will never send you an e-mail link to access Verify payments, always go to Online Banking on",
  "www.nedbank.co.za and click on Verify payments.",
  "This notification of payment is sent to you by Nedbank Limited Reg No 1951/000009/06. Enquiries regarding this",
  "payment notification should be directed to the Nedbank Contact Centre on 0860 555 111. Please contact the payer for",
  "enquiries regarding the contents of this notification.",
  "Nedbank Ltd will not be held responsible for the accuracy of the information on this notification and we accept no liability",
  "whatsoever arising from the transmission and use of the information.",
  "Payments may take up to three business days. Please check your account to verify the existence of the funds.",
  "Note: We as a bank will never send you an e-mail requesting you to enter your personal details or private identification",
  "and authentication details.",
  "Nedbank Limited email disclaimer",
  "Security Code D6CA786CD7DC693B3B6EBABD0C40E8845E9CD186",
  ":",
];
// The email body, verbatim (htmlToText of the real message): no field at all.
const REAL_NEDBANK_BODY = [
  "A payment has been made to your account.",
  "To view the details of the payment, please open the attached PDF file.",
  "You may require Adobe Acrobat Reader on your computer to open the PDF file.",
  "Please do not reply as this email was sent from an unattended mailbox.",
];
const swap = (from, to, lines = REAL_NEDBANK_2710) => lines.map((l) => (l === from ? to : l));
const IMMEDIATE = swap("Channel Internet payment", "Channel Immediate payment");

// Gmail's real stamp on the 27 Oct Nedbank message (header.b shortened).
const NED_AUTH = authenticationVerdict({
  fromAddress: "Notification@nedbank.co.za",
  headerLines: [
    { key: "authentication-results", line: "Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@nedbank.co.za header.s=striatavm3a header.b=pMzNfQvv;\r\n       spf=pass (google.com: domain of tran01n-bounce-324038657-28x@statements.nedbank.co.za designates 168.142.192.170 as permitted sender) smtp.mailfrom=TRAN01N-bounce-324038657-28X@statements.nedbank.co.za;\r\n       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=nedbank.co.za" },
    { key: "from", line: "From: \"Nedbank\" <Notification@nedbank.co.za>" },
  ],
});
const FORGED_AUTH = authenticationVerdict({
  fromAddress: "Notification@nedbank.co.za",
  headerLines: [
    { key: "authentication-results", line: "Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@evil.example header.s=s1 header.b=x;\r\n       spf=fail smtp.mailfrom=evil.example;\r\n       dmarc=fail (p=REJECT) header.from=nedbank.co.za" },
    { key: "from", line: "From: \"Nedbank\" <Notification@nedbank.co.za>" },
  ],
});
const ALLOWED = parseAllowedAccounts("62900004321");
const RECEIVED = Date.parse("2026-10-27T09:19:28Z"); // 11:19 SAST, as the real one arrived
const message = (n = 1) => ({ messageId: `<32403865${n}-28@statements.nedbank.co.za>`, from: "\"Nedbank\" <Notification@nedbank.co.za>", subject: "Payment Notification", receivedAt: RECEIVED });

/** The poller's chain for one document: reader → 7a → 7b → fix 8 → the pool record. */
function decide(lines, { auth = NED_AUTH, received = RECEIVED, cutoff, n } = {}) {
  const reader = selectReader({ fromDomain: "nedbank.co.za", lines });
  const parsed = reader.parse(lines);
  const account = parsed.ok ? destinationVerdict({ accountMask: parsed.accountMask, destBankName: parsed.destBankName, allowedAccounts: ALLOWED, configured: true }) : null;
  const timing = parsed.ok ? immediacyVerdict({ parsed, reader: reader.id, receivedAt: received }) : null;
  const dated = parsed.ok ? paymentDateVerdict({ parsed, cutoff: parsePaymentDateCutoff(cutoff) }) : null;
  const record = eftPoolRecord({ message: { ...message(n), receivedAt: received }, verdict: auth, parsed, account, timing, dated, reader: reader.id, rawText: lines.join("\n"), at: received + 5000 });
  return { reader, parsed, account, timing, dated, record };
}

/** The poller's fingerprint step against an in-memory /eft_pool_fingerprints. */
function ingest(store, poolKey, record) {
  const fp = record.outcome === "recorded" ? paymentFingerprint(record) : refusalFingerprint(record);
  if (!fp) return applyFingerprintHold(record, { fingerprint: null, holder: null, poolKey });
  let holder = null;
  const next = fingerprintClaimStep(poolKey, record.at, (c) => { holder = c.holder; })(store.get(fp) ?? null);
  if (next !== undefined) store.set(fp, next);
  return record.outcome === "recorded"
    ? applyFingerprintHold(record, { fingerprint: fp, holder, poolKey })
    : applyRefusalFingerprint(record, { fingerprint: fp, holder, poolKey });
}
const KEY_A = "a".repeat(40), KEY_B = "b".repeat(40), MANUAL_KEY = "f".repeat(40);

describe("where a Nedbank notification's details live", () => {
  it("the email body carries nothing — no reader claims it, it never confirms", () => {
    expect(selectReader({ fromDomain: "nedbank.co.za", lines: REAL_NEDBANK_BODY })).toBe(null);
  });
  it("the attached PDF is claimed by the Nedbank reader — only from nedbank.co.za", () => {
    expect(EFT_READERS.map((r) => r.id)).toContain("nedbank");
    expect(selectReader({ fromDomain: "nedbank.co.za", lines: REAL_NEDBANK_2710 })?.id).toBe("nedbank");
    expect(selectReader({ fromDomain: "statements.nedbank.co.za", lines: REAL_NEDBANK_2710 })?.id).toBe("nedbank");
    expect(selectReader({ fromDomain: "fnb.co.za", lines: REAL_NEDBANK_2710 })).toBe(null);
    expect(selectReader({ fromDomain: "nedbank.co.za.evil.example", lines: REAL_NEDBANK_2710 })).toBe(null);
  });
  it("the real message is DKIM-verified Nedbank mail", () => {
    expect(NED_AUTH).toMatchObject({ pass: true, fromDomain: "nedbank.co.za", dkimDomain: "nedbank.co.za" });
  });
  it("reads every field from the PDF", () => {
    const { parsed } = decide(REAL_NEDBANK_2710);
    expect(parsed).toEqual({
      ok: true, amountCents: 35000, reference: "Custref", payer: "A CUSTOMER",
      bankTs: Date.parse("2026-10-27T00:00:00+02:00"),
      bankRef: "1a2b3c4d-1111-2222-a333-0b0c0d0e0f1",
      beneficiaryName: "Marathon", destBankName: "FIRST NATIONAL BANK",
      accountMask: "...004321", paymentType: "Internet payment", immediate: false,
    });
    expect(sastDate(parsed.bankTs)).toBe("2026-10-27"); // day-first: 27 can only be the day
  });
});

describe("the real 27 Oct notification ('Channel Internet payment') is NOT confirmed", () => {
  it("passes DKIM, destination and cutoff — and refuses as not immediate: Nedbank says it may take three business days", () => {
    const { account, timing, dated, record } = decide(REAL_NEDBANK_2710);
    expect(account.ok).toBe(true);
    expect(dated).toEqual({ ok: true });
    expect(timing.ok).toBe(false);
    expect(timing.reason).toMatch(/Not an immediate payment \(the bank prints "Internet payment"\)/);
    expect(record).toMatchObject({ outcome: "refused-not-immediate", reader: "nedbank", amountCents: 35000, bankRef: "1a2b3c4d-1111-2222-a333-0b0c0d0e0f1" });
    expect(record.status).toBeUndefined();
  });
  it("the footer's wording is never the marker", () => {
    const footerOnly = REAL_NEDBANK_2710.filter((l) => !/^Channel/.test(l)).concat("Immediate payment");
    expect(decide(footerOnly).parsed.immediate).toBe(null);
  });
  it("an unknown channel, a missing one or two different ones are unreadable, never assumed", () => {
    expect(decide(swap("Channel Internet payment", "Channel App payment")).parsed.immediate).toBe(null);
    expect(decide(REAL_NEDBANK_2710.filter((l) => !/^Channel/.test(l))).record.outcome).toBe("refused-not-immediate");
    const both = decide([...IMMEDIATE, "Channel Internet payment"]);
    expect(both.parsed.ok).toBe(true);
    expect(both.parsed.immediate).toBe(null);
  });
});

describe("a genuine immediate Nedbank payment confirms ONCE; a resend never re-floats", () => {
  it("DKIM + PDF + destination + immediate + dated after the cutoff → recorded, spendable", () => {
    const { timing, record } = decide(IMMEDIATE);
    expect(timing).toEqual({ ok: true });
    expect(record).toMatchObject({ outcome: "recorded", status: "unmatched", amountCents: 35000, reader: "nedbank" });
  });
  it("the first copy claims the bank id; the resend (new Message-ID, same Reference Number) is held-duplicate", () => {
    const store = new Map();
    const first = ingest(store, KEY_A, decide(IMMEDIATE, { n: 1 }).record);
    expect(first).toMatchObject({ outcome: "recorded", status: "unmatched" });
    const resend = ingest(store, KEY_B, decide(IMMEDIATE, { n: 2 }).record);
    expect(resend).toMatchObject({ outcome: "held-duplicate", duplicateOf: KEY_A });
    expect(resend.status).toBeUndefined();
    // …and the settle refuses the copy outright.
    expect(claimHolderCheck({ poolKey: KEY_B, holder: KEY_A }).ok).toBe(false);
  });
  it("the bank id is the dedupe key whatever its case or spacing", () => {
    const loud = swap("Reference Number : 1a2b3c4d-1111-2222-a333-0b0c0d0e0f1", "Reference Number : 1A2B3C4D 1111 2222 A333 0B0C0D0E0F1", IMMEDIATE);
    expect(paymentFingerprint({ reader: "nedbank", bankRef: decide(loud).parsed.bankRef }))
      .toBe(paymentFingerprint({ reader: "nedbank", bankRef: decide(IMMEDIATE).parsed.bankRef }));
  });
  it("a refused copy also claims the id, so changing the rule later cannot float its resend", () => {
    const store = new Map();
    const refused = ingest(store, KEY_A, decide(REAL_NEDBANK_2710).record);
    expect(refused).toMatchObject({ outcome: "refused-not-immediate", fingerprint: expect.any(String) });
    expect(ingest(store, KEY_B, decide(IMMEDIATE, { n: 2 }).record)).toMatchObject({ outcome: "held-duplicate", duplicateOf: KEY_A });
  });
});

describe("what is NOT confirmed", () => {
  it("a future-dated (scheduled) payment refuses even when the channel says immediate", () => {
    const later = swap("Date of Payment : 27/10/2026", "Date of Payment : 30/10/2026", IMMEDIATE);
    const { timing, record } = decide(later);
    expect(timing.reason).toMatch(/scheduled \/ future-dated/);
    expect(record.outcome).toBe("refused-not-immediate");
  });
  it("a payment into someone else's account refuses", () => {
    expect(decide(swap("Account Number ...004321", "Account Number ...998877", IMMEDIATE)).record.outcome).toBe("refused-account");
  });
  it("a payment into another bank — even an account ending the same — refuses", () => {
    expect(decide(swap("Bank FIRST NATIONAL BANK", "Bank NEDBANK", IMMEDIATE)).record.outcome).toBe("refused-account");
  });
  it("a payment the bank dates before the cutoff refuses (bank date, never the email's)", () => {
    const old = swap("Date of Payment : 27/10/2026", "Date of Payment : 19/10/2026", IMMEDIATE);
    expect(decide(old).record).toMatchObject({ outcome: "refused-stale-date", cutoff: "2026-10-20" });
  });
  it("an unreadable date refuses at the cutoff", () => {
    const bad = swap("Date of Payment : 27/10/2026", "Date of Payment : 31/02/2026", IMMEDIATE);
    expect(decide(bad).record.outcome).toBe("refused-stale-date");
  });
  it("a forged Nedbank notification refuses on auth, whatever its PDF says", () => {
    expect(FORGED_AUTH.pass).toBe(false);
    expect(decide(IMMEDIATE, { auth: FORGED_AUTH }).record.outcome).toBe("refused-auth");
  });
  it("a document missing its amount, account or carrying two payments refuses as unreadable", () => {
    // No Amount line: not even recognised as the Nedbank layout — the poller
    // refuses it as "the format may have changed" (noReaderReason).
    expect(selectReader({ fromDomain: "nedbank.co.za", lines: IMMEDIATE.filter((l) => !/^Amount/.test(l)) })).toBe(null);
    expect(decide(IMMEDIATE.filter((l) => !/^Account Number/.test(l))).parsed.ok).toBe(false);
    expect(decide(swap("Amount : R350.00", "Amount : R three fifty", IMMEDIATE)).parsed.ok).toBe(false);
    const two = [...IMMEDIATE, "Reference Number : 9f9f9f9f-0000-1111-2222-333333333333", "Amount : R350.00"];
    expect(decide(two).record.outcome).toBe("refused-parse");
  });
  it("no Reference Number → held, never spendable", () => {
    const store = new Map();
    const rec = ingest(store, KEY_A, decide(IMMEDIATE.filter((l) => !/^Reference Number/.test(l))).record);
    expect(rec.outcome).toBe("held-no-bankref");
  });
});

describe("the 27 Oct R350, settled by hand by Junid, can never re-float", () => {
  // The record the poller wrote before the reader existed: refused-parse,
  // reader null, no bank id, account digits struck from the raw text.
  const BODY = REAL_NEDBANK_BODY.join("<br>");
  const refusedParse = {
    at: RECEIVED + 5000, receivedAt: RECEIVED, outcome: "refused-parse", reader: null,
    auth: { verdict: "pass", fromDomain: "nedbank.co.za", dkimDomain: "nedbank.co.za" },
    messageId: message(1).messageId, from: message(1).from,
    rawText: redactAccountDigits(`${REAL_NEDBANK_2710.join("\n")}\n────────\n${BODY}`),
    reason: "No payment-notification reader exists for nedbank.co.za yet.",
  };
  const manual = { outcome: "recorded", status: "used", reader: "manual", manualEntry: { by: "Junid" }, amountCents: 35000, reference: "CUSTREF", bankRef: "MANUAL-FFFFFFFFFFFF" };
  const docText = REAL_NEDBANK_2710.join("\n");
  // The fetched message's own From and Date, as the script derives them.
  const FETCHED = { from: message(1).from, receivedAt: RECEIVED };
  const parse = selectReader({ fromDomain: "nedbank.co.za", lines: REAL_NEDBANK_2710 }).parse(REAL_NEDBANK_2710);

  it("the stored refusal has no bank id to claim, so the old script cannot mark it", () => {
    expect(refusalFingerprint(refusedParse)).toBe(null);
    expect(refusedParse.rawText).not.toContain("1a2b3c4d-1111-2222-a333-0b0c0d0e0f1");
  });
  it("re-read from its own message, it yields the bank id, spent by Junid's manual record", () => {
    const view = rereadRefusal({ record: refusedParse, readerId: "nedbank", parse, docText, fetched: FETCHED });
    expect(view.ok).toBe(true);
    const plan = settledFingerprintPlan({ refusedKey: KEY_A, refused: view.refused, spenderKey: MANUAL_KEY, spender: manual });
    expect(plan).toEqual({ ok: true, fingerprint: paymentFingerprint({ reader: "nedbank", bankRef: parse.bankRef }) });
  });
  it("after the mark, every copy — even one the reader would accept — is held, and the settle refuses it", () => {
    const fp = paymentFingerprint({ reader: "nedbank", bankRef: parse.bankRef });
    const store = new Map([[fp, settledClaimStep({ spenderKey: MANUAL_KEY, refusedKey: KEY_A, at: RECEIVED + 60000 })(null)]]);
    for (const [key, lines] of [[KEY_A, REAL_NEDBANK_2710], [KEY_B, IMMEDIATE]]) {
      const rec = ingest(store, key, decide(lines).record);
      expect(rec.status, key).toBeUndefined();
      expect(rec.duplicateOf).toBe(MANUAL_KEY);
      expect(claimHolderCheck({ poolKey: key, holder: MANUAL_KEY, spentBy: MANUAL_KEY })).toMatchObject({ ok: false, code: "duplicate-used" });
    }
    expect(ingest(store, KEY_B, decide(IMMEDIATE).record).outcome).toBe("held-duplicate");
  });
  it("a different message's document cannot stand in for the refused one", () => {
    const other = swap("Amount : R350.00", "Amount : R1410.00");
    const otherParse = selectReader({ fromDomain: "nedbank.co.za", lines: other }).parse(other);
    expect(rereadRefusal({ record: refusedParse, readerId: "nedbank", parse: otherParse, docText: other.join("\n"), fetched: FETCHED }).ok).toBe(false);
  });
  it("ids differing only inside struck-out digits read alike — the message's sender and arrival time still bind it", () => {
    const realId = swap("Reference Number : 1a2b3c4d-1111-2222-a333-0b0c0d0e0f1", "Reference Number : 12345678-1234-1234-1234-123456789012");
    const twinId = swap("Reference Number : 1a2b3c4d-1111-2222-a333-0b0c0d0e0f1", "Reference Number : 87654321-4321-4321-4321-000000789012");
    const rec = { ...refusedParse, rawText: redactAccountDigits(realId.join("\n")) };
    const twinParse = selectReader({ fromDomain: "nedbank.co.za", lines: twinId }).parse(twinId);
    // The raw text alone cannot tell them apart (the consistency check passes)…
    expect(rereadRefusal({ record: rec, readerId: "nedbank", parse: twinParse, docText: twinId.join("\n"), fetched: FETCHED }).ok).toBe(true);
    // …so a different message — later arrival, or another sender — refuses.
    expect(rereadRefusal({ record: rec, readerId: "nedbank", parse: twinParse, docText: twinId.join("\n"), fetched: { ...FETCHED, receivedAt: RECEIVED + 3600000 } }).ok).toBe(false);
    expect(rereadRefusal({ record: rec, readerId: "nedbank", parse: twinParse, docText: twinId.join("\n"), fetched: { ...FETCHED, from: "\"Nedbank\" <other@nedbank.co.za>" } }).ok).toBe(false);
    expect(rereadRefusal({ record: rec, readerId: "nedbank", parse: twinParse, docText: twinId.join("\n") }).ok).toBe(false);
  });
  it("a different payment (other amount) is never marked spent by the R350 manual record", () => {
    const view = rereadRefusal({ record: refusedParse, readerId: "nedbank", parse, docText, fetched: FETCHED });
    const plan = settledFingerprintPlan({ refusedKey: KEY_A, refused: { ...view.refused, amountCents: 141000 }, spenderKey: MANUAL_KEY, spender: manual });
    expect(plan.ok).toBe(false);
  });
  it("refuses a forgery's record, a record that already had a reader, and an unreadable document", () => {
    expect(rereadRefusal({ record: { ...refusedParse, auth: { verdict: "fail" } }, readerId: "nedbank", parse, docText, fetched: FETCHED }).ok).toBe(false);
    expect(rereadRefusal({ record: { ...refusedParse, reader: "nedbank" }, readerId: "nedbank", parse, docText, fetched: FETCHED }).ok).toBe(false);
    expect(rereadRefusal({ record: { ...refusedParse, outcome: "refused-not-immediate" }, readerId: "nedbank", parse, docText, fetched: FETCHED }).ok).toBe(false);
    expect(rereadRefusal({ record: refusedParse, readerId: "nedbank", parse: { ok: false, reason: "x" }, docText, fetched: FETCHED }).ok).toBe(false);
  });
});

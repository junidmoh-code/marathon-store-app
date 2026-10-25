// ─── FIX 7b FOR STANDARD BANK — THE HEADING, NEVER THE FOOTER ────────────────
// Junid, 25 Oct 2026. The fixture is the real R710 Standard Bank immediate
// payment of 2026-10-25 11h15, line for line as the PDF extraction gave it,
// sanitised of personal data (payer, reference, bank transaction id and
// account digits replaced; the layout, heading, footer, amount and date kept).
// It runs through the confirmer's own decision chain, exactly as the poller
// calls it, to the record it would write.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EFT_READERS, selectReader, standardBankHeading } from "./eftBanks.mjs";
import {
  authenticationVerdict, destinationVerdict, immediacyVerdict, paymentDateVerdict,
  parsePaymentDateCutoff, parseAllowedAccounts, eftPoolRecord,
} from "./eftCore.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const REAL_SB_IMMEDIATE_2510 = [
  "Internet Banking",
  "Standard Bank Centre",
  "5 Simmonds Street, Johannesburg, 2001",
  "P.O. Box 7725, Johannesburg, 2000",
  "Telephone: 0860 123 000",
  "International: +27 11 299 4701",
  "Fax: +27 11 631 8550",
  "Website: www.standardbank.co.za",
  "Dear MARATHON CLUB",
  "Immediate Payment Confirmation",
  "We confirm that the following payment has been made into your account from A CUSTOMER:",
  "Reference number 261025SBGRPP00000001C00000001",
  "Beneficiary name MARATHON CLUB",
  "Bank name FIRST NATIONAL BANK",
  "Beneficiary account number XXXXXXXXXXXXX4321",
  "Beneficiary branch number 250655",
  "Beneficiary reference REF710",
  "Amount R710.00",
  "Payment date and time 2026-10-25 11h15",
  "If you need more information or have any questions about this payment, please contact:",
  "A CUSTOMER",
  "Immediate payments may take a few hours.",
  "Non-immediate payments to Standard Bank accounts may take up to 24 hours.",
  "Non-immediate payments to other banks may take up to three business days.",
  "Please check your account to confirm you have received this payment.",
  "Yours sincerely,",
  "The Internet Banking Team",
  "The Standard Bank of South Africa Limited (Reg. No. 1962/000738/06) Authorised financial services provider and registered credit provider (NCRCP15)",
];
const HEADING = "Immediate Payment Confirmation";
const FOOTER_IMMEDIATE = REAL_SB_IMMEDIATE_2510.filter((l) => /immediate/i.test(l) && l !== HEADING);
const withHeading = (h) => REAL_SB_IMMEDIATE_2510.map((l) => (l === HEADING ? h : l)).filter((l) => l !== null);

// Gmail's real stamp on a Standard Bank message (eftCore.test.mjs).
const SB_AUTH = authenticationVerdict({
  fromAddress: "noreply@standardbank.co.za",
  headerLines: [
    { key: "authentication-results", line: "Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@standardbank.co.za header.s=myupdates2a header.b=sosrp8N9;\r\n       spf=pass (google.com: domain of bounce@myupdates1.standardbank.co.za designates 196.8.104.111 as permitted sender) smtp.mailfrom=bounce@myupdates1.standardbank.co.za;\r\n       dmarc=pass (p=REJECT sp=NONE dis=NONE) header.from=standardbank.co.za" },
    { key: "from", line: "From: <noreply@standardbank.co.za>" },
  ],
});
const ALLOWED = parseAllowedAccounts("62900004321");
const RECEIVED = Date.parse("2026-10-25T09:33:12Z");   // 11:33 SAST, as the real one arrived
const message = { messageId: "<x-2@myupdates1.standardbank.co.za>", from: "noreply@standardbank.co.za", subject: "Payment confirmation 3723", receivedAt: RECEIVED };

/** The poller's chain for one document: reader → 7a → 7b → fix 8 → the pool record. */
function decide(lines, { auth = SB_AUTH } = {}) {
  const reader = selectReader({ fromDomain: "standardbank.co.za", lines });
  const parsed = reader.parse(lines);
  const account = destinationVerdict({ accountMask: parsed.accountMask, destBankName: parsed.destBankName, allowedAccounts: ALLOWED, configured: true });
  const timing = immediacyVerdict({ parsed, reader: reader.id, receivedAt: RECEIVED });
  const dated = paymentDateVerdict({ parsed, cutoff: parsePaymentDateCutoff(undefined) });
  const record = eftPoolRecord({ message, verdict: auth, parsed, account, timing, dated, reader: reader.id, rawText: lines.join("\n"), at: RECEIVED + 5000 });
  return { reader, parsed, account, timing, dated, record };
}

describe("the real 25 Oct R710 Standard Bank immediate payment", () => {
  it("is DKIM-verified Standard Bank mail, read by the Standard Bank reader", () => {
    expect(SB_AUTH.pass).toBe(true);
    expect(selectReader({ fromDomain: "standardbank.co.za", lines: REAL_SB_IMMEDIATE_2510 })?.id).toBe("standardbank");
  });

  it("reads as IMMEDIATE from its heading, and passes every check to a spendable record", () => {
    const { parsed, account, timing, dated, record } = decide(REAL_SB_IMMEDIATE_2510);
    expect(parsed).toMatchObject({ ok: true, amountCents: 71000, immediate: true, paymentType: "Immediate Payment Confirmation", destBankName: "FIRST NATIONAL BANK" });
    expect(account.ok).toBe(true);           // 7a: into the shop's FNB account
    expect(timing).toEqual({ ok: true });    // 7b: now immediate
    expect(dated).toEqual({ ok: true });     // fix 8: 2026-10-25 is after the cutoff
    expect(record).toMatchObject({ outcome: "recorded", status: "unmatched", amountCents: 71000 });
    expect(record.needsSample).toBeUndefined();
  });

  it("the heading tolerates case and spacing", () => {
    for (const h of ["IMMEDIATE PAYMENT CONFIRMATION", "  Immediate   Payment\tConfirmation  ", "immediate payment confirmation"]) {
      expect(standardBankHeading(withHeading(h)).immediate, h).toBe(true);
    }
  });
});

describe("a Standard Bank 'Payment Confirmation' (no 'Immediate' in the title) still refuses", () => {
  it("the same document headed plain 'Payment Confirmation' is NOT immediate — refused-not-immediate", () => {
    const { parsed, account, timing, record } = decide(withHeading("Payment Confirmation"));
    expect(parsed).toMatchObject({ immediate: false, paymentType: "Payment Confirmation" });
    expect(account.ok).toBe(true);
    expect(timing.ok).toBe(false);
    expect(timing.reason).toMatch(/Not an immediate payment \(the bank prints "Payment Confirmation"\)/);
    expect(record.outcome).toBe("refused-not-immediate");
  });
});

describe("THE FOOTER IS NEVER THE MARKER", () => {
  it("the real footer mentions immediate payments on every confirmation", () => {
    expect(FOOTER_IMMEDIATE).toEqual([
      "Immediate payments may take a few hours.",
      "Non-immediate payments to Standard Bank accounts may take up to 24 hours.",
      "Non-immediate payments to other banks may take up to three business days.",
    ]);
  });

  it("footer boilerplate + a non-immediate title refuses", () => {
    const { parsed, record } = decide(withHeading("Payment Confirmation"));
    expect(parsed.immediate).toBe(false);
    expect(record.outcome).toBe("refused-not-immediate");
  });

  it("footer boilerplate and NO heading at all refuses (unreadable, not assumed)", () => {
    const { parsed, timing, record } = decide(withHeading(null));
    expect(parsed.immediate).toBe(null);
    expect(timing.reason).toMatch(/could not be read/);
    expect(record.outcome).toBe("refused-not-immediate");
  });

  it("the heading phrase inside a sentence, or below the confirmation, does not count", () => {
    const noHead = withHeading(null);
    const inSentence = noHead.map((l) => (l === "Yours sincerely," ? "This is not an Immediate Payment Confirmation." : l));
    expect(standardBankHeading(inSentence).immediate).toBe(null);
    const below = [...noHead, "Immediate Payment Confirmation"];
    expect(standardBankHeading(below).immediate).toBe(null);
  });

  it("a heading the extraction merged into another line does not count", () => {
    const merged = withHeading(null).map((l) => (l === "Dear MARATHON CLUB" ? "Dear MARATHON CLUB Immediate Payment Confirmation" : l));
    expect(standardBankHeading(merged).immediate).toBe(null);
  });

  it("two different headings contradict — refused", () => {
    const both = REAL_SB_IMMEDIATE_2510.flatMap((l) => (l === HEADING ? [HEADING, "Payment Confirmation"] : [l]));
    expect(standardBankHeading(both)).toEqual({ immediate: null, paymentType: "contradictory headings" });
    expect(decide(both).record.outcome).toBe("refused-not-immediate");
  });
});

describe("trusted only from DKIM-verified Standard Bank mail", () => {
  it("the same immediate document on a message that failed DKIM is refused-auth, whatever it says", () => {
    const forged = { pass: false, fromDomain: "standardbank.co.za", dkimDomain: "evil.example", detail: "not aligned" };
    expect(decide(REAL_SB_IMMEDIATE_2510, { auth: forged }).record.outcome).toBe("refused-auth");
  });

  it("the Standard Bank layout from any other domain is nobody's", () => {
    expect(selectReader({ fromDomain: "gmail.com", lines: REAL_SB_IMMEDIATE_2510 })).toBe(null);
    expect(selectReader({ fromDomain: "fnb.co.za", lines: REAL_SB_IMMEDIATE_2510 })).toBe(null);
  });

  it("the poller offers documents to a reader only after DKIM passed", () => {
    const src = readFileSync(resolve(HERE, "email-poller.mjs"), "utf8");
    const calls = [...src.matchAll(/selectReader\(/g)];
    expect(calls).toHaveLength(1);
    const gate = src.lastIndexOf("if (!verdict.pass) {", calls[0].index);
    const elseAt = src.indexOf("} else {", gate);
    expect(gate).toBeGreaterThan(0);
    expect(elseAt).toBeLessThan(calls[0].index);
  });
});

it("only Standard Bank changed: the reader set is the same four", () => {
  expect(EFT_READERS.map((r) => r.id)).toEqual(["standardbank", "fnb", "capitec", "absa"]);
});

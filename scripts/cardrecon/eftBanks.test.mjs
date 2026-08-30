// ─── PER-BANK READERS — tested against the REAL document ─────────────────────
// THE FIXTURE IS THE REAL R100 TEST PAYMENT of 2026-08-30 ("Payment
// confirmation 4401"): the exact lines functions/cardRecon/pdfText.js
// extracted from its PaymentConfirmation.pdf, so the reader can never regress
// to a reconstruction of the format. SANITISED for a public repo, structure
// untouched: the payer's name is replaced (a real person's), the bank's
// transaction reference is renumbered, and the destination account tail is
// changed (the real allowlist lives only in the .env on the mini). Every
// label, ordering and spacing is verbatim.
import { describe, it, expect } from "vitest";
import { EFT_READERS, selectReader, noReaderReason } from "./eftBanks.mjs";

const REAL_SB_PDF_LINES = [
  "Internet Banking",
  "Standard Bank Centre",
  "5 Simmonds Street, Johannesburg, 2001",
  "P.O. Box 7725, Johannesburg, 2000",
  "Telephone: 0860 123 000",
  "International: +27 11 299 4701",
  "Fax: +27 11 631 8550",
  "Website: www.standardbank.co.za",
  "Dear Marathon",
  "We confirm that the following payment has been made into your account from J SOAP:",
  "Reference number 4149999999",
  "Beneficiary name ATUGAR TRADING",
  "Bank name FIRST NATIONAL BANK",
  "Beneficiary account number XXXXXXXXXXXX4321",
  "Beneficiary branch number 25065500",
  "Beneficiary reference OM82",
  "Amount R100.00",
  "Payment date and time 2026-08-30 23h48",
  "If you need more information or have any questions about this payment, please contact:",
  "J SOAP",
  "Payments to Standard Bank accounts may take up to one business day to reflect.",
  "Payments to other banks may take up to three business days.",
  "Please check your account to confirm you have received this payment.",
  "Yours sincerely,",
  "The Internet Banking Team",
];

const sb = EFT_READERS.find((r) => r.id === "standardbank");

describe("the Standard Bank reader — built from the real notification", () => {
  it("selectReader picks it for the real document from the real domain (subdomains too)", () => {
    expect(selectReader({ fromDomain: "standardbank.co.za", lines: REAL_SB_PDF_LINES })?.id).toBe("standardbank");
    expect(selectReader({ fromDomain: "myupdates2.standardbank.co.za", lines: REAL_SB_PDF_LINES })?.id).toBe("standardbank");
  });

  it("a Standard Bank layout arriving from ANOTHER bank's domain is nobody's — content and sender must agree", () => {
    expect(selectReader({ fromDomain: "fnb.co.za", lines: REAL_SB_PDF_LINES })).toBe(null);
  });

  it("does not claim a batch-report-shaped document", () => {
    expect(sb.detect(["BATCH REPORT", "TERMINAL ID 0000HP1X", "BATCH NUMBER (#494)"])).toBe(false);
  });

  it("reads every field of the real document exactly", () => {
    expect(sb.parse(REAL_SB_PDF_LINES)).toEqual({
      ok: true,
      amountCents: 10000,
      reference: "OM82",
      payer: "J SOAP",
      // 2026-08-30 23h48 SAST = 21:48 UTC
      bankTs: Date.UTC(2026, 7, 30, 21, 48, 0),
      bankRef: "4149999999",
      beneficiaryName: "ATUGAR TRADING",
      destBankName: "FIRST NATIONAL BANK",
      accountMask: "XXXXXXXXXXXX4321",
    });
  });

  it("keeps the two references apart: Beneficiary reference is the matching key, Reference number is the bank's", () => {
    const p = sb.parse(REAL_SB_PDF_LINES);
    expect(p.reference).toBe("OM82");
    expect(p.bankRef).toBe("4149999999");
  });

  it("REFUSES a document with no Amount line", () => {
    const p = sb.parse(REAL_SB_PDF_LINES.filter((l) => !/^Amount /.test(l)));
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/no Amount line/);
  });

  it("REFUSES two Amount lines that disagree — never picks one", () => {
    const p = sb.parse([...REAL_SB_PDF_LINES, "Amount R999.00"]);
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/appears 2 times/);
  });

  it("REFUSES a mangled amount — the fuzzed card-recon money parser is the judge", () => {
    const lines = REAL_SB_PDF_LINES.map((l) => (l === "Amount R100.00" ? "Amount R10,0.00" : l));
    const p = sb.parse(lines);
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/does not parse exactly/);
  });

  it("REFUSES a document with no Beneficiary account number — the allowlist cannot be checked", () => {
    const p = sb.parse(REAL_SB_PDF_LINES.filter((l) => !/^Beneficiary account number /.test(l)));
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/destination account cannot be checked/);
  });

  it("REFUSES contradictory Beneficiary references", () => {
    const p = sb.parse([...REAL_SB_PDF_LINES, "Beneficiary reference SOMETHING ELSE"]);
    expect(p.ok).toBe(false);
  });

  it("a missing payer or date does not refuse the payment — those fields land null", () => {
    const lines = REAL_SB_PDF_LINES.filter((l) => !/into your account from|^Payment date|^J SOAP$/.test(l));
    const p = sb.parse(lines);
    expect(p.ok).toBe(true);
    expect(p.payer).toBe(null);
    expect(p.bankTs).toBe(null);
  });
});

describe("the missing-reader refusal is a work order", () => {
  it("an unknown bank names the domain and where the reader goes", () => {
    const reason = noReaderReason("capitecbank.co.za");
    expect(reason).toContain("capitecbank.co.za");
    expect(reason).toContain("eftBanks.mjs");
  });
  it("a known bank whose layout stopped matching says the format may have changed", () => {
    expect(noReaderReason("standardbank.co.za")).toMatch(/may have changed/);
  });
});

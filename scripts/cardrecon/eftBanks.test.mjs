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

  it("REFUSES a document holding TWO payment blocks — even identical ones (a reprint and a double-payment look the same)", () => {
    const p = sb.parse([...REAL_SB_PDF_LINES, ...REAL_SB_PDF_LINES]);
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/2 payment blocks/);
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

// ─── FNB — the real notification of 2026-08-31, pinned ───────────────────────
// The refused-parse record's stored raw text IS this fixture (digits
// sanitised, layout untouched): FNB's two-column PDF interleaves through
// pdfText's Y-grouping so the right column's values land on the line BEFORE
// their labels ("10:11:39" above "Time Actioned :", "MR M" above
// "Reference :", "ZAR30.00" above "Cur/Amount"). The reader must read both
// the inline and the value-above-label shapes — and refuse anything else.
import { EFT_READERS, selectReader as selectReader2 } from "./eftBanks.mjs";

const FNB_LINES = [
  "NOTIFICATION OF PAYMENT",
  "Dear: Payment Notification",
  "First National Bank hereby confirms that the following payment instruction has been received:",
  "Date Actioned : 2026/08/31",
  "10:11:39",
  "Time Actioned :",
  "Trace ID : 5TG59DVQ",
  "Payer Details",
  "Payment From MARA-THONE TRADING",
  "ZAR30.00",
  "Cur/Amount",
  "Payee Details",
  "Recipient/Account no : ..3456625",
  "Marathon club",
  "Name :",
  "Bank : FIRST NATIONAL BANK",
  "Branch Code : 250655",
  "MR M",
  "Reference :",
  "END OF NOTIFICATION",
  "To authenticate this Payment Notification, please visit the First National Bank website at fnb.co.za, select the “Verify Payments” link and follow the on-screen",
  "instructions.",
];

describe("FNB reader", () => {
  const fnb = EFT_READERS.find((r) => r.id === "fnb");

  it("claims the real notification by content, from the fnb.co.za domain only", () => {
    expect(selectReader2({ fromDomain: "fnb.co.za", lines: FNB_LINES })?.id).toBe("fnb");
    expect(selectReader2({ fromDomain: "standardbank.co.za", lines: FNB_LINES })).toBe(null);
  });

  it("reads every field of the real layout, value-above-label included", () => {
    const p = fnb.parse(FNB_LINES);
    expect(p.ok).toBe(true);
    expect(p.amountCents).toBe(3000);
    expect(p.reference).toBe("MR M");          // the line ABOVE "Reference :"
    expect(p.payer).toBe("MARA-THONE TRADING");
    expect(p.bankRef).toBe("5TG59DVQ");
    expect(p.accountMask).toBe("..3456625");
    expect(p.beneficiaryName).toBe("Marathon club"); // above "Name :"
    expect(p.destBankName).toBe("FIRST NATIONAL BANK");
    // 2026/08/31 10:11:39 SAST
    expect(p.bankTs).toBe(Date.UTC(2026, 7, 31, 10, 11, 39) - 2 * 3600 * 1000);
  });

  it("a missing reference still lands — the amount search exists for exactly that", () => {
    const lines = FNB_LINES.filter((l) => l !== "MR M" && l !== "Reference :");
    const p = fnb.parse(lines);
    expect(p.ok).toBe(true);
    expect(p.reference).toBe(null);
  });

  it("a bare label whose previous line is ANOTHER label reads as absent, never as the label", () => {
    // Layout shift: "Reference :" directly under "Branch Code : 250655".
    const lines = FNB_LINES.filter((l) => l !== "MR M");
    const p = fnb.parse(lines);
    expect(p.ok).toBe(true);
    expect(p.reference).toBe(null);
  });

  it("refuses two different amount lines, a missing account, and two Trace IDs", () => {
    expect(fnb.parse([...FNB_LINES, "ZAR99.00"]).ok).toBe(false);
    expect(fnb.parse(FNB_LINES.filter((l) => !l.startsWith("Recipient/Account no"))).ok).toBe(false);
    expect(fnb.parse([...FNB_LINES, "Trace ID : OTHER1"]).ok).toBe(false);
  });

  it("a duplicated page header (same values twice) is one payment, not a refusal", () => {
    const p = fnb.parse([...FNB_LINES.slice(0, 7), ...FNB_LINES]);
    // Two identical "Trace ID : 5TG59DVQ" lines = a reprint of the header —
    // but the reader counts Trace ID LINES, so this is the double-payment
    // refusal. Pin the behaviour either way so a change is a decision.
    expect(p.ok).toBe(false);
  });

  it("the zero amount refuses", () => {
    const lines = FNB_LINES.map((l) => (l === "ZAR30.00" ? "ZAR0.00" : l));
    expect(fnb.parse(lines).ok).toBe(false);
  });
});

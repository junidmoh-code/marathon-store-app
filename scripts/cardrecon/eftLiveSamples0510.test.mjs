// ─── FIX 7 AGAINST THE 5 OCT 2026 LIVE TEST PAYMENTS ─────────────────────────
// Junid paid R10/R9 into the shop's FNB account from Capitec, Standard Bank,
// Absa and FNB to test the pool end to end. These are those notifications'
// extracted lines (pdfToLines, exactly as the poller saw them), SANITISED for
// this public repo: payer names, references, bank transaction ids and account
// digits are replaced; the layout and every label are the bank's own.
//
// What they proved:
//  - Capitec prints "Regular Payment" vs "Immediate Payment" — 7b reads it.
//  - Absa prints "Immediate payment:" Y / N — 7b reads it. Absa's IMMEDIATE
//    notification printed NO transaction number (held-no-bankref upstream).
//  - Absa names the destination bank "FIRSTRAND" (FNB's legal entity) — 7a
//    refused every Absa payment until it accepted that name.
//  - FNB and Standard Bank print NO immediate/normal field at all, so 7b keeps
//    refusing them (needsSample) rather than guessing.
import { describe, it, expect } from "vitest";
import { selectReader } from "./eftBanks.mjs";
import { parseAllowedAccounts, destinationVerdict, immediacyVerdict } from "./eftCore.mjs";

const CAPITEC_REGULAR = [
  "One of the Global One money management products or services",
  "Payment Notification",
  "SkyQR reference: 0000-0000-0001",
  "Capitec Bank",
  "05/10/2026",
  "Branch: 250655",
  "Device: 9003",
  "Dear Sir/Madam",
  "Please take note that Payer made a payment to your account. The payment details are as follows:",
  "Notification number 400001",
  "Payment date 05/10/2026 11:30",
  "Payment details",
  "Beneficiary name Marathon club",
  "Bank name First National Bank",
  "Account number 62900004321",
  "Branch 250655",
  "Payment type Regular Payment",
  "Amount R10.00",
  "Payment reference N PAYER",
  "IMPORTANT NOTES:",
  "Immediate payments to non-Capitec banking clients and regular payments made to Capitec clients will reflect in the beneficiaries account",
  "immediately.",
  "Regular payments made to non-Capitec banking clients BEFORE 02:00 PM Monday to Friday, or BEFORE 09:00 AM on a Saturday should",
  "reflect in the beneficiary account the following business (work) day.",
  "Regular payments made to non-Capitec banking clients AFTER 02:00 PM Monday to Friday, or AFTER 09:00 AM on a Saturday, or on a",
  "Sunday, or on a public holiday should reflect in the beneficiary account within 2 business (work) days.",
  "This is a notification that we received instruction to effect a payment and not a representation of any kind or guarantee that the amount has in",
  "fact been transferred or shall be available in the account. The processing of the payment may be delayed, which may impact on the timing of",
  "the availability of the funds.",
  "Remote Banking Services",
  "24hr Client Care Centre 0860 10 20 43 E ClientCare@capitecbank.co.za capitecbank.co.za",
  "Capitec Bank is an authorised financial services (FSP46669) and registered credit provider (NCRCP13). Capitec Bank Limited Reg. No.: 1980/003695/06. Page 1 of 1",
  "Unique Document No.: 00000000-0000-0000-0000-000000000001 / 903(1) / V1.0 - 08/03/2019"
];

const CAPITEC_IMMEDIATE = [
  "One of the Global One money management products or services",
  "Payment Notification",
  "SkyQR reference: 0000-0000-0002",
  "Capitec Bank",
  "05/10/2026",
  "Branch: 250655",
  "Device: 9003",
  "Dear Sir/Madam",
  "Please take note that Payer made a payment to your account. The payment details are as follows:",
  "Notification number 400002",
  "Payment date 05/10/2026 11:36",
  "Payment details",
  "Beneficiary name Marathon club",
  "Bank name First National Bank",
  "Account number 62900004321",
  "Branch 250655",
  "Payment type Immediate Payment",
  "Amount R9.00",
  "Payment reference N PAYER",
  "IMPORTANT NOTES:",
  "Immediate payments to non-Capitec banking clients and regular payments made to Capitec clients will reflect in the beneficiaries account",
  "immediately.",
  "Regular payments made to non-Capitec banking clients BEFORE 02:00 PM Monday to Friday, or BEFORE 09:00 AM on a Saturday should",
  "reflect in the beneficiary account the following business (work) day.",
  "Regular payments made to non-Capitec banking clients AFTER 02:00 PM Monday to Friday, or AFTER 09:00 AM on a Saturday, or on a",
  "Sunday, or on a public holiday should reflect in the beneficiary account within 2 business (work) days.",
  "This is a notification that we received instruction to effect a payment and not a representation of any kind or guarantee that the amount has in",
  "fact been transferred or shall be available in the account. The processing of the payment may be delayed, which may impact on the timing of",
  "the availability of the funds.",
  "Remote Banking Services",
  "24hr Client Care Centre 0860 10 20 43 E ClientCare@capitecbank.co.za capitecbank.co.za",
  "Capitec Bank is an authorised financial services (FSP46669) and registered credit provider (NCRCP13). Capitec Bank Limited Reg. No.: 1980/003695/06. Page 1 of 1",
  "Unique Document No.: 00000000-0000-0000-0000-000000000002 / 903(1) / V1.0 - 08/03/2019"
];

const STANDARDBANK_0510 = [
  "Internet Banking",
  "Standard Bank Centre",
  "5 Simmonds Street, Johannesburg, 2001",
  "P.O. Box 7725, Johannesburg, 2000",
  "Telephone: 0860 123 000",
  "International: +27 11 299 4701",
  "Fax: +27 11 631 8550",
  "Website: www.standardbank.co.za",
  "Dear Shop",
  "We confirm that the following payment has been made into your account from A PAYER:",
  "Reference number 4100000001",
  "Beneficiary name SHOP TRADING",
  "Bank name FIRST NATIONAL BANK",
  "Beneficiary account number XXXXXXXXXXXX4321",
  "Beneficiary branch number 25065500",
  "Beneficiary reference REF1",
  "Amount R10.00",
  "Payment date and time 2026-10-05 11h44",
  "If you need more information or have any questions about this payment, please contact:",
  "A PAYER",
  "Payments to Standard Bank accounts may take up to one business day to reflect.",
  "Payments to other banks may take up to three business days.",
  "Please check your account to confirm you have received this payment.",
  "Yours sincerely,",
  "The Internet Banking Team",
  "The Standard Bank of South Africa Limited (Reg. No. 1962/000738/06) Authorised financial services provider and registered credit provider (NCRCP15)",
  "Directors: NMC Nyembezi (Chairman) DWP Hodnett* (Chief Executive Officer) HJ Berrange PLH Cook A Daehnke* OA David-Borha1 GMB Kennealy BJ Kruger Li Li2 RN Ogega3 Fenglin",
  "Tian2 SK Tshabalala*",
  "Company Secretary: K Froneman - 2026/06/08",
  "*Executive Director 1Nigerian 2Chinese 3Kenyan"
];

const ABSA_IMMEDIATE_NO_TXN = [
  "05 October 2026",
  "Notice of Payment",
  "Dear Marathon club",
  "Subject: Notice Of Payment: Marathon club",
  "Please be advised that MR A PAYER made a payment to your account as indicated below.",
  "Transaction number:",
  "Payment date:",
  "2026-10-05",
  "Payment made by: MR A PAYER",
  "Payment made to:",
  "Marathon club",
  "Beneficiary bank name: FIRSTRAND",
  "Beneficiary account number: 62900004321",
  "Bank branch code: 250655",
  "For the amount of: 10.00",
  "Immediate payment:",
  "Y",
  "Reference on beneficiary statement: test",
  "View your account to confirm that you have received this payment as the following applies to online banking",
  "payments into non-ABSA and Absa Vehicle and Asset Finance bank accounts.",
  "• Payments made on weekdays before 15:30 will be credited to the receiving bank account by midnight of the same day.",
  "• Payments made on weekdays after 15:30 will be credited by midnight of the following day.",
  "• Payments made on a Saturday, Sunday or Public holiday will be credited to the account by midnight of the 1st",
  "following weekday.",
  "• Payments may take up to 30 minutes to reflect in the beneficiary's Vehicle Finance Account.",
  "If you need more information or assistance, please call us on 0860008600 or +2711 501 5110 (International calls).",
  "If you have made an incorrect internet banking payment, please send an email to digital@absa.co.za",
  "Yours sincerely",
  "General Manager: Digital Channels",
  "This document is intended for use by the addressee and is privileged and confidential. If the transmission has been",
  "misdirected to you, please contact us immediately. Thank you.",
  "Absa Bank Limited Reg No 1986/004794/06 Authorised Financial Services and Registered Credit Provider Reg No NCRCP7 Company Information: www.absa.co.za"
];

const ABSA_NORMAL = [
  "05 October 2026",
  "Notice of Payment",
  "Dear Marathon club",
  "Subject: Notice Of Payment: Marathon club",
  "Please be advised that MR A PAYER made a payment to your account as indicated below.",
  "Transaction number: 80A0A0A0A0-1",
  "Payment date:",
  "2026-10-05",
  "Payment made by: MR A PAYER",
  "Payment made to:",
  "Marathon club",
  "Beneficiary bank name: FIRSTRAND",
  "Beneficiary account number: 62900004321",
  "Bank branch code: 250655",
  "For the amount of: 9.00",
  "Immediate payment:",
  "N",
  "Reference on beneficiary statement: test",
  "View your account to confirm that you have received this payment as the following applies to online banking",
  "payments into non-ABSA and Absa Vehicle and Asset Finance bank accounts.",
  "• Payments made on weekdays before 15:30 will be credited to the receiving bank account by midnight of the same day.",
  "• Payments made on weekdays after 15:30 will be credited by midnight of the following day.",
  "• Payments made on a Saturday, Sunday or Public holiday will be credited to the account by midnight of the 1st",
  "following weekday.",
  "• Payments may take up to 30 minutes to reflect in the beneficiary's Vehicle Finance Account.",
  "If you need more information or assistance, please call us on 0860008600 or +2711 501 5110 (International calls).",
  "If you have made an incorrect internet banking payment, please send an email to digital@absa.co.za",
  "Yours sincerely",
  "General Manager: Digital Channels",
  "This document is intended for use by the addressee and is privileged and confidential. If the transmission has been",
  "misdirected to you, please contact us immediately. Thank you.",
  "Absa Bank Limited Reg No 1986/004794/06 Authorised Financial Services and Registered Credit Provider Reg No NCRCP7 Company Information: www.absa.co.za"
];

const FNB_0510 = [
  "NOTIFICATION OF PAYMENT",
  "Dear: Payment Notification",
  "First National Bank hereby confirms that the following payment instruction has been received:",
  "Date Actioned : 2026/10/05",
  "11:48:05",
  "Time Actioned :",
  "Trace ID : TRACE001",
  "Payer Details",
  "Payment From PAYER TRADING",
  "ZAR10.00",
  "Cur/Amount",
  "Payee Details",
  "Recipient/Account no : ..004321",
  "Marathon club",
  "Name :",
  "Bank : FIRST NATIONAL BANK",
  "Branch Code : 250655",
  "REF2",
  "Reference :",
  "END OF NOTIFICATION",
  "To authenticate this Payment Notification, please visit the First National Bank website at fnb.co.za, select the “Verify Payments” link and follow the on-screen",
  "instructions.",
  "Our customer (the payer) has requested First National Bank Limited to send this notification of payment to you. Should you have any queries regarding the",
  "contents of this notice, please contact the payer. First National Bank Limited does not guarantee or warrant the accuracy and integrity of the information and data",
  "transmitted electronically and we accept no liability whatsoever for any loss, expense, claim or damage, whether direct, indirect or consequential, arising from the",
  "transmission of the information and data.",
  "Disclaimer:",
  "The information contained in this email is confidential and may contain proprietary information. It is meant solely for the intended recipient. Access to this email by",
  "anyone else is unauthorised. If you are not the intended recipient, any disclosure, copying, distribution or any action taken or omitted in reliance on this is prohibited",
  "and may be unlawful. No liability or responsibility is accepted if information or data is, for whatever reason corrupted or does not reach its intended recipient. No",
  "warranty is given that this email is free of viruses. The views expressed in this email are, unless otherwise stated, those of the author and not those of First National",
  "Bank Limited or its management. First National Bank Limited reserves the right to monitor, intercept and block emails addressed to its users or take any other",
  "action in accordance with its email use policy. Licensed divisions of FirstRand Bank Limited are authorised financial service providers in terms of the Financial",
  "Advisory and Intermediary Services Act 37 of 2002.",
  "First National Bank A division of FirstRand Bank Limited. An Authorised Financial Services and Credit Provider (NCRCP20)."
];

const ALLOWED = parseAllowedAccounts("62900004321, 62000009092");
// Each notification arrived within minutes of its payment (5 Oct 2026, SAST).
const RECEIVED = Date.parse("2026-10-05T09:50:00Z");

function judge(fromDomain, lines) {
  const reader = selectReader({ fromDomain, lines });
  expect(reader, fromDomain).toBeTruthy();
  const parsed = reader.parse(lines);
  expect(parsed.ok, fromDomain).toBe(true);
  return {
    parsed,
    dest: destinationVerdict({ accountMask: parsed.accountMask, destBankName: parsed.destBankName, allowedAccounts: ALLOWED, configured: true }),
    timing: immediacyVerdict({ parsed, reader: reader.id, receivedAt: RECEIVED }),
  };
}

describe("fix 7 on the real 5 Oct notifications", () => {
  it("Capitec REGULAR payment: right account, refused as not immediate", () => {
    const { parsed, dest, timing } = judge("capitecbank.co.za", CAPITEC_REGULAR);
    expect(parsed.amountCents).toBe(1000);
    expect(parsed.paymentType).toBe("Regular Payment");
    expect(dest.ok).toBe(true);
    expect(timing.ok).toBe(false);
    expect(timing.needsSample).toBeUndefined();
  });

  it("Capitec IMMEDIATE payment: admitted", () => {
    const { parsed, dest, timing } = judge("capitecbank.co.za", CAPITEC_IMMEDIATE);
    expect(parsed.amountCents).toBe(900);
    expect(dest.ok).toBe(true);
    expect(timing.ok).toBe(true);
  });

  it("Absa IMMEDIATE (Y) payment to FIRSTRAND: destination and timing both pass", () => {
    const { parsed, dest, timing } = judge("absa.co.za", ABSA_IMMEDIATE_NO_TXN);
    expect(parsed.destBankName).toBe("FIRSTRAND");
    expect(parsed.immediate).toBe(true);
    expect(parsed.bankRef ?? null).toBe(null); // no transaction number printed — held upstream
    expect(dest.ok).toBe(true);
    expect(timing.ok).toBe(true);
  });

  it("Absa NORMAL (N) payment: refused as not immediate", () => {
    const { parsed, dest, timing } = judge("absa.co.za", ABSA_NORMAL);
    expect(parsed.immediate).toBe(false);
    expect(parsed.bankRef).toBe("80A0A0A0A0-1");
    expect(dest.ok).toBe(true);
    expect(timing.ok).toBe(false);
  });

  it("FNB: right account, but no immediate field exists — refused, needs a sample", () => {
    const { parsed, dest, timing } = judge("fnb.co.za", FNB_0510);
    expect(parsed.bankRef).toBe("TRACE001");
    expect(dest.ok).toBe(true);
    expect(timing.ok).toBe(false);
    expect(timing.needsSample).toBe(true);
  });

  it("Standard Bank: right account, but no immediate field exists — refused, needs a sample", () => {
    const { parsed, dest, timing } = judge("standardbank.co.za", STANDARDBANK_0510);
    expect(parsed.amountCents).toBe(1000);
    expect(dest.ok).toBe(true);
    expect(timing.ok).toBe(false);
    expect(timing.needsSample).toBe(true);
  });
});

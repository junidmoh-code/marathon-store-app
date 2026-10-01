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
import { authenticationVerdict, eftPoolRecord } from "./eftCore.mjs";

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
    // Nedbank: allowlisted as a bank customers pay from, no reader yet. Its
    // notification therefore refuses with a work order rather than a guess —
    // which is the whole state of that bank until a real PDF arrives.
    const reason = noReaderReason("nedbank.co.za");
    expect(reason).toContain("nedbank.co.za");
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

// ─── CAPITEC ─────────────────────────────────────────────────────────────────
// THE FIXTURE IS A REAL Capitec "Payment Notification" PDF, forwarded to the
// mailbox as a FORMAT SAMPLE on 2026-08-31: the exact lines pdfText.js
// extracted from it. SANITISED for a public repo, structure untouched — the
// payer's first name and typed reference (a real person's), the notification
// number, the destination account and the QR reference are changed; every
// label, ordering and spacing is verbatim, including the QR line this reader
// deliberately ignores. The QR reference is sanitised for the same reason the
// account is — it is a live lookup token for a real payment — and its SHAPE is
// kept so the test that proves it reaches no field still has something to
// prove.
//
// THE SAMPLE ITSELF NEVER ENTERED THE POOL AND MUST NOT. It was forwarded from
// the owner's own address, so it carries HIS DKIM signature, not Capitec's, and
// authVerdict refuses it before any of this runs. That is the point of the
// gate, and building a reader from a document's CONTENT never touches it: a
// real Capitec notification authenticates on its own, or it does not land.
const REAL_CAPITEC_PDF_LINES = [
  "One of the Global One money management products or services",
  "Payment Notification",
  "SkyQR reference: 0000-0000-0000",
  "Capitec Bank",
  "31/08/2026",
  "Branch: 250655",
  "Device: 9003",
  "Dear Sir/Madam",
  "Please take note that Thabo made a payment to your account. The payment details are as follows:",
  "Notification number 500001",
  "Payment date 20/04/2026 10:15",
  "Payment details",
  "Beneficiary name Marathon",
  "Bank name First National Bank",
  "Account number 62900004321",
  "Branch 250655",
  "Payment type Immediate Payment",
  "Amount R750.00",
  "Payment reference T NKOSI",
  "IMPORTANT NOTES:",
  "Immediate payments to non-Capitec banking clients and regular payments made to Capitec clients will reflect in the beneficiaries account",
  "immediately.",
  "This is a notification that we received instruction to effect a payment and not a representation of any kind or guarantee that the amount has in",
  "fact been transferred or shall be available in the account. The processing of the payment may be delayed, which may impact on the timing of",
  "the availability of the funds.",
  "Remote Banking Services",
  "24hr Client Care Centre 0860 10 20 43 E ClientCare@capitecbank.co.za capitecbank.co.za",
  "Capitec Bank is an authorised financial services (FSP46669) and registered credit provider (NCRCP13). Capitec Bank Limited Reg. No.: 1980/003695/06. Page 1 of 1",
  "Unique Document No.: 3234d25f-de4e-45dd-8ceb-fb7f51927f21 / 903 / V1.0 - 08/03/2019",
];

const cap = EFT_READERS.find((r) => r.id === "capitec");

describe("the Capitec reader — built from the real notification", () => {
  it("selectReader picks it for the real document from the real domain (subdomains too)", () => {
    expect(selectReader({ fromDomain: "capitecbank.co.za", lines: REAL_CAPITEC_PDF_LINES })?.id).toBe("capitec");
    expect(selectReader({ fromDomain: "mail.capitecbank.co.za", lines: REAL_CAPITEC_PDF_LINES })?.id).toBe("capitec");
  });

  it("a Capitec layout arriving from ANOTHER bank's domain is nobody's", () => {
    expect(selectReader({ fromDomain: "standardbank.co.za", lines: REAL_CAPITEC_PDF_LINES })).toBe(null);
  });

  it("…and no other reader claims the Capitec document", () => {
    for (const other of EFT_READERS.filter((r) => r.id !== "capitec")) {
      expect(other.detect(REAL_CAPITEC_PDF_LINES), `${other.id} must not claim it`).toBe(false);
    }
    expect(cap.detect(REAL_SB_PDF_LINES), "…and Capitec must not claim Standard Bank's").toBe(false);
  });

  it("does not claim a batch-report-shaped document", () => {
    expect(cap.detect(["BATCH REPORT", "TERMINAL ID 0000HP1X", "BATCH NUMBER (#494)"])).toBe(false);
  });

  it("reads every field of the real document exactly", () => {
    expect(cap.parse(REAL_CAPITEC_PDF_LINES)).toEqual({
      ok: true,
      amountCents: 75000,
      // What the PAYER typed — the matching key — not Capitec's own number.
      reference: "T NKOSI",
      payer: "Thabo",
      // 20/04/2026 10:15 is 20 APRIL, day-first: 08:15 UTC.
      bankTs: Date.UTC(2026, 3, 20, 8, 15, 0),
      bankRef: "500001",
      beneficiaryName: "Marathon",
      destBankName: "First National Bank",
      // Capitec prints it IN FULL; the pool masks it on the way in.
      accountMask: "62900004321",
    });
  });

  it("the QR reference is read as nothing — a document may not vouch for itself", () => {
    // It is in the fixture, it parses cleanly, and not one field carries it.
    const parsed = cap.parse(REAL_CAPITEC_PDF_LINES);
    const values = JSON.stringify(parsed);
    expect(values).not.toContain("0000-0000");
    expect(values).not.toContain("SkyQR");
    // …and removing the line changes nothing about the payment.
    expect(cap.parse(REAL_CAPITEC_PDF_LINES.filter((l) => !/SkyQR/.test(l)))).toEqual(parsed);
  });

  it("refuses a document with two notification blocks rather than picking one", () => {
    const doubled = [...REAL_CAPITEC_PDF_LINES, "Notification number 500002", "Amount R750.00"];
    expect(cap.parse(doubled)).toEqual({
      ok: false,
      reason: "This document holds 2 payment blocks — a reprint and two identical payments cannot be told apart here. Handle it by hand.",
    });
  });

  it("refuses when the destination account is missing — the allowlist check depends on it", () => {
    const без = REAL_CAPITEC_PDF_LINES.filter((l) => !/^Account number/.test(l));
    expect(cap.parse(без).ok).toBe(false);
    expect(cap.parse(без).reason).toMatch(/destination account cannot be checked/);
  });

  it("refuses when the Amount line is absent — never records a payment of nothing", () => {
    const lines = REAL_CAPITEC_PDF_LINES.filter((l) => !/^Amount\s/.test(l));
    expect(cap.parse(lines)).toEqual({ ok: false, reason: "Capitec notification carries no Amount line." });
  });

  it("does not claim a Capitec document that is not a payment notification", () => {
    // The title and a money line are not enough: a statement, a fee letter or a
    // reversal advice can carry both. The confirmation sentence is what says
    // MONEY CAME IN, and all three must agree before this reader touches it.
    expect(cap.detect([
      "Capitec Bank",
      "Payment Notification",
      "Your scheduled payment could not be processed.",
      "Amount R750.00",
    ])).toBe(false);
  });

  it("refuses an unparseable amount rather than guessing one", () => {
    const lines = REAL_CAPITEC_PDF_LINES.map((l) => (l.startsWith("Amount ") ? "Amount R750,0O" : l));
    expect(cap.parse(lines).ok).toBe(false);
    expect(cap.parse(lines).reason).toMatch(/does not parse exactly as a rand amount/);
  });

  it("refuses two different Amount lines — that is a layout it does not understand", () => {
    const lines = [...REAL_CAPITEC_PDF_LINES, "Amount R80.00"];
    expect(cap.parse(lines).ok).toBe(false);
    expect(cap.parse(lines).reason).toMatch(/appears 2 times with different values/);
  });

  it("a payment with no typed reference still refuses — Capitec always prints the line", () => {
    // Unlike FNB's optional reference: this document's reference line is the
    // payer's own name when they type nothing, so its ABSENCE means the layout
    // changed, and a changed layout must refuse rather than record a blank key.
    const lines = REAL_CAPITEC_PDF_LINES.filter((l) => !/^Payment reference/.test(l));
    const parsed = cap.parse(lines);
    expect(parsed.ok).toBe(true);
    expect(parsed.reference).toBe(null);
  });

  it("a date it cannot read costs the date and nothing else", () => {
    const lines = REAL_CAPITEC_PDF_LINES.map((l) => (l.startsWith("Payment date ") ? "Payment date sometime tuesday" : l));
    const parsed = cap.parse(lines);
    expect(parsed.ok, "the payment still lands — receivedAt carries it").toBe(true);
    expect(parsed.bankTs).toBe(null);
    expect(parsed.amountCents).toBe(75000);
  });

  it("a phantom date reads as no date, never as a rolled-over one", () => {
    const lines = REAL_CAPITEC_PDF_LINES.map((l) => (l.startsWith("Payment date ") ? "Payment date 31/02/2026 10:15" : l));
    expect(cap.parse(lines).bankTs).toBe(null);
  });

  it("day-first is applied, not guessed at per document", () => {
    // 04/05 is the ambiguous half of the year, and it must read as 4 MAY.
    const lines = REAL_CAPITEC_PDF_LINES.map((l) => (l.startsWith("Payment date ") ? "Payment date 04/05/2026 09:30" : l));
    expect(cap.parse(lines).bankTs).toBe(Date.UTC(2026, 4, 4, 7, 30, 0));
  });
});

// ─── THE SAMPLE THAT BUILT THE READER MUST NEVER BE A PAYMENT ────────────────
// The Capitec document above reached the mailbox because the owner FORWARDED
// it as a format sample. It is a real notification and it reads perfectly —
// which is exactly why this is pinned: a reader is built from a document's
// CONTENT, and content proves nothing about origin. What proves origin is
// Gmail's DKIM verdict on the message that carried it, and the forward carries
// the OWNER's signature, not Capitec's.
//
// Nothing in eftBanks.mjs was softened to admit the sample, and nothing here
// may be: if this test ever needs changing to let a forwarded document through,
// the change is the bug.
describe("a forwarded sample is a format, never a payment", () => {
  const forwarded = {
    fromAddress: "junidmoh@icloud.com",
    headerLines: [{ key: "authentication-results", line: "Authentication-Results: mx.google.com; dkim=pass header.i=@icloud.com header.s=1a1hai; spf=pass" }],
  };

  it("the verdict fails on the DOMAIN, before DKIM is even weighed", () => {
    const verdict = authenticationVerdict(forwarded);
    expect(verdict.pass).toBe(false);
    // The forward's own dkim=pass is real — for icloud.com. It vouches for the
    // forwarder, which is not the bank.
    expect(verdict.detail).toBe("icloud.com is not an allowlisted bank domain");
  });

  it("…and a Capitec forward from the owner's own gmail fails the same way", () => {
    const verdict = authenticationVerdict({
      fromAddress: "gunidmoh@gmail.com",
      headerLines: [{ key: "authentication-results", line: "Authentication-Results: mx.google.com; dkim=pass header.i=@gmail.com header.s=20230601" }],
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.detail).toBe("gmail.com is not an allowlisted bank domain");
  });

  it("no reader is even offered the document, because the domain is not a bank's", () => {
    expect(selectReader({ fromDomain: "icloud.com", lines: REAL_CAPITEC_PDF_LINES })).toBe(null);
  });

  it("and a record built on a failed verdict cannot be a payment, whatever the document said", () => {
    const record = eftPoolRecord({
      message: { receivedAt: 1788205916000, messageId: "<x@icloud.com>", from: "junidmoh@icloud.com", subject: "Fwd" },
      verdict: authenticationVerdict(forwarded),
      // The parse SUCCEEDS — the document is genuine — and it changes nothing.
      parsed: EFT_READERS.find((r) => r.id === "capitec").parse(REAL_CAPITEC_PDF_LINES),
      account: { ok: true, tail: "4321" },
      reader: "capitec",
      rawText: REAL_CAPITEC_PDF_LINES.join("\n"),
      at: 1788205991422,
    });
    expect(record.outcome).toBe("refused-auth");
    expect(record.status, "a refused record is never a spendable payment").toBeUndefined();
    expect(record.amountCents, "and carries no amount to settle against").toBeUndefined();
  });

  it("the real forward is on record as having done exactly that", () => {
    // 2026-08-31: the sample arrived, produced ZERO /eft_pool records, and was
    // refused by the CARD path instead (it is not a batch report either). This
    // is the observed behaviour, written down so a future change that starts
    // pooling forwarded documents has to argue with it.
    expect(authenticationVerdict(forwarded).pass).toBe(false);
  });
});

// ─── ABSA ────────────────────────────────────────────────────────────────────
// THE FIXTURE IS THE REAL R80 PAYMENT of 2026-09-01 — the owner paid the shop
// from his own Absa account so the format would exist. These are the exact
// lines pdfText.js extracted from Absa.pdf, SANITISED for a public repo
// (the payer's name, the bank's transaction number, the destination account,
// the branch code and the support phone numbers), structure verbatim —
// including the three BARE labels whose values sit on the following line.
const REAL_ABSA_PDF_LINES = [
  "01 September 2026",
  "Notice of Payment",
  "Dear Marathon club",
  "Subject: Notice Of Payment: Marathon club",
  "Please be advised that MR J SOAP made a payment to your account as indicated below.",
  "Transaction number: 80D2F2AB5A-1",
  "Payment date:",
  "2026-09-01",
  "Payment made by: MR J SOAP",
  "Payment made to:",
  "Marathon club",
  "Beneficiary bank name: FIRST NATIONAL BANK",
  "Beneficiary account number: 62900004321",
  "Bank branch code: 250655",
  "For the amount of: 80.00",
  "Immediate payment:",
  "N",
  "Reference on beneficiary statement: test",
  "View your account to confirm that you have received this payment as the following applies to online banking",
  "payments into non-ABSA and Absa Vehicle and Asset Finance bank accounts.",
  "• Payments made on weekdays before 15:30 will be credited to the receiving bank account by midnight of the same day.",
  "If you have made an incorrect internet banking payment, please send an email to digital@absa.co.za",
  "Yours sincerely",
  "General Manager: Digital Channels",
  "Absa Bank Limited Reg No 1986/000000/06 Authorised Financial Services and Registered Credit Provider Reg No NCRCP7 Company Information: www.absa.co.za",
];

const ab = EFT_READERS.find((r) => r.id === "absa");

describe("the Absa reader — built from the real R80 payment", () => {
  it("selectReader picks it for the real document from the real domain", () => {
    expect(selectReader({ fromDomain: "absa.co.za", lines: REAL_ABSA_PDF_LINES })?.id).toBe("absa");
    expect(selectReader({ fromDomain: "ibreply.absa.co.za", lines: REAL_ABSA_PDF_LINES })?.id).toBe("absa");
  });

  it("an Absa layout from another bank's domain is nobody's", () => {
    expect(selectReader({ fromDomain: "capitecbank.co.za", lines: REAL_ABSA_PDF_LINES })).toBe(null);
  });

  it("…and no other reader claims it, nor it theirs", () => {
    for (const other of EFT_READERS.filter((r) => r.id !== "absa")) {
      expect(other.detect(REAL_ABSA_PDF_LINES), `${other.id} must not claim it`).toBe(false);
    }
    expect(ab.detect(REAL_CAPITEC_PDF_LINES), "Capitec's is not Absa's").toBe(false);
    expect(ab.detect(REAL_SB_PDF_LINES), "Standard Bank's is not Absa's").toBe(false);
  });

  it("does not claim a batch-report-shaped document", () => {
    expect(ab.detect(["BATCH REPORT", "TERMINAL ID 0000HP1X", "BATCH NUMBER (#494)"])).toBe(false);
  });

  it("reads every field of the real document exactly", () => {
    expect(ab.parse(REAL_ABSA_PDF_LINES)).toEqual({
      ok: true,
      // "80.00", with no R in front of it.
      amountCents: 8000,
      // What the PAYER typed, not Absa's own transaction number.
      reference: "test",
      payer: "MR J SOAP",
      // 2026-09-01, no time printed: midnight SAST = 22:00 UTC the day before.
      bankTs: Date.UTC(2026, 7, 31, 22, 0, 0),
      bankRef: "80D2F2AB5A-1",
      // A BARE label whose value is on the following line.
      beneficiaryName: "Marathon club",
      destBankName: "FIRST NATIONAL BANK",
      accountMask: "62900004321",
    });
  });

  it("reads a bare label's value from the NEXT line — the mirror of FNB's", () => {
    // Three of them in the real document: Payment date, Payment made to, and
    // Immediate payment. If this direction ever flipped, the date would read as
    // the label above it and the beneficiary as "Payment made to:".
    const parsed = ab.parse(REAL_ABSA_PDF_LINES);
    expect(parsed.beneficiaryName).toBe("Marathon club");
    expect(parsed.bankTs).not.toBe(null);
  });

  it("a bare label followed by ANOTHER label reads as absent, never as that label", () => {
    // The layout has shifted, and guessing would file one field's LABEL as
    // another field's value. Asserted on a field where the wrong answer is
    // VISIBLE: a null date is also what an unparseable date gives, so the date
    // alone cannot tell the two apart.
    const shifted = REAL_ABSA_PDF_LINES.map((l) => (l === "Marathon club" ? "Bank branch code: 250655" : l));
    const parsed = ab.parse(shifted);
    expect(parsed.beneficiaryName, "the next label is not the beneficiary's name").toBe(null);
    const dateShifted = REAL_ABSA_PDF_LINES.map((l) => (l === "2026-09-01" ? "Bank branch code: 250655" : l));
    expect(ab.parse(dateShifted).bankTs).toBe(null);
  });

  it("does not claim an Absa document that is not a payment notice", () => {
    // The title and the sentence are not enough on their own: Absa writes to
    // its customers about payments constantly. The labelled amount is what says
    // MONEY CAME IN, and all three must agree before this reader touches it.
    expect(ab.detect([
      "01 September 2026",
      "Notice of Payment",
      "Please be advised that MR J SOAP made a payment to your account, which has been REVERSED.",
      "No funds have been transferred.",
    ])).toBe(false);
  });

  it("refuses when the amount is missing — never a payment of nothing", () => {
    const lines = REAL_ABSA_PDF_LINES.filter((l) => !/^For the amount of:/.test(l));
    expect(ab.parse(lines)).toEqual({ ok: false, reason: "Absa notification carries no amount line." });
  });

  it("refuses an amount that does not parse exactly", () => {
    const lines = REAL_ABSA_PDF_LINES.map((l) => (l.startsWith("For the amount of:") ? "For the amount of: 8O.00" : l));
    expect(ab.parse(lines).ok).toBe(false);
    expect(ab.parse(lines).reason).toMatch(/does not parse exactly as a rand amount/);
  });

  it("refuses two different amounts — a layout it does not understand", () => {
    const lines = [...REAL_ABSA_PDF_LINES, "For the amount of: 90.00"];
    expect(ab.parse(lines).ok).toBe(false);
    expect(ab.parse(lines).reason).toMatch(/appears 2 times with different values/);
  });

  it("refuses without the destination account — the allowlist check depends on it", () => {
    const lines = REAL_ABSA_PDF_LINES.filter((l) => !/^Beneficiary account number:/.test(l));
    expect(ab.parse(lines).ok).toBe(false);
    expect(ab.parse(lines).reason).toMatch(/destination account cannot be checked/);
  });

  it("refuses a document with two transaction numbers rather than picking one", () => {
    const doubled = [...REAL_ABSA_PDF_LINES, "Transaction number: 80D2F2AB5A-2"];
    expect(ab.parse(doubled).ok).toBe(false);
    expect(ab.parse(doubled).reason).toMatch(/2 payment blocks/);
  });

  it("a date it cannot read costs the date and nothing else", () => {
    const lines = REAL_ABSA_PDF_LINES.map((l) => (l === "2026-09-01" ? "sometime tuesday" : l));
    const parsed = ab.parse(lines);
    expect(parsed.ok).toBe(true);
    expect(parsed.bankTs).toBe(null);
    expect(parsed.amountCents).toBe(8000);
  });

  it("keeps the payer's typed reference and the bank's own number apart", () => {
    const parsed = ab.parse(REAL_ABSA_PDF_LINES);
    expect(parsed.reference).toBe("test");
    expect(parsed.bankRef).toBe("80D2F2AB5A-1");
    expect(parsed.reference).not.toBe(parsed.bankRef);
  });
});

// ─── THE PROOF-OF-PAYMENT READER, ROBUST ACROSS LAYOUTS (Junid, 25 Nov 2026) ─
// A genuine Capitec "Payment Notification" (SkyQR immediate payment, PDF 2.0
// made by Flying Saucer / OpenPDF, metadata title "Proof of Payment") that
// Junid uploaded through "Upload approved proof" was refused as "not a payment
// notification this pool has a reader for". ROOT CAUSE: capitec.detect() was
// keyed on one layout's sentence ("made a payment to your account"); this
// layout says "has made an immediate payment, which is intended to reflect
// instantly in the beneficiary's account" — so NO reader claimed it. Had it
// been claimed, the parse would still have failed: no "Notification number"
// (the old transaction id), "Reference" not "Payment reference", "Bank" not
// "Bank name", no "Payment type" line.
//
// THE FIXTURE is the sample's pdftotext -raw text, SANITISED for a public
// repo with its structure untouched: the payer's name and reference, the
// SkyQR code, the document number and the account number are replaced (the
// real allowlist lives only in the mini's .env and the Secret Manager). Every
// label, ordering and spacing is verbatim — including "R15 050.00".
import { describe, it, expect } from "vitest";
import { EFT_READERS, selectReader, selectReaderByContent, banksEvidencedBy, evidenceClaims } from "./eftBanks.mjs";

export const CAPITEC_SKYQR_LINES = [
  "Payment Notification",
  "Capitec Bank Limited",
  "5 Neutron Road",
  "Techno Park",
  "Stellenbosch",
  "7600",
  "SkyQR reference: 4000-4000-4a00",
  "Dear Sir/Madam",
  "Please note that MARY SOAP has made an immediate payment, which is intended to reflect",
  "instantly in the beneficiary's account.",
  "Beneficiary Details",
  "Beneficiary Name concerte",
  "Account Number 10100008534",
  "Bank Standard Bank",
  "Payment Details",
  "Payment Date 24/11/2026 12:34",
  "Amount R15 050.00",
  "Reference M SOAP",
  "IMPORTANT",
  "Funds may be delayed due to processing at the beneficiary's bank.",
  "24hr Client Care Centre 0860 10 20 43 E ClientCare@capitecbank.co.za W capitecbank.co.za",
  "Capitec Bank is an authorised financial services (FSP46669) and registered credit provider (NCRCP13). Capitec Bank Limited Reg. No.: 1980/003695/06",
  "Unique Document No.: 00000000-f1a5-4908-b450-000000000000 / 903 / V2.0 - 01/11/2024 Page 1 of 1",
];

const cap = EFT_READERS.find((r) => r.id === "capitec");

describe("commit 1 — the issuing bank from strong evidence, not one heading", () => {
  it("the Capitec SkyQR notification is claimed by Capitec alone — by content and from capitecbank.co.za", () => {
    expect(cap.layoutDetect(CAPITEC_SKYQR_LINES), "the old layout rule does not match this layout (the root cause)").toBe(false);
    expect(banksEvidencedBy(CAPITEC_SKYQR_LINES)).toEqual(["capitec"]);
    expect(selectReaderByContent(CAPITEC_SKYQR_LINES)?.id).toBe("capitec");
    expect(selectReader({ fromDomain: "capitecbank.co.za", lines: CAPITEC_SKYQR_LINES })?.id).toBe("capitec");
    for (const other of EFT_READERS.filter((r) => r.id !== "capitec")) {
      expect(other.detect(CAPITEC_SKYQR_LINES), `${other.id} must not claim it`).toBe(false);
    }
  });

  it("the destination bank's NAME is not evidence: 'Bank Standard Bank' makes nobody Standard Bank", () => {
    expect(banksEvidencedBy(["Bank Standard Bank", "Bank name FIRST NATIONAL BANK", "Beneficiary bank name: FIRSTRAND"])).toEqual([]);
  });

  it("from another bank's domain it is still nobody's — the sender must agree with the content", () => {
    expect(selectReader({ fromDomain: "standardbank.co.za", lines: CAPITEC_SKYQR_LINES })).toBe(null);
  });

  it("whitespace variants (non-breaking / narrow spaces, tabs) do not hide the evidence", () => {
    const nbsp = CAPITEC_SKYQR_LINES.map((l) => l.replace(/ /g, " "));
    expect(selectReaderByContent(nbsp)?.id).toBe("capitec");
    const narrow = CAPITEC_SKYQR_LINES.map((l) => l.replace(/ /g, " "));
    expect(selectReaderByContent(narrow)?.id).toBe("capitec");
  });

  it("evidence for TWO banks claims nothing — a guess between them is not a reading", () => {
    const both = [...CAPITEC_SKYQR_LINES, "www.absa.co.za"];
    expect(selectReaderByContent(both)).toBe(null);
  });

  it("a Capitec letter that is not money in claims nothing, footer or not", () => {
    const failed = CAPITEC_SKYQR_LINES.map((l) => (l.startsWith("Please note that") ? "Please note that the payment by MARY SOAP was unsuccessful and has made no payment," : l));
    expect(evidenceClaims("capitec", failed)).toBe(false);
    const noSentence = CAPITEC_SKYQR_LINES.filter((l) => !/made an immediate payment/.test(l));
    expect(evidenceClaims("capitec", noSentence)).toBe(false);
    const noAmount = CAPITEC_SKYQR_LINES.filter((l) => !/^Amount /.test(l));
    expect(evidenceClaims("capitec", noAmount)).toBe(false);
    const noAccount = CAPITEC_SKYQR_LINES.filter((l) => !/^Account Number /.test(l));
    expect(evidenceClaims("capitec", noAccount)).toBe(false);
    // The metadata title alone ("Proof of Payment") is never read.
    expect(selectReaderByContent(["Proof of Payment", "Amount R15 050.00", "Account Number 10100008534"])).toBe(null);
  });

  it("every bank's footer evidence is recognised (reg. no. / domain)", () => {
    expect(banksEvidencedBy(["The Standard Bank of South Africa Limited (Reg. No. 1962/000738/06)"])).toEqual(["standardbank"]);
    expect(banksEvidencedBy(["FirstRand Bank Limited Reg. No. 1929/001225/06 An Authorised FSP 3071"])).toEqual(["fnb"]);
    expect(banksEvidencedBy(["Absa Bank Limited Reg No 1986/004794/06"])).toEqual(["absa"]);
    expect(banksEvidencedBy(["Nedbank Limited Reg No 1951/000009/06"])).toEqual(["nedbank"]);
    expect(banksEvidencedBy(["E ClientCare@capitecbank.co.za"])).toEqual(["capitec"]);
  });
});

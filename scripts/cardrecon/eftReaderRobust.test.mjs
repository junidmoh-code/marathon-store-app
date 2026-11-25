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

// ─── COMMIT 2 — label-driven fields, the reader's own rules first ────────────
import { createRequire } from "node:module";
const requireFn = createRequire(new URL("../../functions/package.json", import.meta.url));
const { labelledField, fieldsSummary } = requireFn("./lib/eft-labels.cjs");

const EXPECTED_SKYQR = {
  ok: true,
  amountCents: 1505000,                      // "R15 050.00": space thousands separator
  reference: "M SOAP",
  payer: "MARY SOAP",
  bankTs: Date.UTC(2026, 10, 24, 10, 34, 0), // 24/11/2026 12:34 SAST, day-first
  bankRef: "4000-4000-4a00",                 // the SkyQR reference
  beneficiaryName: "concerte",
  destBankName: "Standard Bank",
  accountMask: "10100008534",
  paymentType: "Immediate Payment",
  immediate: true,
};

describe("commit 2 — the Capitec SkyQR notification reads exactly", () => {
  it("every field, as the expected parse", () => {
    expect(cap.parse(CAPITEC_SKYQR_LINES)).toEqual(EXPECTED_SKYQR);
  });

  it("the thousands separator may be a space, a non-breaking space, a narrow space or a comma", () => {
    for (const sep of [" ", " ", " ", ","]) {
      const lines = CAPITEC_SKYQR_LINES.map((l) => (l.startsWith("Amount ") ? `Amount R15${sep}050.00` : l));
      expect(cap.parse(lines).amountCents, JSON.stringify(sep)).toBe(1505000);
    }
  });

  it("line order does not matter, nor extra whitespace, nor a value on the line after its label", () => {
    const shuffled = [...CAPITEC_SKYQR_LINES].reverse();
    // (The wrapped sentence is read on the joined prose, in document order;
    // reversed it no longer says "immediate", and that costs only the flag.)
    expect({ ...cap.parse(shuffled), immediate: true, paymentType: "Immediate Payment", payer: "MARY SOAP" }).toEqual(EXPECTED_SKYQR);
    const spaced = CAPITEC_SKYQR_LINES.map((l) => l.replace(/ /g, "   ").replace(/^/, "  "));
    expect(cap.parse(spaced).amountCents).toBe(1505000);
    expect(cap.parse(spaced).bankRef).toBe("4000-4000-4a00");
    const split = CAPITEC_SKYQR_LINES.flatMap((l) => (l.startsWith("Reference ") ? ["Reference", "M SOAP"] : l.startsWith("Bank ") ? ["Bank", "Standard Bank"] : [l]));
    expect(cap.parse(split).reference).toBe("M SOAP");
    expect(cap.parse(split).destBankName).toBe("Standard Bank");
  });

  it("no SkyQR reference: the Unique Document No.'s code is the id", () => {
    const lines = CAPITEC_SKYQR_LINES.filter((l) => !/^SkyQR/.test(l));
    expect(cap.parse(lines).bankRef).toBe("00000000-f1a5-4908-b450-000000000000");
  });

  it("neither printed: no transaction id (the gate then refuses it, naming the field)", () => {
    const lines = CAPITEC_SKYQR_LINES.filter((l) => !/^SkyQR|^Unique Document/.test(l));
    const p = cap.parse(lines);
    expect(p.ok).toBe(true);
    expect(p.bankRef).toBe(null);
  });

  it("the older layout keeps its notification number as the id — its SkyQR line is still read as nothing", async () => {
    const old = [
      "Payment Notification", "SkyQR reference: 0000-0000-0000", "Capitec Bank",
      "Please take note that Thabo made a payment to your account. The payment details are as follows:",
      "Notification number 500001", "Payment date 20/04/2026 10:15", "Beneficiary name Marathon",
      "Bank name First National Bank", "Account number 62900004321", "Payment type Immediate Payment",
      "Amount R750.00", "Payment reference T NKOSI",
    ];
    expect(cap.parse(old).bankRef).toBe("500001");
  });

  it("two different amounts, accounts or SkyQR references refuse — never pick one", () => {
    expect(cap.parse([...CAPITEC_SKYQR_LINES, "Amount R15.00"]).ok).toBe(false);
    expect(cap.parse([...CAPITEC_SKYQR_LINES, "Account Number 62900004321"]).ok).toBe(false);
    expect(cap.parse([...CAPITEC_SKYQR_LINES, "SkyQR reference: 1111-2222-3333"]).ok).toBe(false);
  });

  it("IMMEDIATE ONLY BY THE BANK'S PHRASE: a payer's name cannot pose as it; another wording is not immediate", () => {
    const posing = CAPITEC_SKYQR_LINES.map((l) => (l.startsWith("Please note that")
      ? "Please note that X has made an immediate payment, which is intended to reflect instantly in the beneficiary's account Y has made a payment, which is intended to reflect" : l));
    expect(cap.parse(posing).immediate).toBe(null);
    const regular = CAPITEC_SKYQR_LINES.map((l) => (l.startsWith("Please note that") ? "Please note that MARY SOAP has made a payment, which will reflect" : l))
      .filter((l) => !/^instantly/.test(l));
    expect(cap.parse(regular).immediate).toBe(null);
    expect(cap.parse(regular).payer).toBe(null);
  });
});

describe("commit 2 — the shared extractor itself", () => {
  it("labels and synonyms, same line or next, colon or none", () => {
    expect(labelledField(["Payment Amount: R1 200.50"], "amount").value).toBe("R1 200.50");
    expect(labelledField(["Amount", "R99.00"], "amount").value).toBe("R99.00");
    expect(labelledField(["Recipient Account Number", "62900004321"], "account").value).toBe("62900004321");
    expect(labelledField(["Their reference: INV 7"], "reference").value).toBe("INV 7");
    expect(labelledField(["Reference number 4149999999"], "reference").value, "the bank's id is not the payer's reference").toBe(null);
    expect(labelledField(["Reference number 4149999999"], "txnId").value).toBe("4149999999");
    expect(labelledField(["Trace ID : 5TG59DVQ"], "txnId").value).toBe("5TG59DVQ");
  });
  it("a bare number on the next line is never an amount; a label on the next line is never a value", () => {
    expect(labelledField(["Amount", "250655"], "amount").value).toBe(null);
    expect(labelledField(["Reference", "Amount R5.00"], "reference").value).toBe(null);
    expect(labelledField(["Amount :", ":"], "amount").value).toBe(null);
  });
  it("money and destination must agree across synonyms; a contradiction refuses", () => {
    expect(labelledField(["Amount R10.00", "Payment amount R10.00"], "amount").value).toBe("R10.00");
    expect(labelledField(["Amount R10.00", "Payment amount R11.00"], "amount").ok).toBe(false);
    expect(labelledField(["Account number 62900004321", "Beneficiary account number 62900009999"], "account").ok).toBe(false);
  });
  it("dates: year-first always; day-first only when the bank prints day-first; 31/02 is no date", () => {
    expect(labelledField(["Payment date 2026-11-24 12:34"], "date").value).toBe(Date.UTC(2026, 10, 24, 10, 34));
    expect(labelledField(["Payment date 04/05/2026"], "date").value).toBe(null);
    expect(labelledField(["Payment date 04/05/2026"], "date", { dayFirst: true }).value).toBe(Date.UTC(2026, 4, 3, 22, 0));
    expect(labelledField(["Payment date 31/02/2026"], "date", { dayFirst: true }).value).toBe(null);
  });
  it("fieldsSummary names what was read and what was not — names only, no values", () => {
    const s = fieldsSummary(CAPITEC_SKYQR_LINES.filter((l) => !/^SkyQR|^Unique/.test(l)));
    expect(s.missing).toEqual(["bank transaction id"]);
    expect(JSON.stringify(s)).not.toMatch(/\d{6}/);
  });
});

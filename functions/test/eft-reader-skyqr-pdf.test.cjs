// The Capitec SkyQR notification through the REAL extraction (pdfjs, the
// "bucket" grouping the EFT readers use), with every line broken into
// separately positioned, shuffled fragments — label and value apart, as a
// real generator (Flying Saucer / OpenPDF) emits them. 25 Nov 2026.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { pdfToLines } = require("../cardRecon/pdfText.js");
const { makeSlipPdfFragmented } = require("./fixtures/makeSlipPdf.cjs");
const { selectReaderByContent } = require("../lib/eft-banks.cjs");

// Sanitised (see scripts/cardrecon/eftReaderRobust.test.mjs).
const LINES = [
  "Payment Notification", "Capitec Bank Limited", "5 Neutron Road", "Techno Park", "Stellenbosch", "7600",
  "SkyQR reference: 4000-4000-4a00", "Dear Sir/Madam",
  "Please note that MARY SOAP has made an immediate payment, which is intended to reflect",
  "instantly in the beneficiary's account.",
  "Beneficiary Details", "Beneficiary Name concerte", "Account Number 10100008534", "Bank Standard Bank",
  "Payment Details", "Payment Date 24/11/2026 12:34", "Amount R15 050.00", "Reference M SOAP", "IMPORTANT",
  "Funds may be delayed due to processing at the beneficiary's bank.",
  "24hr Client Care Centre 0860 10 20 43 E ClientCare@capitecbank.co.za W capitecbank.co.za",
  "Capitec Bank is an authorised financial services (FSP46669) and registered credit provider (NCRCP13). Capitec Bank Limited Reg. No.: 1980/003695/06",
  "Unique Document No.: 00000000-f1a5-4908-b450-000000000000 / 903 / V2.0 - 01/11/2024 Page 1 of 1",
];

test("a fragmented, shuffled Capitec SkyQR PDF extracts, is claimed by Capitec, and reads every field", async () => {
  for (const seed of [1, 7, 42]) {
    const pdf = makeSlipPdfFragmented(LINES, { seed });
    const out = await pdfToLines(pdf, { grouping: "bucket" });
    assert.equal(out.ok, true, out.reason);
    const reader = selectReaderByContent(out.lines);
    assert.equal(reader?.id, "capitec", `seed ${seed}: ${out.lines.join(" | ")}`);
    const p = reader.parse(out.lines);
    assert.equal(p.ok, true, p.reason);
    assert.equal(p.amountCents, 1505000);
    assert.equal(p.bankRef, "4000-4000-4a00");
    assert.equal(p.accountMask, "10100008534");
    assert.equal(p.destBankName, "Standard Bank");
    assert.equal(p.reference, "M SOAP");
    assert.equal(p.bankTs, Date.UTC(2026, 10, 24, 10, 34));
    assert.equal(p.immediate, true);
  }
});

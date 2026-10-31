// A Standard Bank card report (Concrete's PAX A8900s, 31 Oct 2026) is
// recognised and refused BY NAME until its reader exists — never "neither a
// slip nor a report", and never mistaken for Standard Bank's EFT payment
// confirmations, which reach the same mailbox. Every identifier here is made
// up; the real-report corpus (card-recon-corpus.test.cjs) is what pins that no
// FNB file reads any differently.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  detectReportFormat, readSlipPdfLines, parseSlipPdf, looksLikeStandardBankCardReport,
  STANDARD_BANK_NOT_BUILT, STANDARD_BANK_REASON, PARSER_VERSION,
} = require("../lib/card-recon-pdf.cjs");

// The shape a merchant settlement report takes — a guess at the layout, which
// is exactly why it is only RECOGNISED, never read.
const SB_REPORT = [
  "Standard Bank",
  "Merchant Settlement Report",
  "Merchant ID: 0001234567",
  "Terminal ID: 0000ZZ9Z",
  "Batch No: 12",
  "Visa Purchases 3 R1,200.00",
  "Mastercard Purchases 2 R450.00",
  "Total R1,650.00",
];
// The EFT confirmation's own words (digits and names changed).
const SB_PAYMENT = [
  "Internet Banking", "Standard Bank Centre", "Website: www.standardbank.co.za", "Dear MARATHON",
  "Immediate Payment Confirmation",
  "We confirm that the following payment has been made into your account from A PAYER:",
  "Reference number 000000SBGRPP00000000C00000000", "Beneficiary name MARATHON", "Bank name FIRST NATIONAL BANK",
  "Beneficiary account number XXXXXXXXXXXXX0000", "Amount R100.00", "Payment date and time 2026-10-28 10h36",
  "The Standard Bank of South Africa Limited (Reg. No. 0000/000000/00)",
];

test("a Standard Bank card report is recognised, and refused by name", () => {
  assert.equal(looksLikeStandardBankCardReport(SB_REPORT), true);
  assert.equal(detectReportFormat(SB_REPORT), "standard-bank");
  const parsed = parseSlipPdf(SB_REPORT);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.awaitingReader, "standard-bank");
  const read = readSlipPdfLines(SB_REPORT);
  assert.equal(read.ok, false);
  assert.equal(read.reason, STANDARD_BANK_REASON);
  assert.ok(read.reason.startsWith(STANDARD_BANK_NOT_BUILT));
  assert.equal(read.awaitingReader, "standard-bank");
  assert.doesNotMatch(read.reason, /neither a terminal batch slip/);
  // A refusal, not "never a slip": the poller keeps its evidence and re-runs it.
  assert.notEqual(read.unrelated, true);
});

test("a Standard Bank EFT payment confirmation is never a card report", () => {
  assert.equal(looksLikeStandardBankCardReport(SB_PAYMENT), false);
  assert.equal(detectReportFormat(SB_PAYMENT), null);
  // …even one that happens to say "merchant" and "card" somewhere.
  assert.equal(detectReportFormat([...SB_PAYMENT, "Merchant services: card payments"]), null);
  // …and one that carries TWO card words — only the payment wording keeps it out.
  assert.equal(detectReportFormat([...SB_PAYMENT, "Merchant ID 12345", "Paid by Visa card"]), null);
});

test("the bank's name alone, or card words alone, are not enough", () => {
  assert.equal(detectReportFormat(["Standard Bank", "Statement of account"]), null);
  assert.equal(detectReportFormat(["Merchant ID: 1", "Terminal ID: 2", "Batch 3"]), null);
  assert.equal(detectReportFormat(["Standard Bank", "Batch 3"]), null);
  // No terminal named: not a card report, however many card words it has.
  assert.equal(detectReportFormat(["Standard Bank", "Daily settlement", "Merchant ID 1", "Visa purchases R10.00"]), null);
});

test("an FNB report naming Standard Bank anywhere is still FNB's — FNB is asked first", () => {
  const fnb = ["Banking Report for Batch 12 of Terminal 0000ZZ9Z", "Merchant: 000000004977890", "Note: Standard Bank cards accepted"];
  assert.equal(detectReportFormat(fnb), "emailed");
});

test("the parser version moved, so earlier refusals re-run under it", () => {
  assert.ok(PARSER_VERSION >= 4);
});

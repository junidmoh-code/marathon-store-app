// Standard Bank reports in the poller (31 Oct 2026): a body-only report is
// kept, not filed as ordinary mail; the "reader not built yet" refusal stays a
// REFUSAL (evidence kept, re-run when the parser version moves); and payment
// confirmations from the same domain are never taken for one.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import {
  standardBankBodyReport, awaitsStandardBankReader, classifyRefusal, retryCandidates, evidenceRecord,
} from "./intakeCore.mjs";

const require = createRequire(import.meta.url);
const { STANDARD_BANK_REASON } = require("../../functions/lib/card-recon-pdf.cjs");

const BODY = [
  "Standard Bank Merchant Services",
  "Daily settlement report",
  "Merchant ID: 0001234567",
  "Terminal ID: 0000ZZ9Z",
  "Card number **** **** **** 4321  R250.00",
  "Visa R250.00",
].join("\n");
const PAYMENT = "Immediate Payment Confirmation\nStandard Bank\nBeneficiary name MARATHON\nAmount R100.00";

describe("Standard Bank report in an email body", () => {
  it("from a Standard Bank domain, is kept with its lines and the named reason", () => {
    const r = standardBankBodyReport({ fromDomain: "standardbank.co.za", text: BODY });
    expect(r).not.toBeNull();
    expect(r.reason).toBe(STANDARD_BANK_REASON);
    expect(r.lines).toContain("Terminal ID: 0000ZZ9Z");
    expect(standardBankBodyReport({ fromDomain: "merchant.standardbank.co.za", text: BODY })).not.toBeNull();
  });

  it("from anyone else, or a payment confirmation, stays ordinary mail", () => {
    expect(standardBankBodyReport({ fromDomain: "gmail.com", text: BODY })).toBeNull();
    expect(standardBankBodyReport({ fromDomain: "notstandardbank.co.za", text: BODY })).toBeNull();
    expect(standardBankBodyReport({ fromDomain: "standardbank.co.za", text: PAYMENT })).toBeNull();
    expect(standardBankBodyReport({ fromDomain: "standardbank.co.za", text: "" })).toBeNull();
  });

  it("its evidence keeps the last four of a card number and nothing more", () => {
    const r = standardBankBodyReport({ fromDomain: "standardbank.co.za", text: BODY });
    const ev = evidenceRecord({ items: [{ filename: "(email body)", reason: r.reason, lines: r.lines }], at: 1, parserVersion: 4 });
    const card = ev.attachments[0].lines.find((l) => /4321/.test(l));
    expect(card).toContain("******4321");
  });
});

describe("the reader-not-built refusal", () => {
  it("is recognised, and is a refusal — not 'never a slip'", () => {
    expect(awaitsStandardBankReader(STANDARD_BANK_REASON)).toBe(true);
    expect(awaitsStandardBankReader("That PDF is neither a terminal batch slip…")).toBe(false);
    expect(classifyRefusal(STANDARD_BANK_REASON)).toBe("refused");
  });

  it("is re-run by the version sweep once the reader ships", () => {
    const now = Date.UTC(2026, 10, 5);
    const row = {
      messageKey: "k1", at: now - 3 * 86400000, refused: 1, recorded: 0, parserVersion: 4,
      attachments: [{ outcome: "refused", reason: STANDARD_BANK_REASON }],
    };
    expect(retryCandidates({ a: row }, { nowMs: now, deployedVersion: 4 })).toEqual([]);
    expect(retryCandidates({ a: row }, { nowMs: now, deployedVersion: 5 }).map((c) => c.id)).toEqual(["a"]);
  });
});

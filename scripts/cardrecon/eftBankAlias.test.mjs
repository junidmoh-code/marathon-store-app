// ─── BANK-NAME ALIASES (Junid, 25 Nov 2026) ──────────────────────────────────
// Absa named Standard Bank "STD S.A." and the confirmer refused a genuine
// R5,900 payment into the shop's own Standard Bank account. One normaliser
// (functions/lib/eft-bank-alias.cjs) now reads every printed variant; the
// DECISION still rests on the destination account number. Each case runs the
// poller's chain on the real notice's lines: reader → destination → timing →
// date → pool record.
//
// ACCOUNT NUMBERS HERE ARE STAND-INS (this repo is public).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { selectReader } from "./eftBanks.mjs";
import {
  authenticationVerdict, destinationVerdict, enforcesImmediateOnly, immediacyVerdict,
  paymentDateVerdict, parsePaymentDateCutoff, parseAccountPolicies, eftPoolRecord,
} from "./eftCore.mjs";

const require = createRequire(import.meta.url);
const { bankIdOf, bankIdFromBranchCode, normaliseBankName } = require("../../functions/lib/eft-bank-alias.cjs");
const { SB_ACCOUNT, SB_POLICY, ABSA_STD_SA, absaStdSa } = require("../../functions/test/fixtures/absa-std-sa-2026-11-25.cjs");

const FNB = "62900004321";
const POLICIES = parseAccountPolicies(`${FNB}, 62000009092, ${SB_POLICY}`);
const ARRIVED = Date.parse("2026-11-25T17:57:37+02:00");
const FROM = "ibreply@absa.co.za";
const auth = authenticationVerdict({
  fromAddress: FROM,
  headerLines: [
    { key: "authentication-results", line: "Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@absa.co.za header.s=s1 header.b=x;\r\n       spf=pass smtp.mailfrom=absa.co.za;\r\n       dmarc=pass (p=REJECT) header.from=absa.co.za" },
    { key: "from", line: `From: <${FROM}>` },
  ],
});

/** The poller's chain — destBranchCode passed exactly as email-poller.mjs does. */
function decide(lines, { policies = POLICIES } = {}) {
  const reader = selectReader({ fromDomain: "absa.co.za", lines });
  const parsed = reader.parse(lines);
  expect(parsed.ok, parsed.reason).toBe(true);
  const account = destinationVerdict({
    accountMask: parsed.accountMask, destBankName: parsed.destBankName,
    allowedAccounts: policies, configured: true, destBranchCode: parsed.destBranchCode ?? null,
  });
  const timing = immediacyVerdict({ parsed, reader: reader.id, receivedAt: ARRIVED, immediateOnly: account?.ok === true && enforcesImmediateOnly(account) });
  const dated = paymentDateVerdict({ parsed, cutoff: parsePaymentDateCutoff(undefined) });
  const record = eftPoolRecord({
    message: { messageId: "<n@absa>", from: FROM, subject: "Notice of payment: CONCRETE", receivedAt: ARRIVED },
    verdict: auth, parsed, account, timing, dated, reader: reader.id, rawText: lines.join("\n"), at: ARRIVED,
  });
  return { parsed, account, record };
}

describe("the shared normaliser", () => {
  it("reads every Standard Bank variant, case and punctuation ignored", () => {
    for (const n of ["STD S.A.", "STD SA", "std s.a", "STD. S.A", "STANDARD BANK", "Standard Bank SA Ltd", "STANDARD BANK SA LTD",
      "SBSA", "THE STANDARD BANK OF SOUTH AFRICA", "The Standard Bank of South Africa Limited", "051001"]) {
      expect(bankIdOf(n), n).toBe("standardbank");
    }
  });
  it("reads every FNB variant", () => {
    for (const n of ["FNB", "F.N.B.", "FIRST NATIONAL BANK", "First National Bank", "FIRSTRAND", "FirstRand Bank Limited", "250655"]) {
      expect(bankIdOf(n), n).toBe("fnb");
    }
  });
  it("knows the other banks as OTHER banks, and never matches a substring", () => {
    expect(bankIdOf("CAPITEC BANK")).toBe("capitec");
    expect(bankIdOf("ABSA BANK LIMITED")).toBe("absa");
    expect(bankIdOf("NEDBANK")).toBe("nedbank");
    expect(bankIdOf("FIRSTRAND NAMIBIA")).toBe("fnbnamibia");
    expect(bankIdOf("STANDARD BANK OF NAMIBIA")).toBe("standardbanknamibia");
    for (const n of ["STD", "STANDARD", "BANK", "FIRST", "STD S.A. NAMIBIA", "SOME NEW BANK", "", null, "LTD"]) expect(bankIdOf(n), String(n)).toBe(null);
  });
  it("branch codes: universal six-digit, and Standard Bank's eight-digit 'xx00' form", () => {
    expect(bankIdFromBranchCode("051001")).toBe("standardbank");
    expect(bankIdFromBranchCode("051 001")).toBe("standardbank");
    expect(bankIdFromBranchCode("25065500")).toBe("fnb");
    expect(bankIdFromBranchCode("25065512")).toBe(null);
    expect(bankIdFromBranchCode("12345")).toBe(null);
    expect(normaliseBankName("The Standard Bank of South Africa Limited")).toBe("STANDARDBANKOFSOUTHAFRICA");
  });
});

describe("the real Absa 'STD S.A.' notice of 25 Nov 2026", () => {
  it("the Absa reader reads the bank as printed and its branch code", () => {
    const { parsed } = decide(ABSA_STD_SA);
    expect(parsed.destBankName).toBe("STD S.A.");
    expect(parsed.destBranchCode).toBe("051001");
    expect(parsed.accountMask).toBe(SB_ACCOUNT);
    expect(parsed.amountCents).toBe(590000);
    expect(parsed.immediate).toBe(true);
  });

  it("own account + alias → ACCEPTED (it was refused as Wrong destination account)", () => {
    const { account, record } = decide(ABSA_STD_SA);
    expect(account).toMatchObject({ ok: true, bank: "standardbank", tail: "8534" });
    expect(account.unrecognisedBankName).toBeUndefined();
    expect(record.outcome).toBe("recorded");
    expect(record.status).toBe("unmatched");
    expect(record.destination.bankNameUnrecognised).toBeUndefined();
  });

  it("the other copy's 'STANDARD BANK SA LTD' is accepted too", () => {
    expect(decide(absaStdSa({ bank: "STANDARD BANK SA LTD" })).record.outcome).toBe("recorded");
  });

  it("alias but WRONG account → refused-account (one digit off; and an FNB number)", () => {
    expect(decide(absaStdSa({ account: "10100008535" })).record.outcome).toBe("refused-account");
    expect(decide(absaStdSa({ account: "10100018534" })).record.outcome).toBe("refused-account");
    const fnbNumber = decide(absaStdSa({ account: FNB }));
    expect(fnbNumber.record.outcome).toBe("refused-account");
    expect(fnbNumber.record.reason).toMatch(/Standard Bank/);
  });

  it("the alias alone admits nothing: with no Standard Bank account configured it refuses", () => {
    const { record } = decide(ABSA_STD_SA, { policies: parseAccountPolicies(`${FNB}, 62000009092`) });
    expect(record.outcome).toBe("refused-account");
  });

  it("UNKNOWN bank name + own full account → decided on the account number (accepted), and the name is flagged for adding", () => {
    const { account, record } = decide(absaStdSa({ bank: "STNDRD BNK OF S.A.", branch: "" }));
    expect(account).toMatchObject({ ok: true, bank: "standardbank", unrecognisedBankName: "STNDRD BNK OF S.A." });
    expect(record.outcome).toBe("recorded");
    expect(record.destination.bankNameUnrecognised).toBe(true);
  });

  it("UNKNOWN bank name + someone else's account → refused", () => {
    expect(decide(absaStdSa({ bank: "STNDRD BNK OF S.A.", account: "10100008535", branch: "" })).record.outcome).toBe("refused-account");
  });

  it("a known OTHER bank with the shop's number still refuses; a branch code contradicting the name refuses", () => {
    expect(decide(absaStdSa({ bank: "CAPITEC BANK", branch: "470010" })).record.outcome).toBe("refused-account");
    expect(decide(absaStdSa({ branch: "250655" })).record.outcome).toBe("refused-account");
  });

  it("an unknown name never rides on a mask of ANY kind, a short number, or a branch code (architect review)", () => {
    const v = (accountMask, destBankName, destBranchCode = null, policies = POLICIES) => destinationVerdict({ accountMask, destBankName, destBranchCode, allowedAccounts: policies, configured: true });
    const tailOnly = parseAccountPolicies("8534:standardbank");
    for (const mask of ["•••• 8534", "…8534", "#######8534", "8534"]) expect(v(mask, "FOO BANK", null, tailOnly).ok, mask).toBe(false);
    expect(v("xxxx8534", "FOO BANK", "051001").ok).toBe(false);
    expect(v(SB_ACCOUNT, "FOO BANK", "051001")).toMatchObject({ ok: true, bank: "standardbank", unrecognisedBankName: "FOO BANK" });
    expect(v(SB_ACCOUNT, "FOO BANK", "250655").ok).toBe(false); // the branch says FNB; the number is the Standard Bank one
    expect(v(SB_ACCOUNT, null, "051001").ok).toBe(true);
    expect(v("XXXXXXX8534", null, "051001").ok).toBe(false);
  });

  it("the poller LOGS an unrecognised name it admitted, and passes the branch code", () => {
    const src = readFileSync(new URL("./email-poller.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/destBranchCode: group\.parse\.destBranchCode/);
    expect(src).toMatch(/EFT_UNRECOGNISED_BANK_NAME/);
  });
});

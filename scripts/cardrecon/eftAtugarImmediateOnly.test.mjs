// ─── THE STANDARD BANK ATUGAR ACCOUNT — IMMEDIATE ONLY (Junid, 2 Nov 2026) ───
// The shop is also paid into a Standard Bank account (ATUGAR TRADING PTY LTD).
// Its EFT_ALLOWED_ACCOUNTS entry is tagged ":standardbank:immediate":
//   · a payment into it is judged by ACCOUNT NUMBER and the bank it is at —
//     never by the beneficiary name the payer typed;
//   · it takes IMMEDIATE payments only — a regular payment into it refuses even
//     when dated on/after 2026-10-27, when the date-phased rule otherwise
//     accepts regular payments;
//   · every other account keeps the date-phased rule.
// Each case runs the poller's own chain (email-poller.mjs): reader → 7a → 7b
// (with the matched account's immediateOnly) → fix 8 → the pool record.
//
// ACCOUNT NUMBERS HERE ARE STAND-INS (this repo is public): the real ones live
// in the mini's .env and the Secret Manager secret. The Standard Bank stand-in
// has the same shape as the real account (eleven digits, printed by Standard
// Bank in groups like "10 10 000 853 4").
import { describe, it, expect } from "vitest";
import { selectReader } from "./eftBanks.mjs";
import {
  authenticationVerdict, destinationVerdict, immediacyVerdict, paymentDateVerdict,
  parsePaymentDateCutoff, parseAccountPolicies, parseAllowedAccounts, accountPolicyProblems, eftPoolRecord,
} from "./eftCore.mjs";

const FNB = "62900004321";          // the Marathon FNB account (stand-in)
const SB = "10100008534";           // the ATUGAR Standard Bank account (stand-in)
const SB_GROUPED = "10 10 000 853 4";
const ENV = `${FNB}, 62000009092, ${SB}:standardbank:immediate`;
const POLICIES = parseAccountPolicies(ENV);
const RECEIVED = Date.parse("2026-11-02T10:00:00Z");

const auth = (domain, from) => authenticationVerdict({
  fromAddress: from,
  headerLines: [
    { key: "authentication-results", line: `Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@${domain} header.s=s1 header.b=x;\r\n       spf=pass smtp.mailfrom=${domain};\r\n       dmarc=pass (p=REJECT) header.from=${domain}` },
    { key: "from", line: `From: <${from}>` },
  ],
});

// The real Standard Bank layout (eftStandardBankImmediate.test.mjs), with the
// heading, destination bank/account, beneficiary name and date varied.
const standardBank = ({ heading = "Immediate Payment Confirmation", bank = "STANDARD BANK", account = SB, name = "ATUGAR TRADING PTY LTD", date = "2026-11-01 10h15", dear = "MARATHON CLUB" } = {}) => [
  "Internet Banking",
  "Website: www.standardbank.co.za",
  `Dear ${dear}`,
  ...(heading ? [heading] : []),
  "We confirm that the following payment has been made into your account from A CUSTOMER:",
  "Reference number 261101SBGRPP00000001C00000001",
  `Beneficiary name ${name}`,
  `Bank name ${bank}`,
  `Beneficiary account number ${account}`,
  "Beneficiary branch number 051001",
  "Beneficiary reference CUSTREF",
  "Amount R450.00",
  `Payment date and time ${date}`,
  "Immediate payments may take a few hours.",
  "Non-immediate payments to Standard Bank accounts may take up to 24 hours.",
  "Non-immediate payments to other banks may take up to three business days.",
  "The Standard Bank of South Africa Limited (Reg. No. 1962/000738/06)",
];
// Capitec prints "Immediate Payment" / "Regular Payment" — the other bank a
// customer pays the Standard Bank account from.
const capitec = ({ type = "Immediate Payment", bank = "Standard Bank", account = SB, name = "ATUGAR", date = "01/11/2026 09:30" } = {}) => [
  "Payment Notification",
  "Capitec Bank",
  "Please take note that A Customer made a payment to your account.",
  "Notification number 600001",
  `Payment date ${date}`,
  `Beneficiary name ${name}`,
  `Bank name ${bank}`,
  `Account number ${account}`,
  "Branch 051001",
  `Payment type ${type}`,
  "Amount R300.00",
  "Payment reference CUSTREF",
];

/** The poller's chain for one document, to the record it would write. */
function decide(domain, from, lines, policies = POLICIES) {
  const reader = selectReader({ fromDomain: domain, lines });
  const parsed = reader.parse(lines);
  expect(parsed.ok, parsed.reason).toBe(true);
  const account = destinationVerdict({ accountMask: parsed.accountMask, destBankName: parsed.destBankName, allowedAccounts: policies, configured: true });
  const timing = immediacyVerdict({
    parsed, reader: reader.id, receivedAt: RECEIVED,
    immediateOnly: account?.ok === true && account.immediateOnly === true,
  });
  const dated = paymentDateVerdict({ parsed, cutoff: parsePaymentDateCutoff(undefined) });
  return eftPoolRecord({
    message: { messageId: "<m@x>", from, subject: "Payment", receivedAt: RECEIVED },
    verdict: auth(domain, from), parsed, account, timing, dated, reader: reader.id, rawText: lines.join("\n"), at: RECEIVED,
  });
}
const sb = (o) => decide("standardbank.co.za", "noreply@standardbank.co.za", standardBank(o));
const cap = (o) => decide("capitecbank.co.za", "noreply@capitecbank.co.za", capitec(o));

describe("EFT_ALLOWED_ACCOUNTS carries each account's bank and immediate-only tag", () => {
  it("reads the tags; an untagged entry is an FNB account under the date-phased rule", () => {
    expect(POLICIES).toEqual([
      { account: FNB, bank: "fnb", immediateOnly: false },
      { account: "62000009092", bank: "fnb", immediateOnly: false },
      { account: SB, bank: "standardbank", immediateOnly: true },
    ]);
    // The plain list (keyed proofs, older callers) is the digits, unchanged.
    expect(parseAllowedAccounts(ENV)).toEqual([FNB, "62000009092", SB]);
    // Spaces in the number are ignored, as Standard Bank prints it.
    expect(parseAccountPolicies(`${SB_GROUPED}:StandardBank:IMMEDIATE`)).toEqual([{ account: SB, bank: "standardbank", immediateOnly: true }]);
    expect(accountPolicyProblems(ENV)).toEqual([]);
  });

  it("an entry whose tags do not read is LEFT OUT (fail closed), and said without the full number", () => {
    for (const bad of [`${SB}:standard`, `${SB}:standardbank:fnb`, `${SB}:immediate:immediate`, `${SB}:imediate`, `${SB} standardbank immediate`, `${SB}:${FNB}`]) {
      expect(parseAccountPolicies(bad), bad).toEqual([]);
      const [problem] = accountPolicyProblems(bad);
      expect(problem, bad).toMatch(/ending 8534/);
      expect(problem).not.toContain(SB);
      expect(problem).not.toContain(FNB); // a mis-pasted second number is never echoed
    }
  });
});

describe("a payment into the Standard Bank account", () => {
  it("an IMMEDIATE Standard Bank payment into it CONFIRMS", () => {
    const r = sb();
    expect(r.outcome).toBe("recorded");
    expect(r.amountCents).toBe(45000);
    expect(r.destination.destBankName).toBe("STANDARD BANK");
    // The full number never reaches the database.
    expect(JSON.stringify(r)).not.toContain(SB);
  });

  it("…whether Standard Bank prints the number whole, masked, or in groups", () => {
    expect(sb({ account: "XXXXXXX08534" }).outcome).toBe("recorded");
    expect(sb({ account: SB_GROUPED }).outcome).toBe("recorded");
  });

  it("a REGULAR payment into it from ANOTHER bank is REFUSED — even dated on/after 2026-10-27", () => {
    // A Standard Bank notice paying it is Standard-to-Standard — same-bank,
    // immediate by nature (6 Nov 2026; eftStandardSameBank.test.mjs).
    for (const date of ["2026-10-27 08h00", "2026-11-01 10h15"]) {
      expect(sb({ heading: "Payment Confirmation", date }).outcome, date).toBe("recorded");
    }
    // Capitec "Regular Payment" into it: refused.
    const c = cap({ type: "Regular Payment" });
    expect(c.outcome).toBe("refused-not-immediate");
    expect(c.reason).toMatch(/IMMEDIATE payments only/);
    // …and Capitec "Immediate Payment" into it confirms.
    expect(cap().outcome).toBe("recorded");
  });

  it("no heading (the same-bank layout) into it confirms on the BANK, never on the footer's wording", () => {
    // Same-bank because the notice is Standard Bank's and the destination is
    // Standard Bank — the footer's "immediate" never decides anything.
    expect(sb({ heading: null }).outcome).toBe("recorded");
    // The same notice paying the FNB account dated 20–26 Oct is not same-bank:
    // no heading there is still unreadable immediacy, refused.
    const fnb = sb({ heading: null, bank: "FIRST NATIONAL BANK", account: "XXXXXXXXXXXXX4321", date: "2026-10-24 10h15" });
    expect(fnb.outcome).toBe("refused-not-immediate");
  });

  it("the beneficiary NAME is never a reason — ATUGAR, Marathon Club or anything else", () => {
    for (const name of ["ATUGAR TRADING PTY LTD", "ATUGAR", "MARATHON CLUB", "Some Name The Payer Typed"]) {
      expect(sb({ name }).outcome, name).toBe("recorded");
      expect(cap({ name }).outcome, name).toBe("recorded");
    }
  });

  it("a Standard Bank account that is NOT ours refuses, even ending in the same four digits", () => {
    expect(sb({ account: "10199998534" }).outcome).toBe("refused-account");
    // Standard Bank masks to four: a different Standard Bank account ending
    // like the FNB one is not the FNB account.
    expect(sb({ account: "XXXXXXX04321" }).outcome).toBe("refused-account");
  });

  it("the Standard Bank number paid at ANOTHER bank refuses (the account is bound to its bank)", () => {
    expect(sb({ bank: "FIRST NATIONAL BANK", account: SB }).outcome).toBe("refused-account");
    expect(sb({ bank: "CAPITEC BANK", account: SB }).outcome).toBe("refused-account");
  });

  it("without the tag, a Standard Bank destination is refused exactly as before this change", () => {
    const fnbOnly = parseAccountPolicies(`${FNB}, ${SB}`); // untagged → FNB
    const r = decide("standardbank.co.za", "noreply@standardbank.co.za", standardBank(), fnbOnly);
    expect(r.outcome).toBe("refused-account");
  });
});

describe("every other account keeps the date-phased rule", () => {
  it("a REGULAR payment into the Marathon FNB account dated on/after 2026-10-27 still CONFIRMS", () => {
    expect(cap({ type: "Regular Payment", bank: "First National Bank", account: FNB, name: "Marathon" }).outcome).toBe("recorded");
    expect(sb({ heading: "Payment Confirmation", bank: "FIRST NATIONAL BANK", account: "XXXXXXXXXXXXX4321", name: "MARATHON CLUB" }).outcome).toBe("recorded");
  });

  it("…and before 2026-10-27 a regular payment into it is still refused (unchanged)", () => {
    const r = cap({ type: "Regular Payment", bank: "First National Bank", account: FNB, date: "24/10/2026 09:30" });
    expect(r.outcome).toBe("refused-not-immediate");
    expect(r.reason).toMatch(/before 2026-10-27 must be immediate/);
  });

  it("the immediate-only flag is the matched account's — never the store's or the bank's", () => {
    const fnb = destinationVerdict({ accountMask: FNB, destBankName: "FIRST NATIONAL BANK", allowedAccounts: POLICIES, configured: true });
    expect(fnb).toEqual({ ok: true, tail: "4321", bank: "fnb", immediateOnly: false });
    const atugar = destinationVerdict({ accountMask: SB, destBankName: "Standard Bank", allowedAccounts: POLICIES, configured: true });
    expect(atugar).toEqual({ ok: true, tail: "8534", bank: "standardbank", immediateOnly: true });
  });
});

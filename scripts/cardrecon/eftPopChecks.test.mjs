// ─── FIX 7: TWO PROOF-OF-PAYMENT CHECKS (built for when ingestion returns) ───
// A. ACCOUNT — the money must be paid INTO JUNID'S OWN FNB ACCOUNT. The check
//    used to compare only the LAST FOUR digits of whatever the document
//    printed, and never the bank: a payment to a Capitec or Absa account that
//    happens to end in the same four digits passed.
// B. IMMEDIATE — only a real-time / immediate EFT may become a payment. A
//    scheduled, future-dated or normal-clearing payment's notification is an
//    INSTRUCTION that may never clear (or be cancelled), so it refuses.
// Both use only fields the bank readers (eftBanks.mjs) already parse from the
// REAL fixtures. Where a bank's document carries no such field, it REFUSES and
// says a real sample is needed — the format is never guessed.
import { describe, it, expect } from "vitest";
import {
  accountVerdict, parseAllowedAccountTails, parseAllowedAccounts, destinationVerdict, immediacyVerdict,
  eftPoolRecord,
} from "./eftCore.mjs";

const OURS = "62900004321"; // the fixtures' sanitised shop account
const CONFIG = `${OURS}, 62000009092`;

describe("7a — paid into Junid's own FNB account", () => {
  it("BEFORE: the last-four check passes a payment to ANOTHER bank's account ending the same", () => {
    const tails = parseAllowedAccountTails(CONFIG);
    expect(accountVerdict({ accountMask: "1234567894321", allowedTails: tails, configured: true }).ok).toBe(true);
    expect(accountVerdict({ accountMask: "XXXXXXXXXXXX4321", allowedTails: tails, configured: true }).ok).toBe(true); // bank never looked at
  });

  const allowed = parseAllowedAccounts(CONFIG);
  const v = (accountMask, destBankName) => destinationVerdict({ accountMask, destBankName, allowedAccounts: allowed, configured: true });

  it("AFTER: a full account number must BE ours, digit for digit", () => {
    expect(v(OURS, "FIRST NATIONAL BANK").ok).toBe(true);
    expect(v("1234567894321", "FIRST NATIONAL BANK").ok).toBe(false);
    expect(v("62900014321", "FIRST NATIONAL BANK").ok).toBe(false); // same tail, one digit off
  });

  it("AFTER: a masked number must agree with ours on every digit it shows", () => {
    expect(v("XXXXXXXXXXXX4321", "FIRST NATIONAL BANK").ok).toBe(true); // Standard Bank masks to 4
    expect(v("..0004321", "FIRST NATIONAL BANK").ok).toBe(true);        // FNB shows 7
    expect(v("..9994321", "FIRST NATIONAL BANK").ok).toBe(false);
    expect(v("XXXX321", "FIRST NATIONAL BANK").ok).toBe(false);          // under four digits: uncheckable
  });

  it("AFTER: the destination bank must be FNB — by the bank's own printed name", () => {
    expect(v(OURS, "First National Bank").ok).toBe(true);
    expect(v(OURS, "FNB").ok).toBe(true);
    // Absa names FNB's legal entity (real notifications, 5 Oct 2026).
    expect(v(OURS, "FIRSTRAND").ok).toBe(true);
    expect(v(OURS, "FirstRand Bank Limited").ok).toBe(true);
    expect(v("62900014321", "FIRSTRAND").ok).toBe(false); // the account is still checked
    for (const bank of ["CAPITEC BANK", "ABSA", "STANDARD BANK", "FIRST NATIONAL BANK OF NAMIBIA", "FIRSTRAND NAMIBIA", "", null]) {
      const out = v(OURS, bank);
      expect(out.ok, String(bank)).toBe(false);
    }
  });

  it("a configured tail-only entry cannot vouch for a full printed number", () => {
    const tailOnly = parseAllowedAccounts("4321");
    const out = destinationVerdict({ accountMask: "1234567894321", destBankName: "FIRST NATIONAL BANK", allowedAccounts: tailOnly, configured: true });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/full account number/);
  });

  it("nothing configured refuses everything, saying so", () => {
    const out = destinationVerdict({ accountMask: OURS, destBankName: "FIRST NATIONAL BANK", allowedAccounts: [], configured: false });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/EFT_ALLOWED_ACCOUNTS/);
  });

});

describe("7b — immediate payments only", () => {
  const base = { ok: true, amountCents: 100, bankTs: 1_000_000, accountMask: OURS, destBankName: "FIRST NATIONAL BANK" };
  const iv = (parsed, receivedAt = 1_000_000) => immediacyVerdict({ parsed, receivedAt });

  it("Capitec: 'Payment type Immediate Payment' passes; any other type refuses", () => {
    expect(iv({ ...base, reader: "capitec", immediate: true }).ok).toBe(true);
    expect(iv({ ...base, reader: "capitec", immediate: false, paymentType: "Future Dated Payment" }).ok).toBe(false);
  });

  it("Absa: 'Immediate payment: Y' passes; 'N' (normal clearing — by midnight) refuses", () => {
    expect(iv({ ...base, reader: "absa", immediate: true }).ok).toBe(true);
    const n = iv({ ...base, reader: "absa", immediate: false, paymentType: "N" });
    expect(n.ok).toBe(false);
    expect(n.reason).toMatch(/not an immediate payment/i);
  });

  it("Standard Bank's real sample carries NO immediate field — refuses and names the sample it needs", () => {
    const out = iv({ ...base, reader: "standardbank", immediate: null });
    expect(out.ok).toBe(false);
    expect(out.needsSample).toBe(true);
    expect(out.reason).toMatch(/real .* sample/i);
  });

  it("FNB has no printed field, but FNB-to-FNB is intra-bank immediate — passes; out to another bank does not", () => {
    // Destination FNB (the account check requires it anyway): intra-bank, immediate.
    expect(iv({ ...base, reader: "fnb", immediate: null, destBankName: "FIRST NATIONAL BANK" }).ok).toBe(true);
    expect(iv({ ...base, reader: "fnb", immediate: null, destBankName: "FNB" }).ok).toBe(true);
    // An FNB-origin payment OUT to another bank is not intra-bank; not immediate,
    // and NOT a needs-sample case.
    const out = iv({ ...base, reader: "fnb", immediate: null, destBankName: "NEDBANK" });
    expect(out.ok).toBe(false);
    expect(out.needsSample).toBeUndefined();
  });

  it("a payment dated in the FUTURE of its own notification is scheduled — refused, whatever it says", () => {
    const later = 1_000_000 + 2 * 60 * 60 * 1000;
    expect(iv({ ...base, reader: "capitec", immediate: true, bankTs: later }).ok).toBe(false);
    // A clock wobble is not a schedule: inside the tolerance passes.
    expect(iv({ ...base, reader: "capitec", immediate: true, bankTs: 1_000_000 + 5 * 60 * 1000 }).ok).toBe(true);
  });

  it("the pool record stores a timing refusal as its own outcome, never spendable", () => {
    const message = { messageId: "<m>", from: "x@capitecbank.co.za", subject: "s", receivedAt: 1_000_000 };
    const verdict = { pass: true, fromDomain: "capitecbank.co.za", dkimDomain: "capitecbank.co.za", detail: "ok" };
    const parsed = { ...base, reader: "capitec", immediate: false, paymentType: "Future Dated", reference: "R", payer: "P", bankRef: "500001" };
    const rec = eftPoolRecord({
      message, verdict, parsed, reader: "capitec", rawText: "", at: 1,
      account: { ok: true, tail: "4321" }, timing: immediacyVerdict({ parsed, receivedAt: 1_000_000 }),
    });
    expect(rec.outcome).toBe("refused-not-immediate");
    expect(rec.status).toBeUndefined();
  });
});

describe("the poller runs both checks on every parsed payment (source scan)", () => {
  it("destinationVerdict with the full numbers and the bank, and immediacyVerdict, feed eftPoolRecord", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./email-poller.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/destinationVerdict\(\{\s*accountMask: group\.parse\.accountMask, destBankName: group\.parse\.destBankName,\s*allowedAccounts: cfg\.eftAccounts/);
    expect(src).toMatch(/immediacyVerdict\(\{ parsed: group\.parse, reader: group\.readerId, receivedAt: message\.receivedAt \}\)/);
    expect(src).toMatch(/message, verdict, parsed: group\.parse, account, timing,/);
    expect(src).not.toMatch(/accountVerdict\(/);
  });
});

describe("7a — a complete printed account must EQUAL ours, not merely be a suffix (CodeRabbit)", () => {
  // A configured number one digit LONGER than a full printed number must not be
  // matched by suffix: the printed full number has to be exactly a configured one.
  const allowed = parseAllowedAccounts("162903776625, 62000009092"); // first is 12 digits
  const v = (accountMask) => destinationVerdict({ accountMask, destBankName: "FIRST NATIONAL BANK", allowedAccounts: allowed, configured: true });
  it("full 11-digit print does NOT match a 12-digit configured account by suffix", () => {
    expect(v("62903776625").ok).toBe(false);
  });
  it("full print matches only an exact configured number", () => {
    expect(destinationVerdict({ accountMask: "62903776625", destBankName: "FNB", allowedAccounts: parseAllowedAccounts("62903776625"), configured: true }).ok).toBe(true);
  });
  it("a genuinely masked number still matches by suffix", () => {
    expect(destinationVerdict({ accountMask: "XXXXXXX6625", destBankName: "FNB", allowedAccounts: parseAllowedAccounts("162903776625"), configured: true }).ok).toBe(true);
    expect(destinationVerdict({ accountMask: "..776625", destBankName: "FNB", allowedAccounts: parseAllowedAccounts("162903776625"), configured: true }).ok).toBe(true);
  });
});

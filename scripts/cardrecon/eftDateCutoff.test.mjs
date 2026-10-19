// ─── FIX 8: THE EFFECTIVE-DATE CUTOFF — no payment the bank dates before it ──
// Junid, 19 Oct 2026. Dedupe (fix 1) stops the SAME payment twice; it cannot
// stop a payment the pool has NEVER seen — a genuine payment from weeks or
// months ago, before the pool was live, whose proof of payment is forwarded
// in today. These tests pin the four things that make the gate worth having:
//
//   1. the boundary — dated 2026-10-19 or earlier refuses, 2026-10-20+ passes;
//   2. the date is THE BANK'S (bankTs, the printed payment date), never the
//      mailbox's: an old proof of payment that ARRIVES today still refuses,
//      and a notification with no readable bank date refuses rather than
//      falling back to arrival time;
//   3. the cutoff is CONFIG (EFT_PAYMENT_DATE_CUTOFF) — moving it moves the
//      boundary, and a value that is not a date is a refusal sentence, not a
//      silent default;
//   4. the refusal lands as its own quarantined outcome, never spendable, and
//      Junid's verdict email names the check.
import { describe, it, expect } from "vitest";
import {
  parsePaymentDateCutoff, paymentDateVerdict, sastDate, parseBankTimestamp, eftPoolRecord,
  destinationVerdict, immediacyVerdict, applyFingerprintHold, parseAllowedAccounts,
  EFT_CUTOFF_ENV_VAR, DEFAULT_EFT_PAYMENT_DATE_CUTOFF,
} from "./eftCore.mjs";
import { selectReader } from "./eftBanks.mjs";
import { eftVerdict, failedCheck, verdictMail, drainVerdictEmails, EFT_VERDICT_SUBJECT_PREFIX } from "./verdictMailCore.mjs";

// SAST is UTC+2, no daylight saving: a bank's "2026-10-20" starts at 22:00 UTC the 19th.
const SAST = 2 * 60 * 60 * 1000;
const sast = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi) - SAST;
const DEFAULT = parsePaymentDateCutoff(undefined);
const verdict = (bankTs, cutoff = DEFAULT) => paymentDateVerdict({ parsed: { ok: true, bankTs }, cutoff });

describe("the cutoff is config — EFT_PAYMENT_DATE_CUTOFF, default 2026-10-20", () => {
  it("unset or blank means the default, the first instant of 2026-10-20 in SAST", () => {
    expect(DEFAULT_EFT_PAYMENT_DATE_CUTOFF).toBe("2026-10-20");
    for (const raw of [undefined, null, "", "   "]) {
      expect(parsePaymentDateCutoff(raw)).toEqual({ ok: true, date: "2026-10-20", startMs: sast(2026, 10, 20) });
    }
  });

  it("a configured date is read as a SAST calendar day", () => {
    expect(parsePaymentDateCutoff(" 2026-11-01 ")).toEqual({ ok: true, date: "2026-11-01", startMs: sast(2026, 11, 1) });
    expect(parsePaymentDateCutoff("2026-09-01")).toEqual({ ok: true, date: "2026-09-01", startMs: sast(2026, 9, 1) });
  });

  it("anything that is not a real YYYY-MM-DD date is a refusal SENTENCE naming the variable — never a silent default", () => {
    for (const raw of ["20/10/2026", "2026-10-20 00:00", "2026-02-30", "yesterday", "0", "2026-13-01"]) {
      const out = parsePaymentDateCutoff(raw);
      expect(out.ok, raw).toBe(false);
      expect(out.reason, raw).toContain(EFT_CUTOFF_ENV_VAR);
      expect(out.reason, raw).toContain(`"${raw}"`);
      expect(out.startMs, raw).toBeUndefined();
    }
  });
});

describe("the boundary — 2026-10-19 or earlier refuses, 2026-10-20 or later passes", () => {
  it("the last minute of 19 October refuses; the first instant of 20 October passes", () => {
    const stale = verdict(sast(2026, 10, 19, 23, 59));
    expect(stale.ok).toBe(false);
    expect(stale.reason).toMatch(/^Payment dated before the cutoff/);
    expect(stale.reason).toContain("the bank dates this payment 2026-10-19");
    expect(stale.reason).toContain("only payments dated 2026-10-20 or later");
    expect(stale.cutoff).toBe("2026-10-20");
    expect(verdict(sast(2026, 10, 20, 0, 0))).toEqual({ ok: true });
    expect(verdict(sast(2026, 10, 20, 9, 15))).toEqual({ ok: true });
    expect(verdict(sast(2026, 12, 31, 23, 59))).toEqual({ ok: true });
  });

  it("a payment weeks or months old — the case the gate exists for — refuses and names its own date", () => {
    for (const [str, day] of [["2026-08-30 23h48", "2026-08-30"], ["2026/09/15 14:41:56", "2026-09-15"], ["5 Oct 2026", "2026-10-05"], ["2025-10-20 10:00", "2025-10-20"]]) {
      const out = verdict(parseBankTimestamp(str));
      expect(out.ok, str).toBe(false);
      expect(out.reason, str).toContain(`the bank dates this payment ${day}`);
    }
  });

  it("the bank's calendar day is read in SAST, not UTC — 23:30 UTC on the 19th is already the 20th in South Africa", () => {
    // 2026-10-19T23:30Z is 01:30 SAST on 20 October: a payment the bank dates the 20th.
    const utcLate19th = Date.UTC(2026, 9, 19, 23, 30);
    expect(sastDate(utcLate19th)).toBe("2026-10-20");
    expect(verdict(utcLate19th)).toEqual({ ok: true });
    // 2026-10-19T21:30Z is 23:30 SAST on the 19th: before the cutoff.
    expect(verdict(Date.UTC(2026, 9, 19, 21, 30)).ok).toBe(false);
  });

  it("the date-only shapes Absa and FNB print: '2026-10-19' refuses, '2026-10-20' passes", () => {
    // Absa prints "Payment date:" then "2026-10-19" — midnight SAST of that day.
    expect(verdict(parseBankTimestamp("2026-10-19")).ok).toBe(false);
    expect(verdict(parseBankTimestamp("2026-10-20"))).toEqual({ ok: true });
    // FNB prints "Date Actioned : 2026/10/19" (with or without a Time Actioned).
    expect(verdict(parseBankTimestamp("2026/10/19")).ok).toBe(false);
    expect(verdict(parseBankTimestamp("2026/10/19 23:59:59")).ok).toBe(false);
    expect(verdict(parseBankTimestamp("2026/10/20"))).toEqual({ ok: true });
  });
});

describe("the date is THE BANK'S, never the mailbox's", () => {
  it("the verdict takes no arrival time at all — an old proof of payment forwarded today is judged on the bank's date", () => {
    // Whatever receivedAt a caller might hand in is not consulted: there is no such input.
    const today = sast(2026, 10, 19, 20, 0);
    const old = paymentDateVerdict({ parsed: { ok: true, bankTs: sast(2026, 8, 30, 23, 48), receivedAt: today }, cutoff: DEFAULT, receivedAt: today });
    expect(old.ok).toBe(false);
    expect(old.reason).toContain("the bank dates this payment 2026-08-30");
  });

  it("no readable bank date refuses — it does NOT fall back to the time the email arrived", () => {
    for (const bankTs of [null, undefined, NaN, "2026-10-25", 1.5]) {
      const out = paymentDateVerdict({ parsed: { ok: true, bankTs, receivedAt: sast(2026, 10, 25, 9, 0) }, cutoff: DEFAULT });
      expect(out.ok, String(bankTs)).toBe(false);
      expect(out.reason, String(bankTs)).toMatch(/bank's own payment date could not be read/);
      expect(out.reason, String(bankTs)).toMatch(/time the email arrived is never used/);
      expect(out.cutoff, String(bankTs)).toBe("2026-10-20");
    }
  });

  it("no cutoff configured refuses rather than assumes", () => {
    for (const cutoff of [null, undefined, {}, { date: "2026-10-20" }, { startMs: 1 }]) {
      const out = paymentDateVerdict({ parsed: { ok: true, bankTs: sast(2026, 10, 25) }, cutoff });
      expect(out.ok).toBe(false);
      expect(out.reason).toMatch(/never configured/);
    }
  });
});

describe("changing the config moves the boundary", () => {
  it("a later cutoff refuses a payment the default would admit; an earlier one admits a payment the default refuses", () => {
    const paidOct25 = sast(2026, 10, 25, 12, 0);
    expect(verdict(paidOct25)).toEqual({ ok: true });
    const nov = parsePaymentDateCutoff("2026-11-01");
    const late = verdict(paidOct25, nov);
    expect(late.ok).toBe(false);
    expect(late.reason).toContain("only payments dated 2026-11-01 or later");
    expect(late.cutoff).toBe("2026-11-01");

    const paidSep15 = parseBankTimestamp("2026-09-15 10:00");
    expect(verdict(paidSep15).ok).toBe(false);
    expect(verdict(paidSep15, parsePaymentDateCutoff("2026-09-01"))).toEqual({ ok: true });
    // Exactly on the moved boundary passes; the day before refuses.
    expect(verdict(sast(2026, 11, 1), nov)).toEqual({ ok: true });
    expect(verdict(sast(2026, 10, 31, 23, 59), nov).ok).toBe(false);
  });
});

// ── THE WHOLE CHAIN ON A REAL-SHAPED NOTIFICATION ────────────────────────────
// A Capitec immediate payment in the layout the live 5 Oct samples print —
// the one bank whose real notification passes BOTH earlier checks (7a: into
// the shop's FNB account; 7b: "Payment type Immediate Payment"), so the date
// gate is the only thing standing between it and the pool.
const ALLOWED = parseAllowedAccounts("62900004321");
const capitecLines = (paymentDate) => [
  "Payment Notification",
  "Please take note that Payer made a payment to your account. The payment details are as follows:",
  "Notification number 400077",
  `Payment date ${paymentDate}`,
  "Beneficiary name Marathon club",
  "Bank name First National Bank",
  "Account number 62900004321",
  "Payment type Immediate Payment",
  "Amount R450.00",
  "Payment reference HAFG",
];
const passAuth = { pass: true, fromDomain: "capitecbank.co.za", dkimDomain: "capitecbank.co.za", detail: "dkim=pass, signed by capitecbank.co.za, aligned with capitecbank.co.za" };

/** The poller's decision chain for one message, exactly as email-poller.mjs wires it. */
function confirm({ lines, receivedAt, cutoff = DEFAULT, holder = "pool-k" }) {
  const reader = selectReader({ fromDomain: "capitecbank.co.za", lines });
  expect(reader?.id).toBe("capitec");
  const parsed = reader.parse(lines);
  expect(parsed.ok).toBe(true);
  const message = { messageId: "<fwd@capitec>", from: "Capitec <noreply@capitecbank.co.za>", subject: "Payment Notification", receivedAt };
  const account = destinationVerdict({ accountMask: parsed.accountMask, destBankName: parsed.destBankName, allowedAccounts: ALLOWED, configured: true });
  const timing = immediacyVerdict({ parsed, reader: reader.id, receivedAt });
  const dated = paymentDateVerdict({ parsed, cutoff });
  const record = eftPoolRecord({ message, verdict: passAuth, parsed, account, timing, dated, reader: reader.id, rawText: lines.join("\n"), at: receivedAt + 5000 });
  return { parsed, account, timing, dated, record: applyFingerprintHold(record, { fingerprint: "fp-k", holder, poolKey: "pool-k" }) };
}

describe("an old proof of payment forwarded today — refused on the bank's date, through the whole chain", () => {
  // Genuinely paid 30 August 2026 (immediate, into the shop's account); the
  // email reaches the mailbox on 19 October 2026 at 18:40 SAST.
  const arrivedToday = sast(2026, 10, 19, 18, 40);
  const { parsed, account, timing, dated, record } = confirm({ lines: capitecLines("30/08/2026 11:36"), receivedAt: arrivedToday });

  it("passes the account and immediacy checks — it IS a real immediate payment into our account", () => {
    expect(parsed.bankTs).toBe(sast(2026, 8, 30, 11, 36));
    expect(account.ok).toBe(true);
    expect(timing.ok).toBe(true);
  });

  it("fails the date gate on the BANK'S date (30 Aug), although the email arrived today", () => {
    expect(dated.ok).toBe(false);
    expect(dated.reason).toContain("the bank dates this payment 2026-08-30");
  });

  it("lands as refused-stale-date: quarantined with the bank's date and the cutoff, never spendable", () => {
    expect(record.outcome).toBe("refused-stale-date");
    expect(record.status).toBeUndefined();
    expect(record.fingerprint).toBeUndefined(); // no claim is made for a refusal
    expect(record).toMatchObject({
      amountCents: 45000, reference: "HAFG", bankRef: "400077", cutoff: "2026-10-20",
      bankTs: sast(2026, 8, 30, 11, 36), receivedAt: arrivedToday, reader: "capitec",
      // The full printed account is masked to its last four on the way in (maskAccountValue).
      destination: { accountMask: "XXXXXXX4321", destBankName: "First National Bank" },
    });
    expect(record.reason).toMatch(/^Payment dated before the cutoff/);
  });

  it("Junid gets a REJECTED verdict naming the check and the cutoff", async () => {
    expect(eftVerdict(record)).toBe("REJECTED");
    expect(failedCheck(record)).toBe("Payment dated before the cutoff");
    const mail = verdictMail(record, { poolKey: "pool-k" });
    expect(mail.subject).toBe(`${EFT_VERDICT_SUBJECT_PREFIX} REJECTED — Payment dated before the cutoff — R450.00 · Capitec`);
    const first = mail.text.split("\n")[0];
    expect(first.startsWith("REJECTED — Payment dated before the cutoff: Payment dated before the cutoff: the bank dates this payment 2026-08-30")).toBe(true);
    expect(mail.text).toContain("Payment-date cutoff: 2026-10-20");
    expect(mail.text).toContain("Bank's timestamp: 2026-08-30 11:36:00 SAST");
    expect(mail.text).toContain("Notification arrived: 2026-10-19 18:40:00 SAST");
    // REJECTED-only mode still sends it.
    const sent = [];
    const out = await drainVerdictEmails({ queue: [{ record, poolKey: "pool-k" }], mode: "rejected", send: async (m) => { sent.push(m); }, from: "marathon6631@gmail.com" });
    expect(out.sent).toEqual([{ verdict: "REJECTED", check: "Payment dated before the cutoff" }]);
    expect(sent).toHaveLength(1);
  });
});

describe("the same notification dated on or after the cutoff is confirmed", () => {
  it("paid 20 October 2026 00:01: recorded, unmatched, spendable", () => {
    const { dated, record } = confirm({ lines: capitecLines("20/10/2026 00:01"), receivedAt: sast(2026, 10, 20, 0, 3) });
    expect(dated).toEqual({ ok: true });
    expect(record).toMatchObject({ outcome: "recorded", status: "unmatched", amountCents: 45000, fingerprint: "fp-k" });
    expect(eftVerdict(record)).toBe("APPROVED");
  });

  it("paid 19 October 2026 23:59 — one minute earlier — refuses", () => {
    const { record } = confirm({ lines: capitecLines("19/10/2026 23:59"), receivedAt: sast(2026, 10, 20, 0, 3) });
    expect(record.outcome).toBe("refused-stale-date");
  });

  it("with the cutoff moved back to 2026-08-01 in config, the 30 August payment is confirmed", () => {
    const { record } = confirm({ lines: capitecLines("30/08/2026 11:36"), receivedAt: sast(2026, 10, 19, 18, 40), cutoff: parsePaymentDateCutoff("2026-08-01") });
    expect(record).toMatchObject({ outcome: "recorded", status: "unmatched" });
  });

  it("a Capitec notification whose Payment date line will not read refuses — not admitted on arrival time", () => {
    const lines = capitecLines("yesterday");
    const { parsed, record } = confirm({ lines, receivedAt: sast(2026, 10, 25, 9, 0) });
    expect(parsed.bankTs).toBe(null);
    expect(record.outcome).toBe("refused-stale-date");
    expect(record.reason).toMatch(/could not be read/);
  });
});

describe("the record builder requires the date verdict, like the account and timing verdicts", () => {
  const message = { messageId: "<m>", from: "x@fnb.co.za", subject: "s", receivedAt: sast(2026, 10, 25) };
  const auth = { pass: true, fromDomain: "fnb.co.za", dkimDomain: "fnb.co.za", detail: "ok" };
  const parsed = { ok: true, amountCents: 100, reference: "R", payer: "P", bankTs: sast(2026, 10, 25), bankRef: "5TG59DVQ", accountMask: "..3456625", destBankName: "FNB" };
  it("a parsed payment never checked against the cutoff cannot be recorded", () => {
    const r = eftPoolRecord({ message, verdict: auth, parsed, account: { ok: true, tail: "6625" }, timing: { ok: true }, reader: "fnb", rawText: "", at: 1 });
    expect(r.outcome).toBe("refused-stale-date");
    expect(r.reason).toMatch(/never checked/);
    expect(r.status).toBeUndefined();
  });
  it("the gates keep their order: a wrong account or a non-immediate payment is named as THAT, not as stale", () => {
    const stale = paymentDateVerdict({ parsed: { ...parsed, bankTs: sast(2026, 9, 1) }, cutoff: DEFAULT });
    expect(eftPoolRecord({ message, verdict: auth, parsed, account: { ok: false, reason: "wrong account" }, timing: { ok: true }, dated: stale, reader: "fnb", rawText: "", at: 1 }).outcome).toBe("refused-account");
    expect(eftPoolRecord({ message, verdict: auth, parsed, account: { ok: true, tail: "6625" }, timing: { ok: false, reason: "not immediate" }, dated: stale, reader: "fnb", rawText: "", at: 1 }).outcome).toBe("refused-not-immediate");
  });
});

describe("the poller wires the gate on the bank's date (source scan)", () => {
  it("reads EFT_PAYMENT_DATE_CUTOFF into cfg, stops on a bad value, and never hands the verdict an arrival time", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./email-poller.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/parsePaymentDateCutoff\(env\.EFT_PAYMENT_DATE_CUTOFF\)/);
    expect(src).toMatch(/if \(!c\.ok\) fail\(/);
    expect(src).toMatch(/paymentDateVerdict\(\{ parsed: group\.parse, cutoff: cfg\.eftPaymentDateCutoff \}\)/);
    expect(src).not.toMatch(/paymentDateVerdict\([^)]*receivedAt/);
    expect(src).toMatch(/message, verdict, parsed: group\.parse, account, timing, dated,/);
    expect(src).toMatch(/eftRefusedStale: count\("refused-stale-date"\)/);
    expect(src).toMatch(/eftPaymentDateCutoff: cfg\.eftPaymentDateCutoff\.date/);
  });
});

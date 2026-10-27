// ─── JUNID'S EFT VERDICT EMAIL — tested on records the confirmer really writes ─
// Every record below is built by the confirmer's OWN functions (eftPoolRecord,
// destinationVerdict, immediacyVerdict, applyFingerprintHold,
// unknownBankRecord), so a change to what the confirmer writes shows up here
// rather than drifting past a hand-written fixture.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  eftPoolRecord, destinationVerdict, immediacyVerdict, paymentDateVerdict, parsePaymentDateCutoff, applyFingerprintHold, unknownBankRecord,
} from "./eftCore.mjs";
import { noReaderReason } from "./eftBanks.mjs";
import { OWNER } from "./intakeRules.mjs";
import {
  eftVerdict, failedCheck, decidingReason, verdictMail, parseVerdictMode, shouldSendVerdict,
  drainVerdictEmails, verdictSenderOk, STRANGER_EMAILS_PER_TICK, maskIdentifier, formatRands, formatSast,
  EFT_VERDICT_TO, EFT_VERDICT_SUBJECT_PREFIX, EFT_VERDICT_FROM_NAME,
} from "./verdictMailCore.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const SHOP_ACCOUNT = "62012345678";
const message = { messageId: "<m@fnb>", from: "FNB <inContact@fnb.co.za>", subject: "FNB: payment notification", receivedAt: 1792242000000 };
const passAuth = { pass: true, fromDomain: "fnb.co.za", dkimDomain: "fnb.co.za", detail: "dkim=pass, signed by fnb.co.za, aligned with fnb.co.za" };
const failAuth = { pass: false, fromDomain: "fnb.co.za", dkimDomain: "evil.example", detail: "dkim=pass for evil.example, which is not aligned with fnb.co.za" };
const parsed = (over = {}) => ({
  ok: true, amountCents: 125050, reference: "INV 1042", payer: "T MOKOENA",
  bankTs: 1792241940000, bankRef: "FNB20261017ABC9876", paymentType: "Immediate",
  accountMask: "XXXXXXX5678", destBankName: "FNB", beneficiaryName: "MARATHON", ...over,
});

// The fixture is a payment of 17 Oct 2026 — before the default cutoff (fix 8,
// 2026-10-20) — so the chain runs with the cutoff Junid would have had then;
// the stale case below runs it against the default.
const CUTOFF_THEN = parsePaymentDateCutoff("2026-10-01");

/** The confirmer's own decision chain for one parsed FNB payment. */
function decide({ auth = passAuth, p = parsed(), accounts = [SHOP_ACCOUNT], holder = "pool-1", reader = "fnb", cutoff = CUTOFF_THEN } = {}) {
  const account = p.ok ? destinationVerdict({ accountMask: p.accountMask, destBankName: p.destBankName, allowedAccounts: accounts, configured: accounts.length > 0 }) : null;
  const timing = p.ok ? immediacyVerdict({ parsed: p, reader, receivedAt: message.receivedAt }) : null;
  const dated = p.ok ? paymentDateVerdict({ parsed: p, cutoff }) : null;
  const record = eftPoolRecord({ message, verdict: auth, parsed: p, account, timing, dated, reader, rawText: "Amount R1,250.50 from 62834519234", at: 1792242005000 });
  return applyFingerprintHold(record, { fingerprint: record.bankRef ? `${reader}~${record.bankRef}` : null, holder, poolKey: "pool-1" });
}

describe("APPROVED — a payment that passed every check", () => {
  const record = decide();
  const mail = verdictMail(record, { poolKey: "pool-1" });

  it("is the confirmer's spendable record, and the email says APPROVED", () => {
    expect(record).toMatchObject({ outcome: "recorded", status: "unmatched" });
    expect(eftVerdict(record)).toBe("APPROVED");
    expect(mail.verdict).toBe("APPROVED");
    expect(mail.subject).toBe(`${EFT_VERDICT_SUBJECT_PREFIX} APPROVED — R1,250.50 · FNB`);
  });

  it("leads with the verdict and \"all checks passed\" on the first line", () => {
    const first = mail.text.split("\n")[0];
    expect(first.startsWith("APPROVED — ")).toBe(true);
    expect(first).toMatch(/all checks passed/i);
    expect(first).toMatch(/dated by the bank on or after the cutoff/);
  });

  it("carries the details, masked — never a full account or transaction number", () => {
    expect(mail.text).toContain("Bank: FNB");
    expect(mail.text).toContain("Amount: R1,250.50");
    expect(mail.text).toContain("Reference: INV 1042");
    expect(mail.text).toContain("Paid into: XXXXXXX5678 (FNB)");
    expect(mail.text).toContain("Bank transaction id: ••••••••9876");
    expect(mail.text).toContain("Notification arrived: 2026-10-17 15:00:00 SAST");
    expect(mail.text).toContain("Pool record: pool-1");
    expect(mail.text).not.toContain(SHOP_ACCOUNT);
    expect(mail.text).not.toContain("FNB20261017ABC9876");
    expect(mail.text).not.toContain("62834519234"); // the raw text never travels
  });
});

describe("REJECTED — every reason the confirmer can refuse names its check", () => {
  const cases = [
    {
      name: "wrong destination account",
      record: decide({ p: parsed({ accountMask: "XXXXXXX1111" }) }),
      outcome: "refused-account", check: "Wrong destination account", says: /account ending 1111/,
    },
    {
      name: "not an immediate / real-time payment (the bank prints a normal-clearing payment)",
      record: decide({ reader: "absa", p: parsed({ immediate: false, paymentType: "Normal" }) }),
      outcome: "refused-not-immediate", check: "Not an immediate (real-time) payment", says: /Not an immediate payment/,
    },
    {
      name: "not an immediate / real-time payment (future-dated)",
      record: decide({ p: parsed({ bankTs: message.receivedAt + 24 * 3600 * 1000 }) }),
      outcome: "refused-not-immediate", check: "Not an immediate (real-time) payment", says: /future-dated/,
    },
    {
      name: "payment dated before the cutoff (a 17 Oct payment against the default 2026-10-20 cutoff)",
      record: decide({ cutoff: parsePaymentDateCutoff(undefined) }),
      outcome: "refused-stale-date", check: "Payment dated before the cutoff", says: /the bank dates this payment 2026-10-17, and only payments dated 2026-10-20 or later/,
    },
    {
      name: "signature / DKIM failed",
      record: decide({ auth: failAuth }),
      outcome: "refused-auth", check: "Signature check failed (DKIM)", says: /Failed authentication/,
    },
    {
      name: "duplicate — bank transaction id already seen",
      record: decide({ holder: "pool-0" }),
      outcome: "held-duplicate", check: "Duplicate — bank transaction id already seen", says: /same bank transaction id/,
    },
    {
      name: "no bank transaction id",
      record: decide({ p: parsed({ bankRef: null }) }),
      outcome: "held-no-bankref", check: "No bank transaction id", says: /no bank transaction id/i,
    },
    {
      name: "unknown / unverified bank sender",
      record: unknownBankRecord({ message: { ...message, from: "pay@paymebank.example" }, fromDomain: "paymebank.example", rawText: "Payment of R500", at: 1 }),
      outcome: "unknown-bank", check: "Unknown bank sender", says: /paymebank\.example.*NOT one of the banks/,
    },
    {
      name: "unparseable",
      record: decide({ p: { ok: false, reason: 'The Amount line reads "R one thousand" — refused rather than guessed.' } }),
      outcome: "refused-parse", check: "Unreadable notification", says: /Amount line/,
    },
    {
      name: "unparseable — no reader for this bank's format",
      record: decide({ p: { ok: false, reason: noReaderReason("tymebank.co.za") } }),
      outcome: "refused-parse", check: "Unreadable notification", says: /No payment-notification reader exists for tymebank\.co\.za/,
    },
  ];

  for (const c of cases) {
    it(`${c.name}: REJECTED, naming "${c.check}" in the subject and the first line`, () => {
      expect(c.record.outcome).toBe(c.outcome);
      const mail = verdictMail(c.record, { poolKey: "k" });
      expect(mail.verdict).toBe("REJECTED");
      expect(failedCheck(c.record)).toBe(c.check);
      expect(mail.subject.startsWith(`${EFT_VERDICT_SUBJECT_PREFIX} REJECTED — ${c.check}`)).toBe(true);
      const first = mail.text.split("\n")[0];
      expect(first.startsWith(`REJECTED — ${c.check}: `)).toBe(true);
      expect(first).toMatch(c.says);
      expect(mail.text).not.toContain(SHOP_ACCOUNT);
      expect(mail.text).not.toContain("62834519234");
    });
  }

  it("a held payment is never APPROVED, even though it carries an amount", () => {
    expect(eftVerdict(decide({ holder: "pool-0" }))).toBe("REJECTED");
  });

  it("an outcome nobody has named yet is still REJECTED, with the raw outcome on show", () => {
    expect(eftVerdict({ outcome: "something-new" })).toBe("REJECTED");
    expect(failedCheck({ outcome: "something-new" })).toMatch(/something-new/);
    expect(eftVerdict(null)).toBe("REJECTED");
    // "recorded" alone is not enough: only an unmatched (spendable) record is approved.
    expect(eftVerdict({ outcome: "recorded", status: "used" })).toBe("REJECTED");
  });

  it("account digits in a reason are struck out before they reach the inbox", () => {
    const r = decidingReason({ outcome: "refused-parse", reason: "Read 62834519234 where the amount should be" });
    expect(r).not.toContain("62834519234");
    expect(r).toContain("⋯234");
  });

  it("a reference typed as an account number keeps only its last four; a phone reference stays matchable", () => {
    const mail = verdictMail(decide({ p: parsed({ reference: "62834519234" }) }));
    expect(mail.text).not.toContain("62834519234");
    expect(mail.text).toContain("Reference: ••9234");
    expect(verdictMail(decide({ p: parsed({ reference: "082 555 1234" }) })).text).toContain("Reference: ••1234");
    expect(verdictMail(decide({ p: parsed({ reference: "INV 1042" }) })).text).toContain("Reference: INV 1042");
  });

  it("an unknown-bank email says the signature was not checked, rather than printing the raw state", () => {
    const r = unknownBankRecord({ message, fromDomain: "paymebank.example", rawText: "x", at: 1 });
    expect(verdictMail(r).text).toContain("Signature (DKIM): not checked (a bank this pool is not set up for)");
  });

  it("a subject or body carrying newlines stays one header line", () => {
    const mail = verdictMail({ outcome: "refused-parse", reason: "line one\r\nBcc: x@y.z", amountCents: 100 });
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.text.split("\n")[0]).not.toMatch(/\r/);
  });
});

describe("the ALL / REJECTED-only switch", () => {
  it("defaults to ALL; reads rejected in the obvious spellings; a typo means ALL, with a warning", () => {
    expect(parseVerdictMode(undefined)).toEqual({ mode: "all", warning: null });
    expect(parseVerdictMode("ALL").mode).toBe("all");
    for (const v of ["rejected", "Rejected", "rejected-only", "REJECTED_ONLY"]) expect(parseVerdictMode(v)).toEqual({ mode: "rejected", warning: null });
    const typo = parseVerdictMode("rejectd");
    expect(typo.mode).toBe("all");
    expect(typo.warning).toMatch(/EFT_VERDICT_EMAILS/);
  });

  it("ALL sends both verdicts; REJECTED-only sends rejections only", () => {
    expect(shouldSendVerdict("APPROVED", "all")).toBe(true);
    expect(shouldSendVerdict("REJECTED", "all")).toBe(true);
    expect(shouldSendVerdict("APPROVED", "rejected")).toBe(false);
    expect(shouldSendVerdict("REJECTED", "rejected")).toBe(true);
  });

  const recorder = () => { const sent = []; return { sent, send: async (m) => { sent.push(m); } }; };

  const FROM = "marathon6631@gmail.com";

  it("REJECTED-only mode suppresses the APPROVED email and still sends the REJECTED one", async () => {
    const { sent, send } = recorder();
    const out = await drainVerdictEmails({ queue: [{ record: decide(), poolKey: "a" }, { record: decide({ auth: failAuth }), poolKey: "r" }], mode: "rejected", send, from: FROM });
    expect(out).toMatchObject({ skipped: 1, unsent: 0, error: null, sent: [{ verdict: "REJECTED", check: "Signature check failed (DKIM)" }] });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/^\[EFT confirmer\] REJECTED — Signature check failed/);
  });

  it("ALL mode sends both, from the card-recon mailbox to the recycler reports' inbox", async () => {
    const { sent, send } = recorder();
    await drainVerdictEmails({ queue: [{ record: decide(), poolKey: "a" }, { record: decide({ auth: failAuth }), poolKey: "r" }], mode: "all", send, from: FROM });
    expect(sent.map((m) => m.subject.split(" — ")[0])).toEqual(["[EFT confirmer] APPROVED", "[EFT confirmer] REJECTED"]);
    for (const m of sent) {
      expect(m.to).toBe("gunidmoh@gmail.com");
      expect(m.from).toEqual({ name: EFT_VERDICT_FROM_NAME, address: FROM });
    }
    // The recycler's OWNER_EMAIL and this repo's OWNER are the same inbox —
    // the 2026-09-21 near-miss (junidmoh@ vs gunidmoh@) must not recur here.
    expect(EFT_VERDICT_TO).toBe(OWNER);
  });

  it("sends only as the card-recon mailbox, like the recycler's guard", () => {
    expect(verdictSenderOk("marathon6631@gmail.com")).toBe(true);
    expect(verdictSenderOk(" Marathon6631@Gmail.com ")).toBe(true);
    expect(verdictSenderOk("someone@else.example")).toBe(false);
    expect(verdictSenderOk(undefined)).toBe(false);
  });
});

describe("sending a tick's verdicts", () => {
  const FROM = "marathon6631@gmail.com";
  const stranger = (n) => ({
    record: unknownBankRecord({ message: { ...message, from: `pay@bank${n}.example` }, fromDomain: `bank${n}.example`, rawText: "Payment received", at: 1 }),
    poolKey: `u${n}`,
  });

  it("the first failed send stops the round — never throws, says how many were dropped", async () => {
    let tries = 0;
    const out = await drainVerdictEmails({
      queue: [{ record: decide(), poolKey: "a" }, { record: decide({ auth: failAuth }), poolKey: "b" }, { record: decide(), poolKey: "c" }],
      mode: "all", from: FROM, send: async () => { tries += 1; throw new Error("535 bad credentials"); },
    });
    expect(tries).toBe(1);
    expect(out).toMatchObject({ sent: [], unsent: 3, error: "535 bad credentials" });
  });

  it("a stranger burst: the first few one by one, the rest in ONE roll-up; payments are never rolled up", async () => {
    const sent = [];
    const queue = [...[1, 2, 3, 4, 5, 6].map(stranger), { record: decide(), poolKey: "pay" }];
    const out = await drainVerdictEmails({ queue, mode: "all", from: FROM, send: async (m) => { sent.push(m); } });
    expect(STRANGER_EMAILS_PER_TICK).toBe(3);
    expect(sent).toHaveLength(3 + 1 + 1);
    expect(out.rolledUp).toBe(3);
    expect(sent.filter((m) => /APPROVED/.test(m.subject))).toHaveLength(1);
    const roll = sent.at(-1);
    expect(roll.subject).toBe("[EFT confirmer] REJECTED — Unknown bank sender — 3 more this round");
    expect(roll.text.split("\n")[0]).toMatch(/^REJECTED — Unknown bank sender: 3 more/);
    for (const d of ["bank4.example", "bank5.example", "bank6.example"]) expect(roll.text).toContain(d);
  });

  it("forgeries share the stranger cap with unknown banks, and the roll-up names each one's check", async () => {
    const sent = [];
    const queue = [stranger(1), stranger(2), ...[1, 2, 3].map((n) => ({ record: decide({ auth: failAuth }), poolKey: `f${n}` })), { record: decide({ p: parsed({ accountMask: "XXXXXXX1111" }) }), poolKey: "acct" }];
    const out = await drainVerdictEmails({ queue, mode: "all", from: FROM, send: async (m) => { sent.push(m); } });
    // 2 unknown + 1 forgery one by one, the wrong-account payment, then one roll-up of 2 forgeries.
    expect(sent).toHaveLength(5);
    expect(out.rolledUp).toBe(2);
    expect(sent.some((m) => /Wrong destination account/.test(m.subject))).toBe(true);
    const roll = sent.at(-1);
    expect(roll.subject).toBe("[EFT confirmer] REJECTED — Signature check failed (DKIM) — 2 more this round");
    expect(roll.text).toContain("- Signature check failed (DKIM) · FNB");
  });

  it("the bank's transaction id never appears whole — not even inside the bank's own subject line", () => {
    const record = { ...decide(), subject: "Payment Notification from T MOKOENA FNB20261017ABC9876" };
    const mail = verdictMail(record);
    expect(mail.text).not.toContain("FNB20261017ABC9876");
    expect(mail.text).toContain("Bank email subject: Payment Notification from T MOKOENA ••••••••9876");
  });
});

describe("formatting", () => {
  it("rands, SAST and masking", () => {
    expect(formatRands(123456789)).toBe("R1,234,567.89");
    expect(formatRands(5)).toBe("R0.05");
    expect(formatRands(null)).toBeNull();
    expect(formatSast(Date.UTC(2026, 9, 17, 22, 30, 0))).toBe("2026-10-18 00:30:00 SAST");
    expect(maskIdentifier("ABC")).toBe("•••");
    expect(maskIdentifier("1234567890123456")).toBe("••••••••3456");
    expect(maskIdentifier(null)).toBeNull();
  });
});

// The poller's wiring, read from source like the fingerprint-ordering test in
// eftCore.test.mjs: the email follows the write and only a WRITTEN record is
// emailed, at all three places the confirmer writes a pool record.
describe("the poller emails only after a pool record is written", () => {
  const src = readFileSync(resolve(HERE, "email-poller.mjs"), "utf8");
  it("the batch path: after the pool writes and the \\Seen flag, only for written records", () => {
    const write = src.indexOf("if (decision?.write) { written.push(record); writtenKeys.push(poolKey); }");
    const mail = src.indexOf("emailVerdict(written[i], writtenKeys[i])");
    expect(write).toBeGreaterThan(-1);
    expect(mail).toBeGreaterThan(src.indexOf('messageFlagsAdd(range, ["\\\\Seen"], { uid: true }).catch((err) =>', write));
  });
  it("the forgery-with-attachments path and the unknown-bank path: only when the create-only write landed", () => {
    expect(src).toMatch(/if \(d\?\.write\) \{\n\s+console\.log\([^\n]+\n\s+emailVerdict\(forgery, key\);/);
    expect(src).toMatch(/if \(!decision\?\.write\) return;[^\n]*\n\s+unknownBankThisRun \+= 1;\n[^\n]+\n\s+emailVerdict\(record, key\);/);
  });
  it("the queue is sent only after the mailbox session is closed", () => {
    expect(src).toMatch(/try \{ await client\.logout\(\); \} catch[^\n]*\n[^\n]*\n\s+await sendVerdicts\(\);/);
    expect(src).toMatch(/function emailVerdict\(record, poolKey\) \{\n\s+if \(verdictSend\) verdictQueue\.push\(\{ record, poolKey \}\);\n\}/);
  });
  it("a dry run sets up no sender", () => {
    expect(src).toMatch(/if \(!cfg\.dryRun\) \{\n\s+const transport = nodemailer\.createTransport[\s\S]{0,400}verdictSend = /);
  });
});

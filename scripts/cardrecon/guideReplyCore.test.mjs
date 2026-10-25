// ─── THE CUSTOMER GUIDE REPLY — tested on records the confirmer really writes ─
// Every refusal below is built by the confirmer's OWN functions, as in
// verdictMailCore.test.mjs, so the outcome gate is tested against the shapes
// the poller actually stores.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  eftPoolRecord, destinationVerdict, immediacyVerdict, paymentDateVerdict, parsePaymentDateCutoff,
  applyFingerprintHold, unknownBankRecord, looksLikeStrangerPayment,
} from "./eftCore.mjs";
import {
  guideReplyEligibility, guideReplyMail, drainGuideReplies, guideClaimPath, guideClaimStep, senderKey,
  senderVerified, hasProofAttachment, automatedMarker, parseGuideReplySwitch, parseNeverList,
  GUIDE_REPLY_TEXT, GUIDE_REPLY_SUBJECT, GUIDE_REPLY_FROM, GUIDE_REPLY_PATH, GUIDE_REPLIES_PER_TICK,
} from "./guideReplyCore.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAY = 1792242000000;                 // 2026-10-17 15:00 SAST
const NEXT_DAY = DAY + 24 * 3600 * 1000;

// ── A customer's own email: Gmail-verified, a PDF attached ───────────────────
const ar = (domain, extra = "") => ({
  key: "authentication-results",
  line: `Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@${domain} header.s=20230601 header.b=abc;\r\n       spf=pass (google.com: domain of x@${domain} designates 1.2.3.4 as permitted sender) smtp.mailfrom=x@${domain};\r\n       dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=${domain}${extra}`,
});
const pdf = { filename: "Proof of payment.pdf", contentType: "application/pdf", size: 84211, contentDisposition: "attachment" };

function customerMail({ address = "thandi.m@gmail.com", headerLines, attachments = [pdf], subject = "Proof of payment" } = {}) {
  const domain = address.split("@")[1];
  return {
    fromAddress: address,
    subject,
    headerLines: headerLines || [ar(domain), { key: "from", line: `From: Thandi <${address}>` }],
    attachments,
  };
}

/** What the poller writes for that mail — the stranger path's own record. */
function strangerRecord(m) {
  const domain = m.fromAddress.split("@")[1];
  return unknownBankRecord({
    message: { messageId: "<cust-1@mail.gmail.com>", from: `Thandi <${m.fromAddress}>`, subject: m.subject, receivedAt: DAY },
    fromDomain: domain, rawText: "Hi, here is my proof. R1,250.50", at: DAY,
  });
}

// ── The confirmer's other refusals (the verdict test's decide()) ─────────────
const SHOP_ACCOUNT = "62012345678";
const message = { messageId: "<m@fnb>", from: "FNB <inContact@fnb.co.za>", subject: "FNB: payment notification", receivedAt: DAY };
const passAuth = { pass: true, fromDomain: "fnb.co.za", dkimDomain: "fnb.co.za", detail: "dkim=pass" };
const failAuth = { pass: false, fromDomain: "fnb.co.za", dkimDomain: "evil.example", detail: "not aligned" };
const parsed = (over = {}) => ({
  ok: true, amountCents: 125050, reference: "INV 1042", payer: "T MOKOENA",
  bankTs: DAY - 60000, bankRef: "FNB20261017ABC9876", paymentType: "Immediate",
  accountMask: "XXXXXXX5678", destBankName: "FNB", beneficiaryName: "MARATHON", ...over,
});
function decide({ auth = passAuth, p = parsed(), holder = "pool-1", reader = "fnb" } = {}) {
  const account = p.ok ? destinationVerdict({ accountMask: p.accountMask, destBankName: p.destBankName, allowedAccounts: [SHOP_ACCOUNT], configured: true }) : null;
  const timing = p.ok ? immediacyVerdict({ parsed: p, reader, receivedAt: message.receivedAt }) : null;
  const dated = p.ok ? paymentDateVerdict({ parsed: p, cutoff: parsePaymentDateCutoff("2026-10-01") }) : null;
  const record = eftPoolRecord({ message, verdict: auth, parsed: p, account, timing, dated, reader, rawText: "x", at: DAY });
  return applyFingerprintHold(record, { fingerprint: record.bankRef ? `${reader}~${record.bankRef}` : null, holder, poolKey: "pool-1" });
}

/** One tick's drain against an in-memory /eft_guide_replies, as the poller wires it. */
function harness() {
  const store = new Map();
  const sent = [];
  let now = DAY;
  const drain = (queue, over = {}) => drainGuideReplies({
    queue,
    send: async (m) => { sent.push(m); },
    claim: async ({ to, poolKey }) => {
      const path = guideClaimPath(to, now);
      const next = guideClaimStep({ at: now, poolKey })(store.has(path) ? store.get(path) : null);
      if (next === undefined) return false;
      store.set(path, next);
      return true;
    },
    release: async ({ to }) => { store.delete(guideClaimPath(to, now)); },
    ...over,
  });
  return { store, sent, drain, at: (ms) => { now = ms; } };
}

function queueFor(m) {
  const v = guideReplyEligibility({ record: strangerRecord(m), ...m });
  return v.ok ? [{ to: v.to, inReplyTo: "<cust-1@mail.gmail.com>", poolKey: "pk" }] : [];
}

describe("a genuine proof from the customer's own Gmail / Yahoo", () => {
  for (const address of ["thandi.m@gmail.com", "sipho_k@yahoo.com", "Lerato@Outlook.com"]) {
    it(`${address}: the stranger path records it, and exactly ONE guide reply goes to the sender`, async () => {
      const m = customerMail({ address });
      expect(looksLikeStrangerPayment({ subject: m.subject, bodyText: "", attachmentNames: [pdf.filename] })).toBe(true);
      const record = strangerRecord(m);
      expect(record.outcome).toBe("unknown-bank");
      expect(guideReplyEligibility({ record, ...m })).toEqual({ ok: true, to: address.toLowerCase() });

      const h = harness();
      const out = await h.drain(queueFor(m));
      expect(out).toMatchObject({ sent: 1, limited: 0, error: null });
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]).toMatchObject({
        to: address.toLowerCase(), subject: GUIDE_REPLY_SUBJECT, text: GUIDE_REPLY_TEXT,
        from: { name: "Marathon Club", address: "marathon6631@gmail.com" }, replyTo: "marathon6631@gmail.com",
        inReplyTo: "<cust-1@mail.gmail.com>",
      });
      expect(h.sent[0].headers["Auto-Submitted"]).toBe("auto-replied");
    });
  }

  it("a screenshot attached as a picture counts as a proof too", () => {
    const m = customerMail({ attachments: [{ filename: "IMG_2041.jpg", contentType: "image/jpeg", size: 310000, contentDisposition: "attachment" }] });
    expect(guideReplyEligibility({ record: strangerRecord(m), ...m }).ok).toBe(true);
  });
});

describe("the rate limit — one per sender per SAST day", () => {
  it("a second mail from the same sender the same day gets NO reply", async () => {
    const h = harness();
    const m = customerMail();
    await h.drain(queueFor(m));
    const second = await h.drain(queueFor(m));
    expect(second).toMatchObject({ sent: 0, limited: 1 });
    expect(h.sent).toHaveLength(1);
  });

  it("two mails from the same sender in ONE tick: one reply", async () => {
    const h = harness();
    const m = customerMail();
    const out = await h.drain([...queueFor(m), ...queueFor(m)]);
    expect(out).toMatchObject({ sent: 1, limited: 1 });
    expect(h.sent).toHaveLength(1);
  });

  it("the same address in different case is the same sender", () => {
    expect(guideClaimPath("Thandi.M@Gmail.com", DAY)).toBe(guideClaimPath("thandi.m@gmail.com", DAY));
  });

  it("the next SAST day the same sender may get one again; another sender is not limited", async () => {
    const h = harness();
    await h.drain(queueFor(customerMail()));
    expect((await h.drain(queueFor(customerMail({ address: "someone.else@gmail.com" })))).sent).toBe(1);
    h.at(NEXT_DAY);
    expect((await h.drain(queueFor(customerMail()))).sent).toBe(1);
    expect(h.sent).toHaveLength(3);
  });

  it("the claim stores a hash under the day, never the address", async () => {
    const h = harness();
    await h.drain(queueFor(customerMail()));
    const [path, value] = [...h.store.entries()][0];
    expect(path).toBe(`${GUIDE_REPLY_PATH}/2026-10-17/${senderKey("thandi.m@gmail.com")}`);
    expect(JSON.stringify({ path, value })).not.toMatch(/thandi|gmail/i);
  });

  it("a failed send releases the claim (no reply was sent, so a later one may go)", async () => {
    const h = harness();
    const out = await h.drain(queueFor(customerMail()), { send: async () => { throw new Error("421 try later"); } });
    expect(out).toMatchObject({ sent: 0, unsent: 1, error: "421 try later" });
    expect(h.store.size).toBe(0);
  });

  it("a claim that cannot be made sends nothing (fail closed)", async () => {
    const h = harness();
    const out = await h.drain(queueFor(customerMail()), { claim: async () => { throw new Error("db down"); } });
    expect(out).toMatchObject({ sent: 0, unsent: 1 });
    expect(h.sent).toHaveLength(0);
  });

  it(`at most ${GUIDE_REPLIES_PER_TICK} per tick, whatever arrives`, async () => {
    const h = harness();
    const queue = Array.from({ length: 9 }, (_, i) => queueFor(customerMail({ address: `c${i}@gmail.com` }))[0]);
    const out = await h.drain(queue);
    expect(out).toMatchObject({ sent: GUIDE_REPLIES_PER_TICK, capped: 9 - GUIDE_REPLIES_PER_TICK });
  });
});

describe("every other refusal gets NO reply — even from a Gmail address", () => {
  const gmail = customerMail();
  const cases = [
    ["fake / failed signature (refused-auth)", decide({ auth: failAuth })],
    ["edited or unreadable document (refused-parse)", decide({ p: { ok: false, reason: "Could not read an amount" } })],
    ["duplicate (held-duplicate)", decide({ holder: "pool-0" })],
    ["not immediate (refused-not-immediate)", decide({ reader: "absa", p: parsed({ immediate: false, paymentType: "Normal" }) })],
    ["wrong account (refused-account)", decide({ p: parsed({ accountMask: "XXXXXXX1111" }) })],
    ["no bank transaction id (held-no-bankref)", decide({ p: parsed({ bankRef: null }) })],
    ["an approved payment", decide()],
  ];
  for (const [name, record] of cases) {
    it(name, async () => {
      expect(record.outcome).not.toBe("unknown-bank");
      const v = guideReplyEligibility({ record, ...gmail });
      expect(v).toEqual({ ok: false, why: "not an unknown-sender refusal" });
    });
  }
});

describe("spam, noise and non-proofs get NO reply", () => {
  const no = (m, why) => {
    const v = guideReplyEligibility({ record: strangerRecord(m), ...m });
    expect(v.ok).toBe(false);
    if (why) expect(v.why).toMatch(why);
  };
  it("no attachment at all", () => no(customerMail({ attachments: [] }), /no PDF or picture/));
  it("only a small inline signature logo", () => no(customerMail({ attachments: [{ filename: "logo.png", contentType: "image/png", size: 4200, related: true, contentDisposition: "inline" }] }), /no PDF or picture/));
  it("a spreadsheet or a zip is not a proof", () => no(customerMail({ attachments: [{ filename: "x.zip", contentType: "application/zip", size: 9000 }] }), /no PDF/));
  it("a newsletter (List-Unsubscribe)", () => no(customerMail({ headerLines: [ar("gmail.com"), { key: "list-unsubscribe", line: "List-Unsubscribe: <mailto:u@x>" }] }), /automated/));
  it("bulk mail (Precedence: bulk)", () => no(customerMail({ headerLines: [ar("gmail.com"), { key: "precedence", line: "Precedence: bulk" }] }), /automated/));
  it("an auto-reply (Auto-Submitted)", () => no(customerMail({ headerLines: [ar("gmail.com"), { key: "auto-submitted", line: "Auto-Submitted: auto-replied" }] }), /automated/));
  it("a bounce (empty Return-Path)", () => no(customerMail({ headerLines: [ar("gmail.com"), { key: "return-path", line: "Return-Path: <>" }] }), /automated/));
  it("a no-reply or role address", () => no(customerMail({ address: "noreply@gmail.com" }), /role/));
  it("a business or unknown-bank domain, not a personal mailbox", () => no(customerMail({ address: "payments@paymebank.example" }), /not a personal mailbox/));
  it("a subdomain posing as a personal provider", () => no(customerMail({ address: "x@gmail.com.evil.example" }), /not a personal mailbox/));
  it("a forged Gmail address — no DKIM / DMARC pass for gmail.com", () => no(customerMail({ headerLines: [{ key: "authentication-results", line: "Authentication-Results: mx.google.com; dkim=fail header.i=@gmail.com; spf=softfail; dmarc=fail header.from=gmail.com" }] }), /did not verify/));
  it("DKIM signed by some other domain does not vouch for gmail.com", () => no(customerMail({ headerLines: [{ key: "authentication-results", line: "Authentication-Results: mx.google.com; dkim=pass header.i=@evil.example; dmarc=fail header.from=gmail.com" }] }), /did not verify/));
  it("an Authentication-Results the sender wrote (not Gmail's, or not topmost)", () => {
    no(customerMail({ headerLines: [{ key: "authentication-results", line: "Authentication-Results: evil.example; dkim=pass header.i=@gmail.com" }] }), /did not verify/);
    no(customerMail({ headerLines: [{ key: "authentication-results", line: "Authentication-Results: mx.google.com; dkim=none" }, ar("gmail.com")] }), /did not verify/);
  });
  it("Junid or the shop forwarding a proof from their own Gmail", () => {
    for (const a of ["marathon6631@gmail.com", "gunidmoh@gmail.com", "junidmoh@gmail.com"]) no(customerMail({ address: a }), /shop's own/);
    const staff = customerMail({ address: "staff.till2@gmail.com" });
    expect(guideReplyEligibility({ record: strangerRecord(staff), ...staff, never: parseNeverList("staff.till2@gmail.com, x@y.com") }).ok).toBe(false);
  });
  it("a payment-shaped stranger record but no clean From address", () => no({ ...customerMail(), fromAddress: "Thandi <thandi@gmail.com>" }, /no clean sender/));
});

describe("the reply reveals nothing", () => {
  const mail = guideReplyMail({ to: "thandi.m@gmail.com", inReplyTo: "<cust-1@mail.gmail.com>" });
  const all = `${mail.subject}\n${mail.text}`;

  it("is Junid's copy, word for word, with the shop's address and WhatsApp", () => {
    expect(mail.subject).toBe("One quick step to confirm your payment — Marathon Club");
    expect(mail.text.startsWith("Hi there,\n\nThanks for sending this through. We received your email, but to confirm your payment automatically it needs to come straight from your bank, not forwarded from your email.")).toBe(true);
    expect(mail.text).toContain('3. Tap "Send proof of payment" (or "Share receipt") and send it to marathon6631@gmail.com from inside the app — don\'t download it and email it yourself.');
    expect(mail.text).toContain('enter marathon6631@gmail.com in the "notify by email" field');
    expect(mail.text).toContain("Any trouble, WhatsApp us on 0631353434 and we'll help right away.");
    expect(mail.text.trimEnd().endsWith("Thanks,\nMarathon Club")).toBe(true);
    expect(GUIDE_REPLY_FROM).toBe("marathon6631@gmail.com");
  });

  it("is the same text for every sender and every message — nothing of theirs is in it", () => {
    const other = guideReplyMail({ to: "sipho_k@yahoo.com", inReplyTo: "<other@yahoo.com>" });
    expect(other.text).toBe(mail.text);
    expect(other.subject).toBe(mail.subject);
  });

  it("never says money arrived, never a status beyond 'could not confirm automatically'", () => {
    expect(all).not.toMatch(/payment (was |has been )?(received|confirmed|approved|successful)/i);
    expect(all).not.toMatch(/received your (payment|money|funds)/i);
    expect(all).not.toMatch(/\b(approved|rejected|declined|refused|pending|cleared)\b/i);
  });

  it("never names a failed check", () => {
    expect(all).not.toMatch(/dkim|signature|duplicate|immediate|real-time|cutoff|account|transaction id|forg|fake|edited|verif|fail/i);
  });

  it("never names a bank, an amount or a reference", () => {
    expect(all).not.toMatch(/\b(fnb|first national|standard bank|absa|capitec|nedbank|tyme|discovery|investec|african bank)\b/i);
    expect(all).not.toMatch(/R\s?\d|\d+\.\d{2}|INV/);
  });

  it("an odd Message-ID is never echoed into the headers", () => {
    expect(guideReplyMail({ to: "a@gmail.com", inReplyTo: "<a b>\r\nBcc: x@y" }).inReplyTo).toBeUndefined();
  });
});

describe("the pieces", () => {
  it("the switch: on by default, off on 'off', OFF on a typo", () => {
    expect(parseGuideReplySwitch(undefined)).toEqual({ on: true, warning: null });
    expect(parseGuideReplySwitch("off").on).toBe(false);
    const typo = parseGuideReplySwitch("ofg");
    expect(typo.on).toBe(false);
    expect(typo.warning).toMatch(/OFF/);
  });
  it("senderVerified accepts a DMARC pass when DKIM is signed by the provider's other domain", () => {
    expect(senderVerified({ headerLines: [{ key: "authentication-results", line: "Authentication-Results: mx.google.com; dkim=pass header.i=@outlook.com; spf=pass smtp.mailfrom=x@hotmail.com; dmarc=pass (p=NONE) header.from=hotmail.com" }], fromDomain: "hotmail.com" })).toBe(true);
  });
  it("hasProofAttachment reads only name, type and size", () => {
    expect(hasProofAttachment([{ filename: "a.pdf", size: 10 }])).toBe(true);
    expect(hasProofAttachment([{ filename: "a.pdf", size: 0 }])).toBe(false);
    expect(automatedMarker([{ key: "auto-submitted", line: "Auto-Submitted: no" }])).toBeNull();
  });
});

describe("the poller hooks it ONLY at a fresh unknown-bank write", () => {
  const src = readFileSync(resolve(HERE, "email-poller.mjs"), "utf8");
  it("queueGuideReply is called exactly once, in noteStrangerPayment, after the create-only write and Junid's verdict email", () => {
    const calls = src.match(/\bqueueGuideReply\(/g) || [];
    expect(calls).toHaveLength(2); // the definition and the one call
    const fn = src.slice(src.indexOf("async function noteStrangerPayment"));
    const written = fn.indexOf("if (!decision?.write) return;");
    const verdict = fn.indexOf("emailVerdict(record, key);");
    const guide = fn.indexOf("queueGuideReply({ record, poolKey: key, parsed });");
    expect(written).toBeGreaterThan(0);
    expect(verdict).toBeGreaterThan(written);
    expect(guide).toBeGreaterThan(verdict);
  });
  it("Junid's verdict emails still go first, and a guide-reply failure cannot stop them", () => {
    expect(src).toMatch(/async function sendVerdicts\(\) \{\n {2}try \{ await sendVerdictEmails\(\); \} finally \{ await sendGuideReplies\(\); \}/);
  });
});

// ─── SENDER IDENTITY: EXACT AUTOMATED SENDERS, NO FORWARDS, NO FOREIGN DOCS ───
// Junid, 10 Nov 2026. SipheleleMkwa@nedbank.co.za — a Nedbank client advisor's
// own mailbox — forwarded a CAPITEC proof of payment (DOC-…-WA0059.pdf) and
// DKIM passed for nedbank.co.za. It was refused only because no reader
// recognised the layout. These tests pin the deliberate refusal:
//
//   1. only the five exact automated senders seen in the mailbox's history
//      are payment-notification sources (DKIM still required);
//   2. a forward / reply is never one, and only the sender's own system-named
//      PDF is opened;
//   3. a document another bank's reader recognises is a bank/sender mismatch;
//   4. genuine notifications from the real addresses still confirm;
//   5. Junid's owner proof upload (content-only reading) is untouched.
//
// Each case runs the poller's chain with its own functions: DKIM verdict →
// senderTrustVerdict → isSendersOwnDocument → noticeReadPlan → parse →
// destination → timing → datedVerdict → eftPoolRecord.
// ACCOUNT NUMBERS AND NAMES HERE ARE STAND-INS (this repo is public).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { EFT_READERS, selectReaderByContent } from "./eftBanks.mjs";
import {
  authenticationVerdict, senderTrustVerdict, trustedSenderOf, isSendersOwnDocument, forwardSignOf,
  noticeReadPlan, foreignBankOf, TRUSTED_NOTIFICATION_SENDERS, CARD_REPORT_SENDERS, EFT_ALLOWED_DOMAINS,
  destinationVerdict, enforcesImmediateOnly, immediacyVerdict, datedVerdict, parsePaymentDateCutoff,
  parseAccountPolicies, eftPoolRecord, groupEftPayments,
} from "./eftCore.mjs";
import { failedCheck, decidingReason, STRANGER_OUTCOMES } from "./verdictMailCore.mjs";

const POLICIES = parseAccountPolicies("62900004321, 63000005678, 10100008534:standardbank:immediate");
const CUTOFF = parsePaymentDateCutoff(undefined);
const sast = (s) => Date.parse(`${s}+02:00`);

const dkimPass = (domain, from, extra = []) => [
  { key: "authentication-results", line: `Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@${domain} header.s=s1 header.b=x;\r\n       spf=pass smtp.mailfrom=${domain};\r\n       dmarc=pass (p=REJECT) header.from=${domain}` },
  { key: "from", line: `From: <${from}>` },
  ...extra,
];

// ── Real-shaped documents (stand-in numbers) ──
const CAPITEC_DOC = (date = "10/11/2026 09:15") => [
  "Payment Notification", "SkyQR reference: 0000-0000-0000", "Capitec Bank", "10/11/2026", "Branch: 250655", "Device: 9003",
  "Dear Sir/Madam", "Please take note that A CUSTOMER made a payment to your account. The payment details are as follows:",
  "Notification number 500001", `Payment date ${date}`, "Payment details", "Beneficiary name Marathon",
  "Bank name First National Bank", "Account number 62900004321", "Branch 250655", "Payment type Immediate Payment",
  "Amount R750.00", "Payment reference T NKOSI", "IMPORTANT NOTES:",
  "Capitec Bank is an authorised financial services (FSP46669) and registered credit provider (NCRCP13). Capitec Bank Limited Reg. No.: 1980/003695/06. Page 1 of 1",
];
const NEDBANK_DOC = [
  "Notification of Payment", "Nedbank Limited confirms that the following payment has been made:",
  "Date of Payment : 10/11/2026", "Reference Number : 1a2b3c4d-1111-2222-a333-0b0c0d0e0f1", "Beneficiary details",
  "Recipient : Marathon", "Amount : R350.00", "Recipient Reference : Custref", ":", "Bank FIRST NATIONAL BANK", ":",
  "Account Number ...004321", ":", "Channel Immediate payment", "Payer details", "Paid from Account Holder : A CUSTOMER",
  "This notification of payment is sent to you by Nedbank Limited Reg No 1951/000009/06. Enquiries regarding this",
  "Nedbank Limited email disclaimer", "Security Code D6CA786CD7DC693B3B6EBABD0C40E8845E9CD186", ":",
];
const ABSA_DOC = [
  "10 November 2026", "Notice of Payment", "Dear Marathon club", "Subject: Notice Of Payment: Marathon club",
  "Please be advised that MR J SOAP made a payment to your account as indicated below.", "Transaction number: 80D2F2AB5A-1",
  "Payment date:", "2026-11-10", "Payment made by: MR J SOAP", "Payment made to:", "Marathon club",
  "Beneficiary bank name: FIRST NATIONAL BANK", "Beneficiary account number: 62900004321", "Bank branch code: 250655",
  "For the amount of: 80.00", "Immediate payment:", "Y", "Reference on beneficiary statement: test",
  "Absa Bank Limited Reg No 1986/000000/06 Authorised Financial Services and Registered Credit Provider Reg No NCRCP7 Company Information: www.absa.co.za",
];
const FNB_DOC = [
  "NOTIFICATION OF PAYMENT", "Dear: Payment Notification",
  "First National Bank hereby confirms that the following payment instruction has been received:",
  "Date Actioned : 2026/11/10", "10:11:39", "Time Actioned :", "Trace ID : 5TG59DVQ", "Payer Details",
  "Payment From A CUSTOMER", "ZAR30.00", "Cur/Amount", "Payee Details", "Recipient/Account no : ..0004321",
  "Marathon club", "Name :", "Bank : FIRST NATIONAL BANK", "Branch Code : 250655", "MR M", "Reference :",
  "END OF NOTIFICATION",
  "To authenticate this Payment Notification, please visit the First National Bank website at fnb.co.za, select the “Verify Payments” link and follow the on-screen",
  "instructions.",
];
const ATTACHED_BODY = "A payment has been made to your account.\nTo view the details of the payment, please open the attached PDF file.";
const SIPHELELE_BODY = "Good day.\nPlease find the attached proof of payment for Mr S. Mtetwa.\nWarm regards.\nSiphelele Mkwanazi\nClient Advisor | Nedbank";

/**
 * The poller's EFT decision for one message (handleEftMessage, minus IO).
 * attachments: [{ filename, lines }]
 */
function poller({ from, subject, extraHeaders = [], body = ATTACHED_BODY, attachments = [], receivedAt = sast("2026-11-10T10:00:00") }) {
  const domain = from.split("@")[1];
  const verdict = senderTrustVerdict({
    verdict: authenticationVerdict({ headerLines: dkimPass(domain, from, extraHeaders), fromAddress: from }),
    fromAddress: from, subject, headerLines: dkimPass(domain, from, extraHeaders), bodyText: body,
  });
  const message = { messageId: "<m@x>", from, subject, receivedAt };
  if (!verdict.pass) {
    // The auth-fail path: attachments are NEVER opened; the body alone is recorded.
    return { opened: [], records: [eftPoolRecord({ message, verdict, parsed: null, account: null, reader: null, rawText: body, at: receivedAt })] };
  }
  const opened = attachments.filter((a) => isSendersOwnDocument(verdict.sender, a.filename));
  const documents = attachments.map((a) => (opened.includes(a) ? { lines: a.lines, text: a.lines.join("\n") } : { lines: null, text: `[attachment "${a.filename}" not read]` }));
  const offered = [...documents.filter((d) => d.lines), { lines: body.split("\n"), text: body }];
  const { claimed, mismatched } = noticeReadPlan({ sender: verdict.sender, offered, readers: EFT_READERS });
  const parsedDocs = claimed.map((x) => ({ ...x, p: x.r.parse(x.d.lines) }));
  for (const { d, foreign } of mismatched) parsedDocs.push({ d, r: null, p: { ok: false, bankMismatch: true, reason: `Bank/sender mismatch: this is a ${foreign} document, but it came from ${verdict.sender.address}.` } });
  if (!parsedDocs.length) return { opened: opened.map((a) => a.filename), records: [eftPoolRecord({ message, verdict, parsed: { ok: false, reason: "no reader" }, account: null, reader: null, rawText: body, at: receivedAt })] };
  const records = groupEftPayments(parsedDocs).map((group) => {
    const account = group.parse.ok ? destinationVerdict({ accountMask: group.parse.accountMask, destBankName: group.parse.destBankName, allowedAccounts: POLICIES, configured: true }) : null;
    const timing = group.parse.ok ? immediacyVerdict({ parsed: group.parse, reader: group.readerId, receivedAt, immediateOnly: account?.ok === true && enforcesImmediateOnly(account) }) : null;
    const dated = group.parse.ok ? datedVerdict({ parsed: group.parse, cutoff: CUTOFF, account, floors: [] }) : null;
    return eftPoolRecord({ message, verdict, parsed: group.parse, account, timing, dated, reader: group.readerId, rawText: group.rawText, at: receivedAt });
  });
  return { opened: opened.map((a) => a.filename), records };
}

describe("THE 10 NOV CASE — a Capitec PDF forwarded from a Nedbank PERSONAL mailbox", () => {
  const siphelele = () => poller({
    from: "siphelelemkwa@nedbank.co.za", subject: "FW:",
    extraHeaders: [{ key: "in-reply-to", line: "In-Reply-To: <abc@nedbank.co.za>" }, { key: "references", line: "References: <abc@nedbank.co.za>" }],
    body: SIPHELELE_BODY,
    attachments: [{ filename: "DOC-20261110-WA0059.pdf", lines: CAPITEC_DOC() }],
  });

  it("DKIM passes for nedbank.co.za — and it is still REFUSED as an untrusted sender, never confirmed", () => {
    expect(authenticationVerdict({ headerLines: dkimPass("nedbank.co.za", "siphelelemkwa@nedbank.co.za"), fromAddress: "siphelelemkwa@nedbank.co.za" }).pass).toBe(true);
    const { opened, records } = siphelele();
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("refused-untrusted-sender");
    expect(records[0].status).toBeUndefined();
    expect(records[0].reason).toMatch(/^Untrusted sender: DKIM passed for nedbank\.co\.za, but siphelelemkwa@nedbank\.co\.za is not that bank's automated payment-notification address/);
    expect(opened).toEqual([]); // the PDF was never opened
  });

  it("is logged for Junid's review: its own check name in the verdict email, and in the stranger roll-up set", () => {
    const r = siphelele().records[0];
    expect(failedCheck(r)).toBe("Untrusted sender");
    expect(decidingReason(r).match(/Untrusted sender/g)).toHaveLength(1);
    expect(STRANGER_OUTCOMES).toContain("refused-untrusted-sender");
  });

  it("refused even if the personal address forged nothing else: no FW:, no reply headers, a perfect Capitec layout", () => {
    const { records, opened } = poller({ from: "siphelelemkwa@nedbank.co.za", subject: "Payment Notification", attachments: [{ filename: "Proof_Of_Payment.pdf", lines: NEDBANK_DOC }] });
    expect(records[0].outcome).toBe("refused-untrusted-sender");
    expect(opened).toEqual([]);
  });
});

describe("a crafted STRUCTURED BODY from a personal bank-domain mailbox", () => {
  it("a full Nedbank layout typed into the body by a person at nedbank.co.za → REFUSED, untrusted sender", () => {
    const { records } = poller({ from: "j.smith@nedbank.co.za", subject: "Payment Notification", body: NEDBANK_DOC.join("\n") });
    expect(records[0].outcome).toBe("refused-untrusted-sender");
  });
  it("the same at every bank domain: any address that is not the bank's automated sender is untrusted", () => {
    const crafted = [
      ["someone@fnb.co.za", FNB_DOC], ["advisor@absa.co.za", ABSA_DOC], ["teller@capitecbank.co.za", CAPITEC_DOC()],
      ["no-reply@capitecbank.co.za", CAPITEC_DOC()], ["paymentsemail@mail.fnb.co.za", FNB_DOC],
    ];
    for (const [from, doc] of crafted) {
      const { records } = poller({ from, subject: "Payment Notification", body: doc.join("\n") });
      expect(records[0].outcome, from).toBe("refused-untrusted-sender");
    }
  });
});

describe("GENUINE automated notifications from the real addresses still confirm", () => {
  it("Nedbank — notification@nedbank.co.za (any case) with Proof_Of_Payment.pdf → recorded", () => {
    const { records, opened } = poller({ from: "Notification@nedbank.co.za", subject: "Payment Notification", attachments: [{ filename: "Proof_Of_Payment.pdf", lines: NEDBANK_DOC }] });
    expect(opened).toEqual(["Proof_Of_Payment.pdf"]);
    expect(records.map((r) => r.outcome)).toEqual(["recorded"]);
    expect(records[0].status).toBe("unmatched");
  });
  it("Absa — ibreply@absa.co.za with Absa.pdf → recorded", () => {
    const { records } = poller({ from: "ibreply@absa.co.za", subject: "Notice of payment: Marathon club", attachments: [{ filename: "Absa.pdf", lines: ABSA_DOC }] });
    expect(records.map((r) => r.outcome)).toEqual(["recorded"]);
  });
  it("FNB — paymentsemail@fnb.co.za with 'Payment Notification.pdf' → recorded", () => {
    const { records } = poller({ from: "paymentsemail@fnb.co.za", subject: "Payment Notification from A CUSTOMER", attachments: [{ filename: "Payment Notification.pdf", lines: FNB_DOC }] });
    expect(records.map((r) => r.outcome)).toEqual(["recorded"]);
  });
  it("Capitec — noreply@capitecbank.co.za with ImmediatePaymentNotification.pdf → recorded", () => {
    const { records } = poller({ from: "noreply@capitecbank.co.za", subject: "Immediate Payment Notification", attachments: [{ filename: "ImmediatePaymentNotification.pdf", lines: CAPITEC_DOC() }] });
    expect(records.map((r) => r.outcome)).toEqual(["recorded"]);
  });
  it("the trusted list is exactly the five senders the history proved, each with its own reader", () => {
    expect(TRUSTED_NOTIFICATION_SENDERS.map((t) => `${t.address}:${t.reader}`)).toEqual([
      "paymentsemail@fnb.co.za:fnb", "noreply@capitecbank.co.za:capitec", "notification@nedbank.co.za:nedbank",
      "noreply@standardbank.co.za:standardbank", "ibreply@absa.co.za:absa",
    ]);
    for (const t of TRUSTED_NOTIFICATION_SENDERS) expect(EFT_READERS.some((r) => r.id === t.reader), t.address).toBe(true);
    expect(EFT_ALLOWED_DOMAINS).toContain("tymebank.co.za"); // authenticated, but no proven sender yet
    expect(trustedSenderOf("noreply@tymebank.co.za")).toBe(null);
    expect(CARD_REPORT_SENDERS).toEqual(["noreplytransreport@fnb.co.za"]);
  });
});

describe("never an attachment or a forward as a confirmation source", () => {
  it("a trusted sender's message that is a FORWARD (subject, reply headers, quoted body) → REFUSED", () => {
    const att = [{ filename: "Proof_Of_Payment.pdf", lines: NEDBANK_DOC }];
    for (const variant of [
      { subject: "FW: Payment Notification" },
      { subject: "Fwd: Payment Notification" },
      { subject: "RE: Payment Notification" },
      { subject: "Payment Notification", extraHeaders: [{ key: "in-reply-to", line: "In-Reply-To: <x@y>" }] },
      { subject: "Payment Notification", extraHeaders: [{ key: "references", line: "References: <x@y>" }] },
      { subject: "Payment Notification", extraHeaders: [{ key: "resent-from", line: "Resent-From: a@b" }] },
      { subject: "Payment Notification", body: "---------- Forwarded message ---------\nFrom: someone" },
      { subject: "Payment Notification", body: "Hi\n\nFrom: Bank <x@y>\nSent: Monday\nSubject: pop" },
    ]) {
      const { records, opened } = poller({ from: "notification@nedbank.co.za", attachments: att, ...variant });
      expect(records[0].outcome, JSON.stringify(variant)).toBe("refused-untrusted-sender");
      expect(opened, JSON.stringify(variant)).toEqual([]);
    }
  });

  it("from a trusted sender, an attachment that is not its own system document is NEVER opened", () => {
    const { records, opened } = poller({ from: "notification@nedbank.co.za", subject: "Payment Notification", attachments: [{ filename: "DOC-20261110-WA0059.pdf", lines: NEDBANK_DOC }] });
    expect(opened).toEqual([]);
    expect(records.every((r) => r.outcome !== "recorded")).toBe(true);
  });

  it("only the exact system filenames count", () => {
    const ned = trustedSenderOf("notification@nedbank.co.za");
    expect(isSendersOwnDocument(ned, "Proof_Of_Payment.pdf")).toBe(true);
    for (const f of ["proof_of_payment.PDF", "Proof_Of_Payment.pdf"]) expect(isSendersOwnDocument(ned, f), f).toBe(true);
    for (const f of ["Proof_Of_Payment.pdf.exe", "My Proof_Of_Payment.pdf", "ImmediatePaymentNotification.pdf", "", null]) expect(isSendersOwnDocument(ned, f), String(f)).toBe(false);
    expect(isSendersOwnDocument(null, "Proof_Of_Payment.pdf")).toBe(false);
  });

  it("a genuine notification has no forward sign", () => {
    expect(forwardSignOf({ subject: "Payment Notification", headerLines: dkimPass("nedbank.co.za", "notification@nedbank.co.za"), bodyText: ATTACHED_BODY })).toBe(null);
    expect(forwardSignOf({ subject: "Payment Notification from MR A FWRD", headerLines: [], bodyText: "" })).toBe(null);
  });
});

describe("bank/sender match", () => {
  it("a CAPITEC document from Nedbank's REAL notification address (system filename) → refused-bank-mismatch", () => {
    const { records } = poller({ from: "notification@nedbank.co.za", subject: "Payment Notification", attachments: [{ filename: "Proof_Of_Payment.pdf", lines: CAPITEC_DOC() }] });
    expect(records.map((r) => r.outcome)).toEqual(["refused-bank-mismatch"]);
    expect(records[0].reason).toMatch(/capitec document, but it came from notification@nedbank\.co\.za/);
    expect(failedCheck(records[0])).toBe("Bank/sender mismatch");
  });
  it("an FNB layout in a Capitec sender's body is a mismatch too", () => {
    const { records } = poller({ from: "noreply@capitecbank.co.za", subject: "Payment Notification", body: FNB_DOC.join("\n") });
    expect(records.map((r) => r.outcome)).toEqual(["refused-bank-mismatch"]);
  });
  it("each bank's own document is never a mismatch from its own sender", () => {
    for (const [addr, doc] of [["notification@nedbank.co.za", NEDBANK_DOC], ["ibreply@absa.co.za", ABSA_DOC], ["paymentsemail@fnb.co.za", FNB_DOC], ["noreply@capitecbank.co.za", CAPITEC_DOC()]]) {
      expect(foreignBankOf({ sender: trustedSenderOf(addr), lines: doc, readers: EFT_READERS }), addr).toBe(null);
      expect(noticeReadPlan({ sender: trustedSenderOf(addr), offered: [{ lines: doc }], readers: EFT_READERS }).claimed, addr).toHaveLength(1);
    }
  });
});

describe("Junid's in-app owner proof upload is unchanged", () => {
  it("it reads a document by CONTENT alone (no sender, no DKIM) — a Capitec proof is still recognised for him", () => {
    expect(selectReaderByContent(CAPITEC_DOC())?.id).toBe("capitec");
    expect(selectReaderByContent(NEDBANK_DOC)?.id).toBe("nedbank");
  });
  it("the owner path does not go through the sender gate", () => {
    const approve = readFileSync(new URL("../../functions/lib/eft-manual-approved.cjs", import.meta.url), "utf8");
    const pool = readFileSync(new URL("../../functions/eftPool/eftPool.js", import.meta.url), "utf8");
    for (const src of [approve, pool]) expect(src).not.toMatch(/senderTrustVerdict|TRUSTED_NOTIFICATION_SENDERS|noticeReadPlan/);
  });
});

describe("the poller wires it in", () => {
  const src = readFileSync(new URL("./email-poller.mjs", import.meta.url), "utf8");
  it("DKIM, then the sender gate, before anything is read; only the sender's own document is opened", () => {
    const handler = src.slice(src.indexOf("async function handleEftMessage"));
    const gate = handler.indexOf("senderTrustVerdict({");
    expect(gate).toBeGreaterThan(-1);
    expect(handler.indexOf("pdfToLines(")).toBeGreaterThan(gate);
    expect(handler).toMatch(/if \(!isSendersOwnDocument\(verdict\.sender, att\.filename\)\)/);
    expect(handler).toMatch(/noticeReadPlan\(\{ sender: verdict\.sender, offered, readers: EFT_READERS \}\)/);
    expect(src).not.toMatch(/selectReader\(\{ fromDomain/);
  });
});

// ─── FNB PAYSHAP: ONE-LINE AMOUNT, REAL-TIME INTO ANY BANK ───────────────────
// Junid, 7 Nov 2026. A customer paid R650 by PayShap from FNB into Concrete's
// immediate-only Standard Bank account. Junid received the money, but the
// poller refused the notice three times as "FNB notification carries no amount
// line (a lone ZAR figure)": the PayShap PDF prints "Cur/Amount R650.00" on ONE
// line, where the ordinary FNB notice (31 Aug sample) puts the figure on its
// own line. Read past that, it would still have refused: an FNB notice was
// immediate only FNB-to-FNB. PayShap is the real-time interbank rail, and FNB
// says so in its own sentence below END OF NOTIFICATION.
//
// The fixture is the real notice's layout with the payer, reference, trace id
// and every number replaced (this repo is public). Each case runs the
// poller's own chain (email-poller.mjs).
import { describe, it, expect } from "vitest";
import { selectReader } from "./eftBanks.mjs";
import {
  authenticationVerdict, destinationVerdict, immediacyVerdict, paymentDateVerdict, parsePaymentDateCutoff,
  parseAccountPolicies, eftPoolRecord,
} from "./eftCore.mjs";

const FNB = "62900004321";
const SB = "10100008534";
const POLICIES = parseAccountPolicies(`${FNB}, 62000009092, ${SB}:standardbank:immediate`);
// 7 Nov 2026 09:47:12 SAST; the bank dates the payment 09:47:08.
const RECEIVED = Date.parse("2026-11-07T07:47:12Z");

const PAYSHAP_SENTENCE = "Please note that this PayShap Payment Notification cannot be authenticated using our FNB “Verify Payments” link, however, as PayShap payments are made in";
const PAYSHAP = ({ amountLine = "Cur/Amount R650.00", bank = "Standard Bank", account = "..8534", reference = "Custref", tail = [PAYSHAP_SENTENCE], extra = [] } = {}) => [
  "NOTIFICATION OF PAYMENT",
  "To whom it may concern:",
  "First National Bank hereby confirms that the following payment instruction has been received:",
  "Date Actioned : 2026/11/07",
  "Time Actioned : 09:47:08",
  "Trace ID : TESTTRACE001",
  "Payer Details",
  "Payment From MR A CUSTOMER",
  amountLine,
  "Payee Details",
  `Recipient/Account no : ${account}`,
  "Name : Concrete",
  `Bank : ${bank}`,
  "Branch Code : SBZAZAJJ",
  `Reference : ${reference}`,
  ...extra,
  "END OF NOTIFICATION",
  ...tail,
  "real time, to verify this payment please check that this payment reflects in the bank account as per the Payee Details above.",
  "Our customer (the payer) has requested First National Bank Limited to send this notification of payment to you.",
];

const authFor = (domain, from, dkim = "pass") => authenticationVerdict({
  fromAddress: from,
  headerLines: [
    { key: "authentication-results", line: `Authentication-Results: mx.google.com;\r\n       dkim=${dkim} header.i=@${domain} header.s=s1 header.b=x;\r\n       spf=pass smtp.mailfrom=${domain};\r\n       dmarc=${dkim} (p=REJECT) header.from=${domain}` },
    { key: "from", line: `From: <${from}>` },
  ],
});

function decide(lines, { dkim = "pass" } = {}) {
  const reader = selectReader({ fromDomain: "fnb.co.za", lines });
  const parsed = reader.parse(lines);
  if (!parsed.ok) return { parsed, reader, record: null };
  const account = destinationVerdict({ accountMask: parsed.accountMask, destBankName: parsed.destBankName, allowedAccounts: POLICIES, configured: true });
  const timing = immediacyVerdict({ parsed, reader: reader.id, receivedAt: RECEIVED, immediateOnly: account?.ok === true && account.immediateOnly === true });
  return {
    parsed, reader, account, timing,
    record: eftPoolRecord({
      message: { messageId: "<m@fnb.co.za>", from: "Paymentsemail@fnb.co.za", subject: "Payment Notification from MR A CUSTOMER_TESTTRACE001", receivedAt: RECEIVED },
      verdict: authFor("fnb.co.za", "Paymentsemail@fnb.co.za", dkim), parsed, account, timing,
      dated: paymentDateVerdict({ parsed, cutoff: parsePaymentDateCutoff(undefined) }),
      reader: reader.id, rawText: lines.join("\n"), at: RECEIVED,
    }),
  };
}

describe("FNB PayShap notice — the amount on the Cur/Amount line", () => {
  it("the FNB reader claims it and reads every field, the one-line amount included", () => {
    const { reader, parsed } = decide(PAYSHAP());
    expect(reader.id).toBe("fnb");
    expect(parsed).toMatchObject({
      ok: true, amountCents: 65000, reference: "Custref", payer: "MR A CUSTOMER", bankRef: "TESTTRACE001",
      destBankName: "Standard Bank", accountMask: "..8534", paymentType: "PayShap", immediate: true,
    });
    expect(parsed.bankTs).toBe(Date.parse("2026-11-07T07:47:08Z"));
  });

  it("ZAR and a colon after the label read too", () => {
    expect(decide(PAYSHAP({ amountLine: "Cur/Amount : ZAR650.00" })).parsed.amountCents).toBe(65000);
  });

  it("a Cur/Amount line whose value is not money-only refuses", () => {
    const { parsed } = decide(PAYSHAP({ amountLine: "Cur/Amount R650.00 USD" }));
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/does not parse exactly/);
  });

  it("a second, DIFFERENT figure anywhere still refuses; the same figure twice does not", () => {
    expect(decide(PAYSHAP({ extra: ["ZAR99.00"] })).parsed.ok).toBe(false);
    expect(decide(PAYSHAP({ extra: ["ZAR650.00"] })).parsed.amountCents).toBe(65000);
  });

  it("a bare Cur/Amount label with no figure still refuses as before", () => {
    expect(decide(PAYSHAP({ amountLine: "Cur/Amount" })).parsed.reason).toMatch(/no amount line/);
  });
});

describe("FNB PayShap notice — immediate into the immediate-only Standard Bank account", () => {
  it("CONFIRMS: recorded, spendable, into Concrete's Standard Bank account", () => {
    const { account, record } = decide(PAYSHAP());
    expect(account).toMatchObject({ ok: true, bank: "standardbank", immediateOnly: true });
    expect(record).toMatchObject({ outcome: "recorded", status: "unmatched", amountCents: 65000, reader: "fnb", bankRef: "TESTTRACE001" });
  });

  it("an ORDINARY FNB notice (no PayShap sentence) into Standard Bank is still refused — not FNB-to-FNB", () => {
    const normal = PAYSHAP({ tail: ["To authenticate this Payment Notification, please visit the First National Bank website at fnb.co.za, select the “Verify Payments” link"] });
    const { parsed, record } = decide(normal);
    expect(parsed.immediate).toBeUndefined();
    expect(record.outcome).toBe("refused-not-immediate");
  });

  it("the PayShap sentence ABOVE END OF NOTIFICATION (where the payer types) is not FNB's — refused", () => {
    const posing = PAYSHAP({ tail: [], extra: [PAYSHAP_SENTENCE] });
    expect(decide(posing).parsed.immediate).toBeUndefined();
    expect(decide(posing).record.outcome).toBe("refused-not-immediate");
  });

  it("no END OF NOTIFICATION line: PayShap is never assumed", () => {
    const lines = PAYSHAP().filter((l) => l !== "END OF NOTIFICATION");
    expect(decide(lines).parsed.immediate).toBeUndefined();
  });

  it("the destination is still checked digit for digit: another Standard Bank account refuses", () => {
    expect(decide(PAYSHAP({ account: "..9999" })).record.outcome).toBe("refused-account");
  });

  it("a forged notice (DKIM fails) is refused", () => {
    expect(decide(PAYSHAP(), { dkim: "fail" }).record.outcome).toBe("refused-auth");
  });

  it("the PayShap pass needs the reader's immediate flag: paymentType alone is nothing", () => {
    const parsed = { bankTs: Date.parse("2026-11-07T07:47:08Z"), destBankName: "Standard Bank", immediate: false, paymentType: "PayShap" };
    expect(immediacyVerdict({ parsed, reader: "fnb", receivedAt: RECEIVED, immediateOnly: true }).ok).toBe(false);
  });

  it("the PayShap pass is FNB's only: another reader carrying paymentType PayShap gets no pass from it (Fable review)", () => {
    // A same-day payment (so only the immediacy rule decides) whose reader is
    // not FNB and prints no immediate signal of its own.
    const parsed = { bankTs: Date.parse("2026-11-07T07:47:08Z"), destBankName: "Standard Bank", immediate: null, paymentType: "PayShap" };
    expect(immediacyVerdict({ parsed, reader: "capitec", receivedAt: RECEIVED, immediateOnly: true }).ok).toBe(false);
  });
});

// ─── SONNET ARCHITECT REVIEW: THE SIGNAL'S TRUST BOUNDARY ────────────────────
describe("FNB PayShap signal — hardened", () => {
  it("two END OF NOTIFICATION lines (one payer-typed) — no PayShap", () => {
    const lines = PAYSHAP({ extra: ["END OF NOTIFICATION", PAYSHAP_SENTENCE, "real time, to verify"] });
    expect(decide(lines).parsed.immediate).toBeUndefined();
  });

  it("the sentence cut short, or without its second line — no PayShap", () => {
    expect(decide(PAYSHAP({ tail: ["Please note that this PayShap Payment Notification"] })).parsed.immediate).toBeUndefined();
    const noSecond = PAYSHAP().filter((l) => !l.startsWith("real time,"));
    expect(decide(noSecond).parsed.immediate).toBeUndefined();
  });

  it("the ordinary notice's 'To authenticate this Payment Notification' anywhere — no PayShap", () => {
    const both = [...PAYSHAP(), "To authenticate this Payment Notification, please visit the First National Bank website"];
    expect(decide(both).parsed.immediate).toBeUndefined();
  });

  it("R650.00 and ZAR650.00 on the same notice agree — one amount", () => {
    expect(decide(PAYSHAP({ extra: ["ZAR650.00"] })).parsed.amountCents).toBe(65000);
  });

  it("a PayShap notice dated in the future of its arrival is still judged by the date rule", () => {
    const lines = PAYSHAP().map((l) => (l === "Date Actioned : 2026/11/07" ? "Date Actioned : 2026/11/20" : l));
    expect(decide(lines).record.outcome).toBe("refused-not-immediate");
  });
});

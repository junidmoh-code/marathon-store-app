// ─── EFT PAYMENT POOL — the decisions, tested as data ────────────────────────
// THE AUTHENTICATION FIXTURE IS REAL. The header block below is copied verbatim
// (folding and all) from a genuine FNB message delivered to marathon6631@gmail.com
// on 2026-08-30 and pulled from the mailbox over IMAP — because the exact shape
// of the Authentication-Results header Gmail stamps is the entire point of the
// check, and a hand-written approximation of it would test the approximation.
// The forgeries are then derived from the real thing by changing exactly the
// part an attacker controls.
import { describe, it, expect } from "vitest";
import {
  domainOfAddress, domainsAligned, domainAllowlisted, authenticationVerdict,
  isEftCandidate, htmlToText, parseBankTimestamp, redactAccountDigits,
  parseAllowedAccountTails, accountVerdict, EFT_ACCOUNTS_ENV_VAR,
  maskAccountValue, looksPaymentShaped,
  eftMessageKey, poolWriteDecision, eftPoolRecord,
} from "./eftCore.mjs";

// Verbatim from the real message (uid 6, "Banking Report for Batch 16 of
// Terminal 67377843") — Gmail's own stamp, authserv-id mx.google.com.
const REAL_AUTH_RESULTS =
  "Authentication-Results: mx.google.com;\r\n" +
  "       dkim=pass header.i=@fnb.co.za header.s=frg header.b=KVqF692g;\r\n" +
  "       spf=pass (google.com: domain of prvs=695f7c991=noreplytransreport@fnb.co.za designates 216.71.157.235 as permitted sender) smtp.mailfrom=\"prvs=695f7c991=NoReplyTransReport@fnb.co.za\";\r\n" +
  "       dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=fnb.co.za";
// The real From — note the MIXED-CASE domain, exactly as FNB sends it.
const REAL_FROM = "NoReplyTransReport@FNB.co.za";

// mailparser's headerLines shape: {key, line}, original order, topmost first.
const realHeaderLines = [
  { key: "delivered-to", line: "Delivered-To: marathon6631@gmail.com" },
  { key: "received", line: "Received: by 2002:a2e:bb82:0:b0:3a3:29e2:7220 with SMTP id y2csp222292lje" },
  { key: "arc-authentication-results", line: "ARC-Authentication-Results: i=1; mx.google.com;\r\n       dkim=pass header.i=@fnb.co.za header.s=frg header.b=KVqF692g" },
  { key: "return-path", line: "Return-Path: <prvs=695f7c991=NoReplyTransReport@fnb.co.za>" },
  { key: "authentication-results", line: REAL_AUTH_RESULTS },
  { key: "from", line: `From: <${REAL_FROM}>` },
];

describe("domains", () => {
  it("reads the domain out of an address, case-folded", () => {
    expect(domainOfAddress("NoReplyTransReport@FNB.co.za")).toBe("fnb.co.za");
    expect(domainOfAddress("  <x@y.example.>  ")).toBe(null); // not a bare address
    expect(domainOfAddress("x@sub.fnb.co.za")).toBe("sub.fnb.co.za");
    expect(domainOfAddress("no-at-sign")).toBe(null);
    expect(domainOfAddress(null)).toBe(null);
  });
  it("relaxed alignment: equal or subdomain, either way round", () => {
    expect(domainsAligned("fnb.co.za", "fnb.co.za")).toBe(true);
    expect(domainsAligned("frg.fnb.co.za", "fnb.co.za")).toBe(true);
    expect(domainsAligned("fnb.co.za", "frg.fnb.co.za")).toBe(true);
    expect(domainsAligned("notfnb.co.za", "fnb.co.za")).toBe(false);
    // suffix without a dot boundary must NOT align
    expect(domainsAligned("evilfnb.co.za", "fnb.co.za")).toBe(false);
    expect(domainsAligned(null, "fnb.co.za")).toBe(false);
  });
  it("the allowlist accepts subdomains of a listed domain and NEVER its parents", () => {
    expect(domainAllowlisted("fnb.co.za")).toBe(true);
    expect(domainAllowlisted("secure.fnb.co.za")).toBe(true);
    // The parent direction is the hole a bidirectional test would open: every
    // .co.za sender would qualify, then align its own DKIM with itself.
    expect(domainAllowlisted("co.za")).toBe(false);
    expect(domainAllowlisted("za")).toBe(false);
    expect(domainAllowlisted("evilfnb.co.za")).toBe(false);
    expect(domainAllowlisted("fnb.co.za.evil.example")).toBe(false);
    expect(domainAllowlisted(null)).toBe(false);
  });
});

describe("the authentication verdict", () => {
  it("PASSES the real message: Gmail's stamp, dkim=pass, @fnb.co.za aligned", () => {
    const v = authenticationVerdict({ headerLines: realHeaderLines, fromAddress: REAL_FROM });
    expect(v.pass).toBe(true);
    expect(v.fromDomain).toBe("fnb.co.za");
    expect(v.dkimDomain).toBe("fnb.co.za");
  });

  it("REFUSES a From that claims fnb.co.za when Gmail recorded dkim=fail — the forgery case", () => {
    const forged = realHeaderLines.map((h) => h.key !== "authentication-results" ? h : {
      ...h, line: h.line.replace("dkim=pass header.i=@fnb.co.za", "dkim=fail header.i=@fnb.co.za"),
    });
    const v = authenticationVerdict({ headerLines: forged, fromAddress: REAL_FROM });
    expect(v.pass).toBe(false);
    expect(v.detail).toMatch(/no aligned DKIM pass/);
  });

  it("REFUSES dkim=pass signed by an UNALIGNED domain — a real signature is not enough, it must vouch for the From", () => {
    const forged = realHeaderLines.map((h) => h.key !== "authentication-results" ? h : {
      ...h, line: h.line.replace("header.i=@fnb.co.za", "header.i=@attacker.example"),
    });
    const v = authenticationVerdict({ headerLines: forged, fromAddress: REAL_FROM });
    expect(v.pass).toBe(false);
  });

  it("REFUSES when the topmost Authentication-Results is not Gmail's own", () => {
    const forged = realHeaderLines.map((h) => h.key !== "authentication-results" ? h : {
      ...h, line: h.line.replace("mx.google.com;", "mail.attacker.example;"),
    });
    const v = authenticationVerdict({ headerLines: forged, fromAddress: REAL_FROM });
    expect(v.pass).toBe(false);
    expect(v.detail).toMatch(/not Gmail's/);
  });

  it("a forged Authentication-Results the SENDER wrote sits below Gmail's and never wins", () => {
    // Gmail prepends on delivery, so the genuine header is topmost. Here the
    // genuine one says dkim=fail; the attacker's own 'dkim=pass' copy is below.
    const genuine = { key: "authentication-results", line: REAL_AUTH_RESULTS.replace("dkim=pass", "dkim=fail") };
    const planted = { key: "authentication-results", line: REAL_AUTH_RESULTS };
    const v = authenticationVerdict({
      headerLines: [realHeaderLines[0], genuine, ...realHeaderLines.slice(1, 4), planted],
      fromAddress: REAL_FROM,
    });
    expect(v.pass).toBe(false);
  });

  it("REFUSES a message with no Authentication-Results at all", () => {
    const v = authenticationVerdict({
      headerLines: realHeaderLines.filter((h) => h.key !== "authentication-results"),
      fromAddress: REAL_FROM,
    });
    expect(v.pass).toBe(false);
    expect(v.detail).toMatch(/no Authentication-Results/);
  });

  it("REFUSES a domain that is not allowlisted, before believing any header", () => {
    const v = authenticationVerdict({ headerLines: realHeaderLines, fromAddress: "x@shopify.com" });
    expect(v.pass).toBe(false);
    expect(v.detail).toMatch(/not an allowlisted/);
  });

  it("REFUSES a message with no usable From address", () => {
    expect(authenticationVerdict({ headerLines: realHeaderLines, fromAddress: "" }).pass).toBe(false);
    expect(authenticationVerdict({ headerLines: realHeaderLines, fromAddress: undefined }).pass).toBe(false);
  });

  it("a ';' smuggled through a QUOTED mailfrom cannot manufacture a passing dkim segment", () => {
    // Gmail's header truthfully transcribes the sender's own envelope address,
    // quoted — and an envelope localpart may legally contain ';'. Unquoted
    // splitting would read the smuggled text as a segment of Gmail's verdict.
    const forged = realHeaderLines.map((h) => h.key !== "authentication-results" ? h : {
      ...h, line:
        'Authentication-Results: mx.google.com;\r\n' +
        '       dkim=fail header.i=@fnb.co.za;\r\n' +
        '       spf=pass (google.com: domain of "x;dkim=pass header.i=@fnb.co.za;y"@evil.example designates 1.2.3.4 as permitted sender) smtp.mailfrom="x;dkim=pass header.i=@fnb.co.za;y"@evil.example',
    });
    const v = authenticationVerdict({ headerLines: forged, fromAddress: REAL_FROM });
    expect(v.pass).toBe(false);
  });

  it("a ')' and ';' smuggled UNQUOTED through the spf comment cannot pass either — dkim is only read before the spf segment", () => {
    // Even if the comment is broken open by an exotic localpart and the
    // injection re-balances itself, everything attacker-reachable sits inside
    // or after the spf segment, where the dkim scan has already stopped.
    const forged = realHeaderLines.map((h) => h.key !== "authentication-results" ? h : {
      ...h, line:
        "Authentication-Results: mx.google.com;\r\n" +
        "       dkim=fail header.i=@fnb.co.za;\r\n" +
        "       spf=pass (google.com: domain of x)y;dkim=pass header.i=@fnb.co.za;z(w@evil.example designates 1.2.3.4 as permitted sender) smtp.mailfrom=z@evil.example",
    });
    const v = authenticationVerdict({ headerLines: forged, fromAddress: REAL_FROM });
    expect(v.pass).toBe(false);
  });

  it("an escaped quote inside smtp.mailfrom does not end the quoted string early", () => {
    const forged = realHeaderLines.map((h) => h.key !== "authentication-results" ? h : {
      ...h, line:
        "Authentication-Results: mx.google.com;\r\n" +
        "       dkim=fail header.i=@fnb.co.za;\r\n" +
        '       spf=pass smtp.mailfrom="x\\";dkim=pass header.i=@fnb.co.za;\\"y"@evil.example',
    });
    const v = authenticationVerdict({ headerLines: forged, fromAddress: REAL_FROM });
    expect(v.pass).toBe(false);
  });

  it("UNBALANCED quoting or comments refuse the verdict outright", () => {
    for (const tail of ['smtp.mailfrom="unterminated', "spf=pass (unclosed comment", "spf=pass stray ) here"]) {
      const forged = realHeaderLines.map((h) => h.key !== "authentication-results" ? h : {
        ...h, line: `Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@fnb.co.za;\r\n       ${tail}`,
      });
      const v = authenticationVerdict({ headerLines: forged, fromAddress: REAL_FROM });
      expect(v.pass, tail).toBe(false);
      expect(v.detail, tail).toMatch(/unbalanced/);
    }
  });

  it("accepts an aligned SUBDOMAIN signature (frg.fnb.co.za signing for fnb.co.za)", () => {
    const sub = realHeaderLines.map((h) => h.key !== "authentication-results" ? h : {
      ...h, line: h.line.replace("header.i=@fnb.co.za", "header.i=@frg.fnb.co.za"),
    });
    const v = authenticationVerdict({ headerLines: sub, fromAddress: REAL_FROM });
    expect(v.pass).toBe(true);
    expect(v.dkimDomain).toBe("frg.fnb.co.za");
  });
});

// Verbatim from the REAL R100 payment notification (uid 10, "Payment
// confirmation 4401", 2026-08-30) — the payer's own bank, Standard Bank.
const REAL_SB_AUTH_RESULTS =
  "Authentication-Results: mx.google.com;\r\n" +
  "       dkim=pass header.i=@standardbank.co.za header.s=myupdates2a header.b=sosrp8N9;\r\n" +
  "       spf=pass (google.com: domain of bounce-330458969-1b@myupdates2.standardbank.co.za designates 196.8.104.111 as permitted sender) smtp.mailfrom=bounce-330458969-1B@myupdates2.standardbank.co.za;\r\n" +
  "       dmarc=pass (p=REJECT sp=NONE dis=NONE) header.from=standardbank.co.za";

describe("the authentication verdict — the payer's bank", () => {
  it("PASSES the real Standard Bank payment notification", () => {
    const lines = [
      realHeaderLines[0],
      { key: "authentication-results", line: REAL_SB_AUTH_RESULTS },
      { key: "from", line: "From: <noreply@standardbank.co.za>" },
    ];
    const v = authenticationVerdict({ headerLines: lines, fromAddress: "noreply@standardbank.co.za" });
    expect(v).toMatchObject({ pass: true, fromDomain: "standardbank.co.za", dkimDomain: "standardbank.co.za" });
  });
});

describe("candidacy — which messages the EFT reader examines at all", () => {
  it("the payer's bank is the sender — every allowlisted SA bank is a candidate", () => {
    for (const d of ["standardbank.co.za", "absa.co.za", "nedbank.co.za", "capitecbank.co.za", "tymebank.co.za"]) {
      expect(isEftCandidate({ fromAddress: `noreply@${d}`, subject: "Payment confirmation 4401" }), d).toBe(true);
    }
  });
  it("an FNB-claiming message is a candidate — attachments do not disqualify", () => {
    // A notification with a proof-of-payment PDF attached must still be
    // examined; the poller runs BOTH readers on such a message. Candidacy
    // deliberately knows nothing about attachments.
    expect(isEftCandidate({ fromAddress: REAL_FROM, subject: "Payment notification" })).toBe(true);
  });
  it("a subdomain sender is a candidate too — and the verdict will agree, not file it as forgery", () => {
    expect(isEftCandidate({ fromAddress: "alerts@secure.fnb.co.za", subject: "Payment notification" })).toBe(true);
  });
  it("a batch report is the CARD path's, even if its PDF went missing", () => {
    expect(isEftCandidate({ fromAddress: REAL_FROM, subject: "Banking Report for Batch 16 of Terminal 67377843" })).toBe(false);
  });
  it("ordinary mail is nobody's", () => {
    expect(isEftCandidate({ fromAddress: "news@shopify.com", subject: "hello" })).toBe(false);
    expect(isEftCandidate({ fromAddress: null, subject: "x" })).toBe(false);
    // The parent-of-allowlisted direction stays out (see domainAllowlisted).
    expect(isEftCandidate({ fromAddress: "x@co.za", subject: "Payment" })).toBe(false);
  });
});

describe("htmlToText — FNB mail carries no text part", () => {
  it("flattens block markup into labelled lines", () => {
    const html = `<html><style>.x{color:red}</style><body><table>
      <tr><td>Amount:</td><td>R 1,234.56</td></tr>
      <tr><td>Reference:</td><td>THANDI M</td></tr>
    </table><p>Regards<br>FNB</p></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("Amount: R 1,234.56");
    expect(text).toContain("Reference: THANDI M");
    expect(text).not.toContain("color:red");
    expect(text).not.toMatch(/<[a-z]/i);
  });
  it("decodes the entities banks actually use — numeric references included", () => {
    expect(htmlToText("R&nbsp;500.00 &amp; more")).toBe("R 500.00 & more");
    // &#160; is the no-break space bank templates love.
    expect(htmlToText("<p>Amount:&#160;R500.00</p>")).toBe("Amount:\u00a0R500.00");
    expect(htmlToText("&#82;100.00 &#x52;")).toBe("R100.00 R");
  });
});

describe("the bank's own timestamp", () => {
  it("reads the shapes FNB prints, as SAST", () => {
    // 2026-08-30 14:41:56 SAST = 12:41:56 UTC
    expect(parseBankTimestamp("2026/08/30 14:41:56")).toBe(Date.UTC(2026, 7, 30, 12, 41, 56));
    expect(parseBankTimestamp("2026-08-30 14:41")).toBe(Date.UTC(2026, 7, 30, 12, 41, 0));
    expect(parseBankTimestamp("30 Aug 2026")).toBe(Date.UTC(2026, 7, 29, 22, 0, 0));
    expect(parseBankTimestamp("30 August 2026 14:41")).toBe(Date.UTC(2026, 7, 30, 12, 41, 0));
    // Standard Bank's own shape, from the real notification: "2026-08-30 23h48"
    expect(parseBankTimestamp("2026-08-30 23h48")).toBe(Date.UTC(2026, 7, 30, 21, 48, 0));
  });
  it("refuses phantoms and garbage rather than rolling them", () => {
    expect(parseBankTimestamp("2026/02/30 10:00:00")).toBe(null);
    expect(parseBankTimestamp("30 Foo 2026")).toBe(null);
    expect(parseBankTimestamp("yesterday")).toBe(null);
    expect(parseBankTimestamp("")).toBe(null);
  });
});

describe("account numbers are struck out", () => {
  it("keeps the last three digits of any long run and nothing else", () => {
    expect(redactAccountDigits("from account 62834519234 to 250655588888")).toBe("from account ⋯234 to ⋯888");
  });
  it("catches grouped account numbers too — spaces and dashes do not hide one", () => {
    expect(redactAccountDigits("acc 6283 4519 234")).toBe("acc ⋯234");
    expect(redactAccountDigits("acc 62-834-519")).toBe("acc ⋯519");
  });
  it("…but never a DATE — the refusal diagnostic keeps its timestamp", () => {
    expect(redactAccountDigits("Payment date and time 2026-08-30 23h48")).toBe("Payment date and time 2026-08-30 23h48");
  });
  it("maskAccountValue: a bank that prints the full number stores only the last four", () => {
    expect(maskAccountValue("62834519234")).toBe("XXXXXXX9234");
    expect(maskAccountValue("XXXXXXXXXXXX6625")).toBe("XXXXXXXXXXXX6625"); // already masked: unchanged
    expect(maskAccountValue("1234")).toBe("1234");
    expect(maskAccountValue(null)).toBe(null);
  });
  it("looksPaymentShaped keeps the refusal feed about payments, not newsletters", () => {
    expect(looksPaymentShaped("Payment confirmation 4401")).toBe(true);
    expect(looksPaymentShaped("You received R 750.00")).toBe(true);
    expect(looksPaymentShaped("Your statement is ready to view")).toBe(false);
    expect(looksPaymentShaped("Win big with our new rewards programme!")).toBe(false);
  });
  it("leaves amounts and short numbers alone", () => {
    expect(redactAccountDigits("R 1,234.56 ref 12345")).toBe("R 1,234.56 ref 12345");
  });
});

describe("the destination-account allowlist — only the shop's own accounts", () => {
  it("reads last-four tails out of the env value, full numbers or tails alike", () => {
    expect(parseAllowedAccountTails("62123456625, 4009")).toEqual(["6625", "4009"]);
    expect(parseAllowedAccountTails(" 6212-345-6625 ")).toEqual(["6625"]);
    expect(parseAllowedAccountTails("123")).toEqual([]); // too short to be an account
    expect(parseAllowedAccountTails("")).toEqual([]);
    expect(parseAllowedAccountTails(undefined)).toEqual([]);
  });

  it("matches the MASKED destination on its last four — the payer's bank never prints the full number", () => {
    expect(accountVerdict({ accountMask: "XXXXXXXXXXXX6625", allowedTails: ["6625"] })).toMatchObject({ ok: true, tail: "6625" });
    const wrong = accountVerdict({ accountMask: "XXXXXXXXXXXX9999", allowedTails: ["6625"] });
    expect(wrong.ok).toBe(false);
    expect(wrong.reason).toMatch(/ending 9999/);
  });

  it("FAILS CLOSED: no allowlist configured refuses, and names the variable to set", () => {
    const v = accountVerdict({ accountMask: "XXXXXXXXXXXX6625", allowedTails: [] });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain(EFT_ACCOUNTS_ENV_VAR);
  });

  it("FAILS CLOSED: fewer than four visible digits cannot be checked", () => {
    const v = accountVerdict({ accountMask: "XXXXXXXX625", allowedTails: ["6625"] });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/fewer than four/);
  });
});

describe("identity — the same notification never lands twice", () => {
  const parts = { messageId: "<1418003107.199359.1788093716654@communications>", from: REAL_FROM, subject: "Payment", date: 1788093716654, size: 9000, uid: 12, uidValidity: "5" };

  it("a replay computes the SAME key", () => {
    expect(eftMessageKey({ ...parts, authPass: true })).toBe(eftMessageKey({ ...parts, authPass: true }));
  });

  it("a forgery guessing a genuine Message-ID cannot occupy the genuine record's key", () => {
    expect(eftMessageKey({ ...parts, authPass: false })).not.toBe(eftMessageKey({ ...parts, authPass: true }));
  });

  it("a message with no Message-ID still gets a stable, mailbox-scoped key", () => {
    const noId = { ...parts, messageId: null };
    expect(eftMessageKey({ ...noId, authPass: true })).toBe(eftMessageKey({ ...noId, authPass: true }));
    expect(eftMessageKey({ ...noId, authPass: true })).not.toBe(eftMessageKey({ ...noId, uid: 13, authPass: true }));
  });

  it("REPLAY: the create-only write leaves the existing record — and its status — untouched", () => {
    // A miniature of the RTDB transaction the poller runs: first delivery
    // writes; the same message replayed later (stale claim, mailbox re-read)
    // finds the record and must not reset a status a later session has moved.
    const store = {};
    const transact = (key, record) => {
      const d = poolWriteDecision(store[key] ?? null, record);
      if (d.write) store[key] = d.value;
      return d;
    };
    const key = eftMessageKey({ ...parts, authPass: true });
    const record = { outcome: "recorded", status: "unmatched", amountCents: 50000 };
    expect(transact(key, record).write).toBe(true);
    store[key].status = "matched"; // a future session moved it on
    expect(transact(key, { ...record }).write).toBe(false);
    expect(store[key].status).toBe("matched");
    expect(Object.keys(store)).toHaveLength(1);
  });
});

describe("the pool record", () => {
  const message = { messageId: "<m@x>", from: `<${REAL_FROM}>`, subject: "Payment notification", receivedAt: 1788093716654 };
  const passVerdict = { pass: true, fromDomain: "fnb.co.za", dkimDomain: "fnb.co.za", detail: "dkim=pass, signed by fnb.co.za, aligned with fnb.co.za" };

  const parsedOk = {
    ok: true, amountCents: 123456, reference: "THANDI", payer: "T M", bankTs: 5,
    bankRef: "999", beneficiaryName: "ATUGAR TRADING", destBankName: "FIRST NATIONAL BANK",
    accountMask: "XXXXXXXXXXXX4321",
  };

  it("a verified, parsed, ACCOUNT-CHECKED payment: outcome recorded, status unmatched, every field aboard", () => {
    const r = eftPoolRecord({
      message, verdict: passVerdict, parsed: parsedOk,
      account: { ok: true, tail: "4321" }, reader: "standardbank",
      rawText: "Amount: R 1,234.56\nfrom account 62834519234", at: 99,
    });
    expect(r).toMatchObject({
      outcome: "recorded", status: "unmatched", amountCents: 123456,
      reference: "THANDI", payer: "T M", bankTs: 5, at: 99, receivedAt: 1788093716654,
      bankRef: "999", accountTail: "4321", reader: "standardbank",
      destination: { accountMask: "XXXXXXXXXXXX4321", beneficiaryName: "ATUGAR TRADING", destBankName: "FIRST NATIONAL BANK" },
      auth: { verdict: "pass" },
    });
    expect(r.rawText).toContain("⋯234"); // the account run is struck out
    expect(r.rawText).not.toContain("62834519234");
  });

  it("a payment into somebody else's account is refused-account — with the amount and destination on show", () => {
    const r = eftPoolRecord({
      message, verdict: passVerdict, parsed: parsedOk,
      account: { ok: false, reason: "This payment credits an account ending 4321, which is not one of the shop's own accounts." },
      reader: "standardbank", rawText: "x", at: 99,
    });
    expect(r.outcome).toBe("refused-account");
    expect(r.amountCents).toBe(123456);
    expect(r.destination.accountMask).toBe("XXXXXXXXXXXX4321");
    expect(r.status).toBeUndefined();
    expect(r.reference).toBeUndefined(); // not a poolable payment; the fields that matter are the refusal's
  });

  it("a parsed payment with NO account verdict at all cannot be stored as recorded", () => {
    const r = eftPoolRecord({ message, verdict: passVerdict, parsed: parsedOk, account: null, reader: "standardbank", rawText: "x", at: 99 });
    expect(r.outcome).toBe("refused-account");
    expect(r.reason).toMatch(/never checked/);
  });

  it("the subject gets the same account-number sweep as the body", () => {
    const r = eftPoolRecord({
      message: { ...message, subject: "Payment to account 62834519234" },
      verdict: passVerdict,
      parsed: parsedOk, account: { ok: true, tail: "4321" }, reader: "standardbank",
      rawText: "x", at: 99,
    });
    expect(r.subject).toBe("Payment to account ⋯234");
  });

  it("a failed-authentication refusal is its own outcome, named as a forgery attempt", () => {
    const r = eftPoolRecord({
      message, verdict: { pass: false, fromDomain: "fnb.co.za", dkimDomain: null, detail: "no aligned DKIM pass — Gmail recorded dkim=fail (fnb.co.za)" },
      parsed: null, rawText: "pay me", at: 99,
    });
    expect(r.outcome).toBe("refused-auth");
    expect(r.reason).toMatch(/forgery attempt/);
    expect(r.status).toBeUndefined();
    expect(r.amountCents).toBeUndefined();
  });

  it("a parse refusal keeps the raw text so the format change is diagnosable", () => {
    const r = eftPoolRecord({
      message, verdict: passVerdict,
      parsed: { ok: false, reason: "No Amount field and no rand figure anywhere in the message." },
      rawText: "Sawubona! Your payment of five hundred rand is in.", at: 99,
    });
    expect(r.outcome).toBe("refused-parse");
    expect(r.rawText).toContain("five hundred rand");
    expect(r.status).toBeUndefined();
  });
});

// ─── EFT PAYMENT POOL — the decisions, tested as data ────────────────────────
// THE AUTHENTICATION FIXTURE IS REAL. The header block below is copied verbatim
// (folding and all) from a genuine FNB message delivered to marathon6631@gmail.com
// on 2026-08-30 and pulled from the mailbox over IMAP — because the exact shape
// of the Authentication-Results header Gmail stamps is the entire point of the
// check, and a hand-written approximation of it would test the approximation.
// The forgeries are then derived from the real thing by changing exactly the
// part an attacker controls.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  domainOfAddress, domainsAligned, domainAllowlisted, authenticationVerdict,
  isEftCandidate, htmlToText, parseBankTimestamp, redactAccountDigits,
  parseAllowedAccountTails, accountVerdict, EFT_ACCOUNTS_ENV_VAR,
  maskAccountValue, looksPaymentShaped,
  eftMessageKey, poolWriteDecision, eftPoolRecord,
  eftMessageRoute, looksLikeStrangerPayment, unknownBankRecord, UNKNOWN_BANK_RAW_LIMIT,
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
    // …and the exemption is END-anchored: a run that merely STARTS like a
    // date is still an account, and a run riding one space after a date too.
    expect(redactAccountDigits("Account 1234-56-789012 holder")).toBe("Account ⋯012 holder");
    expect(redactAccountDigits("paid 2026-08-30 1234567890 ref")).toBe("paid ⋯890 ref");
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
    const v = accountVerdict({ accountMask: "XXXXXXXXXXXX6625", allowedTails: [], configured: false });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain(EFT_ACCOUNTS_ENV_VAR);
    expect(v.reason).toMatch(/No account allowlist is configured/);
  });

  it("a SET variable with no usable entry refuses with the RIGHT cause — never 'not configured'", () => {
    const v = accountVerdict({ accountMask: "XXXXXXXXXXXX6625", allowedTails: [], configured: true });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/set but holds no usable/);
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

// ─── SEVERAL PAYMENTS ON ONE MESSAGE ─────────────────────────────────────────
// Standard Bank batches payments: one email, several PDFs, each one payment.
// The contract pinned here: identical parses collapse to ONE payment (reprint,
// or body+PDF twins), distinct parses are EACH their own payment with their
// own deterministic 40-hex pool key, a single-payment message keeps the
// message key itself (records written before batching existed stay reachable
// by replays), and unparseable documents each refuse separately.
import { groupEftPayments, eftPaymentKey, paymentIdentity, envelopeCandidateKeys } from "./eftCore.mjs";
import { messageKey } from "./intakeCore.mjs";

const okParse = (over = {}) => ({
  ok: true, amountCents: 55000, reference: "JUNID1234", payer: "J SOAP",
  bankTs: 890, bankRef: "4140542552", beneficiaryName: "ATUGAR", destBankName: "FNB",
  accountMask: "XXXXXXXXXXXX6625", ...over,
});
const doc = (text, p) => ({ d: { text }, r: { id: "standardbank" }, p });

describe("groupEftPayments", () => {
  it("two DIFFERENT payments in one message are two groups, order stable", () => {
    const a = okParse();
    const b = okParse({ amountCents: 20000, bankRef: "999", reference: "OM82" });
    const groups = groupEftPayments([doc("A", a), doc("B", b)]);
    expect(groups).toHaveLength(2);
    expect(groups[0].parse.amountCents).toBe(55000);
    expect(groups[1].parse.amountCents).toBe(20000);
    expect(groups[0].rawText).toBe("A");
  });

  it("identical parses collapse to one payment and count their copies", () => {
    const groups = groupEftPayments([doc("pdf", okParse()), doc("body", okParse())]);
    expect(groups).toHaveLength(1);
    expect(groups[0].copies).toBe(2);
  });

  it("same amount+reference but different bank transaction ids are TWO payments", () => {
    // The customer paying twice: everything identical except the bank's id.
    const groups = groupEftPayments([doc("A", okParse()), doc("B", okParse({ bankRef: "4140542553" }))]);
    expect(groups).toHaveLength(2);
  });

  it("unparseable documents refuse separately; identical broken twins collapse", () => {
    const bad = { ok: false, reason: "no Amount line" };
    const groups = groupEftPayments([doc("broken-1", bad), doc("broken-1", bad), doc("broken-2", bad)]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => !g.parse.ok)).toBe(true);
  });

  it("a parsed payment and a broken sibling both survive as their own groups", () => {
    const groups = groupEftPayments([doc("good", okParse()), doc("bad", { ok: false, reason: "x" })]);
    expect(groups).toHaveLength(2);
  });
});

describe("eftPaymentKey", () => {
  const base = "a".repeat(40);
  it("an OK parse is keyed by content identity even when it is the only group — a crash-retry whose sibling document flapped must land on the SAME key", () => {
    const [g] = groupEftPayments([doc("A", okParse())]);
    const alone = eftPaymentKey(base, g, 1);
    const [g2] = groupEftPayments([doc("A", okParse()), doc("B", okParse({ bankRef: "9" }))]);
    expect(alone).toBe(eftPaymentKey(base, g2, 2)); // same payment, same key, any group count
    expect(alone).toMatch(/^[0-9a-f]{40}$/);
    expect(alone).not.toBe(base);
  });
  it("a message's ONLY refusal keeps the message key (a refusal is about the message)", () => {
    const [g] = groupEftPayments([doc("broken", { ok: false, reason: "x" })]);
    expect(eftPaymentKey(base, g, 1)).toBe(base);
  });
  it("multi-payment keys are 40-hex, deterministic, distinct per payment", () => {
    const groups = groupEftPayments([doc("A", okParse()), doc("B", okParse({ bankRef: "9" }))]);
    const k0 = eftPaymentKey(base, groups[0], 2);
    const k1 = eftPaymentKey(base, groups[1], 2);
    expect(k0).toMatch(/^[0-9a-f]{40}$/);
    expect(k1).toMatch(/^[0-9a-f]{40}$/);
    expect(k0).not.toBe(k1);
    expect(k0).not.toBe(base);
    // A replay computes the same keys — that is what makes the pool write
    // create-only rather than duplicating.
    expect(eftPaymentKey(base, groups[0], 2)).toBe(k0);
  });
  it("identity ignores volatile fields (payer prose, timestamps)", () => {
    expect(paymentIdentity(okParse({ payer: "X", bankTs: 1 }))).toBe(paymentIdentity(okParse({ payer: "Y", bankTs: 2 })));
  });
});

describe("envelopeCandidateKeys", () => {
  it("covers the slip key and both EFT auth-verdict keys from the Message-ID alone", () => {
    const id = "<abc@standardbank.co.za>";
    const keys = envelopeCandidateKeys({ messageId: id });
    expect(keys).toHaveLength(3);
    expect(keys).toContain(messageKey({ messageId: id }));
    expect(keys).toContain(eftMessageKey({ messageId: id, authPass: true }));
    expect(keys).toContain(eftMessageKey({ messageId: id, authPass: false }));
    expect(new Set(keys).size).toBe(3);
  });
  it("no Message-ID → null: download and let the claim decide, never a wrong skip", () => {
    expect(envelopeCandidateKeys({ messageId: null })).toBe(null);
    expect(envelopeCandidateKeys({ messageId: "" })).toBe(null);
  });
});

// ─── A BANK THE POOL IS NOT SET UP FOR ───────────────────────────────────────
// The gap this closes: a payment notification from a domain that is not on the
// allowlist was filed as ordinary mail — no record, no refusal, nobody told. A
// bank paying the shop that nobody has heard of is the silent loss this whole
// feature exists to prevent, and it is worse than a refusal, because a refusal
// is at least a row somebody can act on.
describe("routing — three answers, because 'not a candidate' hid two of them", () => {
  it("a batch report is the card path's, whoever sent it", () => {
    expect(eftMessageRoute({ fromAddress: "NoReplyTransReport@fnb.co.za", subject: "Banking Report for Batch 16 of Terminal 67377843" })).toBe("card");
  });
  it("an allowlisted bank is the reader's", () => {
    expect(eftMessageRoute({ fromAddress: "noreply@standardbank.co.za", subject: "Payment confirmation" })).toBe("bank");
    expect(eftMessageRoute({ fromAddress: "alerts@secure.fnb.co.za", subject: "Payment notification" })).toBe("bank");
  });
  it("anyone else is a STRANGER — no longer silently nobody's", () => {
    // Discovery is the case that prompted this: a real SA bank, no reader, not
    // on the allowlist, and until now completely invisible.
    expect(eftMessageRoute({ fromAddress: "noreply@discoverybank.co.za", subject: "Payment Notification" })).toBe("stranger");
    expect(eftMessageRoute({ fromAddress: "news@shopify.com", subject: "hello" })).toBe("stranger");
    expect(eftMessageRoute({ fromAddress: null, subject: "x" })).toBe("stranger");
    // The parent-of-allowlisted direction stays OUT of "bank" — it must never
    // be the way an attacker gets read (see domainAllowlisted).
    expect(eftMessageRoute({ fromAddress: "x@co.za", subject: "Payment" })).toBe("stranger");
  });
  it("isEftCandidate still answers exactly what it always did", () => {
    // Kept in terms of the route so the two can never drift apart.
    for (const c of [
      { fromAddress: "noreply@standardbank.co.za", subject: "Payment confirmation", expected: true },
      { fromAddress: "NoReplyTransReport@fnb.co.za", subject: "Banking Report for Batch 16 of Terminal 1", expected: false },
      { fromAddress: "noreply@discoverybank.co.za", subject: "Payment Notification", expected: false },
    ]) {
      expect(isEftCandidate(c), c.fromAddress).toBe(c.expected);
    }
  });
});

describe("which stranger mail is worth a row", () => {
  const looks = (o) => looksLikeStrangerPayment(o);

  it("a cue in the SUBJECT is enough — that is where a bank puts it", () => {
    expect(looks({ subject: "Payment Notification", bodyText: "", attachmentNames: [] })).toBe(true);
    expect(looks({ subject: "Proof of payment", bodyText: "", attachmentNames: [] })).toBe(true);
  });

  it("a cue in an ATTACHMENT NAME is enough — and it has to be", () => {
    // Standard Bank's own notification body says only "please open the attached
    // PDF file". A body-only test would go silent on exactly the layout most
    // banks use, which is the failure this whole thing is about.
    expect(looks({
      subject: "FW: document", bodyText: "Please open the attached PDF file.",
      attachmentNames: ["PaymentConfirmation.pdf"],
    })).toBe(true);
  });

  it("…and reading the NAME is not opening the file", () => {
    // Nothing here takes bytes. The signal is envelope metadata, which is the
    // only thing about an unauthenticated stranger this poller will touch.
    expect(looks({ subject: "", bodyText: "", attachmentNames: ["Payment Notification.pdf"] })).toBe(true);
  });

  it("the BODY needs both a cue and an amount — one alone is a newsletter", () => {
    expect(looks({ subject: "hello", bodyText: "our payment terms have changed", attachmentNames: [] })).toBe(false);
    expect(looks({ subject: "hello", bodyText: "now only R199.00 a month", attachmentNames: [] })).toBe(false);
    expect(looks({ subject: "hello", bodyText: "a payment of R750.00 was made", attachmentNames: [] })).toBe(true);
  });

  it("plain mail from a stranger stays ordinary mail", () => {
    expect(looks({ subject: "Your invoice is ready", bodyText: "log in to view", attachmentNames: [] })).toBe(false);
    expect(looks({ subject: "", bodyText: "", attachmentNames: [] })).toBe(false);
    expect(looks({})).toBe(false);
  });
});

describe("the unknown-bank record", () => {
  const message = {
    receivedAt: 1788207000000, messageId: "<x@discoverybank.co.za>",
    from: "Discovery Bank <noreply@discoverybank.co.za>", subject: "Payment Notification",
  };
  const record = unknownBankRecord({
    message, fromDomain: "discoverybank.co.za",
    rawText: "A payment of R750.00 was made to your account from account 1234567890.",
    at: 1788207100000,
  });

  it("names the domain, in the reason and on its own field", () => {
    expect(record.fromDomain).toBe("discoverybank.co.za");
    expect(record.reason).toContain("discoverybank.co.za");
    expect(record.reason).toMatch(/add its domain to EFT_ALLOWED_DOMAINS/);
  });

  it("is NOT a failed authentication — the two mean different things", () => {
    // refused-auth: a message CLAIMED a bank we know and failed verification.
    // unknown-bank: nobody claimed anything, so nothing was checked. Filing one
    // as the other would either cry forgery about a bank the owner simply has
    // not set up, or hide a forgery among them.
    expect(record.outcome).toBe("unknown-bank");
    expect(record.auth.verdict).toBe("not-checked");
    expect(record.auth.detail).toMatch(/nothing was authenticated and nothing was read/);
  });

  it("carries NOTHING that could be settled against", () => {
    // No reader ran, so there is no amount, no reference and no account. It is
    // structurally impossible for this row to become money.
    expect(record.amountCents).toBeUndefined();
    expect(record.status).toBeUndefined();
    expect(record.reference).toBeUndefined();
    expect(record.accountTail).toBeUndefined();
    expect(record.destination).toBeUndefined();
    expect(record.reader).toBe(null);
  });

  it("keeps the sender's words, struck out and kept SHORT", () => {
    // A stranger's raw text is a lead, not evidence: enough to recognise the
    // bank, not a wall of someone else's page. Account digits go, as everywhere.
    expect(record.rawText).not.toContain("1234567890");
    expect(record.rawText.length).toBeLessThanOrEqual(UNKNOWN_BANK_RAW_LIMIT);
    const long = unknownBankRecord({ message, fromDomain: "x.co.za", rawText: "y".repeat(5000), at: 1 });
    expect(long.rawText.length).toBeLessThanOrEqual(UNKNOWN_BANK_RAW_LIMIT);
    // …and shorter than a known bank's refusal keeps (4000).
    expect(UNKNOWN_BANK_RAW_LIMIT).toBeLessThan(4000);
  });

  it("an unreadable sender still leaves a row rather than nothing", () => {
    const nameless = unknownBankRecord({ message, fromDomain: null, rawText: "hi", at: 1 });
    expect(nameless.outcome).toBe("unknown-bank");
    expect(nameless.reason).toContain("an unreadable address");
  });
});

// ─── WHAT THE STRANGER PATH IS NOT ALLOWED TO DO ─────────────────────────────
// The record is pure and tested above; the DISCIPLINE around it lives in the
// poller, which cannot be unit-tested (it is IMAP and a database). So its one
// function is read as source, and the three things it must never do are pinned
// here — each of them a security property, not a preference:
//
//   it must not AUTHENTICATE       a verdict on a domain we do not know is a
//                                  claim we have no business making, and it
//                                  would file an unset-up bank as a forgery.
//   it must not OPEN AN ATTACHMENT rendering a PDF from an unauthenticated
//                                  stranger is the one thing this poller has
//                                  always refused to do.
//   it must not PARSE              no reader, so no amount, no reference, no
//                                  account — nothing that could ever settle.
const POLLER = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "email-poller.mjs"), "utf8");

describe("the stranger path stays a bystander", () => {
  const body = (() => {
    const from = POLLER.indexOf("async function noteStrangerPayment");
    expect(from, "noteStrangerPayment has been renamed — this scan must follow it").toBeGreaterThan(-1);
    const end = POLLER.indexOf("\n}\n", from);
    const text = POLLER.slice(from, end);
    expect(text.length, "the slice must actually cover the function").toBeGreaterThan(400);
    return text;
  })();

  it("never authenticates — it makes no claim about a domain it does not know", () => {
    expect(body).not.toMatch(/authenticationVerdict/);
  });

  it("never opens an attachment", () => {
    expect(body, "no PDF rendering").not.toMatch(/pdfToLines|renderPdf|planMessage/);
    // The names, off the envelope, are all it may read.
    expect(body).toMatch(/attachments \|\| \[\]\)\.map\(\(a\) => a\?\.filename/);
  });

  it("never offers the document to a reader", () => {
    expect(body).not.toMatch(/selectReader|EFT_READERS|eftPoolRecord|accountVerdict/);
  });

  it("writes create-only — a replay lands on the same node and finds it there", () => {
    expect(body).toMatch(/poolWriteDecision\(existing, record\)/);
    expect(body).toMatch(/eftMessageKey\(/);
  });

  it("CONSUMES NOTHING — noting a message must not cost the message", () => {
    // A batch report forwarded from someone's own address with an edited
    // subject is a stranger too. If this path claimed the message or marked it
    // read, the slip inside would be lost — silently, which is the exact
    // failure this change exists to end. It writes its row and hands the
    // message back to the ordinary route.
    expect(body, "no read flag").not.toMatch(/messageFlagsAdd/);
    expect(body, "no ledger claim").not.toMatch(/SEEN_PATH/);
    expect(POLLER, "…and the caller carries on rather than returning").toMatch(
      /await noteStrangerPayment\([^)]*\);\s*\n\s*return null;/);
  });

  it("is reached only for a stranger, and a batch report never reaches it", () => {
    expect(POLLER).toMatch(/if \(route === "card"\) return null;/);
    expect(POLLER).toMatch(/if \(route === "stranger"\) \{/);
  });

  it("stays silent about ordinary mail from a stranger", () => {
    expect(body).toMatch(/if \(!looksLikeStrangerPayment\([\s\S]{0,120}\)\) return;/);
  });

  it("counts what it noted, so a run says so out loud", () => {
    expect(POLLER).toMatch(/eftUnknownBank: unknownBankThisRun/);
    expect(POLLER).toMatch(/from a bank not set up — see \/eft_pool/);
  });
});

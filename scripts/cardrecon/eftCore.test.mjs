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
  parseEftNotification, eftMessageKey, poolWriteDecision, eftPoolRecord,
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
    const v = authenticationVerdict({ headerLines: realHeaderLines, fromAddress: "x@absa.co.za" });
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

describe("candidacy — which messages the EFT reader examines at all", () => {
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
    // &#160; is the no-break space bank templates love; a parser that cannot
    // see through it refuses the first genuine notification for nothing.
    const p = parseEftNotification(htmlToText("<p>Amount:&#160;R500.00</p><p>Reference: X</p>"));
    expect(p).toMatchObject({ ok: true, amountCents: 50000, reference: "X" });
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
  it("leaves amounts and short numbers alone", () => {
    expect(redactAccountDigits("R 1,234.56 ref 12345")).toBe("R 1,234.56 ref 12345");
  });
});

describe("parsing the notification — exact or refused", () => {
  const good = [
    "Payment notification",
    "Amount: R 1,234.56",
    "Reference: THANDI 0821234567",
    "Paid by: T MOKOENA",
    "Date: 2026/08/30 14:41:56",
  ].join("\n");

  it("extracts amount, reference, payer and the bank's timestamp", () => {
    const p = parseEftNotification(good);
    expect(p).toMatchObject({
      ok: true, amountCents: 123456,
      reference: "THANDI 0821234567", payer: "T MOKOENA",
      bankTs: Date.UTC(2026, 7, 30, 12, 41, 56),
    });
  });

  it("a payment without a reference still lands — reference null", () => {
    const p = parseEftNotification("Amount: R 500.00\nPaid by: X");
    expect(p.ok).toBe(true);
    expect(p.reference).toBe(null);
    expect(p.amountCents).toBe(50000);
  });

  it("REFUSES two Amount fields that disagree", () => {
    const p = parseEftNotification("Amount: R 500.00\nAmount: R 600.00");
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/disagree/);
  });

  it("REFUSES a mangled figure — the fuzzed card-recon parser is the judge", () => {
    const p = parseEftNotification("Amount: R50,307,00.5");
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/does not parse exactly/);
  });

  it("with NO Amount label it refuses — even one lone rand figure is a guess", () => {
    // "The only R-figure in the text" and "the payment" are not the same
    // claim; a wrong amount here eventually releases stock. The refusal names
    // how many loose figures it saw, so the refusal itself documents the
    // format for the fix.
    const one = parseEftNotification("You have received R 750.00 into your account.");
    expect(one.ok).toBe(false);
    expect(one.reason).toMatch(/1 loose rand figure/);
    const two = parseEftNotification("You received R 750.00. Your balance is R 9,120.44.");
    expect(two.ok).toBe(false);
    expect(two.reason).toMatch(/2 loose rand figure/);
  });

  it("REFUSES a message with no money in it at all", () => {
    expect(parseEftNotification("Dear customer, your statement is ready.").ok).toBe(false);
    expect(parseEftNotification("").ok).toBe(false);
  });

  it("REFUSES a zero or negative amount — not an incoming payment", () => {
    expect(parseEftNotification("Amount: R 0.00").ok).toBe(false);
    expect(parseEftNotification("Amount: -R 50.00").ok).toBe(false);
  });

  it("a 'From:' line is NOT a payer — a forwarded chain must not make the bank the payer", () => {
    const p = parseEftNotification("Amount: R 500.00\nFrom: NoReplyTransReport@FNB.co.za");
    expect(p.ok).toBe(true);
    expect(p.payer).toBe(null);
  });

  it("disagreeing payers or dates refuse the FIELD, not the payment — null, never a silent first", () => {
    const p = parseEftNotification("Amount: R 5.00\nPaid by: A\nPaid by: B\nDate: 30 Aug 2026\nDate: 2026/08/29 10:00:00");
    expect(p.ok).toBe(true);
    expect(p.payer).toBe(null);
    expect(p.bankTs).toBe(null);
    // …and a value that merely REPEATS is not a disagreement.
    const q = parseEftNotification("Amount: R 5.00\nPaid by: A\nPaid by: A");
    expect(q.payer).toBe("A");
  });

  it("REFUSES two References that disagree, keeps one that repeats", () => {
    expect(parseEftNotification("Amount: R 5.00\nReference: A\nReference: B").ok).toBe(false);
    const p = parseEftNotification("Amount: R 5.00\nReference: A\nReference: A");
    expect(p.ok).toBe(true);
    expect(p.reference).toBe("A");
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

  it("a verified, parsed payment: outcome recorded, status unmatched, every field aboard", () => {
    const r = eftPoolRecord({
      message, verdict: passVerdict,
      parsed: { ok: true, amountCents: 123456, reference: "THANDI", payer: "T M", bankTs: 5 },
      rawText: "Amount: R 1,234.56\nfrom account 62834519234", at: 99,
    });
    expect(r).toMatchObject({
      outcome: "recorded", status: "unmatched", amountCents: 123456,
      reference: "THANDI", payer: "T M", bankTs: 5, at: 99, receivedAt: 1788093716654,
      auth: { verdict: "pass" },
    });
    expect(r.rawText).toContain("⋯234"); // the account run is struck out
    expect(r.rawText).not.toContain("62834519234");
  });

  it("the subject gets the same account-number sweep as the body", () => {
    const r = eftPoolRecord({
      message: { ...message, subject: "Payment to account 62834519234" },
      verdict: passVerdict,
      parsed: { ok: true, amountCents: 100, reference: null, payer: null, bankTs: null },
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

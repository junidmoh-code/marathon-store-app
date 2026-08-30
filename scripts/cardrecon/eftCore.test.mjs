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
  domainOfAddress, domainsAligned, unfoldHeader, authenticationVerdict,
  isEftCandidate, htmlToText, parseBankTimestamp, redactAccountDigits,
  parseEftNotification, eftMessageKey,
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
  it("an FNB-claiming message with no slip PDFs is a candidate", () => {
    expect(isEftCandidate({ fromAddress: REAL_FROM, subject: "Payment notification", slipCount: 0 })).toBe(true);
  });
  it("a batch report is the CARD path's, even if its PDF went missing", () => {
    expect(isEftCandidate({ fromAddress: REAL_FROM, subject: "Banking Report for Batch 16 of Terminal 67377843", slipCount: 0 })).toBe(false);
  });
  it("a message carrying slip PDFs is the card path's", () => {
    expect(isEftCandidate({ fromAddress: REAL_FROM, subject: "Payment notification", slipCount: 2 })).toBe(false);
  });
  it("ordinary mail is nobody's", () => {
    expect(isEftCandidate({ fromAddress: "news@shopify.com", subject: "hello", slipCount: 0 })).toBe(false);
    expect(isEftCandidate({ fromAddress: null, subject: "x", slipCount: 0 })).toBe(false);
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
  it("decodes the entities banks actually use", () => {
    expect(htmlToText("R&nbsp;500.00 &amp; more")).toBe("R 500.00 & more");
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

  it("with no Amount label, exactly ONE rand figure in the text is accepted", () => {
    const p = parseEftNotification("You have received R 750.00 into your account.");
    expect(p).toMatchObject({ ok: true, amountCents: 75000 });
  });

  it("with no Amount label and SEVERAL figures, it refuses to guess", () => {
    const p = parseEftNotification("You received R 750.00. Your balance is R 9,120.44.");
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/refuses to make/);
  });

  it("REFUSES a message with no money in it at all", () => {
    expect(parseEftNotification("Dear customer, your statement is ready.").ok).toBe(false);
    expect(parseEftNotification("").ok).toBe(false);
  });

  it("REFUSES a zero or negative amount — not an incoming payment", () => {
    expect(parseEftNotification("Amount: R 0.00").ok).toBe(false);
    expect(parseEftNotification("Amount: -R 50.00").ok).toBe(false);
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
});

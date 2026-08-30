// ─── EFT PAYMENT POOL — EVERY DECISION, WITHOUT A MAILBOX (PURE) ─────────────
// Customers paying by EFT enter marathon6631@gmail.com as the notification
// address in their FNB app, and FNB emails a payment notification to the same
// mailbox the card recon poller already reads. This module is the SECOND READER
// on that mailbox: every decision it makes about such a message, kept away from
// IMAP, firebase-admin and the clock so the awkward cases are testable as data.
// The poller (email-poller.mjs) wires it in; nothing else calls it.
//
// WHAT THIS SESSION BUILDS, AND ONLY THIS: ingestion and storage. A verified
// payment notification becomes a record at /eft_pool with status "unmatched".
// Nothing reads the pool yet — no matching, no cashier surface, no release.
// The status field is designed for what is coming (matched, used) but no
// transition exists here.
//
// ── THE From ADDRESS IS ATTACKER-CONTROLLED TEXT ─────────────────────────────
// Anyone can send this mailbox a message whose From says fnb.co.za. The From
// domain decides only that a message is WORTH EXAMINING; whether it is believed
// rests entirely on what Gmail itself verified on delivery — the
// Authentication-Results header Gmail stamps above the message's own headers.
// Two checks, and deliberately no more:
//
//   1. dkim=pass, with the signing domain ALIGNED to the From domain.
//   2. the From domain on the allowlist (fnb.co.za).
//
// Return-Path, the Received chain, Message-ID and TLS are deliberately NOT
// checked: each is attacker-influenced or already subsumed in what Gmail
// verified, and each would add surface without adding certainty.
//
// A message that claims fnb.co.za and fails the check is a FORGERY ATTEMPT,
// recorded as a failed-authentication refusal — distinct from a parse refusal,
// because the person reading the feed does different things about them.
//
// ── A WRONG AMOUNT HERE EVENTUALLY RELEASES STOCK ────────────────────────────
// The parser refuses on any ambiguity rather than guessing. Every refusal
// stores the extracted text (account numbers struck out) so a format change is
// diagnosable from the record alone — card recon's refused files stored nothing
// and cost two diagnostic rounds.
//
// PURE by the house rule: no IMAP, no firebase-admin, no fetch, no clock.
// Tested in eftCore.test.mjs against the REAL headers of real FNB mail pulled
// from this very mailbox.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { clip } from "./intakeCore.mjs";

// The money parser is BORROWED from card recon, not rewritten: it has been
// fuzzed and had two real grouping bugs found and fixed in it, and a second
// copy would need the same history to be worth the same trust.
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { parseRandsToCents } = require("./lib/card-recon.cjs");

export const EFT_POOL_PATH = "eft_pool";

// The banks whose notifications are believed at all. One entry today; adding a
// bank is adding a line AND checking what its Authentication-Results look like.
export const EFT_ALLOWED_DOMAINS = ["fnb.co.za"];

// The card poller routes these to the PDF capture path; they must never appear
// in the payment pool even when a report arrives with its PDF missing.
export const BATCH_REPORT_SUBJECT = /banking report for batch/i;

// ─── ADDRESSES AND DOMAINS ───────────────────────────────────────────────────
/** The domain of an email address, lowercased — or null when there isn't one. */
export function domainOfAddress(address) {
  const m = /@([A-Za-z0-9.-]+)\s*$/.exec(String(address ?? "").trim());
  return m ? m[1].toLowerCase().replace(/\.$/, "") : null;
}

/**
 * DKIM relaxed alignment: the signing domain vouches for the From domain when
 * they are equal or one is a subdomain of the other ("frg.fnb.co.za" signs for
 * "fnb.co.za" and vice versa). Case-insensitive — the real mail writes
 * "@FNB.co.za" in From and "@fnb.co.za" in the signature.
 *
 * BIDIRECTIONAL, and that is safe HERE ONLY because the From domain has
 * already been pinned to the allowlist: the parent direction ("fnb.co.za"
 * vouching for "frg.fnb.co.za") cannot be reached by an attacker without
 * controlling fnb.co.za's DNS. It is NOT the allowlist test — see
 * domainAllowlisted, where the parent direction would be a hole.
 */
export function domainsAligned(a, b) {
  const x = String(a ?? "").toLowerCase(), y = String(b ?? "").toLowerCase();
  if (!x || !y) return false;
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

/**
 * Is this domain an allowlisted bank domain, or a SUBDOMAIN of one?
 * ONE DIRECTION ONLY, deliberately: "secure.fnb.co.za" qualifies, "co.za"
 * must not — a bidirectional test would have made every .co.za sender a
 * candidate whose own DKIM-signed subdomain then aligned with itself, which
 * is the exact hole an allowlist exists to close.
 */
export function domainAllowlisted(domain) {
  const d = String(domain ?? "").toLowerCase();
  return !!d && EFT_ALLOWED_DOMAINS.some((a) => d === a || d.endsWith(`.${a}`));
}

// ─── THE AUTHENTICATION VERDICT ──────────────────────────────────────────────
/** A folded RFC 5322 header rejoined into one line. */
export function unfoldHeader(line) {
  return String(line ?? "").replace(/\r?\n[ \t]+/g, " ").trim();
}

/**
 * The verdict on one message, from what Gmail verified on delivery.
 *
 * `headerLines` is mailparser's array — {key, line} in ORIGINAL ORDER, top of
 * the message first. The TOPMOST Authentication-Results header whose
 * authserv-id is mx.google.com is Gmail's own stamp: Gmail prepends its headers
 * above everything that arrived, so a forged Authentication-Results the sender
 * wrote into their own message sits BELOW the genuine one and is never the
 * first. An absent stamp is a fail, not a shrug — a message this cannot
 * authenticate is a message this does not believe.
 *
 * @returns {{pass:boolean, fromDomain:string|null, dkimDomain:string|null, detail:string}}
 */
export function authenticationVerdict({ headerLines, fromAddress }) {
  const fromDomain = domainOfAddress(fromAddress);
  if (!fromDomain) {
    return { pass: false, fromDomain: null, dkimDomain: null, detail: "the From header carries no usable address" };
  }
  if (!domainAllowlisted(fromDomain)) {
    return { pass: false, fromDomain, dkimDomain: null, detail: `${fromDomain} is not an allowlisted bank domain` };
  }

  const lines = Array.isArray(headerLines) ? headerLines : [];
  const first = lines.find((h) => String(h?.key ?? "").toLowerCase() === "authentication-results");
  if (!first) {
    return { pass: false, fromDomain, dkimDomain: null, detail: "no Authentication-Results header — Gmail recorded no verification for this message" };
  }
  const unfolded = unfoldHeader(first.line);
  const value = unfolded.replace(/^authentication-results\s*:\s*/i, "");
  // The authserv-id names WHO did the verifying. Anything but Gmail's own
  // resolver is a header somebody else wrote, and believing it would hand the
  // whole check to the sender.
  if (!/^mx\.google\.com\s*;/i.test(value)) {
    return { pass: false, fromDomain, dkimDomain: null, detail: "the topmost Authentication-Results header is not Gmail's (authserv-id is not mx.google.com)" };
  }

  // dkim=pass header.i=@fnb.co.za header.s=frg header.b=… — one segment per
  // method, semicolon-separated. Several dkim results can coexist (a message
  // signed twice); ONE passing, aligned signature is what the check needs.
  //
  // QUOTED STRINGS AND COMMENTS ARE EMPTIED BEFORE THE SPLIT, and this is a
  // security boundary, not tidiness: Gmail's own header EMBEDS ATTACKER TEXT —
  // the envelope sender appears both quoted (smtp.mailfrom="…") and inside a
  // parenthesised comment, and an envelope localpart may legally contain ';'.
  // A naive split would let a sender whose mailfrom reads
  //   "x;dkim=pass header.i=@fnb.co.za;y"@evil.example
  // manufacture a passing segment out of Gmail's truthful transcription of
  // their own address. With quotes and comments emptied, every remaining
  // segment is structure Gmail wrote. (Independent adversarial review.)
  const cleaned = value.replace(/"[^"]*"/g, '""').replace(/\([^)]*\)/g, " ");
  const dkimSeen = [];
  for (const segment of cleaned.split(";")) {
    const m = /\bdkim\s*=\s*([a-z]+)/i.exec(segment);
    if (!m) continue;
    const result = m[1].toLowerCase();
    const dom = /\bheader\.i\s*=\s*@?([A-Za-z0-9.-]+)/.exec(segment)?.[1]
      || /\bheader\.d\s*=\s*([A-Za-z0-9.-]+)/.exec(segment)?.[1]
      || null;
    const domain = dom ? dom.toLowerCase() : null;
    dkimSeen.push({ result, domain });
    if (result === "pass" && domainsAligned(domain, fromDomain)) {
      return { pass: true, fromDomain, dkimDomain: domain, detail: `dkim=pass, signed by ${domain}, aligned with ${fromDomain}` };
    }
  }
  if (!dkimSeen.length) {
    return { pass: false, fromDomain, dkimDomain: null, detail: "Gmail's Authentication-Results records no DKIM result at all" };
  }
  const said = dkimSeen.map((d) => `dkim=${d.result}${d.domain ? ` (${d.domain})` : ""}`).join(", ");
  return { pass: false, fromDomain, dkimDomain: dkimSeen[0].domain, detail: `no aligned DKIM pass — Gmail recorded ${said}` };
}

// ─── WHICH MESSAGES THIS READER EXAMINES ─────────────────────────────────────
/**
 * A message is an EFT candidate when its From CLAIMS an allowlisted bank
 * domain and it is not a batch report (those belong to the card path). The
 * claim is attacker-controlled text — candidacy only decides that the
 * authentication check RUNS, never that it passes.
 *
 * ATTACHMENTS DO NOT DISQUALIFY. An earlier draft skipped any message carrying
 * a slip PDF — but a notification with a proof-of-payment PDF attached, or a
 * forwarded chain dragging an old slip along, would then have routed
 * exclusively down the slip pipeline and the payment itself would never have
 * been examined: a silently lost payment from a message that WAS read. The
 * poller runs both readers on such a message. (Independent architect review.)
 */
export function isEftCandidate({ fromAddress, subject }) {
  if (BATCH_REPORT_SUBJECT.test(String(subject ?? ""))) return false;
  // The SAME allowlist test the verdict applies (subdomain-of-allowlisted,
  // never parent-of) — candidacy and verdict disagreeing is how genuine
  // subdomain mail would have been filed as a forgery attempt.
  return domainAllowlisted(domainOfAddress(fromAddress));
}

// ─── HTML → TEXT ─────────────────────────────────────────────────────────────
// FNB's real mail carries NO text part at all — html only (verified against the
// live mailbox, 2026-08-30) — so the notification body has to be read out of
// the markup. This is a deliberately dumb flattener: block tags become line
// breaks, tags go, a handful of entities decode. Anything it mangles shows up
// verbatim in the stored rawText and refuses loudly rather than mis-parsing.
export function htmlToText(html) {
  let s = String(html ?? "");
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<\s*(?:br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table)\b[^>]*>/gi, "\n");
  s = s.replace(/<\s*\/t[dh]\b[^>]*>/gi, "  ");
  s = s.replace(/<[^>]+>/g, " ");
  // Numeric character references are routine in bank HTML (&#160; for a
  // space in "Amount:&#160;R500.00" would otherwise turn the first genuine
  // notification into a refusal). Decoded before the named entities; anything
  // outside the printable range becomes a space rather than a control char.
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, h) => {
    const c = parseInt(h, 16);
    return c >= 32 && c <= 0xffff ? String.fromCharCode(c) : " ";
  });
  s = s.replace(/&#(\d+);/g, (_, d) => {
    const c = Number(d);
    return c >= 32 && c <= 0xffff ? String.fromCharCode(c) : " ";
  });
  s = s.replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
  return s.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n");
}

// ─── THE BANK'S OWN TIMESTAMP ────────────────────────────────────────────────
// SA is UTC+2 with no daylight saving; the offset is a constant, same as the
// card slips. Only shapes the bank is known to print are accepted; anything
// else is null — the record still lands, carried by receivedAt, because a
// payment with an unreadable date is still a payment.
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

export function parseBankTimestamp(str) {
  const s = String(str ?? "").trim();
  if (!s) return null;
  let y, mo, d, h = 0, mi = 0, sec = 0;
  // 2026/08/30 14:41:56 · 2026-08-30 14:41
  let m = /^(\d{4})[/-](\d{2})[/-](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    if (m[4]) [h, mi, sec] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  } else {
    // 30 Aug 2026 · 30 August 2026 14:41
    m = /^(\d{1,2}) ([A-Za-z]{3,9}) (\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (!m) return null;
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    [d, mo, y] = [Number(m[1]), month, Number(m[3])];
    if (m[4]) [h, mi, sec] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  }
  if (d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return null;
  const utc = Date.UTC(y, mo, d, h, mi, sec) - SAST_OFFSET_MS;
  // Date.UTC rolls Feb 30 into March; round-trip to refuse the phantom.
  const check = new Date(utc + SAST_OFFSET_MS);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo || check.getUTCDate() !== d) return null;
  return utc;
}

// ─── ACCOUNT NUMBERS DO NOT GET STORED ───────────────────────────────────────
// The notification body can carry the paying account, and the raw text is kept
// with every record precisely so refusals are diagnosable — so anything that
// looks like an account number is struck out on the way in: any run of six or
// more digits keeps its last three and loses the rest. Over-striking is the
// right direction; the cost is a vaguer diagnostic, not a leaked account.
// (The EXTRACTED reference is deliberately not swept: it is the customer's own
// typed matching key — often a phone number — and destroying it would destroy
// the thing the pool exists to search on. It is a field the payer chose to
// write, not a field the bank printed about an account.)
export function redactAccountDigits(text) {
  if (typeof text !== "string" || !text) return text;
  return text.replace(/\d{6,}/g, (run) => `⋯${run.slice(-3)}`);
}

// ─── PARSING THE NOTIFICATION ────────────────────────────────────────────────
// NO REAL PAYMENT NOTIFICATION EXISTED IN THE MAILBOX WHEN THIS WAS BUILT (the
// mailbox is days old; searched all folders, 2026-08-30) — so this parser is
// labelled-field driven and biased hard toward refusal: the FIRST real
// notification that arrives either parses exactly or leaves a refusal carrying
// its full (account-struck) text, from which this file is corrected in one
// round. That failure mode is the designed one.
const AMOUNT_LABELS = /^(?:amount(?: paid)?|payment amount)\s*[:\-–]\s*(.+)$/i;
const REFERENCE_LABELS = /^(?:(?:payment |their |beneficiary |recipient |my )?reference(?: number)?)\s*[:\-–]\s*(.+)$/i;
// "From" is DELIBERATELY not a payer label: it is the single most common line
// in a forwarded or quoted body, and matching it makes the BANK the payer the
// moment anyone forwards a notification. (Independent adversarial review.)
const PAYER_LABELS = /^(?:paid by|payer|sender|received from)\s*[:\-–]\s*(.+)$/i;
const DATE_LABELS = /^(?:(?:payment |transaction |effective )?date(?: and time)?)\s*[:\-–]\s*(.+)$/i;
// A rand figure loose in prose, for the no-label fallback. Grouping correctness
// is parseRandsToCents' job; this only FINDS candidates.
const MONEY_TOKEN = /(?:ZAR|R)\s?\d[\d,\s]*(?:\.\d{1,2})?/gi;

function labelledValues(lines, re) {
  const out = [];
  for (const line of lines) {
    const m = re.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/**
 * Extract the payment from a notification's text. Exact or refused — never a
 * guess, because a wrong amount here eventually releases stock.
 *
 * @returns {{ok:true, amountCents:number, reference:string|null, payer:string|null, bankTs:number|null}
 *          |{ok:false, reason:string}}
 */
export function parseEftNotification(text) {
  const body = String(text ?? "").trim();
  if (!body) return { ok: false, reason: "The message has no readable text at all." };
  const lines = body.split("\n");

  // ── THE AMOUNT — the one field that must parse, exactly ────────────────────
  const labelled = labelledValues(lines, AMOUNT_LABELS);
  let amountCents = null;
  if (labelled.length) {
    const parsed = [...new Set(labelled.map((v) => parseRandsToCents(v)))];
    if (parsed.length !== 1 || parsed[0] === null) {
      return { ok: false, reason: labelled.length > 1 && parsed.length > 1
        ? `The message carries ${labelled.length} Amount fields that disagree.`
        : `The Amount field reads "${clip(labelled[0], 60)}", which does not parse exactly as a rand amount.` };
    }
    amountCents = parsed[0];
  } else {
    // NO LABELLED AMOUNT MEANS NO AMOUNT. An earlier draft accepted a lone
    // rand figure loose in the prose — but "the only R-figure in the text" and
    // "the payment" are not the same claim: a disclaimer or fee line carrying
    // the message's one R-token while the real amount prints unprefixed would
    // have been accepted WRONG, and a wrong amount here eventually releases
    // stock. Refused instead, with the count of loose figures in the reason so
    // the first real notification's refusal already says what the format is.
    // (Independent architect review, this PR.)
    const tokens = body.match(MONEY_TOKEN) || [];
    const parsed = [...new Set(tokens.map((t) => parseRandsToCents(t.trim())).filter((v) => v !== null))];
    return { ok: false, reason: parsed.length === 0
      ? "No Amount field and no rand figure anywhere in the message."
      : `No labelled Amount field. The text carries ${parsed.length} loose rand figure(s), and which one is the payment is a guess this refuses to make.` };
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, reason: "The amount is zero or negative — not an incoming payment." };
  }

  // ── REFERENCE / PAYER / BANK TIME — taken where present, refused only on
  //    contradiction. A payment without a reference is still a payment.
  const refs = [...new Set(labelledValues(lines, REFERENCE_LABELS).map((v) => v.trim()).filter(Boolean))];
  if (refs.length > 1) {
    return { ok: false, reason: `The message carries ${refs.length} Reference fields that disagree.` };
  }
  // Payer and date are optional, so a CONTRADICTION does not refuse the
  // payment — it refuses the FIELD: two disagreeing payers or dates store
  // null rather than a silently-picked first. A payment with an unknown payer
  // is still a payment; a confidently wrong payer poisons the matching that
  // is coming. (Independent adversarial review.)
  const payers = [...new Set(labelledValues(lines, PAYER_LABELS).map((v) => v.trim()).filter(Boolean))];
  const dates = [...new Set(labelledValues(lines, DATE_LABELS).map(parseBankTimestamp).filter((v) => v !== null))];

  return {
    ok: true,
    amountCents,
    reference: refs.length ? clip(refs[0], 140) : null,
    payer: payers.length === 1 ? clip(redactAccountDigits(payers[0]), 120) : null,
    bankTs: dates.length === 1 ? dates[0] : null,
  };
}

// ─── IDENTITY AND IDEMPOTENCY ────────────────────────────────────────────────
/**
 * The pool key for a message — ALSO the record's node name, which is what makes
 * "the same notification never creates two pool records" structural rather than
 * procedural: a replay computes the same key and lands on the same node, where
 * a create-only write finds the record already there.
 *
 * The AUTH VERDICT is part of the key, deliberately. Message-IDs are
 * attacker-controlled: a forgery carrying a guessed genuine Message-ID must not
 * occupy the key the genuine notification will need — with the verdict in the
 * basis, the forgery's failed-auth record and the real payment's record cannot
 * collide, while a true replay (same message, same verdict) still dedupes.
 */
export function eftMessageKey({ messageId, from, subject, date, size, uid, uidValidity, authPass }) {
  const basis = (clip(messageId, 400)
    || `no-id|${uidValidity || ""}|${uid ?? ""}|${clip(from, 200) || ""}|${clip(subject, 200) || ""}|${date || ""}|${size || 0}`)
    + `|auth:${authPass ? "pass" : "fail"}`;
  return createHash("sha256").update(basis).digest("hex").slice(0, 40);
}

/**
 * Create-only: the decision inside the RTDB transaction that writes the pool.
 * An existing record — whatever its status by then — is NEVER overwritten; a
 * later session's matched/used must not be reset to unmatched by a replay.
 */
export function poolWriteDecision(existing, record) {
  if (existing !== null && existing !== undefined) return { write: false, why: "a record for this message already exists" };
  return { write: true, value: record };
}

// ─── THE RECORD ──────────────────────────────────────────────────────────────
/**
 * One pool record, exactly as stored at /eft_pool/{eftKey}.
 *
 *   outcome   "recorded" | "refused-auth" | "refused-parse" — separable on
 *             purpose: a forgery attempt and a format change are different
 *             problems for different people.
 *   status    only on recorded payments, and always "unmatched" this session.
 *             The lifecycle it is designed for is unmatched → matched → used;
 *             no transition exists yet anywhere.
 *   rawText   what the parser saw, account runs struck out — the diagnostic
 *             that makes a refusal fixable without reconstructing the message.
 */
export function eftPoolRecord({ message, verdict, parsed, rawText, at }) {
  const base = {
    at,
    receivedAt: Number.isInteger(message.receivedAt) ? message.receivedAt : null,
    messageId: clip(message.messageId, 200),
    from: clip(message.from, 200),
    // The subject gets the same account-number sweep as the body — FNB
    // subject lines can carry one. (Independent adversarial review.)
    subject: clip(redactAccountDigits(message.subject), 200),
    auth: {
      verdict: verdict.pass ? "pass" : "fail",
      fromDomain: verdict.fromDomain || null,
      dkimDomain: verdict.dkimDomain || null,
      detail: clip(verdict.detail, 300),
    },
    rawText: clip(redactAccountDigits(rawText), 4000),
  };
  if (!verdict.pass) {
    return { ...base, outcome: "refused-auth", reason: `Failed authentication: ${verdict.detail}. Treat as a forgery attempt until shown otherwise.` };
  }
  if (!parsed.ok) {
    return { ...base, outcome: "refused-parse", reason: parsed.reason };
  }
  return {
    ...base,
    outcome: "recorded",
    status: "unmatched",
    amountCents: parsed.amountCents,
    reference: parsed.reference,
    payer: parsed.payer,
    bankTs: parsed.bankTs,
  };
}

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

// The banks whose notifications are believed at all. THE NOTIFICATION COMES
// FROM THE PAYER'S BANK, not the shop's — the R100 test payment of 2026-08-30
// proved it, arriving from standardbank.co.za — so this is the list of SA
// banks customers pay from, each verified by DKIM against its OWN domain.
// Being listed here only admits a message to the authentication check and the
// per-format readers (eftBanks.mjs); a listed bank with no reader yet is a
// clean refusal that stores the raw text, never a guess.
export const EFT_ALLOWED_DOMAINS = [
  "fnb.co.za",
  "standardbank.co.za",
  "absa.co.za",
  "nedbank.co.za",
  "capitecbank.co.za",
  "tymebank.co.za",
];

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
 * Empty every quoted string and parenthesised comment out of a header value,
 * RFC 5322-style: quotes honour backslash escapes, comments NEST, and either
 * one left unbalanced returns null — the caller refuses the verdict rather
 * than guessing where structure ends and attacker text begins. A bare ')'
 * outside any comment is unbalanced too.
 */
export function stripQuotesAndComments(value) {
  let out = "", inQuote = false, depth = 0, escaped = false;
  for (const ch of String(value ?? "")) {
    if (inQuote || depth > 0) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (inQuote) { if (ch === '"') inQuote = false; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      continue;
    }
    // A space stands in for the stripped content, so text on either side of a
    // quote or comment can never merge into one token. (Delta review.)
    if (ch === '"') { inQuote = true; out += " "; continue; }
    if (ch === "(") { depth = 1; out += " "; continue; }
    if (ch === ")") return null;
    out += ch;
  }
  return inQuote || depth > 0 ? null : out;
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
  // their own address. The scanner tracks quote state, backslash escapes and
  // comment NESTING, and an unbalanced quote or comment refuses the verdict
  // outright — a header this cannot parse cleanly is a header this does not
  // believe. (Independent adversarial review; scanner per CodeRabbit.)
  const cleaned = stripQuotesAndComments(value);
  if (cleaned === null) {
    return { pass: false, fromDomain, dkimDomain: null, detail: "Gmail's Authentication-Results carries unbalanced quoting or comments — refused rather than parsed loosely" };
  }
  // …AND DKIM IS ONLY READ FROM THE LEADING RUN OF dkim= SEGMENTS. The scan
  // stops at the first segment that is not a dkim result — an ALLOWLIST, not
  // a denylist of known other methods: a method name this file has never
  // heard of must stop the scan too, or a segment carrying attacker-reachable
  // text becomes a place to smuggle a passing pseudo-segment past a list that
  // did not know its name. In Gmail's format the dkim result(s) lead. The one
  // surface this does not cover is the dkim segment's own header.i/s/b values
  // — attacker-chosen, but RFC 8601 requires quoting there and the scanner
  // already ate quotes, so reaching it needs Gmail to print an unquoted ';'
  // inside a signature tag: theoretical, and named here rather than claimed
  // away. (Independent delta review, this PR.)
  //
  // Cost of the allowlist: a genuine dkim result that Gmail ever printed
  // AFTER another method would be refused (fail-closed, visible on the owner
  // panel as refused-auth) — the detail string below says exactly that, so
  // the day it happens the record itself names the fix.
  const segments = cleaned.split(";");
  const dkimSeen = [];
  for (const segment of segments.slice(1)) { // [0] is the authserv-id, checked above
    if (!/^\s*dkim\s*=/i.test(segment)) break;
    const m = /\bdkim\s*=\s*([a-z]+)/i.exec(segment);
    if (!m) break;
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
    // PRECISE, because this is the one failure the allowlist itself can
    // cause: a dkim result printed after another method exists but is not
    // read, and the record must say so rather than claim there was none.
    const laterDkim = segments.slice(1).some((s) => /\bdkim\s*=/i.test(s));
    return { pass: false, fromDomain, dkimDomain: null, detail: laterDkim
      ? "no DKIM result in the leading dkim segments of Gmail's Authentication-Results (one appears later, after another method — if FNB mail genuinely does this, the scan order in eftCore.mjs needs a look)"
      : "Gmail's Authentication-Results records no DKIM result at all" };
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
  } else if ((m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})h(\d{2})$/.exec(s))) {
    // 2026-08-30 23h48 — Standard Bank's printed shape (real notification,
    // 2026-08-30).
    [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])];
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
  // Grouped forms too ("6283 4519 234", "62-834-519") — six or more digits
  // however they are spaced or dashed. This eats grouped AMOUNTS as well,
  // which is the accepted cost: over-striking a diagnostic is fine,
  // under-striking an account is not. (Delta review.)
  //
  // EXCEPT A DATE. "2026-08-30 23h48" is digits joined by dashes and a space,
  // and striking it out of a refusal's raw text deletes the very field the
  // format is judged by. A run that STARTS as an ISO date is a date.
  // (Independent adversarial review, v2.)
  return text.replace(/\d(?:[ -]?\d){5,}/g, (run) =>
    /^\d{4}-\d{2}-\d{2}/.test(run) ? run : `⋯${run.replace(/\D/g, "").slice(-3)}`);
}

/**
 * The stored/rendered form of a destination account value. Today's banks print
 * it masked already ("XXXXXXXXXXXX6625") and this changes nothing — but a bank
 * that prints the FULL number must not put a complete account number into the
 * database and onto a screen. Digits beyond the last four become X.
 * (Independent adversarial review, v2.)
 */
export function maskAccountValue(value) {
  const s = String(value ?? "");
  if (!s) return null;
  return s.replace(/\d(?=(?:\D*\d){4})/g, "X");
}

// A cheap "is this even about a payment?" cue, used ONLY to decide whether an
// unrecognised bank message deserves a pool refusal or is ordinary bank mail
// (a statement, a marketing letter, a fraud alert). Refusals must stay
// meaningful — a feed of red rows about newsletters trains the owner to
// ignore red — but the gate errs open: any money token or payment-ish word
// records the refusal. (Independent adversarial review, v2.)
const PAYMENT_CUES = /payment|proof of|credited|credit received|deposit|transfer|eft|confirmation/i;
const MONEY_CUE = /(?:ZAR|R)\s?\d[\d,\s]*\.\d{2}\b/;
export function looksPaymentShaped(text) {
  const s = String(text ?? "");
  return PAYMENT_CUES.test(s) || MONEY_CUE.test(s);
}

// ─── THE DESTINATION-ACCOUNT ALLOWLIST ───────────────────────────────────────
// THE POOL ONLY ACCEPTS CREDITS INTO THE SHOP'S OWN ACCOUNTS. An authenticated
// notification is real money moving — but into WHOSE account? Without this
// check, any FNB customer could send their own genuine payment notification to
// the shop's mailbox and have an unrelated payment settle a sale.
//
// The allowed accounts live in the gitignored .env ON THE MINI as
// EFT_ALLOWED_ACCOUNTS (comma-separated; full numbers or last-four) — never in
// this public repo. The notification is printed by the PAYER'S bank and shows
// the destination MASKED ("XXXXXXXXXXXX6625" — real sample, 2026-08-30), so
// matching is on the LAST FOUR digits: an entry matches when its own last four
// equal the mask's visible tail.
//
// FAIL-CLOSED THREE WAYS: no allowlist configured refuses (naming the
// variable), a mask with fewer than four visible digits refuses, and an
// unmatched tail refuses — each as outcome "refused-account", distinct from
// auth and parse refusals, because the person reading the feed does different
// things about them.
export const EFT_ACCOUNTS_ENV_VAR = "EFT_ALLOWED_ACCOUNTS";

/** "62123456625, 4009" → ["6625","4009"] — the last four digits of each entry. */
export function parseAllowedAccountTails(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.replace(/\D/g, ""))
    .filter((digits) => digits.length >= 4)
    .map((digits) => digits.slice(-4));
}

/**
 * Is this masked destination one of ours?
 * `configured` says whether ${EFT_ACCOUNTS_ENV_VAR} carried ANY text — a set
 * variable whose every entry was too short to be an account must not produce
 * a refusal claiming the variable is unset. (CodeRabbit, this PR.)
 * @returns {{ok:true, tail:string} | {ok:false, reason:string}}
 */
export function accountVerdict({ accountMask, allowedTails, configured }) {
  const visible = String(accountMask ?? "").replace(/\D/g, "");
  if (visible.length < 4) {
    return { ok: false, reason: `The destination account prints as "${clip(accountMask, 40)}" — fewer than four visible digits, so it cannot be checked against the allowlist.` };
  }
  const tail = visible.slice(-4);
  if (!Array.isArray(allowedTails) || !allowedTails.length) {
    return { ok: false, reason: configured
      ? `${EFT_ACCOUNTS_ENV_VAR} is set but holds no usable account number — each comma-separated entry needs at least four digits. Every payment refuses here until it is fixed.`
      : `No account allowlist is configured — set ${EFT_ACCOUNTS_ENV_VAR} in the .env on the mini (comma-separated account numbers). Until then every payment refuses here, deliberately.` };
  }
  if (!allowedTails.includes(tail)) {
    return { ok: false, reason: `This payment credits an account ending ${tail}, which is not one of the shop's own accounts. If it should be, add it to ${EFT_ACCOUNTS_ENV_VAR} in the .env on the mini.` };
  }
  return { ok: true, tail };
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
 *   outcome   "recorded" | "refused-auth" | "refused-parse" | "refused-account"
 *             — separable on purpose: a forgery attempt, a format change and a
 *             payment into somebody else's account are different problems for
 *             different people.
 *   status    only on recorded payments, and always "unmatched" this session.
 *             The lifecycle it is designed for is unmatched → matched → used;
 *             no transition exists yet anywhere.
 *   rawText   what the reader saw, account runs struck out — the diagnostic
 *             that makes a refusal fixable without reconstructing the message.
 *   reader    which bank reader produced the fields (eftBanks.mjs), so a
 *             record can always be traced to the format it was read with.
 *
 * `account` is the destination-allowlist verdict (accountVerdict) — required
 * whenever `parsed.ok`; a parsed payment whose destination was not checked
 * must be impossible to store as recorded.
 */
export function eftPoolRecord({ message, verdict, parsed, account, reader, rawText, at }) {
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
    reader: reader || null,
  };
  if (!verdict.pass) {
    return { ...base, outcome: "refused-auth", reason: `Failed authentication: ${verdict.detail}. Treat as a forgery attempt until shown otherwise.` };
  }
  if (!parsed.ok) {
    // The reason can QUOTE the body ('The Amount line reads "…"'), so it
    // gets the account sweep too. (Delta review.)
    return { ...base, outcome: "refused-parse", reason: clip(redactAccountDigits(parsed.reason), 400) };
  }
  // The reader's destination fields travel on BOTH the account refusal and
  // the recorded payment — a refusal must show which account the money
  // actually went to, and a recorded payment must show it was checked.
  const destination = {
    // maskAccountValue: a bank that prints the FULL destination number must
    // not put it in the database — digits beyond the last four become X.
    accountMask: clip(maskAccountValue(parsed.accountMask), 40) || null,
    beneficiaryName: clip(parsed.beneficiaryName, 120) || null,
    destBankName: clip(parsed.destBankName, 60) || null,
  };
  if (!account || account.ok !== true) {
    return {
      ...base, outcome: "refused-account", destination,
      amountCents: parsed.amountCents,
      reason: clip(redactAccountDigits(account?.reason || "The destination account was never checked — refused rather than assumed."), 400),
    };
  }
  return {
    ...base,
    outcome: "recorded",
    status: "unmatched",
    amountCents: parsed.amountCents,
    reference: parsed.reference,
    payer: parsed.payer,
    bankTs: parsed.bankTs,
    bankRef: clip(parsed.bankRef, 60) || null,
    destination,
    accountTail: account.tail,
  };
}

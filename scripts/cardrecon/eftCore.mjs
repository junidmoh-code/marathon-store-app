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
import { clip } from "./intakeCore.mjs";

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
 */
export function domainsAligned(a, b) {
  const x = String(a ?? "").toLowerCase(), y = String(b ?? "").toLowerCase();
  if (!x || !y) return false;
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
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
  if (!EFT_ALLOWED_DOMAINS.includes(fromDomain)) {
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
  const dkimSeen = [];
  for (const segment of value.split(";")) {
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
 * domain, it is not a batch report (those belong to the card path), and it
 * carried no slip PDFs. The claim is attacker-controlled text — candidacy only
 * decides that the authentication check RUNS, never that it passes.
 */
export function isEftCandidate({ fromAddress, subject, slipCount }) {
  if (slipCount > 0) return false;
  if (BATCH_REPORT_SUBJECT.test(String(subject ?? ""))) return false;
  const domain = domainOfAddress(fromAddress);
  return !!domain && EFT_ALLOWED_DOMAINS.some((d) => domainsAligned(domain, d));
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

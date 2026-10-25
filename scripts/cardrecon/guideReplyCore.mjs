// ─── THE GUIDE REPLY TO A CUSTOMER WHO EMAILED THEIR OWN PROOF (PURE) ────────
// Junid, 25 Oct 2026: a customer who paid, then emailed the proof of payment
// from their OWN mailbox (Gmail, Yahoo, …) instead of letting their bank send
// it, is refused as "unknown-bank" — correctly, because a stranger's PDF proves
// nothing. The customer has done nothing wrong but send it the wrong way, so
// they get ONE short email telling them how to send it from the banking app.
//
// OBSERVE AND REPLY ONLY. Nothing here can change a decision: the poller asks
// for a reply only AFTER it has written the unknown-bank record (a fresh write,
// never a replay), and Junid's own REJECTED verdict email still goes as before.
//
// NARROW ON PURPOSE. Every other refusal — a forged or failed signature, a
// duplicate, not-immediate, unreadable, wrong account — gets NO reply, ever:
// those can be scammers, and a reply teaches a scammer which check stopped
// them. Even an unknown-bank record is replied to only when it looks like a
// real person's proof: a personal mailbox Gmail verified, no bulk or
// auto-reply markers, and a PDF or picture attached (its NAME and TYPE only —
// the attachment is never opened, as on the rest of the stranger path).
//
// THE REPLY SAYS NOTHING. Fixed text, the same for everyone: never that money
// arrived, never which check failed, never a bank, an amount or anything read
// from their mail. Its only status is "we couldn't confirm it automatically".
//
// ONE PER SENDER PER DAY (SAST), claimed in RTDB before sending, so the poller
// can never become a spam or bounce cannon; plus a per-tick ceiling.
//
// PURE: no SMTP, no clock, no database. The poller injects send/claim/release;
// tests hand in data (guideReplyCore.test.mjs).
import { createHash } from "node:crypto";
import { domainOfAddress, unfoldHeader, stripQuotesAndComments, sastDate } from "./eftCore.mjs";
import { clip } from "./intakeCore.mjs";
import { EFT_VERDICT_FROM_MAILBOX, EFT_VERDICT_TO } from "./verdictMailCore.mjs";
import { OWNER } from "./intakeRules.mjs";

// Sent AS, and replied TO, the card-recon mailbox — the address the reply
// itself tells the customer to send their proof to.
export const GUIDE_REPLY_FROM = EFT_VERDICT_FROM_MAILBOX;
export const GUIDE_REPLY_FROM_NAME = "Marathon Club";
export const GUIDE_REPLY_WHATSAPP = "0631353434";
export const GUIDE_REPLY_SUBJECT = "One quick step to confirm your payment — Marathon Club";
export const GUIDE_REPLY_TEXT = `Hi there,

Thanks for sending this through. We received your email, but to confirm your payment automatically it needs to come straight from your bank, not forwarded from your email.

It's quick to do from your banking app:
1. Open your banking app and go to your payment history.
2. Find the payment you made to Marathon Club.
3. Tap "Send proof of payment" (or "Share receipt") and send it to ${GUIDE_REPLY_FROM} from inside the app — don't download it and email it yourself.

That sends it directly from your bank, and it'll confirm on its own.

To never deal with this again: in your banking app, remove Marathon Club from your saved beneficiaries, then add us again — and when you add us, enter ${GUIDE_REPLY_FROM} in the "notify by email" field. After that, every payment you make to us automatically sends the proof to us, and you're sorted for good.

Any trouble, WhatsApp us on ${GUIDE_REPLY_WHATSAPP} and we'll help right away.

Thanks,
Marathon Club
`;

// /eft_guide_replies/{SAST day}/{sender hash} = {at, poolKey}. Written by the
// poller's admin identity only; the address itself is never stored.
export const GUIDE_REPLY_PATH = "eft_guide_replies";
export const GUIDE_REPLIES_PER_TICK = 5;
// And at most this many a day in all, counted at {day}/_count: anyone can open
// Gmail accounts, and this mailbox's send quota also carries Junid's verdict
// emails and the Unread notices. (Sonnet architect review.)
export const GUIDE_REPLIES_PER_DAY = 30;

// EFT_GUIDE_REPLY in the mini's .env: "on" (default) or "off" — the kill
// switch. Anything else is OFF with a warning: a typo must never START mail
// to customers. EFT_GUIDE_REPLY_NEVER: extra addresses (comma-separated) that
// are never replied to — staff who forward proofs from their own Gmail.
export const GUIDE_REPLY_ENV_VAR = "EFT_GUIDE_REPLY";
export const GUIDE_REPLY_NEVER_ENV_VAR = "EFT_GUIDE_REPLY_NEVER";

/** @returns {{on:boolean, warning:string|null}} */
export function parseGuideReplySwitch(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v || v === "on" || v === "true" || v === "1") return { on: true, warning: null };
  if (v === "off" || v === "false" || v === "0") return { on: false, warning: null };
  return { on: false, warning: `${GUIDE_REPLY_ENV_VAR} reads "${clip(String(raw), 20)}", which is not "on" or "off" — customer guide replies are OFF until it is fixed.` };
}

/** Lowercased addresses from a comma-separated list. */
export function parseNeverList(raw) {
  return String(raw ?? "").split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.includes("@"));
}

// The shop's own mailboxes: Junid forwarding a customer's proof from his own
// Gmail is not a confused customer.
const INTERNAL = [GUIDE_REPLY_FROM, EFT_VERDICT_TO, OWNER, "junidmoh@gmail.com"].map((s) => s.toLowerCase());

// Personal mailbox providers — EXACT domains, no subdomains. A business or a
// bank on its own domain is not "a customer's own email", and a bank we have
// not set up sends from noreply@its-domain: replying there is noise.
export const PERSONAL_MAIL_DOMAINS = [
  "gmail.com", "googlemail.com",
  "yahoo.com", "yahoo.co.za", "yahoo.co.uk", "ymail.com", "rocketmail.com",
  "outlook.com", "hotmail.com", "hotmail.co.za", "hotmail.co.uk", "live.com", "live.co.za", "msn.com",
  "icloud.com", "me.com", "mac.com", "aol.com",
  "proton.me", "protonmail.com", "gmx.com", "gmx.net", "zoho.com", "yandex.com", "mail.com",
  "mweb.co.za", "telkomsa.net", "vodamail.co.za", "webmail.co.za", "afrihost.co.za",
];

// Personal providers only, so only the addresses no person reads — a Gmail
// user called "info.jane" is still a customer. (Spec review.)
const ROLE_LOCAL = /^(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?)(?:[+._-]|$)/i;

// Mail no person typed: lists, bulk senders, auto-replies, bounces.
const AUTOMATED_HEADERS = ["list-id", "list-unsubscribe", "list-post", "feedback-id", "x-autoreply", "x-autorespond", "x-auto-response-suppress"];

function headerValues(headerLines, name) {
  return (Array.isArray(headerLines) ? headerLines : [])
    .filter((h) => String(h?.key ?? "").toLowerCase() === name)
    .map((h) => unfoldHeader(h.line).replace(/^[^:]*:\s*/, "").trim());
}

/** Why this looks automated, or null for mail a person sent. */
export function automatedMarker(headerLines) {
  for (const h of AUTOMATED_HEADERS) if (headerValues(headerLines, h).length) return `carries ${h}`;
  const auto = headerValues(headerLines, "auto-submitted").find((v) => !/^no\b/i.test(v));
  if (auto) return "is Auto-Submitted";
  if (headerValues(headerLines, "precedence").some((v) => /^(bulk|list|junk|auto_reply)\b/i.test(v))) return "is bulk (Precedence)";
  if (headerValues(headerLines, "return-path").some((v) => /^<\s*>$/.test(v))) return "is a bounce (empty Return-Path)";
  return null;
}

/**
 * Did Gmail verify this personal mailbox really sent it? The TOPMOST
 * Authentication-Results is Gmail's own stamp (see eftCore.authenticationVerdict).
 * A DKIM pass signed by exactly the From domain, a DMARC pass for it, or an
 * SPF pass whose envelope sender is the From ADDRESS itself (local ISPs such
 * as mweb or telkomsa may not DKIM-sign). DKIM and DMARC are domain-level:
 * they rest on the provider letting an account send only as itself, which
 * the big providers enforce. SPF is held to the whole address, because SPF
 * alone would let any customer of a shared ISP pose as another.
 * Without this, anyone could forge a victim's Gmail address and have the shop
 * email them — the backscatter the rate limit alone does not stop.
 */
export function senderVerified({ headerLines, fromDomain, fromAddress }) {
  const first = (Array.isArray(headerLines) ? headerLines : []).find((h) => String(h?.key ?? "").toLowerCase() === "authentication-results");
  if (!first || !fromDomain) return false;
  const value = unfoldHeader(first.line).replace(/^authentication-results\s*:\s*/i, "");
  if (!/^mx\.google\.com\s*;/i.test(value)) return false;
  const cleaned = stripQuotesAndComments(value);
  if (cleaned === null) return false;
  const dom = String(fromDomain).toLowerCase();
  return cleaned.split(";").slice(1).some((seg) => {
    if (/^\s*dkim\s*=\s*pass\b/i.test(seg)) {
      const d = (/\bheader\.i\s*=\s*[^\s@]*@([A-Za-z0-9.-]+)/i.exec(seg)?.[1] || /\bheader\.d\s*=\s*([A-Za-z0-9.-]+)/i.exec(seg)?.[1] || "").toLowerCase();
      return d === dom;
    }
    if (/^\s*dmarc\s*=\s*pass\b/i.test(seg)) {
      return (/\bheader\.from\s*=\s*([A-Za-z0-9.-]+)/i.exec(seg)?.[1] || "").toLowerCase() === dom;
    }
    if (/^\s*spf\s*=\s*pass\b/i.test(seg)) {
      const mailfrom = (/\bsmtp\.mailfrom\s*=\s*([^\s;]+@[A-Za-z0-9.-]+)/i.exec(seg)?.[1] || "").toLowerCase();
      return !!fromAddress && mailfrom === String(fromAddress).trim().toLowerCase();
    }
    return false;
  });
}

const PROOF_NAME = /\.(pdf|png|jpe?g|heic|webp)$/i;
const MIN_INLINE_PICTURE_BYTES = 20 * 1024;   // smaller inline pictures are signatures and logos

/** Is something attached that could be a proof of payment? Name, type and size only — nothing is opened. */
export function hasProofAttachment(attachments) {
  return (Array.isArray(attachments) ? attachments : []).some((a) => {
    const type = String(a?.contentType ?? "").toLowerCase();
    const name = String(a?.filename ?? "");
    const size = Number(a?.size) || 0;
    if (size <= 0) return false;
    if (type === "application/pdf" || /\.pdf$/i.test(name)) return true;
    if (!type.startsWith("image/") && !PROOF_NAME.test(name)) return false;
    const inline = a?.related === true || String(a?.contentDisposition ?? "").toLowerCase() === "inline";
    return !inline || size >= MIN_INLINE_PICTURE_BYTES;
  });
}

/**
 * Should this refusal get the guide reply? Only a FRESH unknown-bank record
 * from a verified personal mailbox, sent by a person, with a proof attached.
 * @returns {{ok:true, to:string} | {ok:false, why:string}}
 */
export function guideReplyEligibility({ record, fromAddress, headerLines, attachments, never = [] }) {
  if (record?.outcome !== "unknown-bank") return { ok: false, why: "not an unknown-sender refusal" };
  const to = String(fromAddress ?? "").trim().toLowerCase();
  if (!/^[^\s@<>"(),;:]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(to)) return { ok: false, why: "no clean sender address" };
  const domain = domainOfAddress(to);
  if (!PERSONAL_MAIL_DOMAINS.includes(domain)) return { ok: false, why: `${domain} is not a personal mailbox` };
  if (INTERNAL.includes(to) || never.includes(to)) return { ok: false, why: "the shop's own address" };
  if (ROLE_LOCAL.test(to.split("@")[0])) return { ok: false, why: "a role or no-reply address" };
  const automated = automatedMarker(headerLines);
  if (automated) return { ok: false, why: `automated mail (${automated})` };
  if (!senderVerified({ headerLines, fromDomain: domain, fromAddress: to })) return { ok: false, why: "Gmail did not verify the sender" };
  if (!hasProofAttachment(attachments)) return { ok: false, why: "no PDF or picture attached" };
  return { ok: true, to };
}

/** The sender's key under one day: a hash, so no address is stored. */
export function senderKey(address) {
  return createHash("sha256").update(String(address ?? "").trim().toLowerCase()).digest("hex").slice(0, 40);
}

/** Where today's claim for this sender lives. */
export function guideClaimPath(address, nowMs) {
  return `${GUIDE_REPLY_PATH}/${sastDate(nowMs)}/${senderKey(address)}`;
}

/** Where today's reply count lives (a key no sha256 hex can be). */
export function guideCountPath(nowMs) {
  return `${GUIDE_REPLY_PATH}/${sastDate(nowMs)}/_count`;
}

/** RTDB transaction step: claim only an empty slot; anything there aborts. */
export function guideClaimStep(value) {
  return (current) => (current === null ? value : undefined);
}

/** RTDB transaction step: one more for today, or abort at the daily ceiling. */
export function guideCountStep(cap = GUIDE_REPLIES_PER_DAY) {
  return (current) => {
    const n = Number.isInteger(current) ? current : 0;
    return n < cap ? n + 1 : undefined;
  };
}

/**
 * Did the SMTP server definitely REFUSE it (a numbered reply), so nothing was
 * delivered? A timeout or a dropped socket may come after Gmail accepted the
 * message, so it keeps the claim: at worst no second reply today, never two.
 */
export function definitelyNotSent(err) {
  return Number.isInteger(err?.responseCode) && err.responseCode >= 400;
}

/** The one email. Fixed text; only the address and the thread header vary. */
export function guideReplyMail({ to, inReplyTo }) {
  const ref = /^<[^<>\s]{1,250}>$/.test(String(inReplyTo ?? "")) ? inReplyTo : null;
  return {
    from: { name: GUIDE_REPLY_FROM_NAME, address: GUIDE_REPLY_FROM },
    replyTo: GUIDE_REPLY_FROM,
    to,
    subject: GUIDE_REPLY_SUBJECT,
    text: GUIDE_REPLY_TEXT,
    ...(ref ? { inReplyTo: ref, references: ref } : {}),
    // RFC 3834: an automatic reply — a well-behaved autoresponder will not answer it.
    headers: { "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All" },
  };
}

/**
 * Send one tick's queued guide replies. Each sender is CLAIMED for the day
 * before it is sent (a claim already taken means they were answered today),
 * then counted against the daily ceiling. A send the server refused releases
 * the sender's claim; any failed send ends the round. NEVER throws.
 *
 * What is skipped here is not retried: the unknown-bank record already exists,
 * so a later tick never queues that message again. Junid's REJECTED email
 * for it has gone regardless. A send the server refused still used one of the
 * day's count — at most one a tick, since a failed send ends the round.
 * @param {{queue:{to:string, inReplyTo?:string, poolKey:string}[], send:Function,
 *   claim:(item)=>Promise<string|null>, countToday:()=>Promise<boolean>, release:(claimPath:string)=>Promise<any>, cap?:number}} p
 */
export async function drainGuideReplies({ queue, send, claim, countToday, release, cap = GUIDE_REPLIES_PER_TICK }) {
  const out = { sent: 0, limited: 0, capped: 0, dayCapped: 0, unsent: 0, error: null };
  const items = Array.isArray(queue) ? queue : [];
  const why = (err) => clip(String(err?.response || err?.message || err), 200);
  for (let i = 0; i < items.length; i++) {
    if (out.sent >= cap) { out.capped = items.length - i; break; }
    // A claim that cannot be made is no reply: fail closed, never twice.
    let claimPath = null;
    try { claimPath = await claim(items[i]); } catch (err) { out.error = why(err); out.unsent += 1; continue; }
    if (!claimPath) { out.limited += 1; continue; }
    let counted = false;
    try { counted = await countToday(); } catch (err) {
      // No count, no send — and the sender's slot is given back, since
      // nothing went to them.
      out.error = why(err);
      out.unsent += 1;
      try { await release(claimPath); } catch { /* at worst no reply today */ }
      continue;
    }
    if (!counted) {
      try { await release(claimPath); } catch { /* at worst no reply today */ }
      out.dayCapped = items.length - i;
      break;
    }
    try {
      await send(guideReplyMail(items[i]));
      out.sent += 1;
    } catch (err) {
      out.error = why(err);
      if (definitelyNotSent(err)) {
        try { await release(claimPath); } catch { /* the slot stays taken: at worst no reply today */ }
      }
      out.unsent += items.length - i;
      break;
    }
  }
  return out;
}

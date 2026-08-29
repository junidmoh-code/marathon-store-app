// ─── CARD RECON EMAIL INTAKE — EVERY DECISION, WITHOUT A MAILBOX (PURE) ──────
// The poller (email-poller.mjs) is IMAP, firebase-admin and one HTTPS call.
// This file is everything it DECIDES, kept away from all three so the awkward
// cases can be tested as data: a message with no attachments, an invoice that
// happens to be a PDF, a 30 MB scan, an attachment whose bytes are not a PDF at
// all, a message that arrives twice, a claim left behind by a killed run.
//
// THE RULE THE WHOLE THING IS BUILT ON: NOTHING IS EVER SILENTLY DROPPED.
// A terminal that quietly stops reconciling is the exact failure this feature
// exists to make impossible, so every message that carried a PDF leaves a
// record with an outcome and a reason — including the ones that were refused,
// and including the ones that turned out to be somebody's invoice. The Card
// recon tab reads that feed.
//
// Three outcomes, and the difference between them is what a person should DO:
//
//   recorded    the batch is in /card_batches. Nothing to do.
//   refused     a batch report that did not pass a check — an unmapped
//               terminal, a duplicate batch, lines that do not sum. SOMEONE
//               MUST LOOK. This is the one that must never be invisible.
//   unrelated   a PDF that was never a batch report (an invoice, a statement).
//               Recorded so the feed is complete, marked so it is not noise.
//
// PURE by the house rule the functions/lib modules follow: no IMAP, no
// firebase-admin, no fetch, no clock. Tested in intakeCore.test.mjs.
import { createHash } from "node:crypto";

// The callable's own ceiling is 10 MB, but a base64 body is a third larger
// again and the request limit sits at 10 MB — so an attachment above this is
// refused HERE, with a sentence in the feed, rather than failing as a transport
// error nobody can read. A batch report is tens of kilobytes.
export const MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024;

// One message may legitimately carry two slips (a manager forwarding a day's
// reports). More than this is not that, and a message is never worth an
// unbounded number of capture calls.
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

// A claim written by a run that then died — SIGKILL, a power cut — must not
// hold a slip out of the feed for ever. After this, the next tick takes it
// again. The downstream duplicate-batch refusal is what makes a retry safe:
// a slip already recorded refuses itself rather than doubling.
export const STALE_CLAIM_MS = 30 * 60 * 1000;

/** Bounded, trimmed text for a record a person will read. */
export function clip(value, max = 200) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * The dedupe key for a message.
 *
 * RFC 5322 Message-IDs contain "." and "@", which RTDB will not take in a key,
 * so the key is a hash — and a hash is the right shape anyway: fixed length,
 * no collision with a path separator, nothing leaked into a node name.
 *
 * A message with NO Message-ID (they exist) falls back to a hash of what does
 * identify it. That is weaker, and it is deliberately not "just process it":
 * an id we made up from stable parts still stops the same message being
 * submitted twice, which is the point.
 */
export function messageKey({ messageId, from, subject, date, size }) {
  const basis = clip(messageId, 400)
    || `no-id|${clip(from, 200) || ""}|${clip(subject, 200) || ""}|${date || ""}|${size || 0}`;
  return createHash("sha256").update(basis).digest("hex").slice(0, 40);
}

/**
 * Is this attachment something worth handing to the capture path?
 *
 * The BYTES decide, not the name and not the declared type: a mail client that
 * labels a PDF `application/octet-stream` is routine, and so is a JPEG called
 * "slip.pdf". "%PDF-" is the header every PDF carries.
 *
 * @returns {{ok:true}|{ok:false, why:string, kind:"skip"|"refuse"}}
 *   "skip" — this was never meant to be a batch report (an image signature, a
 *            calendar invite). Not a problem, and not worth a refusal row.
 *   "refuse" — it claimed to be a PDF and could not be used. Someone should see it.
 */
export function classifyAttachment(att) {
  const name = clip(att?.filename, 120) || "(unnamed)";
  const type = String(att?.contentType || "").toLowerCase();
  const bytes = att?.content;
  const size = bytes?.length ?? 0;
  const looksNamed = /\.pdf$/i.test(name) || type.includes("pdf");
  const isPdf = size >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-";

  if (!isPdf) {
    return looksNamed
      ? { ok: false, kind: "refuse", why: `${name} is named as a PDF but its contents are not one — the attachment did not arrive intact.` }
      : { ok: false, kind: "skip", why: `${name} is not a PDF` };
  }
  if (!size) return { ok: false, kind: "refuse", why: `${name} arrived empty.` };
  if (size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, kind: "refuse", why: `${name} is ${(size / 1048576).toFixed(1)}MB — too large for a batch report. Check it is the right file.` };
  }
  return { ok: true };
}

/**
 * Which attachments this message contributes, and what to say about the rest.
 * Never throws on a malformed attachment list — a message is data from outside.
 */
export function planMessage(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  const take = [], refused = [], skipped = [];
  for (const att of list) {
    if (take.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      refused.push({ filename: clip(att?.filename, 120) || "(unnamed)", reason: `More than ${MAX_ATTACHMENTS_PER_MESSAGE} attachments on one message — this one was not read.` });
      continue;
    }
    let verdict;
    try { verdict = classifyAttachment(att); }
    catch { verdict = { ok: false, kind: "refuse", why: "That attachment could not be read at all." }; }
    if (verdict.ok) take.push(att);
    else if (verdict.kind === "refuse") refused.push({ filename: clip(att?.filename, 120) || "(unnamed)", reason: verdict.why });
    else skipped.push({ filename: clip(att?.filename, 120) || "(unnamed)", reason: verdict.why });
  }
  return { take, refused, skipped };
}

// A refusal whose reason says the file never was a batch report. These are the
// invoices and statements that land in a shop mailbox: recorded (so the feed is
// complete and nothing is dropped) but NOT counted as a terminal failing to
// reconcile, which is what the refused count means.
const NOT_A_SLIP = [
  /does not print .* anywhere this could find it/i,
  /holds no text/i,
  /has no readable text/i,
  /could not be opened as a PDF/i,
  /is not a PDF/i,
  /password-protected/i,
  /more text than a batch report/i,
  /pages — a batch report is one or two/i,
];

/** "refused" (someone must look) or "unrelated" (it was never a slip). */
export function classifyRefusal(reason) {
  const text = String(reason || "");
  return NOT_A_SLIP.some((re) => re.test(text)) ? "unrelated" : "refused";
}

/**
 * One attachment's outcome, as it is stored and as the tab renders it.
 * `capture` is the callable's answer: {ok:true, batchKey…} or {ok:false, reason}.
 */
export function attachmentOutcome({ filename, capture, error }) {
  const name = clip(filename, 120) || "(unnamed)";
  if (error) return { filename: name, outcome: "refused", reason: clip(error, 400) };
  if (capture?.recorded) {
    return {
      filename: name, outcome: "recorded",
      tid: clip(capture.tid, 20) || null,
      batchKey: clip(capture.batchKey, 20) || null,
      storeId: clip(capture.storeId, 30) || null,
      tillId: clip(capture.tillId, 30) || null,
      linesCaptured: capture.linesCaptured === true,
      warnings: (capture.warnings || []).map((w) => clip(w, 300)).filter(Boolean).slice(0, 6),
      reason: null,
    };
  }
  return {
    filename: name,
    outcome: classifyRefusal(capture?.reason),
    reason: clip(capture?.reason, 400) || "Refused with no reason given.",
    tid: clip(capture?.tid, 20) || null,
  };
}

/**
 * The record written to /card_batch_intake/{pushId}.
 *
 * NO SLIP CONTENT. No transaction lines, no masked PANs, no expected figure and
 * no variance — this node is read by everyone who can capture a slip, and what
 * it exists to answer is "did every terminal's report get in, and if not why
 * not". The evidence itself stays in /card_batches, which is owner-only.
 */
export function intakeRecord({ message, results, skipped, at }) {
  const rows = results.map((r) => ({ ...r }));
  const refused = rows.filter((r) => r.outcome === "refused").length;
  const recorded = rows.filter((r) => r.outcome === "recorded").length;
  const unrelated = rows.filter((r) => r.outcome === "unrelated").length;
  return {
    at,
    messageKey: message.key,
    messageId: clip(message.messageId, 200),
    from: clip(message.from, 200),
    subject: clip(message.subject, 200),
    receivedAt: Number.isInteger(message.receivedAt) ? message.receivedAt : null,
    attachments: rows.length ? rows : null,
    // The counts are what the tab sorts and colours on, so they are stored
    // rather than derived by every reader.
    recorded, refused, unrelated,
    // Attachments that were never candidates (an inline logo, a signature
    // image). Kept as a count and a name list, not as rows.
    skipped: skipped.length ? skipped.map((s) => clip(s.filename, 120)).filter(Boolean).slice(0, 10) : null,
    state: refused > 0 ? "needs-attention" : "done",
  };
}

/**
 * Should this tick process a message the claim node already knows about?
 * `claim` is whatever is at /card_batch_intake_seen/{key}, or null.
 */
export function claimDecision(claim, nowMs) {
  if (!claim) return { take: true, why: "new" };
  // `done` is not merely "do not take it" — it is what tells the caller the
  // message may be marked read. A message held by a run that DIED must stay
  // unread, or the tick that would retake its stale claim in half an hour
  // never sees it again. Two different reasons for the same `take: false`,
  // and the difference is a slip.
  if (claim.state === "done") return { take: false, done: true, why: "already processed" };
  const age = Number.isInteger(claim.at) ? nowMs - claim.at : Infinity;
  if (age > STALE_CLAIM_MS) return { take: true, why: "a previous run claimed this and never finished" };
  return { take: false, done: false, why: "another run is holding it" };
}

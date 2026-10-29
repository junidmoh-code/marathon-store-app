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
import { createRequire } from "node:module";

// ─── .env, PARSED ONCE, IN ONE PLACE ─────────────────────────────────────────
// Deliberately not a dependency: it is a dozen lines, and a package that reads
// secrets is a package somebody must keep patched forever.
//
// IT LIVES HERE, EXPORTED, BECAUSE TWO PROGRAMS NEED THE SAME ANSWER. The
// poller reads the values; the installer must refuse to arm a schedule over a
// file the poller cannot read. That was written twice — once in JavaScript and
// once in bash — and the two copies drifted FOUR times in one review cycle:
// stripping before trimming, stripping each quote character independently, a
// lone quote read as a credential, and CRLF handling that differed on a stray
// carriage return. Every one of them had the same shape: the installer says
// fine and the failure appears in a log five minutes later.
//
// So there is no bash copy any more. The installer runs THIS, through node,
// and asks which keys are missing — names only, never values.
//
// Line endings: split on /\r?\n/, because a .env saved on Windows ends every
// line with \r, and in JavaScript `.` does not match \r and an unanchored `$`
// is the true end of the string — so `KEY="x"\r` matched NOTHING and every
// value silently vanished from a file that looks perfectly correct in an editor.
export function parseEnvText(text) {
  const env = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    // ONE MATCHED PAIR. A lone quote is an empty value, not a value of `"`.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[m[1]] = value;
  }
  return env;
}

/**
 * Which of these keys carry a usable value, and which do not — by NAME.
 * The installer's whole check, and it never sees a value.
 */
export function missingEnvKeys(env, keys) {
  return keys.filter((k) => !String(env?.[k] ?? "").trim());
}

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

// ─── NO MONEY IN THE FEED. NOT EVEN INSIDE A SENTENCE. ───────────────────────
// The intake feed is readable by everyone who holds `card_recon`, where
// /card_batches is owner-only — and the reason for that difference is that the
// feed carries outcomes, not figures. It very nearly did not.
//
// The refusal reasons and warnings this record stores are written for the
// person holding the slip, so they QUOTE THE FIGURES: "The transaction lines in
// that PDF add up to R10.00, but the slip's own total is R20.00", "purchases +
// cash − refunds ≠ total", "N transactions (R…) have no card sale that answers
// them. This is the variance." Stored verbatim, they would have put the batch
// total, the purchase/cash/refund breakdown and the variance itself in front of
// every manager — the exact material this feature is capture-only to withhold,
// and the exact claim the rule's own justification makes about this node.
//
// So every amount is struck out on the way in. The SENTENCE survives, because
// what a manager needs is "this batch did not reconcile and Junid must look",
// and that reads perfectly well without the number. The full text is still in
// the poller's log on the Mac mini, and the figures are still on the record in
// /card_batches, which is owner-only.
//
// COUNTS ARE NOT MONEY and are left alone: "the slip says 12 transactions but
// 11 lines were read" is what makes a refusal actionable, and a transaction
// count is not what /card_batches is protected for (masked PANs, auth codes,
// RRNs, and the variance).
//
// It strikes out more than it strictly must — a grouped or two-decimal number
// anywhere goes, whether or not it carries an R. That is the right direction
// for a redaction: the cost of over-striking is a slightly vaguer sentence,
// and the cost of under-striking is a figure in front of someone who should
// not have it. (Independent review, PR #519.)
const MONEY_PATTERNS = [
  // R50,355.00 · -R48.00 · R 1.00 · ZAR 900.00 — the formatted forms.
  // The leading minus and any space before it are LEFT ALONE: consuming them
  // ran the redaction into the previous word ("add up toR⋯"), and a sentence
  // this is meant to keep readable should stay readable.
  /(?:ZAR|R)\s?-?\d[\d,\s]*(?:\.\d{1,2})?/gi,
  // 50,355.00 · 50 355.00 — grouped, no currency mark (a slip's own printing)
  /\b\d{1,3}(?:[,\s]\d{3})+(?:\.\d{1,2})?\b/g,
  // 307.00 — a bare two-decimal amount
  /\b\d+\.\d{2}\b/g,
];
export const MONEY_REDACTED = "R⋯";

export function redactMoney(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const re of MONEY_PATTERNS) out = out.replace(re, MONEY_REDACTED);
  return out;
}

/** Bounded, trimmed text for a record a person will read. */
// clip moved to functions/lib/eft-text.cjs on 29 Oct 2026 (the per-bank EFT
// readers now run in Cloud Functions too); re-exported here unchanged.
const requireFromFunctions = createRequire(new URL("../../functions/package.json", import.meta.url));
const { clip } = requireFromFunctions("./lib/eft-text.cjs");
export { clip };

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
 *
 * THE FALLBACK INCLUDES THE MAILBOX'S OWN UID, and it has to. Sender, subject,
 * date and size are exactly the fields two DIFFERENT slips from the same
 * terminal on the same evening would share — and a collision there does not
 * look like a bug: the second message reads as "already processed" and is
 * marked read, and a real batch report is gone with nothing recorded about it.
 * A uid is unique within a mailbox, which is the guarantee the other fields
 * cannot give. (CodeRabbit, PR #510.)
 *
 * uidValidity travels with it because a uid only means anything inside one
 * incarnation of a mailbox; if a mailbox is ever recreated, keys change and
 * previously-seen mail is re-read — which the downstream duplicate-batch
 * refusal handles, and which is the right way round: re-reading is recoverable,
 * a lost slip is not.
 */
export function messageKey({ messageId, from, subject, date, size, uid, uidValidity }) {
  const basis = clip(messageId, 400)
    || `no-id|${uidValidity || ""}|${uid ?? ""}|${clip(from, 200) || ""}|${clip(subject, 200) || ""}|${date || ""}|${size || 0}`;
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
  /pages — more than any batch report/i,
  // FNB documents that share the slip's file name but are not batches — see
  // notABatchReport in functions/lib/card-recon-pdf.cjs.
  /is a Transaction History report/i,
  /"Banking Done" notice/i,
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
  // REDACT FIRST, THEN CLIP. Clipping first can cut a sentence mid-amount and
  // leave "…adds up to R50,3" behind, which is both a figure and a lie.
  const text = (v, max) => clip(redactMoney(v), max);
  if (error) return { filename: name, outcome: "refused", reason: text(error, 400) };
  if (capture?.recorded) {
    return {
      filename: name, outcome: "recorded",
      tid: clip(capture.tid, 20) || null,
      batchKey: clip(capture.batchKey, 20) || null,
      storeId: clip(capture.storeId, 30) || null,
      tillId: clip(capture.tillId, 30) || null,
      // The terminal's name AT CAPTURE. Not looked up when the feed renders:
      // the registry row moves (renames, till moves), and a row that resolved
      // the name later would relabel history. Absent on rows written before
      // 2026-09-18, which the reader falls back from to the TID — itself
      // immutable, which is why it is the fallback.
      terminalLabel: clip(capture.terminalLabel, 60) || null,
      // When the batch closed (a time, not a figure) and where the machine
      // stood for it. Absent on rows written before 25 Oct 2026.
      closedAt: Number.isFinite(capture.closedAt) ? capture.closedAt : null,
      placeStoreId: clip(capture.placeStoreId, 30) || null,
      placeTillId: clip(capture.placeTillId, 30) || null,
      placeLabel: clip(capture.placeLabel, 60) || null,
      linesCaptured: capture.linesCaptured === true,
      warnings: (capture.warnings || []).map((w) => text(w, 300)).filter(Boolean).slice(0, 6),
      reason: null,
    };
  }
  return {
    filename: name,
    outcome: classifyRefusal(capture?.reason),
    reason: text(capture?.reason, 400) || "Refused with no reason given.",
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
export function intakeRecord({ message, results, skipped, at, parserVersion = null }) {
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
    // Which parser judged it — see retryCandidates. null = no answer at all.
    parserVersion: Number.isInteger(parserVersion) ? parserVersion : null,
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

// ─── EVERY REFUSAL CARRIES ITS OWN EVIDENCE ──────────────────────────────────
// Until 15 Oct 2026 a refused row stored a redacted sentence and nothing else,
// so every refusal cost a dig through the mailbox to see what the file said —
// and the refusals were each a NEW layout, so that dig was the whole diagnosis
// every time (CARD-RECON-REFUSALS.md). Now the poller keeps, per refused
// attachment, the original PDF in Storage and the lines it extracted.
//
// NOT ON THE INTAKE ROW. That node is read by every `card_recon` holder — the
// managers — and is cleared for outcomes only (see the money redaction above).
// The lines carry amounts, auth codes and RRNs. So they go to a sibling node
// that is OWNER-ONLY, keyed by the same push id, and the PDF to an owner-only
// Storage path. The row itself gains only the path string, which is useless
// without the owner's read.
//
// CARD NUMBERS: FNB prints them masked (first six, last four). Kept to the LAST
// FOUR here — enough to tell two cards apart while reading a refusal, and
// nothing a BIN lookup can use. Any long digit run that passes the Luhn check
// is withheld outright, in case some layout ever prints a number unmasked; a
// merchant id line is exempt (MIDs are 15 digits and can pass Luhn by chance,
// and the MID is exactly what a routing refusal needs to show).
export const EVIDENCE_PATH = "card_batch_intake_evidence";
export const REFUSED_PDF_PREFIX = "card_recon_refused";
export const EVIDENCE_MAX_LINES = 600;
export const EVIDENCE_MAX_LINE_CHARS = 160;
export const EVIDENCE_MAX_ATTACHMENTS = 5;

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** One extracted line, safe to keep: masked PANs cut to last four, no unmasked card number. */
export function maskEvidenceLine(line) {
  let s = String(line ?? "");
  // One token, as FNB prints it: 518103******4436 → ******4436
  s = s.replace(/\b\d{2,8}[*xX·•#]{2,}(\d{2,4})\b/g, (_, tail) => `******${tail}`);
  // Grouped, any mix of digits and mask per group: 4111 11** **** 1111,
  // 4111 1111 **** 1111 → ******1111
  s = s.replace(/(?<![\d*xX·•#])(?:[\d*xX·•#]{4} ){3}(\d{4})(?!\d)/g, (m, last4) => (/[*xX·•#]/.test(m) ? `******${last4}` : m));
  // ONLY the merchant id itself is exempt — the first number after a
  // "Merchant" label — never the rest of that line, which still gets the
  // card-number check like any other. (CodeRabbit, PR #726.)
  const mid = /^\s*merchant\b[^0-9]*((?:\d[ -]?){12,18}\d)(?!\d)/i.exec(s);
  const midDigits = mid ? mid[1].replace(/\D/g, "") : null;
  let midKept = false;
  // Bounded by "not a digit" rather than a word boundary, so a number run
  // into a label ("PAN4111…") is still seen.
  s = s.replace(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, (m) => {
    const digits = m.replace(/\D/g, "");
    if (!midKept && midDigits !== null && digits === midDigits) { midKept = true; return m; }
    return luhn(digits) ? "[card number withheld]" : m;
  });
  return s.length > EVIDENCE_MAX_LINE_CHARS ? `${s.slice(0, EVIDENCE_MAX_LINE_CHARS - 1)}…` : s;
}

/** Where a refused attachment's PDF is kept: the first as {intakeId}.pdf, any more as -1, -2… */
export function refusedPdfPath(intakeId, n = 0) {
  return `${REFUSED_PDF_PREFIX}/${intakeId}${n ? `-${n}` : ""}.pdf`;
}

/**
 * The owner-only evidence record for one message's refused attachments.
 * @param {{items: {filename:string, reason:string, lines:string[]|null, pdfPath:string|null, note?:string}[], at:number, parserVersion:number|null}} input
 */
export function evidenceRecord({ items, at, parserVersion }) {
  const list = (items || []).slice(0, EVIDENCE_MAX_ATTACHMENTS);
  return {
    at,
    parserVersion: Number.isInteger(parserVersion) ? parserVersion : null,
    attachments: list.map((it) => {
      const lines = Array.isArray(it.lines) ? it.lines : [];
      return {
        filename: clip(it.filename, 120) || "(unnamed)",
        // The FULL reason, money and all — this node is the owner's.
        reason: clip(it.reason, 600),
        pdfPath: it.pdfPath || null,
        lineCount: lines.length,
        lines: lines.length ? lines.slice(0, EVIDENCE_MAX_LINES).map(maskEvidenceLine) : null,
        truncated: lines.length > EVIDENCE_MAX_LINES,
        note: clip(it.note, 200),
      };
    }),
  };
}

// ─── A FIX REACHES THE SLIPS IT WAS WRITTEN FOR, BY ITSELF ───────────────────
// Every intake row is stamped with the parser version the callable reported
// when it judged the file (PARSER_VERSION in functions/lib/card-recon-pdf.cjs).
// When a deploy raises that version, the poller re-runs every refusal from the
// last fortnight that an older version judged — the same two moves
// retry-intake-message.mjs makes by hand (clear the claim, forget the cached
// key), minus the hand. The duplicate-batch refusal downstream still stops a
// slip that DID land from landing twice.
//
// NOT RETRIED, deliberately:
//   • a row that recorded anything — re-running it can only produce duplicate
//     refusals or, worse, a second record of a sibling attachment;
//   • a row whose every refusal is "already captured" — a re-send of a batch
//     that is on file; no parser change makes it new;
//   • a row already re-run (retriedAt), or one the current version judged;
//   • the EFT reader's synthetic slip-loss rows (eftslip-…), whose key belongs
//     to the payment message, not to a slip.
export const RETRY_WINDOW_MS = 14 * 86400000;
// How often the deployed version is asked for, and how often a sweep runs even
// when it has not changed (to catch a row an old instance judged mid-deploy).
export const VERSION_CHECK_MS = 30 * 60 * 1000;
export const RESWEEP_MS = 6 * 60 * 60 * 1000;
// A released message the scan has not yet re-processed is remembered this long.
export const PENDING_RETRY_MS = 3 * 86400000;

const DUPLICATE = /already captured/i;

/**
 * Which intake rows to re-run. Pure: `rows` is the bounded tail as read.
 * @returns {{id:string, messageKey:string, messageId:string|null}[]}
 */
export function retryCandidates(rows, { nowMs, deployedVersion, windowMs = RETRY_WINDOW_MS }) {
  if (!Number.isInteger(deployedVersion)) return [];
  const out = [];
  for (const [id, rec] of Object.entries(rows || {})) {
    if (!rec || typeof rec !== "object" || id.startsWith("eftslip-")) continue;
    if (!rec.messageKey || rec.retriedAt) continue;
    const stamp = Number(rec.receivedAt) || Number(rec.at) || 0;
    if (!stamp || nowMs - stamp > windowMs) continue;
    if (Number(rec.recorded) > 0 || !(Number(rec.refused) > 0)) continue;
    // An automatic re-run that got no answer at all is not re-run again: the
    // fault was the transport, not a parser, and a fresh row every six hours
    // for a fortnight is noise. The next version bump does not revive it
    // either — Junid's hand script remains for that.
    if (rec.rerunOf && !Number.isInteger(rec.parserVersion)) continue;
    const judgedBy = Number.isInteger(rec.parserVersion) ? rec.parserVersion : 0;
    if (judgedBy >= deployedVersion) continue;
    const atts = Array.isArray(rec.attachments) ? rec.attachments : Object.values(rec.attachments || {});
    const refusals = atts.filter((a) => a && a.outcome === "refused");
    if (refusals.length && refusals.every((a) => DUPLICATE.test(String(a.reason || "")))) continue;
    out.push({ id, messageKey: rec.messageKey, messageId: rec.messageId || null });
  }
  return out;
}

/**
 * Is a sweep due? `state` is the poller's local retry state.
 * @returns {boolean}
 */
export function sweepDue(state, { deployedVersion, nowMs }) {
  if (!Number.isInteger(deployedVersion)) return false;
  const swept = Number.isInteger(state?.sweptVersion) ? state.sweptVersion : 0;
  if (deployedVersion > swept) return true;
  return !(Number(state?.sweptAt) > 0) || nowMs - state.sweptAt > RESWEEP_MS;
}

/**
 * The parser version a set of attachment outcomes was judged by: the LOWEST
 * any of them reported, or null when one of them got no answer at all (a
 * transport failure) — which then reads as "older than anything" and is
 * re-run after the next deploy.
 */
export function judgedVersion(versions) {
  const list = Array.isArray(versions) ? versions : [];
  if (!list.length || list.some((v) => !Number.isInteger(v))) return null;
  return Math.min(...list);
}

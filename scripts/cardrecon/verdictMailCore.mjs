// ─── THE EMAIL TO JUNID ON EVERY EFT VERDICT (PURE) ──────────────────────────
// Junid, 17 Oct 2026: an email on every payment the EFT confirmer processes,
// so he can watch how it reasons. Subject is the verdict — APPROVED when the
// payment passed every check and became a spendable pool record, REJECTED
// otherwise — and the body's first line is the deciding reason in plain
// English. Details follow; no full card or account number ever.
//
// OBSERVE AND REPORT ONLY. This module reads a pool record AFTER the poller
// has decided and written it; nothing here can change an outcome, and a mail
// that fails to send costs that one email, never the record.
//
// ── THE SAME PATH AND THE SAME INBOX AS THE RECYCLER REPORTS ─────────────────
// The recycler watcher (marathon-pos-app scripts/recycler/lib/mail.mjs) emails
// Junid over Gmail SMTP (smtp.gmail.com:465) as marathon6631@gmail.com, with
// the app password card recon owns in ~/marathon-store-app/.env, to
// gunidmoh@gmail.com — the inbox he reads. The poller already holds exactly
// that mailbox and password (CARD_RECON_IMAP_USER / _PASSWORD) and already
// sends over that SMTP host for the Unread notices, so these go the same way,
// to the same fixed address. A constant, like the recycler's, not a setting.
//
// PURE: no SMTP, no clock, no env. The poller hands in the record; tests hand
// in records as data (verdictMailCore.test.mjs).
import { redactAccountDigits } from "./eftCore.mjs";
import { clip } from "./intakeCore.mjs";

export const EFT_VERDICT_TO = "gunidmoh@gmail.com";
// Only ever sent AS the card-recon mailbox — the recycler's own guard
// (mail.mjs: "not sending as a different mailbox"). A different account in
// .env means somebody changed card recon, and this must not send as it.
export const EFT_VERDICT_FROM_MAILBOX = "marathon6631@gmail.com";
export const EFT_VERDICT_FROM_NAME = "Marathon EFT confirmer";

/** Whether the poller's mailbox is the one these may be sent as. */
export function verdictSenderOk(user) {
  return String(user ?? "").trim().toLowerCase() === EFT_VERDICT_FROM_MAILBOX;
}

// Every subject starts with this, so one Gmail filter (subject:"[EFT confirmer]")
// files them all into a folder.
export const EFT_VERDICT_SUBJECT_PREFIX = "[EFT confirmer]";

// ── DIALLING IT BACK ─────────────────────────────────────────────────────────
// EFT_VERDICT_EMAILS in the mini's .env: "all" (the default — every verdict)
// or "rejected" (REJECTED only; APPROVED emails stop). A value this does not
// understand falls back to ALL with a warning: a typo should cost Junid extra
// emails, never a rejection he did not hear about — and it must never stop
// the poller, which would stop the payments.
export const EFT_VERDICT_MODE_ENV_VAR = "EFT_VERDICT_EMAILS";
export const VERDICT_MODES = ["all", "rejected"];

/** @returns {{mode:"all"|"rejected", warning:string|null}} */
export function parseVerdictMode(raw) {
  const v = String(raw ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!v || v === "all") return { mode: "all", warning: null };
  if (v === "rejected" || v === "rejectedonly") return { mode: "rejected", warning: null };
  return {
    mode: "all",
    warning: `${EFT_VERDICT_MODE_ENV_VAR} reads "${oneLine(raw, 40)}", which is not "all" or "rejected" — sending every verdict.`,
  };
}

/** Whether this verdict is emailed under this mode. */
export function shouldSendVerdict(verdict, mode) {
  return mode === "rejected" ? verdict === "REJECTED" : true;
}

// The checks, in the order the confirmer runs them, named the way Junid reads
// them. Every outcome eftPoolRecord / applyFingerprintHold / unknownBankRecord
// can write is here; anything else is reported as REJECTED with its raw
// outcome named, never silently dropped.
const CHECKS = {
  "unknown-bank": "Unknown bank sender",
  "refused-auth": "Signature check failed (DKIM)",
  "refused-parse": "Unreadable notification",
  "refused-account": "Wrong destination account",
  "refused-not-immediate": "Not an immediate (real-time) payment",
  "refused-stale-date": "Payment dated before the cutoff",
  "held-duplicate": "Duplicate — bank transaction id already seen",
  "held-no-bankref": "No bank transaction id",
};

const BANK_NAMES = {
  fnb: "FNB", standardbank: "Standard Bank", absa: "Absa",
  capitec: "Capitec", nedbank: "Nedbank", tymebank: "TymeBank",
};
const DOMAIN_BANKS = {
  "fnb.co.za": "FNB", "standardbank.co.za": "Standard Bank", "absa.co.za": "Absa",
  "capitecbank.co.za": "Capitec", "nedbank.co.za": "Nedbank", "tymebank.co.za": "TymeBank",
};

/**
 * APPROVED only for a record that is spendable: outcome "recorded" with status
 * "unmatched" — exactly what the pool search and the settle accept. A held
 * payment is NOT approved, whatever it carries.
 */
export function eftVerdict(record) {
  return record?.outcome === "recorded" && record?.status === "unmatched" ? "APPROVED" : "REJECTED";
}

/** The check that decided a REJECTED record, as Junid reads it. */
export function failedCheck(record) {
  // Fix 8 refuses two different things under one outcome: a date the bank
  // printed that is before the cutoff, and a date that could not be read at
  // all (bankTs null). The label must not call the second "dated before".
  if (record?.outcome === "refused-stale-date" && !Number.isInteger(record?.bankTs)) return "Payment date unreadable (cutoff check)";
  return CHECKS[record?.outcome] || `Not approved (outcome "${clip(String(record?.outcome ?? "none"), 40)}")`;
}

/** Plain-English deciding reason: one line, account digits struck out. */
export function decidingReason(record) {
  if (eftVerdict(record) === "APPROVED") {
    return "All checks passed — genuine bank signature (DKIM), paid into the shop's own account, an immediate payment, dated by the bank on or after the cutoff, and a bank transaction id not seen before. It is now a spendable payment in the pool.";
  }
  const check = failedCheck(record);
  const why = oneLine(redactAccountDigits(String(record?.reason ?? "")), 600);
  if (!why) return check;
  // A reason that already opens with its check's name (the stale-date reason
  // does, by spec) is not prefixed with it a second time.
  return why.toLowerCase().startsWith(check.toLowerCase()) ? why : `${check}: ${why}`;
}

const oneLine = (s, n) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, n);

/** R1,234.56 — or null for no usable amount. */
export function formatRands(cents) {
  if (!Number.isInteger(cents)) return null;
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const rands = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}R${rands}.${String(abs % 100).padStart(2, "0")}`;
}

/** 2026-10-17 14:05:09 SAST — South Africa has no daylight saving. */
export function formatSast(ms) {
  if (!Number.isFinite(ms)) return null;
  return `${new Date(ms + 2 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ")} SAST`;
}

/** Every character but the last four becomes •, so an id can be matched by eye but not read whole. */
export function maskIdentifier(value) {
  const s = oneLine(value, 80);
  if (!s) return null;
  if (s.length <= 4) return "•".repeat(s.length);
  return `${"•".repeat(Math.min(s.length - 4, 8))}${s.slice(-4)}`;
}

/**
 * The payer's reference, readable but never a whole long number. It is the
 * customer's matching key — usually a phone number or invoice — so it is not
 * struck out the way a diagnostic is (eftCore keeps it whole in the pool for
 * the same reason); but a payer can type an account or card number there, so
 * any run of six or more digits keeps only its last four.
 */
export function maskReference(value) {
  const s = oneLine(value, 120);
  if (!s) return null;
  return s.replace(/\d(?:[ -]?\d){5,}/g, (run) => `••${run.replace(/\D/g, "").slice(-4)}`);
}

/** The paying bank, from the reader that read it or the sender's domain. */
export function bankName(record) {
  if (record?.reader && BANK_NAMES[record.reader]) return BANK_NAMES[record.reader];
  const domain = String(record?.auth?.fromDomain || record?.fromDomain || "").toLowerCase();
  const hit = Object.keys(DOMAIN_BANKS).find((d) => domain === d || domain.endsWith(`.${d}`));
  return hit ? DOMAIN_BANKS[hit] : (domain || "unknown sender");
}

/**
 * The whole email for one pool record. `poolKey` is the record's id at
 * /eft_pool, so Junid can find it on the owner panel.
 * @returns {{verdict:"APPROVED"|"REJECTED", subject:string, text:string}}
 */
export function verdictMail(record, { poolKey } = {}) {
  const verdict = eftVerdict(record);
  const bank = oneLine(bankName(record), 60);
  const amount = formatRands(record?.amountCents);
  // The bank's transaction id is shown masked — and FNB repeats it in its own
  // email subject ("Payment Notification from … 5TG59DVQ", real record), so
  // every free-text field has it replaced by the masked form too.
  const ref = oneLine(record?.bankRef, 80);
  const unref = (s) => (ref.length >= 4 && s ? String(s).split(ref).join(maskIdentifier(ref)) : s);
  const subject = oneLine([
    `${EFT_VERDICT_SUBJECT_PREFIX} ${verdict}`,
    verdict === "REJECTED" ? failedCheck(record) : null,
    [amount, bank].filter(Boolean).join(" · "),
  ].filter(Boolean).join(" — "), 200);

  // Free text the bank or the payer wrote goes through the account sweep —
  // this leaves the database for an inbox. The reference is swept too: it is
  // usually a phone number or an invoice, but a payer can type anything.
  const sweep = (s, n) => (s ? oneLine(redactAccountDigits(unref(String(s))), n) : null);
  const details = [
    ["Bank", bank],
    ["Amount", amount],
    ["Reference", maskReference(unref(record?.reference))],
    ["Payer", sweep(record?.payer, 120)],
    ["Paid into", record?.destination?.accountMask
      ? `${oneLine(record.destination.accountMask, 40)}${record.destination.destBankName ? ` (${oneLine(record.destination.destBankName, 60)})` : ""}`
      : null],
    ["Bank transaction id", maskIdentifier(record?.bankRef)],
    ["Payment type", sweep(record?.paymentType, 60)],
    ["Bank's timestamp", formatSast(record?.bankTs)],
    // Fix 8: the configured cutoff this payment's bank date failed.
    ["Payment-date cutoff", record?.cutoff ? oneLine(record.cutoff, 20) : null],
    ["Notification arrived", formatSast(record?.receivedAt)],
    ["Decided", formatSast(record?.at)],
    ["Sender", sweep(record?.from, 120)],
    ["Bank email subject", sweep(record?.subject, 160)],
    ["Signature (DKIM)", record?.auth
      ? `${record.auth.verdict === "not-checked" ? "not checked (a bank this pool is not set up for)" : record.auth.verdict}${record.auth.dkimDomain ? ` — signed by ${oneLine(record.auth.dkimDomain, 80)}` : ""}`
      : null],
    ["Duplicate of", record?.duplicateOf ? oneLine(record.duplicateOf, 120) : null],
    ["Pool record", poolKey ? oneLine(poolKey, 160) : null],
  ].filter(([, v]) => v);

  const text = [
    `${verdict} — ${redactAccountDigits(unref(decidingReason(record)))}`,
    "",
    ...details.map(([k, v]) => `${k}: ${v}`),
    "",
    "The EFT confirmer on the Mac mini sent this after deciding; the email changes nothing.",
    "No full card or account numbers are included.",
  ].join("\n");

  return { verdict, subject, text };
}

// ── SENDING A TICK'S VERDICTS ────────────────────────────────────────────────
// The poller QUEUES each verdict while it holds the mailbox and sends them
// here, after the IMAP session is closed — so a slow or black-holed SMTP host
// can never hold the mailbox lock or push a tick past its budget (Sonnet
// architect review). Two limits, each saying what it dropped:
//   · the FIRST failed send stops the round: the host is down or refusing,
//     and every further try would wait out its own timeout;
//   · ANYONE CAN SEND THIS MAILBOX MAIL. Two outcomes are triggered by a
//     stranger rather than by a payment: unknown-bank (a domain we never set
//     up) and refused-auth (a forgery claiming a bank — CodeRabbit, #733).
//     A burst of either must not bury Junid's inbox or the mailbox's Gmail
//     send quota (which the Unread notices share). The first
//     STRANGER_EMAILS_PER_TICK of them are sent one by one; the rest of the
//     tick's go as ONE roll-up email naming each one's check and sender.
//     Real payments (every other outcome) are never rolled up.
export const STRANGER_EMAILS_PER_TICK = 3;
export const STRANGER_OUTCOMES = ["unknown-bank", "refused-auth"];

/** One roll-up email for the stranger-triggered verdicts past the per-tick cap. */
export function strangerRollupMail(items) {
  const checks = [...new Set(items.map(({ record }) => failedCheck(record)))];
  const lines = items.map(({ record, poolKey }) =>
    `- ${failedCheck(record)} · ${oneLine(bankName(record), 80)} · arrived ${formatSast(record?.receivedAt) || "unknown"} · pool record ${oneLine(poolKey, 160)}`);
  return {
    subject: oneLine(`${EFT_VERDICT_SUBJECT_PREFIX} REJECTED — ${checks.join(" / ")} — ${items.length} more this round`, 200),
    text: [
      `REJECTED — ${checks.join(" / ")}: ${items.length} more message(s) of this kind arrived in one round. None became a payment. Rolled into one email so a burst cannot flood the inbox.`,
      "",
      ...lines,
      "",
      "The EFT confirmer on the Mac mini sent this after deciding; the email changes nothing.",
    ].join("\n"),
  };
}

/**
 * Send one tick's queued verdicts. `send` is injected (nodemailer's sendMail
 * on the mini, a recorder in tests). NEVER throws.
 * @param {{queue:{record:object, poolKey:string}[], mode:string, send:(m:object)=>Promise<any>, from:string, cap?:number}} p
 * @returns {Promise<{sent:{verdict:string, check:string|null}[], skipped:number, rolledUp:number, unsent:number, error:string|null}>}
 */
export async function drainVerdictEmails({ queue, mode, send, from, cap = STRANGER_EMAILS_PER_TICK }) {
  const out = { sent: [], skipped: 0, rolledUp: 0, unsent: 0, error: null };
  const envelope = (m) => ({ from: { name: EFT_VERDICT_FROM_NAME, address: from }, to: EFT_VERDICT_TO, subject: m.subject, text: m.text });
  const mails = [];
  const rollup = [];
  let strangers = 0;
  for (const item of Array.isArray(queue) ? queue : []) {
    const verdict = eftVerdict(item?.record);
    if (!shouldSendVerdict(verdict, mode)) { out.skipped += 1; continue; }
    if (STRANGER_OUTCOMES.includes(item.record?.outcome) && ++strangers > cap) { rollup.push(item); continue; }
    mails.push({ verdict, check: verdict === "REJECTED" ? failedCheck(item.record) : null, item });
  }
  const tryMail = async (build) => {
    try { await send(envelope(build())); return true; }
    catch (err) { out.error = oneLine(err?.response || err?.message || err, 200); return false; }
  };
  for (let i = 0; i < mails.length; i++) {
    const { verdict, check, item } = mails[i];
    if (!(await tryMail(() => verdictMail(item.record, { poolKey: item.poolKey })))) {
      out.unsent = mails.length - i + rollup.length;
      return out;
    }
    out.sent.push({ verdict, check });
  }
  if (rollup.length) {
    if (await tryMail(() => strangerRollupMail(rollup))) out.rolledUp = rollup.length;
    else out.unsent = rollup.length;
  }
  return out;
}

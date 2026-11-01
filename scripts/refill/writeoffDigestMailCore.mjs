// ─── WRITE-OFF DIGEST MAIL — the pure decisions (2026-11-01) ─────────────────
//
// The daily digest (functions/lib/writeoff-digest.cjs) files its finished email
// at /refill_engine/refusalWriteoffDigestOutbox/{key}. The mini's launchd agent
// (writeoff-digest-mailer.mjs) sends each entry over Gmail SMTP — the route
// every email that reaches Junid already takes — and records Gmail's answer.
// This file decides; the runner only does I/O. Tests: writeoffDigestMailCore.test.mjs.

// Fixed here, NEVER read from the database: a row cannot redirect the mail.
export const DIGEST_MAIL_TO = "gunidmoh@gmail.com";        // Junid reads this one (with a G)
export const DIGEST_MAIL_FROM_MAILBOX = "marathon6631@gmail.com";
export const DIGEST_MAIL_FROM_NAME = "Marathon write-off digest";
export const OUTBOX = "refill_engine/refusalWriteoffDigestOutbox";
export const ARCHIVE = "refill_engine/refusalWriteoffDigests";
export const STATUS = "refill_engine/refusalWriteoffDigestStatus";
// The digest function writes the outbox entry a few milliseconds before it
// writes STATUS ("checking", mail queued). An entry this young is left for the
// next tick, so Gmail's answer is never overwritten by that first write.
export const MIN_AGE_MS = 2 * 60e3;
export const MAX_ATTEMPTS = 12;   // ~2 hours of 10-minute ticks, then "failed" (red) and hourly retries
export const SLOW_RETRY_MS = 3600e3;
// A tick marks the entry BEFORE sending; a tick that died mid-send is retried
// only after this, so one crash never becomes an email every 10 minutes.
export const SENDING_STALE_MS = 30 * 60e3;

/** Only ever sent AS the shop mailbox (same guard as the EFT verdict mail). */
export function senderOk(user) {
  return String(user ?? "").trim().toLowerCase() === DIGEST_MAIL_FROM_MAILBOX;
}

/** Which outbox entries to send this tick, oldest first. */
export function dueEntries(outbox, nowMs) {
  return Object.entries(outbox && typeof outbox === "object" ? outbox : {})
    .filter(([, e]) => e && typeof e === "object" && typeof e.text === "string" && e.text.trim())
    .filter(([key, e]) => {
      const at = Number(e.createdAtMs) || Number(String(key).split("_")[1]) || 0;
      if (!(at > 0) || nowMs - at < MIN_AGE_MS) return false;
      if (Number(e.sendingAtMs) && nowMs - Number(e.sendingAtMs) < SENDING_STALE_MS) return false;
      // Past the last fast attempt it keeps trying hourly — fixing the password
      // or switching the mini back on sends it without anyone editing a row.
      if ((Number(e.attempts) || 0) >= MAX_ATTEMPTS) return nowMs - (Number(e.lastTriedAtMs) || 0) >= SLOW_RETRY_MS;
      return true;
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The message — recipient and sender are constants, never the row's. */
export function mailFor(key, entry, fromUser) {
  return {
    from: { name: DIGEST_MAIL_FROM_NAME, address: fromUser },
    to: DIGEST_MAIL_TO,
    subject: String(entry.subject || `[Write-off digest] ${key}`).replace(/[\r\n]+/g, " ").slice(0, 200),
    text: `${entry.text}\n\nFull list with every refusal date and who refused: Inventory Health → Written off after refusal (super admin only).\n`,
  };
}

/**
 * The one multi-path update after a send attempt.
 *   statusArchiveKey  the archiveKey STATUS currently names (STATUS/mail is
 *                     only written when it is this digest's status)
 */
export function patchAfter({ key, entry, ok, info, error, nowMs, statusArchiveKey }) {
  const patch = {};
  if (ok) {
    const mail = {
      state: "sent", to: DIGEST_MAIL_TO, atMs: nowMs,
      messageId: info?.messageId || null,
      response: String(info?.response || "").slice(0, 200) || null,
      accepted: Array.isArray(info?.accepted) ? info.accepted.map(String) : null,
    };
    patch[`${OUTBOX}/${key}`] = null;
    patch[`${ARCHIVE}/${key}/mail`] = mail;
    if (statusArchiveKey === key) patch[`${STATUS}/mail`] = mail;
    return patch;
  }
  const attempts = (Number(entry?.attempts) || 0) + 1;
  const why = String(error?.message || error || "unknown").slice(0, 300);
  patch[`${OUTBOX}/${key}/attempts`] = attempts;
  patch[`${OUTBOX}/${key}/lastError`] = why;
  patch[`${OUTBOX}/${key}/lastTriedAtMs`] = nowMs;
  patch[`${OUTBOX}/${key}/sendingAtMs`] = null;
  const mail = { state: attempts >= MAX_ATTEMPTS ? "failed" : "retrying", to: DIGEST_MAIL_TO, atMs: nowMs, attempts, why };
  patch[`${ARCHIVE}/${key}/mail`] = mail;
  if (statusArchiveKey === key) patch[`${STATUS}/mail`] = mail;
  return patch;
}

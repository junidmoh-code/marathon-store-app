// ─── THE EMAIL TO JUNID WHEN A SLIP NEVER READ ───────────────────────────────
// A slip that the server could not read after every retry becomes an "Unread –
// needs manual entry" row in Junid's POS report, and ONE email (Junid, 7 Oct
// 2026: "email Junid (email only)"). The server decides what to say and to
// whom (functions/lib/card-unread.cjs); this poller only DELIVERS it, because
// it is the one process that already holds a mailbox it can send from — the
// shop's own, marathon6631@gmail.com, whose app password works for SMTP the
// same as for IMAP.
//
// THE ROUND, once per tick:
//   1. cardBatchCapture { action: "notices" }  → { to, notices: [{key, subject, text}] }
//      (each is LEASED server-side for ten minutes, so a second tick in that
//      time is not handed it again);
//   2. one sendMail per notice;
//   3. cardBatchCapture { action: "noticeSent", results: [{key, ok, error?}] }
//      — a sent notice is closed and its row stamped; a failed one is offered
//      again next tick.
// If step 3 itself fails after a send, the lease runs out and the notice goes
// a second time. A duplicate email is the cost; a lost one is not on offer.
//
// PURE but for the two functions handed in (`call`, `send`), so the whole
// round is tested without a mailbox or a server.

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const MAX_NOTICES = 10;

// A header is one line. A subject carrying CR/LF could add headers of its
// own; the server writes these, but a header is never trusted to be one line.
const oneLine = (s, n) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, n);

/** The server's reply → what may be sent, or a sentence saying why nothing. */
export function planNoticeRound(reply) {
  if (!reply || reply.ok !== true) return { to: null, notices: [], refusal: "the server did not hand over any notices" };
  const to = typeof reply.to === "string" && EMAIL_RE.test(reply.to.trim()) ? reply.to.trim() : null;
  if (!to) return { to: null, notices: [], refusal: "the server named no valid recipient" };
  const notices = (Array.isArray(reply.notices) ? reply.notices : [])
    .filter((n) => n && typeof n.key === "string" && /^[A-Za-z0-9_~-]{1,120}$/.test(n.key)
      && typeof n.subject === "string" && n.subject.trim() && typeof n.text === "string")
    .slice(0, MAX_NOTICES)
    .map((n) => ({ key: n.key, subject: oneLine(n.subject, 200), text: String(n.text).slice(0, 4000) }));
  return { to, notices, refusal: null };
}

/** One notice as a message nodemailer can send. Plain text only. */
export function noticeMail({ from, to, notice }) {
  return { from, to, subject: notice.subject, text: notice.text };
}

/**
 * The whole round. Never throws for one failed send — that notice is reported
 * back as failed and the rest still go. Throws only if the server cannot be
 * asked at all (the tick logs it and carries on).
 *
 * @param {{call:(data:object)=>Promise<object>, send:(mail:object)=>Promise<any>, from:string, log?:Console}} p
 * @returns {Promise<{sent:number, failed:number, refusal:string|null}>}
 */
export async function deliverNotices({ call, send, from, log = console }) {
  const { to, notices, refusal } = planNoticeRound(await call({ action: "notices" }));
  if (refusal) return { sent: 0, failed: 0, refusal };
  if (!notices.length) return { sent: 0, failed: 0, refusal: null };
  const results = [];
  for (const notice of notices) {
    try {
      await send(noticeMail({ from, to, notice }));
      results.push({ key: notice.key, ok: true });
      log.log(`· card recon notice emailed to Junid: ${notice.subject}`);
    } catch (err) {
      const error = oneLine(err && (err.response || err.message) || "send failed", 300);
      results.push({ key: notice.key, ok: false, error });
      log.error(`  ✗ card recon notice NOT sent (${error}) — it is offered again next tick: ${notice.subject}`);
    }
  }
  await call({ action: "noticeSent", results });
  return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, refusal: null };
}

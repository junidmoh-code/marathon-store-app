// ─── WHAT THE EMAILED-SLIP FEED SAYS, AS A PURE FUNCTION ─────────────────────
// The poller on the Mac mini writes one record per message at
// /card_batch_intake; this turns the tail of that node into what the Card recon
// tab renders. Kept out of the screen so the cases that matter can be tested
// without a database: a refusal that must not be buried, an invoice that must
// not be treated as one, and a READ THAT WAS DENIED — which is not an empty
// feed and must never be shown as one.
//
// THE ORDER IS THE POINT. A terminal quietly failing to reconcile is the thing
// this feature exists to make visible, so anything needing attention sorts to
// the top regardless of when it arrived, and the count is stated rather than
// left to be noticed.

/** newest first, refusals first of all. */
export function summariseIntake(node) {
  const rows = Object.entries(node || {}).map(([id, r]) => ({ id, ...(r || {}) }));
  const needsAttention = rows.filter((r) => (r.refused || 0) > 0);
  const rest = rows.filter((r) => !((r.refused || 0) > 0));
  const byNewest = (a, b) => (Number(b.at) || 0) - (Number(a.at) || 0);
  return {
    rows: [...needsAttention.sort(byNewest), ...rest.sort(byNewest)],
    refusedCount: needsAttention.reduce((n, r) => n + (r.refused || 0), 0),
    recordedCount: rows.reduce((n, r) => n + (r.recorded || 0), 0),
    lastAt: rows.length ? Math.max(...rows.map((r) => Number(r.at) || 0)) : null,
  };
}

/**
 * Every attachment on one message, in the order a person should read them:
 * what went wrong first.
 */
export function attachmentRows(record) {
  const list = Object.values(record?.attachments || {});
  const rank = { refused: 0, unrelated: 2, recorded: 1 };
  return list.slice().sort((a, b) => (rank[a?.outcome] ?? 3) - (rank[b?.outcome] ?? 3));
}

/**
 * SILENCE IS THE FAILURE MODE OF A SCHEDULED JOB, and there are two silences
 * that look identical in a feed and mean opposite things:
 *
 *   NOTHING CAME IN — the poller ran minutes ago and the mailbox was empty.
 *     A quiet week. Nothing to do, and an alarm here is the kind that teaches
 *     people to ignore alarms.
 *
 *   NOTHING RAN — the poller itself has stopped, and every batch report emailed
 *     since is sitting unread. This is an outage, and it is invisible without
 *     being told: the feed of a dead poller looks exactly like a quiet one.
 *
 * The heartbeat (/card_batch_poll_status, written every tick including the ones
 * that found nothing) is what tells them apart, so it is checked FIRST and its
 * absence is not treated as good news.
 *
 * `now` is the caller's SERVER-corrected clock (serverNowMs), never the
 * device's: a phone with a wrong date would otherwise raise or hide an alarm on
 * its own.
 */
const HEARTBEAT_STALE_MS = 60 * 60 * 1000;   // ticks are 5 minutes apart
const QUIET_FEED_DAYS = 2;

export function silenceNotice(lastAt, now, status) {
  if (!Number.isInteger(now)) return null;
  const lastRunAt = Number(status?.lastRunAt);
  if (Number.isFinite(lastRunAt) && lastRunAt > 0) {
    const quietFor = now - lastRunAt;
    if (quietFor > HEARTBEAT_STALE_MS) {
      const hours = Math.max(1, Math.round(quietFor / 3600000));
      return `The mailbox has not been checked for ${hours} hour${hours === 1 ? "" : "s"} — the poller on the Mac mini has stopped. Any batch report emailed since is sitting unread. Check logs/card-recon-poll.log.`;
    }
    return null;   // it ran recently; a quiet mailbox is just a quiet mailbox
  }
  // No heartbeat at all: either it has never run, or it is an older build. Fall
  // back to the feed's own age rather than saying nothing.
  if (!Number.isInteger(lastAt)) return null;
  const days = Math.floor((now - lastAt) / 86400000);
  if (days < QUIET_FEED_DAYS) return null;
  return `Nothing has arrived by email for ${days} days, and the poller has not reported in at all. If the terminals are still emailing their reports, it has stopped — check logs/card-recon-poll.log.`;
}

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
 * How long since the poller last wrote anything, as a sentence.
 *
 * SILENCE IS THE FAILURE MODE OF A SCHEDULED JOB, and a feed that is merely
 * empty looks exactly like a mailbox with nothing in it. `now` is the caller's
 * SERVER-corrected clock (serverNowMs), never the device's: a phone with a
 * wrong clock would otherwise raise or hide an alarm on its own.
 */
export function silenceNotice(lastAt, now) {
  if (!Number.isInteger(lastAt) || !Number.isInteger(now)) return null;
  const days = Math.floor((now - lastAt) / 86400000);
  if (days < 2) return null;
  return `Nothing has arrived by email for ${days} days. If the terminals are still emailing their reports, the poller on the Mac mini has stopped — check logs/card-recon-poll.log.`;
}

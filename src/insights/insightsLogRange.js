// ─── BOUNDED KEY RANGES FOR /insights_log ───────────────────────────────────
// /insights_log is 18.73 MB and has NO `.indexOn` in the live console rules, so
// `orderByChild("timestamp")` is not available — it would fall back to an
// unindexed scan. What IS available for free is `orderByKey()`: Firebase push
// keys encode the write time (ms since epoch) in their first 8 characters, so a
// key range IS a time range.
//
// KEY TIME vs `timestamp` — measured across all 64,011 live entries
// (docs/insights-log-investigation.md, 2026-08-02):
//   median skew +0.7s · p1 −54.7s · p99 +40.3s · min −725s · max +86,388s
//   8 entries (0.012%) differ by more than an hour, none by more than a day.
// The dangerous direction is an entry whose `timestamp` is inside the window but
// whose KEY sorts BEFORE the range start — that is the negative skew, and the
// worst observed case is −725s (12 minutes). PAD_MS below is 48 hours, ~238x
// that margin.
//
// Callers MUST still filter on `timestamp` after fetching (every existing
// consumer already does — see eventsForPeriod / restockCountsFromLog). The range
// is a cheap server-side pre-filter, never the definition of the window, so a
// skewed key can widen what we download but can never change what is rendered.

const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";

// 48h of slack on the lower bound (see the skew note above).
export const PAD_MS = 48 * 60 * 60 * 1000;

// Milliseconds in an SA day. SA (UTC+2) has no DST, so a fixed offset is exact.
const SA_OFFSET_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The 8-character push-key prefix encoding `ms`. Comparing against this prefix
 * with startAt() selects every key written at or after `ms` — push keys sort
 * lexicographically in PUSH_CHARS order, which is the same order as time.
 * @param {number} ms epoch milliseconds
 * @returns {string} 8-char key prefix, e.g. 1785000000000 -> "-OyPHbc-"
 */
export function pushKeyForMs(ms) {
  let n = Math.max(0, Math.floor(Number(ms) || 0));
  let out = "";
  for (let i = 0; i < 8; i++) {
    out = PUSH_CHARS[n % 64] + out;
    n = Math.floor(n / 64);
  }
  return out;
}

/**
 * Lower-bound key for "the last `days` SA days, inclusive of today", padded.
 * Derived from the period the caller renders — never a hard-coded window.
 * @param {number} days how many past SA days the screen shows
 * @param {number} nowMs server-anchored now
 * @returns {{ startKey: string, startMs: number }}
 */
export function recentDaysStartKey(days, nowMs) {
  const d = Math.max(0, Math.floor(Number(days) || 0));
  // Midnight SA at the start of the oldest day the screen renders.
  const saNow = Number(nowMs) + SA_OFFSET_MS;
  const saMidnight = Math.floor(saNow / DAY_MS) * DAY_MS;
  const startMs = saMidnight - d * DAY_MS - SA_OFFSET_MS - PAD_MS;
  return { startKey: pushKeyForMs(startMs), startMs };
}

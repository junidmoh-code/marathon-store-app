// ─── THE WHOLE LOG, WITHOUT AN UNBOUNDED READ ────────────────────────────────
//
// Three screens (Insights, Customers, the Admin product line) genuinely show
// all-time figures, so they need every row of /insights_log. Until now they got
// them the obvious way: `onValue(ref(db, "insights_log"))` — one read, no
// query, 35.99 MB on the wire, measured live on 2026-09-20 at ~97 of those a
// day.
//
// The content is not the problem. The SHAPE of the read is, for one reason
// that no amount of client tuning fixes: a bare whole-node read is the only
// read a security rule cannot tell apart from a small one, so as long as any
// client issues it, the rule has to permit it — and a PARKED TAB running a
// months-old bundle keeps issuing it for ever. The account is shared, the
// device cannot be chased, and signing out does not replace a web app's code.
//
// So this module gets the same rows through reads that a rule CAN recognise:
//
//   · HISTORY — the repo's existing bounded pager (src/push/pagedRead.js):
//     orderByKey() + limitToFirst, then startAfter(cursor). It already carries
//     the traps this walk has to survive (order from forEach, never
//     Object.keys; a prototype-free accumulator; a reported truncation), so
//     this reader uses it rather than growing a second copy of them.
//   · TAIL — onChildAdded on orderByKey() + startAt(a key BELOW where the walk
//     ended), so a screen left open still sees rows landing while somebody
//     watches. (startAt rather than startAfter because the rule keys on
//     `query.startAt` — see the provider.) The overlap is deliberate; see the
//     next section. Rows the walk already delivered are dropped by KEY.
//
// Every one of those carries a query modifier, which is what the read rule in
// RULES-INSIGHTS-LOG-QUERY.md keys on. Nothing else about the data changes:
// the rows are the same rows, in the same newest-first order, and the screens
// above compute from them exactly as before.
//
// ─── WHAT THIS DOES NOT DO, SAID PLAINLY ─────────────────────────────────────
//
// It does not save a byte for an up-to-date client. The walk fetches the same
// 35.99 MB the single read fetched, in twelve requests instead of one. What it
// buys is the SHAPE, and the shape is what lets the rule refuse the clients we
// cannot otherwise reach. The bytes are the next piece of work (daily rollups
// plus a bounded read for today).
//
// It also does not use the offline mirror's own pager (src/offline/rtdbAdapter.js
// readChildPage / readKeyRange), so the repo now has two bounded pagers over
// this node. That is deliberate: the mirror's is wound into its staging and
// commit machinery, and pulling this path through it would make a rule fix
// depend on the mirror being enabled — which, today, it is not. When the mirror
// IS serving, this reader is not used at all (openMirroredInsightsLog takes
// over in the provider) and the device reads nothing from the network here.
//
// ─── WHY onChildAdded FOR THE TAIL, NOT onValue ──────────────────────────────
//
// onValue on a range re-sends THE WHOLE RANGE every time one child lands. A
// till left open through a trading day would re-download a growing tail once
// per event — about a thousand events against a tail that reaches a thousand
// rows, which is hundreds of megabytes to learn about a few hundred kilobytes.
// onChildAdded delivers each new row once.
//
// The cost of that choice, stated plainly: onChildAdded does not report
// changes or deletions. /insights_log is append-only — never updated, never
// deleted (SCHEMA.md) — so there are none to report. If that ever stops being
// true, this tail stops being correct, which is why the property is written
// here rather than assumed.
//
// ─── WHY THE TAIL STARTS BELOW WHERE THE WALK ENDED ──────────────────────────
//
// A forward walk with a cursor assumes new keys always sort above the cursor.
// Push keys are built from the writing device's clock (corrected by the SDK's
// server-time offset), and this node is written by several devices — the store
// app, every POS till, the refill engine. This repo has MEASURED that
// correction failing: across 64,011 entries, key time ran as much as 725
// seconds BEHIND the event's own timestamp (src/insights/insightsLogRange.js).
//
// A row written during the walk by a device whose key time is behind can
// therefore land below the cursor the walk has already passed. The walk misses
// it, and a tail starting at the walk's last key misses it too — for the whole
// session, with nothing on screen to say a sale is missing. The unbounded read
// this replaces could not lose a row that way, because it re-read everything
// on every change, so this would be a defect INTRODUCED by bounding the read.
// (Sonnet architect review.)
//
// So the tail's lower bound is the earlier of (a) the walk's last key and
// (b) a push key for `walk start − TAIL_BACKDATE_PAD_MS`. Everything in that
// overlap is re-offered and dropped by key against what the walk delivered.
//
// The pad is two hours — roughly ten times the worst backdating ever measured
// here — and costs about ninety re-offered rows, ~30 KB, once per mount. It is
// a bound, not a guarantee: a row backdated by more than two hours AND written
// during the walk would still be missed. That is stated rather than implied,
// and it is a far smaller window than "any row written during the walk".
//
// ─── WHY THE FIRST EMIT WAITS FOR THE LAST PAGE ──────────────────────────────
//
// Emitting each page as it arrives would show an all-time total climbing from
// a wrong number to the right one. Today's single read shows an empty screen
// and then the full figures, so that is what this does: one emit when the walk
// finishes, then one per tail row.
//
// ─── A TRUNCATED LOG IS NOT A LOG ────────────────────────────────────────────
//
// The pager reports `complete: false` when its page budget runs out. Every
// figure these screens render is a count or a total, so a truncated read does
// not look broken — it looks like a quieter month. It is therefore treated as
// a FAILURE here (nothing emitted, the caller told), not as data.
//
// ─── A FAILED PAGE MUST NOT END THE SUBSCRIPTION ─────────────────────────────
//
// The read this replaces was a listener. A tablet that lost its network for
// thirty seconds got its data when the network came back, because the listener
// was still there. A walk made of one-shot get()s has no such property: one
// rejected page — a blip on a till's wifi, the SDK deciding the client is
// offline — would leave Insights, Customers and the admin all-time line empty
// until somebody navigated away for five minutes and came back.
//
// So the walk RETRIES, from the beginning, with a backoff that settles at a
// minute, for as long as a consumer is still retaining the subscription. It
// restarts rather than resumes because a partial walk is not a safe thing to
// continue from: the cursor is a key, and the reason it might be unsafe is the
// same key-ordering one described above. Restarting costs bytes on a failure,
// which is the right trade against showing a wrong total. (Fable-vs-spec
// review.)

import { EMPTY_LOG } from "./InsightsLogContext";
import { pushKeyForMs } from "./insightsLogRange";

// 10,000 rows a page ≈ 3.2 MB per request against today's node, and exactly
// the ceiling the read rule allows (RULES-INSIGHTS-LOG-QUERY.md). The two
// numbers are the same number on purpose: a page size above the rule's cap is
// a permission error, and one far below it is round trips nobody needs — the
// walk is ~12 requests, against the ~23 a 5,000-row page cost.
export const PAGE_SIZE = 10000;

// 200 pages × 5,000 = a million rows. The node holds 112,968 (measured
// 2026-09-19) and grows by about a thousand a day, so this is roughly a
// decade of headroom — and still a ceiling rather than "whatever it grows to".
export const MAX_PAGES = 200;

// The lowest character in Firebase's push-key alphabet. `startAt("-")` is a
// real lower bound that happens to admit every push key — used only for the
// tail of an EMPTY node, where there is no last key to continue from and no
// history for the bound to exclude.
const LOWEST_PUSH_CHAR = "-";

/** See "WHY THE TAIL STARTS BELOW WHERE THE WALK ENDED". */
export const TAIL_BACKDATE_PAD_MS = 2 * 60 * 60 * 1000;

// Retry backoff for a failed walk: 1s, 3s, 9s, 27s, then every 60s for as long
// as a consumer is still there. See "A FAILED PAGE MUST NOT END THE
// SUBSCRIPTION".
export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 60_000;

// The tail's opening burst re-offers the overlap one child at a time. Emitting
// per child would rebuild the consumer array once per row; these are coalesced
// into one emit per turn of the event loop instead.
const COALESCE_MS = 0;

// Same contract as the provider's tsMs: null/NaN sort oldest.
function tsMsLocal(v) {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : new Date(v).getTime();
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Newest-first, identical in ordering to the array the unbounded read used to
 * produce (Object.values(...).filter(Boolean).sort by timestamp desc).
 */
export function shapeRows(rows) {
  if (!rows || rows.length === 0) return EMPTY_LOG;
  return rows.slice().sort((a, b) => tsMsLocal(b.timestamp) - tsMsLocal(a.timestamp));
}

/**
 * A new array with `row` placed so the array stays newest-first. Equal
 * timestamps place the new row AFTER the existing ones, which is what a stable
 * sort of the same rows would have done — arrival order is the tie-break in
 * both cases.
 */
export function insertNewestFirst(sortedNewestFirst, row) {
  const t = tsMsLocal(row && row.timestamp);
  let lo = 0;
  let hi = sortedNewestFirst.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tsMsLocal(sortedNewestFirst[mid].timestamp) >= t) lo = mid + 1;
    else hi = mid;
  }
  const out = sortedNewestFirst.slice();
  out.splice(lo, 0, row);
  return out;
}

export class InsightsLogTruncatedError extends Error {
  constructor(pages) {
    super(`/insights_log walk hit the ${pages}-page budget — the log is longer than this reader will fetch`);
    this.name = "InsightsLogTruncatedError";
  }
}

/**
 * Read the whole log through bounded reads, then follow it forward.
 *
 * @param {(log: Array) => void} onData called once when the history walk
 *        completes, and again after each row the tail delivers.
 * @param {object} deps injected so the query SHAPE can be asserted in a unit
 *        test rather than inferred from a running app:
 *        - readAll() -> Promise<{data, complete, lastKey}> (see pagedRead.js)
 *        - openTail({ after }, onRow) -> unsubscribe; onRow is called with
 *          (key, value) and MUST be given the child's key — the overlap the
 *          lower bound re-offers is dropped by key, not by position
 *        - onError(err) optional
 * @returns {() => void} unsubscribe
 */
export function readWholeLogBounded(
  onData,
  {
    readAll, openTail, onError,
    nowFn = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
  } = {},
) {
  let closed = false;
  let stopTail = null;
  let retryTimer = null;

  const fail = (err) => {
    if (closed) return;
    // A refused, failed or truncated read must not look like an empty log:
    // every all-time figure in the app would render as zero, which is worse
    // than rendering nothing. Leave the last emit standing and say so.
    console.warn("insights_log: bounded whole-log read failed:", err);
    if (onError) onError(err);
  };

  const attempt = async (tryNo) => {
    // Stamped BEFORE the first page of THIS attempt: the pad has to cover
    // anything written from the moment this walk began.
    const walkStartedMs = nowFn();
    let result;
    try {
      result = await readAll();
      if (!result || result.complete === false) throw new InsightsLogTruncatedError(MAX_PAGES);
    } catch (err) {
      if (closed) return;
      fail(err);
      const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(3, tryNo));
      retryTimer = setTimeoutFn(() => { retryTimer = null; attempt(tryNo + 1); }, wait);
      return;
    }
    if (closed) return;

    const data = result.data || {};
    const seen = new Set(Object.keys(data));
    const rows = Object.values(data).filter(Boolean);
    let sorted = shapeRows(rows);
    onData(sorted);

    const lastKey = result.lastKey ?? null;
    const padKey = pushKeyForMs(walkStartedMs - TAIL_BACKDATE_PAD_MS);
    const after = lastKey === null ? LOWEST_PUSH_CHAR : (padKey < lastKey ? padKey : lastKey);

    let pending = [];
    let flushTimer = null;
    const flush = () => {
      flushTimer = null;
      if (closed || pending.length === 0) return;
      for (const row of pending) sorted = insertNewestFirst(sorted, row);
      pending = [];
      onData(sorted);
    };

    stopTail = openTail({ after }, (key, row) => {
      if (closed || !row) return;
      // Dropped by KEY: the overlap below the walk's cursor is re-offered in
      // full, and a row the walk already has must not be counted twice.
      if (key !== null && key !== undefined) {
        if (seen.has(key)) return;
        seen.add(key);
      }
      pending.push(row);
      if (flushTimer === null) flushTimer = setTimeoutFn(flush, COALESCE_MS);
    });
  };

  attempt(0);

  return () => {
    closed = true;
    if (retryTimer !== null) { clearTimeoutFn(retryTimer); retryTimer = null; }
    if (stopTail) {
      try { stopTail(); } catch { /* a teardown must never throw at a caller */ }
      stopTail = null;
    }
  };
}

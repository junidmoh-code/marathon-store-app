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
//   · TAIL — onChildAdded on orderByKey() + startAt(lastKey), so a screen left
//     open still sees rows landing while somebody watches. startAt is
//     inclusive, so the tail re-offers the row the walk ended on; `skipKey`
//     names it and the caller drops it. (startAt rather than startAfter
//     because the rule keys on `query.startAt` — see the provider.)
//
// Every one of those carries a query modifier, which is what the read rule in
// RULES-INSIGHTS-LOG-QUERY.md keys on. Nothing else about the data changes:
// the rows are the same rows, in the same newest-first order, and the screens
// above compute from them exactly as before.
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

import { EMPTY_LOG } from "./InsightsLogContext";

// 5,000 rows a page ≈ 1.6 MB per request against today's node: large enough
// that the full walk is ~23 requests rather than hundreds, small enough that
// no single request is the whole node again.
export const PAGE_SIZE = 5000;

// 200 pages × 5,000 = a million rows. The node holds 112,968 (measured
// 2026-09-19) and grows by about a thousand a day, so this is roughly a
// decade of headroom — and still a ceiling rather than "whatever it grows to".
export const MAX_PAGES = 200;

// The lowest character in Firebase's push-key alphabet. `startAt("-")` is a
// real lower bound that happens to admit every push key — used only for the
// tail of an EMPTY node, where there is no last key to continue from and no
// history for the bound to exclude.
const LOWEST_PUSH_CHAR = "-";

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
 *        - openTail({ after, skipKey }, onRow) -> unsubscribe; `skipKey` is
 *          the one key the inclusive lower bound re-offers, or null
 *        - onError(err) optional
 * @returns {() => void} unsubscribe
 */
export function readWholeLogBounded(onData, { readAll, openTail, onError } = {}) {
  let closed = false;
  let stopTail = null;

  const fail = (err) => {
    if (closed) return;
    // A refused, failed or truncated read must not look like an empty log:
    // every all-time figure in the app would render as zero, which is worse
    // than rendering nothing. Leave the last emit standing and say so.
    console.warn("insights_log: bounded whole-log read failed:", err);
    if (onError) onError(err);
  };

  (async () => {
    let result;
    try {
      result = await readAll();
    } catch (err) {
      fail(err);
      return;
    }
    if (closed) return;
    if (!result || result.complete === false) {
      fail(new InsightsLogTruncatedError(MAX_PAGES));
      return;
    }

    const rows = Object.values(result.data || {}).filter(Boolean);
    let sorted = shapeRows(rows);
    onData(sorted);

    const lastKey = result.lastKey ?? null;
    stopTail = openTail(
      { after: lastKey ?? LOWEST_PUSH_CHAR, skipKey: lastKey },
      (row) => {
        if (closed || !row) return;
        // Insert in place rather than re-sorting 113,000 rows for every
        // arriving event.
        sorted = insertNewestFirst(sorted, row);
        onData(sorted);
      },
    );
  })();

  return () => {
    closed = true;
    if (stopTail) {
      try { stopTail(); } catch { /* a teardown must never throw at a caller */ }
      stopTail = null;
    }
  };
}

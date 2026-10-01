// ─── BUILDING THE DAY ROLLUPS ────────────────────────────────────────────────
//
// One node per finished SA day at /insights_rollup/days/{YYYY-MM-DD}, holding
// that day's /insights_log rows, dictionary-encoded (rollupCodec.cjs). The
// screens expand them back into events and compute from them with the
// production selectors, so nothing downstream has to know this exists.
//
// ── A DAY NODE IS A PURE FUNCTION OF THAT DAY'S EVENTS ──────────────────────
//
// It is never merged into, never incremented, never patched. To bring a day up
// to date the builder re-reads that day and writes the node again. That is the
// whole consistency story, and it is deliberate:
//
//   · a rebuild is idempotent, so a crashed run costs a repeat, never a
//     double-count;
//   · two runs that overlap write the same bytes;
//   · an event written slightly out of order lands in ITS OWN day, because
//     membership is decided by the event's timestamp and not by when the
//     builder happened to notice it.
//
// The alternative, a running fold with a cursor, has to get merge order,
// partial failure and late arrival all right at once, and a fold that drifts
// is invisible: the numbers stay plausible.
//
// The running counter is the ONE thing here that is a fold rather than a
// recomputation, and it is therefore the one thing overlapping runs could get
// wrong — so it does not ride in the atomic update with everything else. It is
// advanced by a TRANSACTION that only applies if the cursor is still where
// this run read it. See commitMeta below. (Sonnet architect re-review.)
//
// What a rebuild costs, measured rather than guessed: a day is fetched by a
// key range padded 48 hours at BOTH ends, so re-reading one day reads about
// 2.7 days of rows — 919 KB on the live node. A run rebuilds two or three
// days, so the sweep costs roughly 2.8 MB a run and 11 MB a day against the
// 3.5 GB a day it removes from the clients.
//
// ── WHICH DAYS GET REBUILT ──────────────────────────────────────────────────
//
// 1. Every SA date named by events that landed since the high-water key, minus
//    today. This is what catches a `collected` written a week after its sale.
// 2. Yesterday and the day before, every run — the day that was "today" when
//    its events were discovered has to be built by somebody, and this is who.
// 3. Any of the last BACKSTOP_DAYS with no node at all, which is how a run of
//    outages heals itself without anyone noticing it happened.
//
// Today is never built. The screens read today live, bounded to today, because
// a day still being written to would otherwise be served stale.
//
// ── KEY RANGE, THEN FILTER ON THE TIMESTAMP ─────────────────────────────────
//
// A day's rows are fetched by KEY range, because push keys are the only index
// this node has. Key time and event time disagree — measured at up to 725
// seconds behind and 24 hours ahead across 64,011 entries
// (src/insights/insightsLogRange.js) — so the range is padded by 48 hours at
// both ends and the rows are then filtered on `timestamp`. The range decides
// what is DOWNLOADED; the timestamp decides what is IN the day. Exactly the
// rule the client's bounded readers already follow.
//
// ── AND WHAT THE PAD CANNOT COVER, THE LATE BUCKET DOES ─────────────────────
//
// 48 hours covers every one of those 64,011 entries, and it is still a bound
// rather than a guarantee: a till that was offline for a week would write a
// `collected` whose key is seven days above its own timestamp, and rebuilding
// that day by key range would never look where the row actually is.
//
// Making the pad wider does not fix this; lateness has no ceiling. So the
// sweep watches for it. While walking what is new, any row whose KEY falls
// outside its own day's padded range is written to
// /insights_rollup/late/{date}/{pushKey} — keyed by the row's own push key, so
// re-discovering it rewrites the same bytes. Readers merge a day's node with
// its late bucket, in key order, and get the day the log would have given them.
//
// This is expected to stay empty. It exists so that if it ever is not, the
// rows are IN the figures and countable, rather than absent and plausible.
//
// ── AND A ROW WITH NO USABLE TIMESTAMP BELONGS TO NO DAY AT ALL ─────────────
//
// It still belongs to the LOG. The Insights sidebar counts every event the
// store has logged, and the Customers list walks every `placed` event without
// looking at a window, so a row whose timestamp is missing or unparseable is
// visible on those screens today. Dropping it because it has no day would
// change a number. It goes to /insights_rollup/late/undated/{pushKey}, which
// readers include whenever their window is all-time — which is the only window
// such a row can appear in, since every window filter compares its timestamp.

const { compactDay, storeBucketOf } = require("./rollupCodec.cjs");

const SA_OFFSET_MS = 2 * 60 * 60 * 1000;   // SA has no DST, so a fixed offset is exact
const DAY_MS = 24 * 60 * 60 * 1000;
const PAD_MS = 48 * 60 * 60 * 1000;

const ROLLUP_ROOT = "insights_rollup";
const DAYS_PATH = `${ROLLUP_ROOT}/days`;
const LATE_PATH = `${ROLLUP_ROOT}/late`;
/** Where a row with no usable timestamp goes. Not a date, on purpose: it sorts
 *  after every "YYYY-MM-DD" key, so a reader's date range never picks it up by
 *  accident — it has to be asked for. */
const UNDATED_BUCKET = "undated";
const CURSOR_PATH = `${ROLLUP_ROOT}/meta/cursor`;
// A tiny index of which days have a node, and how many rows each holds — as a
// whole and per store. It exists for two readers:
//
//   · the sweep, so "which days are missing?" is a 3 KB read of short keys
//     rather than a walk of the day nodes, which would download the entire
//     rollup once a run to answer a question about its index;
//   · the Insights sidebar, whose "N events in view" is NOT the window's count
//     but every event the store has ever logged. A screen that loads one day
//     cannot produce that from the day it loaded, and loading all of history to
//     render one number is the cost this whole change exists to remove.
const INDEX_PATH = `${ROLLUP_ROOT}/meta/built`;
// ─── THE WHOLE LOG'S RUNNING TOTALS ─────────────────────────────────────────
//
// The Insights sidebar shows "N events in view" — every event the store has
// ever logged, sliced by the store filter, whatever period is selected. A
// screen that loads one day cannot produce that.
//
// Summing the day index was the obvious source and it is wrong in a way that
// looks right: a day the backfill has not reached, or one the sweep has not
// built, is simply absent from the index and silently absent from the total —
// and late and undated rows belong to no day at all. (Fable-vs-spec review.)
//
// So the counter is kept over the WALK, which sees every row exactly once, and
// is stamped with the cursor it is exact as far as. A reader adds whatever has
// landed since that cursor, which is one bounded read of at most a few hours.
const LOG_TOTALS_PATH = `${ROLLUP_ROOT}/meta/logTotals`;
const BUILT_PATH = `${ROLLUP_ROOT}/meta/lastBuild`;

/** How far back a run will notice a day that has no node at all. */
const BACKSTOP_DAYS = 14;

/** Pages of /insights_log per run when catching up from the high-water key.
 *  A normal run reads one short page; this is the ceiling for a run after an
 *  outage, and it is reported rather than silently truncating. */
const MAX_CATCHUP_PAGES = 40;
const CATCHUP_PAGE = 5000;

const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";

/** The 8-char push-key prefix encoding `ms` — the same function the client
 *  uses (src/insights/insightsLogRange.js). */
function pushKeyForMs(ms) {
  let n = Math.max(0, Math.floor(Number(ms) || 0));
  let out = "";
  for (let i = 0; i < 8; i++) { out = PUSH_CHARS[n % 64] + out; n = Math.floor(n / 64); }
  return out;
}

/** "YYYY-MM-DD" in SA time for an ISO timestamp, or "" if it has none. */
function saDateOf(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + SA_OFFSET_MS).toISOString().slice(0, 10);
}

/** SA midnight, in epoch ms, that starts `dateStr`. */
function saDayStartMs(dateStr) {
  return Date.parse(`${dateStr}T00:00:00.000Z`) - SA_OFFSET_MS;
}

function saDateStringOf(ms) {
  return new Date(ms + SA_OFFSET_MS).toISOString().slice(0, 10);
}

/** `dateStr` moved by whole SA days. SA has no DST, so this is exact. */
function shiftSaDate(dateStr, days) {
  return saDateStringOf(saDayStartMs(dateStr) + days * DAY_MS);
}

/** Is this row's key inside the padded range its own day will be rebuilt from?
 *  False means a rebuild of that day would never see it — see the late bucket. */
function isWithinDayRange(key, dateStr) {
  const { startKey, endKey } = keyRangeForDate(dateStr);
  return key >= startKey && key <= endKey;
}

/** The key range that certainly contains every row belonging to `dateStr`. */
function keyRangeForDate(dateStr) {
  const start = saDayStartMs(dateStr);
  return {
    startKey: pushKeyForMs(start - PAD_MS),
    endKey: pushKeyForMs(start + DAY_MS + PAD_MS),
  };
}

/**
 * Rebuild one day from the log. Pure apart from `io.readKeyRange`.
 *
 * @returns {{path: string, node: object, rows: number}}
 */
async function buildDay(io, dateStr) {
  const { startKey, endKey } = keyRangeForDate(dateStr);
  const page = await io.readKeyRange(startKey, endKey);
  // KEY order is arrival order, and `groupCount`'s tie-break depends on it.
  const rows = page
    .filter((r) => r && r.value && saDateOf(r.value.timestamp) === dateStr)
    .map((r) => r.value);
  const node = compactDay(rows, {
    date: dateStr,
    anchorMs: saDayStartMs(dateStr),
    cursorEnd: page.length ? page[page.length - 1].key : null,
  });
  return {
    path: `${DAYS_PATH}/${dateStr}`,
    node,
    rows: rows.length,
    counts: { n: rows.length, ...node.byStore },
  };
}

/**
 * Decide which days this run must (re)build.
 *
 * @param {object} args
 * @param {string[]} args.touched SA dates named by events since the high-water key
 * @param {string[]} args.missing SA dates inside the backstop window with no node
 * @param {string} args.todaySA
 * @returns {string[]} sorted, de-duplicated, today excluded
 */
function datesToBuild({ touched = [], missing = [], todaySA }) {
  const yesterday = shiftSaDate(todaySA, -1);
  const dayBefore = shiftSaDate(todaySA, -2);
  const set = new Set([...touched, ...missing, yesterday, dayBefore]);
  set.delete(todaySA);
  // A date beyond today is a clock problem somewhere, not a day to build.
  return [...set].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < todaySA).sort();
}

/**
 * One sweep.
 *
 * `io` is the whole database surface, injected so this is testable against a
 * fake without an emulator:
 *   readCursor()                        -> string|null
 *   readKeyRange(startKey, endKey)      -> [{key, value}] in key order
 *   readPageAfter(key, limit)           -> [{key, value}] in key order
 *   listDayKeys()                       -> string[] (shallow, keys only)
 *   commit({ updates })                 -> void  (ONE multi-path update)
 */
async function runSweep({ io, nowMs, log = () => {} }) {
  const todaySA = saDateStringOf(nowMs);
  // The cursor this run starts from, and the value advanceCursor will insist
  // is still there before it folds this run's counts in.
  const cursorBefore = await io.readCursor();

  // ── 1. what has landed since last time ──────────────────────────────────
  const touched = new Set();
  const late = {};
  const seenByStore = { n: 0, pe: 0, trophy: 0, pine: 0, other: 0 };
  let cursor = cursorBefore;
  let pages = 0;
  let truncated = false;
  for (;;) {
    if (pages >= MAX_CATCHUP_PAGES) { truncated = true; break; }
    const page = await io.readPageAfter(cursor, CATCHUP_PAGE);
    pages += 1;
    if (!page || page.length === 0) break;
    // How many children the SERVER sent, which is not how many were new: the
    // inclusive lower bound re-sends the cursor's own row. Judging the end of
    // the node on the NEW count ends the walk one request in.
    const sent = typeof page.sent === "number" ? page.sent : page.length;
    for (const r of page) {
      if (r && r.value) {
        const b = storeBucketOf(r.value);
        seenByStore.n += 1;
        if (b) seenByStore[b] += 1;
        const d = saDateOf(r.value.timestamp);
        touched.add(d);
        // A row whose key is outside its own day's padded range would be
        // invisible to that day's rebuild; a row with no usable timestamp
        // belongs to no day at all. Both go where readers can still find them,
        // keyed by their own push key, so re-discovery is idempotent.
        if (r.key && (!d || !isWithinDayRange(r.key, d))) {
          late[`${LATE_PATH}/${d || UNDATED_BUCKET}/${r.key}`] = r.value;
        }
      }
      if (r && r.key) cursor = r.key;
    }
    if (sent < CATCHUP_PAGE) break;
  }

  // ── 2. days inside the backstop window that have no node ────────────────
  const have = new Set(await io.listDayKeys());
  const missing = [];
  for (let i = 1; i <= BACKSTOP_DAYS; i++) {
    const d = shiftSaDate(todaySA, -i);
    if (!have.has(d)) missing.push(d);
  }

  const dates = datesToBuild({ touched: [...touched], missing, todaySA });
  log(`insightsRollup: cursor ${cursorBefore || "(none)"} -> ${cursor || "(none)"}; building ${dates.length} day(s)`);

  // ── 3. rebuild, and commit the nodes WITH the cursor in one update ──────
  const updates = { ...late };
  let rows = 0;
  for (const d of dates) {
    const built = await buildDay(io, d);
    updates[built.path] = built.node;
    updates[`${INDEX_PATH}/${d}`] = built.counts;
    rows += built.rows;
  }
  // The cursor moves only in the same atomic update as the nodes the walk
  // justified. If this commit never lands, the next run rediscovers exactly
  // the same days and writes exactly the same bytes.
  updates[BUILT_PATH] = {
    at: new Date(nowMs).toISOString(),
    todaySA,
    days: dates,
    rows,
    truncated,
    lateRows: Object.keys(late).length,
  };
  // Day nodes, the index, the late bucket and the run record: all
  // recomputations, all idempotent, one atomic update. The cursor is NOT here
  // any more — it moves with the counter, which is a fold, and a fold has to
  // be applied exactly once.
  await io.commit({ updates });

  // ── THE CURSOR AND THE COUNTER MOVE TOGETHER, EXACTLY ONCE ──────────────
  //
  // Everything above can be redone safely; this cannot. Two runs that read the
  // same cursor and both add their own walk would count the overlap twice, and
  // a late commit from a shorter walk would drag the cursor BACKWARDS, so the
  // next run re-walks the gap and adds it again — a counter that is wrong for
  // ever with nothing to show it.
  //
  // So it is a compare-and-set: advance only if the cursor is still where this
  // run found it. A refused advance costs a repeat of a walk that has already
  // written its (idempotent) day nodes, and the cursor stays BEHIND the
  // aggregates rather than ahead of them — which is the safe direction.
  const advanced = await io.advanceCursor({
    expect: cursorBefore ?? null,
    cursor: cursor ?? null,
    seen: seenByStore,
    at: new Date(nowMs).toISOString(),
  });

  return {
    dates, rows, cursorBefore, cursor, truncated, advanced,
    late: Object.keys(late).length,
  };
}

module.exports = {
  ROLLUP_ROOT, DAYS_PATH, LATE_PATH, UNDATED_BUCKET, CURSOR_PATH, BUILT_PATH, INDEX_PATH,
  LOG_TOTALS_PATH,
  BACKSTOP_DAYS, MAX_CATCHUP_PAGES, CATCHUP_PAGE, PAD_MS,
  pushKeyForMs, saDateOf, saDayStartMs, saDateStringOf, shiftSaDate, keyRangeForDate,
  isWithinDayRange,
  buildDay, datesToBuild, runSweep,
};

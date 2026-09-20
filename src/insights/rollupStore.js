// ─── FETCHING A WINDOW: DAY NODES, LIVE RANGES, AND A CACHE THAT PAYS OFF ────
//
// planWindow (rollupWindow.js) decides WHAT a window needs. This gets it.
//
// ── EVERY READ IS BOUNDED, AND THE RULE IS NOT WHY ──────────────────────────
//
// /insights_rollup is read by key range over the day index and by exact path
// for a run of days; /insights_log by the padded key ranges the plan produced.
// The read rule on /insights_log (RULES-INSIGHTS-LOG-QUERY.md) would insist on
// it anyway, but the reason is the bill: 35.99 MB per Insights mount, 97 times
// a day, was $3.19.
//
// ── A FINISHED DAY NEVER CHANGES, SO IT IS CACHED FOR THE SESSION ───────────
//
// That is the property that makes changing the period cheap. Moving from Today
// to This Week fetches six day nodes; moving back fetches nothing; moving to
// This Month fetches the twenty-three it does not already hold. The cache holds
// the COMPACT nodes, not the expanded events — about a fifth of the bytes and,
// more to the point, not 113,000 live objects on a tablet that is also running
// the till.
//
// It is not a correctness cache. A day node is immutable once the sweep has
// written it, with one exception — a rebuild, which only happens for the last
// couple of days — so `todaySA` and the two days before it are never taken from
// the cache. Everything older is.
//
// ── WHAT IS NOT CACHED ──────────────────────────────────────────────────────
//
// The live ranges. They cover today, which is still being written to, and a
// partial day at a window edge. They are read every time.
//
// ── IF THE ROLLUP CANNOT BE READ AT ALL, THE SCREENS STILL WORK ─────────────
//
// /insights_rollup is a new node and needs its own read rule, which is pasted
// into the console by hand. Between a hosting deploy and that paste, every
// read here is PERMISSION_DENIED — and a screen that showed an error for that
// window would be a worse outcome than the bill it is fixing.
//
// So an unreadable rollup is not an error: it degrades to reading the whole
// window from /insights_log, by bounded key range, which is exactly what the
// screens did before this change. It costs what it used to cost and it is
// reported on the result as `degraded`, so nobody mistakes a missing rule for
// a working rollup.

import {
  get, limitToFirst, orderByKey, query, ref, startAfter, startAt, endAt,
} from "firebase/database";
import { database } from "../firebase";
import { expandDay, storeBucketOf } from "./rollupCodec";
import {
  planWindow, rowsInRange, mergeNewestFirst, liveRangeFor, UNDATED_BUCKET, shiftSaDate,
} from "./rollupWindow";

export const ROLLUP_ROOT = "insights_rollup";
export const DAYS_PATH = `${ROLLUP_ROOT}/days`;
export const INDEX_PATH = `${ROLLUP_ROOT}/meta/built`;
export const LATE_PATH = `${ROLLUP_ROOT}/late`;
export const LOG_TOTALS_PATH = `${ROLLUP_ROOT}/meta/logTotals`;

/** Day nodes per request when a window needs a run of them. A month is 30 and
 *  a year is 365; at ~72 KB a node, 60 keeps one response around 4 MB. */
export const DAYS_PAGE = 60;

/** Rows per request on the live log. Matches the read rule's ceiling. */
export const LOG_PAGE = 10000;

// date -> compact node. Module-level, so it survives a screen unmounting and
// remounting — which is exactly what happens when somebody flips between
// Insights and Customers.
const dayCache = new Map();

/** Days this recent may still be rebuilt by the sweep, so they are re-read. */
const VOLATILE_DAYS = 2;

export function _clearRollupCacheForTests() { dayCache.clear(); }
export function _cachedDayCountForTests() { return dayCache.size; }

/** The small index: which days have a node, and how many rows each holds.
 *  Short keys, a few KB. It answers "which days are missing" — NOT the
 *  sidebar's all-time total, which comes from the sweep's own running counter
 *  (see readWindow). */
export async function readDayIndex() {
  const snap = await get(query(ref(database, INDEX_PATH), orderByKey()));
  return snap.val() || {};
}

/** All-time per-store totals from the index, plus whatever the window read
 *  found live. `pe + trophy + pine + other === n`, by construction. */
/** Does this event belong to `dateStr` in SA time? */
function inDay(e, dateStr) {
  const ms = Date.parse(e && e.timestamp);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms + 2 * 60 * 60 * 1000).toISOString().slice(0, 10) === dateStr;
}

export function totalsFromIndex(index) {
  const out = { n: 0, pe: 0, trophy: 0, pine: 0, other: 0 };
  for (const v of Object.values(index || {})) {
    if (!v || typeof v !== "object") continue;
    for (const k of Object.keys(out)) out[k] += Number(v[k]) || 0;
  }
  return out;
}

async function readDayNodes(dates) {
  if (dates.length === 0) return;
  // Contiguous runs are fetched as ONE key range; a scattered set falls back to
  // per-day reads. Windows are contiguous by construction, so the first branch
  // is the normal one.
  const sorted = dates.slice().sort();
  let i = 0;
  while (i < sorted.length) {
    const slice = sorted.slice(i, i + DAYS_PAGE);
    const snap = await get(query(
      ref(database, DAYS_PATH),
      orderByKey(), startAt(slice[0]), endAt(slice[slice.length - 1]),
      limitToFirst(DAYS_PAGE),
    ));
    snap.forEach((child) => { dayCache.set(child.key, child.val()); });
    i += DAYS_PAGE;
  }
}

/** Returns {key, value} pairs: the KEYS are what the caller's live tail needs
 *  to know it has already seen a row. Rollup rows carry no key and need none —
 *  a finished day is not something the tail can re-offer. */
async function readLogRange({ startKey, endKey }) {
  const rows = [];
  let after = null;
  for (;;) {
    const parts = [orderByKey()];
    parts.push(after === null ? startAt(startKey) : startAfter(after));
    parts.push(endAt(endKey), limitToFirst(LOG_PAGE));
    const snap = await get(query(ref(database, "insights_log"), ...parts));
    let n = 0;
    let last = after;
    snap.forEach((child) => { rows.push({ key: child.key, value: child.val() }); last = child.key; n += 1; });
    if (n < LOG_PAGE || last === after) break;
    after = last;
  }
  return rows;
}

/** {key, value} pairs — the keys go into the de-duplication set the caller's
 *  live tail uses. A late row's push key is by definition recent, so it can
 *  easily still be inside the tail's window; without its key it would arrive
 *  once from here and once from the tail. (Sonnet architect review.) */
async function readUndated() {
  const snap = await get(query(
    ref(database, `${LATE_PATH}/${UNDATED_BUCKET}`), orderByKey(), limitToFirst(LOG_PAGE),
  ));
  const rows = [];
  snap.forEach((child) => { rows.push({ key: child.key, value: child.val() }); });
  return rows;
}

async function readLate({ from, to }) {
  if (!from || !to || from > to) return [];
  const snap = await get(query(
    ref(database, LATE_PATH), orderByKey(), startAt(from), endAt(to),
  ));
  const rows = [];
  // /insights_rollup/late/{date}/{key} — two levels, and expected to be empty.
  // See the builder's header for when it is not.
  snap.forEach((day) => { day.forEach((child) => { rows.push({ key: child.key, value: child.val() }); }); });
  return rows;
}

/** The whole log's running totals, maintained by the sweep's own walk. */
async function readLogTotals() {
  const snap = await get(ref(database, LOG_TOTALS_PATH));
  return snap.val();
}

/**
 * Everything the window needs, as events, newest-first.
 *
 * @returns {{ log: Array, plan: object, fromRollup: number, fromLive: number,
 *             corruptDays: string[], liveKeys: Set<string>, totals: object }}
 */
export async function readWindow({ startIso, endIso, nowMs, allTime = false, io = null }) {
  const readers = io || {
    readDayIndex, readDayNodes, readLogRange, readUndated, readLate, readLogTotals,
    getCached: (d) => dayCache.get(d),
  };

  let index = {};
  let degraded = null;
  try {
    index = await readers.readDayIndex();
  } catch (err) {
    // No rule yet, or the node is gone. Every day becomes a live range below.
    console.warn("insights rollup: index unreadable, falling back to the log —", err);
    degraded = "index";
    index = {};
  }
  const haveDays = Array.isArray(index) ? index : Object.keys(index || {});
  const plan = planWindow({ startIso, endIso, nowMs, haveDays, allTime });

  // A day the sweep may still rebuild is never served from the cache.
  const volatileFrom = shiftSaDate(plan.todaySA, -VOLATILE_DAYS);
  const needed = plan.days.filter((d) => d >= volatileFrom || readers.getCached(d) === undefined);
  try {
    await readers.readDayNodes(needed);
  } catch (err) {
    // Same reasoning as the index: the days simply become live ranges.
    console.warn("insights rollup: day nodes unreadable, falling back to the log —", err);
    degraded = degraded || "days";
  }

  const parts = [];
  const corruptDays = [];
  let fromRollup = 0;
  for (const d of plan.days) {
    const node = readers.getCached(d);
    const rows = node ? expandDay(node) : null;
    if (!rows) {
      // A node that will not expand — an unknown shape, a dangling dictionary
      // index — is NOT an empty day. Read it live instead and say which day it
      // was; rendering it as zero is indistinguishable from a quiet Tuesday.
      corruptDays.push(d);
      continue;
    }
    fromRollup += rows.length;
    parts.push(rows);
  }

  // Anything the rollup could not serve, plus today and the window's edges.
  // A corrupt day is simply its own live range — the day is wholly inside the
  // window (planWindow only ever returns whole days), so its bounds are the
  // day's own.
  const ranges = plan.liveRanges.concat(corruptDays.map(liveRangeFor));

  let fromLive = 0;
  // Every key a live read returned, INCLUDING the ones the padding dragged in
  // and the window then dropped. The caller's tail de-duplicates on this, and
  // a key it has not got is a row it has genuinely not seen.
  const liveKeys = new Set();
  for (const r of ranges) {
    const page = await readers.readLogRange(r);
    for (const p of page) if (p && p.key) liveKeys.add(p.key);
    const rows = rowsInRange(page.map((p) => p.value), r);
    fromLive += rows.length;
    parts.push(rows);
  }

  // ── THE ALL-TIME TOTAL THE SIDEBAR SHOWS ────────────────────────────────
  //
  // "N events in view" is every event the store has ever logged, sliced by the
  // store filter — not the window's count. A screen that loads one day cannot
  // produce it from the day it loaded.
  //
  // It does NOT come from summing the day index. That was the first attempt and
  // it is wrong in a way that looks right: a day the backfill has not reached,
  // or one the sweep has not built yet, is simply absent from the index and
  // silently absent from the total, with nothing to say so — and late and
  // undated rows are in no day at all. (Fable-vs-spec review.)
  //
  // It comes from a counter the sweep keeps over its own walk of the log:
  // exact as far as its cursor, which is where the walk stopped. Everything
  // after that cursor is one bounded read — at most the few hours since the
  // last sweep — counted here. Exact, and a few KB.
  let totals = null;
  let liveKeys2 = null;
  try {
    const stored = await readers.readLogTotals();
    if (stored && typeof stored === "object" && stored.cursor) {
      totals = { n: 0, pe: 0, trophy: 0, pine: 0, other: 0 };
      for (const k of Object.keys(totals)) totals[k] = Number(stored[k]) || 0;
      const sinceRange = { startKey: stored.cursor, endKey: "\uffff", startMs: 0, endMs: 0 };
      const since = await readers.readLogRange(sinceRange);
      liveKeys2 = since;
      for (const p of since) {
        // startAt is inclusive, so the cursor's own row comes back and is
        // already counted in `stored`.
        if (!p || !p.key || p.key === stored.cursor || !p.value) continue;
        const b = storeBucketOf(p.value);
        totals.n += 1;
        if (b) totals[b] += 1;
      }
    }
  } catch (err) {
    console.warn("insights rollup: the log totals could not be read —", err);
    degraded = degraded || "totals";
  }

  // ── THE LATE AND UNDATED BUCKETS ────────────────────────────────────────
  //
  // Expected to be empty. Asked for across EVERY day the window touches, not
  // just the days served from a node: a late row is by definition one whose
  // key sits outside its own day's padded range, which is exactly the row a
  // live range cannot find either. (Sonnet architect review.)
  //
  // Their keys go into the de-duplication set for the same reason — a late
  // row's push key is recent, so the caller's tail can offer it again.
  let late = [];
  let undated = [];
  try {
    late = await readers.readLate(plan.lateDates);
    if (plan.includeUndated) undated = await readers.readUndated();
  } catch (err) {
    console.warn("insights rollup: late buckets unreadable —", err);
    degraded = degraded || "late";
  }
  for (const p of late) if (p && p.key) liveKeys.add(p.key);
  for (const p of undated) if (p && p.key) liveKeys.add(p.key);
  if (liveKeys2) for (const p of liveKeys2) if (p && p.key) liveKeys.add(p.key);
  const lateRows = late.map((p) => p.value).filter(Boolean);
  const undatedRows = undated.map((p) => p.value).filter(Boolean);
  if (lateRows.length) parts.push(lateRows);
  if (undatedRows.length) parts.push(undatedRows);

  return {
    log: mergeNewestFirst(parts), plan, fromRollup, fromLive, corruptDays, liveKeys,
    totals, degraded,
  };
}


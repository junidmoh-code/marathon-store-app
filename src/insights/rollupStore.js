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

/** The small index: which days have a node, and how many rows each holds as a
 *  whole and per store. Short keys, a few KB — and it is what the Insights
 *  sidebar's all-time total is built from, since a screen that loads one day
 *  cannot count every event the store has ever logged from the day it loaded. */
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

async function readUndated() {
  const snap = await get(query(
    ref(database, `${LATE_PATH}/${UNDATED_BUCKET}`), orderByKey(), limitToFirst(LOG_PAGE),
  ));
  const rows = [];
  snap.forEach((child) => { rows.push(child.val()); });
  return rows;
}

async function readLate(dates) {
  if (dates.length === 0) return [];
  const sorted = dates.slice().sort();
  const snap = await get(query(
    ref(database, LATE_PATH),
    orderByKey(), startAt(sorted[0]), endAt(sorted[sorted.length - 1]),
  ));
  const rows = [];
  // /insights_rollup/late/{date}/{key} — two levels, and it is expected to be
  // empty. See the builder's header for when it is not.
  snap.forEach((day) => { day.forEach((child) => { rows.push(child.val()); }); });
  return rows;
}

/**
 * Everything the window needs, as events, newest-first.
 *
 * @returns {{ log: Array, plan: object, fromRollup: number, fromLive: number,
 *             corruptDays: string[], liveKeys: Set<string>, totals: object }}
 */
export async function readWindow({ startIso, endIso, nowMs, allTime = false, io = null }) {
  const readers = io || {
    readDayIndex, readDayNodes, readLogRange, readUndated, readLate,
    getCached: (d) => dayCache.get(d),
  };

  const index = await readers.readDayIndex();
  const haveDays = Array.isArray(index) ? index : Object.keys(index || {});
  const plan = planWindow({ startIso, endIso, nowMs, haveDays, allTime });

  // A day the sweep may still rebuild is never served from the cache.
  const volatileFrom = shiftSaDate(plan.todaySA, -VOLATILE_DAYS);
  const needed = plan.days.filter((d) => d >= volatileFrom || readers.getCached(d) === undefined);
  await readers.readDayNodes(needed);

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
  // store filter — not the window's count. The index gives that for every day
  // that has a node; today never has one, so today is counted separately.
  //
  // For the default window (today) that read has already happened and costs
  // nothing extra. For a historical window it is one more bounded day — about
  // 335 KB against the 35.99 MB this change removes — and it is what keeps the
  // number on screen the same number as before rather than one that quietly
  // stops counting today.
  const totals = totalsFromIndex(index);
  const todayRange = liveRangeFor(plan.todaySA);
  const coversToday = ranges.some((r) => r.startMs <= todayRange.startMs && r.endMs >= todayRange.endMs);
  const todayRows = coversToday
    ? parts.flat().filter((e) => inDay(e, plan.todaySA))
    : rowsInRange((await readers.readLogRange(todayRange)).map((p) => p.value), todayRange);
  for (const e of todayRows) {
    const b = storeBucketOf(e);
    totals.n += 1;
    if (b) totals[b] += 1;
  }

  const late = await readers.readLate(plan.days);
  if (late.length) parts.push(late);
  if (plan.includeUndated) {
    const undated = await readers.readUndated();
    if (undated.length) parts.push(undated);
  }

  return {
    log: mergeNewestFirst(parts), plan, fromRollup, fromLive, corruptDays, liveKeys, totals,
  };
}


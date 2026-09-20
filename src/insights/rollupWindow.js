// ─── COMPOSING A WINDOW OUT OF DAY ROLLUPS AND LIVE READS ───────────────────
//
// A screen asks for "every event between these two instants". This decides
// where each part of that comes from:
//
//   · a finished SA day that lies WHOLLY inside the window, and has a rollup
//     node, comes from the node — about a fifth of the bytes;
//   · everything else — today, a partial day at either edge, a day whose node
//     is missing — comes from /insights_log by bounded key range.
//
// The result is the same events the whole-node read produced for that window,
// so the screens keep computing with the untouched production selectors.
//
// ── TODAY IS NEVER SERVED FROM A ROLLUP ─────────────────────────────────────
//
// The sweep does not build today, because today is still being written to.
// Every window that reaches into today has a live range covering it.
//
// ── A MISSING DAY IS A LOUD FALLBACK, NEVER A ZERO ──────────────────────────
//
// If a day inside the window has no node — the backfill has not reached it, the
// sweep has been down — that day becomes a live range and is named in
// `missingDays` so the caller can say so. Rendering a day as empty because its
// rollup is absent is the one outcome this must never produce: it is
// indistinguishable, on screen, from a quiet Tuesday.
//
// ── WHY THE LIVE RANGES ARE FILTERED ON TIME, NOT TRUSTED FROM THE KEY ──────
//
// A key range is padded by 48 hours at both ends (the measured key/timestamp
// skew — see insightsLogRange.js), so a live read for a gap WILL return rows
// belonging to days already served from rollups. Those rows are then dropped by
// timestamp, against the gap's exact bounds. Without that the same event would
// arrive twice — once from a node, once from the padding — and every count
// would be quietly too high. Rollup rows carry no key, so there is no key to
// de-duplicate on afterwards; the overlap has to be impossible rather than
// repaired.

import { PAD_MS, pushKeyForMs } from "./insightsLogRange";

const SA_OFFSET_MS = 2 * 60 * 60 * 1000;   // SA has no DST
const DAY_MS = 24 * 60 * 60 * 1000;

/** Where a row with no usable timestamp lives. Mirrors UNDATED_BUCKET in
 *  functions/insightsRollup/builder.cjs. */
export const UNDATED_BUCKET = "undated";

/** How far back the day scan looks. Four years — the log began 2026-05-04, so
 *  this is not a limit anybody meets; it is there so an all-time window cannot
 *  turn into a walk from the year zero. Anything older is read live. */
export const MAX_SCAN_DAYS = 1500;

export function saDateStringOf(ms) {
  return new Date(ms + SA_OFFSET_MS).toISOString().slice(0, 10);
}

export function saDayStartMs(dateStr) {
  return Date.parse(`${dateStr}T00:00:00.000Z`) - SA_OFFSET_MS;
}

export function shiftSaDate(dateStr, days) {
  return saDateStringOf(saDayStartMs(dateStr) + days * DAY_MS);
}

/**
 * @param {object} args
 * @param {string} args.startIso window start, inclusive (the screen's filterStart)
 * @param {string} args.endIso   window end, exclusive (the screen's filterEnd)
 * @param {number} args.nowMs
 * @param {Set<string>|string[]} args.haveDays dates with a rollup node
 * @param {boolean} [args.allTime] the caller wants everything, including rows
 *        that belong to no day
 * @returns {{
 *   days: string[], missingDays: string[],
 *   liveRanges: {startMs:number,endMs:number,startKey:string,endKey:string}[],
 *   includeUndated: boolean, todaySA: string,
 * }}
 */
export function planWindow({ startIso, endIso, nowMs, haveDays, allTime = false }) {
  const have = haveDays instanceof Set ? haveDays : new Set(haveDays || []);
  const todaySA = saDateStringOf(nowMs);

  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  // An unusable window is not an empty one: fall back to a single live range
  // covering everything the caller could have meant.
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return {
      days: [], missingDays: [], includeUndated: allTime, todaySA,
      lateDates: { from: "0000-01-01", to: "9999-12-31" },
      liveRanges: [liveRange(0, nowMs + DAY_MS)],
    };
  }

  // Candidate days: those whose SA day lies wholly inside the window, are
  // finished, and are not today.
  //
  // The scan is bounded BY TIME, not by the days we happen to have. Bounding it
  // by the rollup's own span was the obvious thing and it is wrong: a day that
  // is missing from the middle of the span is exactly what has to be noticed,
  // and one missing from the START would have been skipped silently. MAX_SCAN
  // keeps an all-time window from walking forward from the year zero; days
  // older than it are read live, which is correct, just not cheap.
  const days = [];
  const missingDays = [];
  const covered = [];

  // The scan bounds are computed in MILLISECONDS and clamped before they are
  // turned into dates. "All time" arrives here as the year 0 and the year 9999,
  // and `new Date(...).toISOString()` renders a five-digit year as
  // "+010000-01-01…" — a string that sorts BELOW "2026-…" and quietly made the
  // whole scan empty. Clamping first, formatting second.
  const scanFromMs = Math.max(startMs, saDayStartMs(shiftSaDate(todaySA, -MAX_SCAN_DAYS)));
  const scanToMs = Math.min(endMs, saDayStartMs(todaySA));
  const firstCandidate = saDateStringOf(scanFromMs);
  const lastCandidate = saDateStringOf(scanToMs);

  // A day is only MISSING if the rollup claims to cover its era. Outside the
  // span of days we have, an absent node is not a gap in the rollup — there is
  // simply no rollup there yet — and those days are read live, as one range
  // rather than as hundreds of complaints.
  const sortedHave = [...have].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const haveFirst = sortedHave[0] ?? null;
  const haveLast = sortedHave[sortedHave.length - 1] ?? null;

  if (scanFromMs < scanToMs) {
    for (let d = firstCandidate; d <= lastCandidate; d = shiftSaDate(d, 1)) {
      if (d >= todaySA) break;                       // today is never a rollup
      const s = saDayStartMs(d);
      const e = s + DAY_MS;
      if (s < startMs || e > endMs) continue;        // only WHOLE days inside
      if (!have.has(d)) {
        if (haveFirst && d >= haveFirst && d <= haveLast) missingDays.push(d);
        continue;
      }
      days.push(d);
      covered.push([s, e]);
    }
  }

  return {
    days,
    missingDays,
    includeUndated: allTime,
    todaySA,
    // EVERY SA day the window touches, not just the ones served from a node.
    // The late bucket exists for rows whose key sits outside their own day's
    // padded range — which is exactly the row a live range cannot find either,
    // so asking only about the rollup days would rescue those rows on the days
    // that least need rescuing and abandon them on the days that do.
    // (Sonnet architect review.)
    lateDates: {
      from: saDateStringOf(Math.max(startMs, saDayStartMs(shiftSaDate(todaySA, -MAX_SCAN_DAYS)))),
      to: saDateStringOf(Math.min(endMs, saDayStartMs(todaySA) + DAY_MS - 1)),
    },
    liveRanges: gapsOutside(startMs, endMs, covered).map(([s, e]) => liveRange(s, e)),
  };
}

function liveRange(startMs, endMs) {
  return {
    startMs,
    endMs,
    // Padded outward, because a row's key can sit up to 48 hours from its own
    // timestamp. The rows that padding drags in are dropped again by
    // rowsInRange().
    startKey: pushKeyForMs(startMs - PAD_MS),
    endKey: pushKeyForMs(endMs + PAD_MS),
  };
}

/** The live range covering one whole SA day. Used when a day's node exists but
 *  will not expand — an unknown shape, a dangling dictionary index — and the
 *  day has to be read from the log instead. */
export function liveRangeFor(dateStr) {
  const s = saDayStartMs(dateStr);
  return liveRange(s, s + DAY_MS);
}

/** [startMs, endMs) minus the covered intervals, as a list of gaps. */
export function gapsOutside(startMs, endMs, covered) {
  const sorted = covered.slice().sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let at = startMs;
  for (const [s, e] of sorted) {
    if (s > at) gaps.push([at, Math.min(s, endMs)]);
    at = Math.max(at, e);
    if (at >= endMs) break;
  }
  if (at < endMs) gaps.push([at, endMs]);
  return gaps.filter(([s, e]) => e > s);
}

/** Rows of a live read, reduced to the gap they were fetched for. */
export function rowsInRange(rows, { startMs, endMs }) {
  const out = [];
  for (const r of rows || []) {
    if (!r) continue;
    const ms = Date.parse(r.timestamp);
    // No usable timestamp means the row belongs to no window — it is served
    // from the undated bucket for all-time reads, and nowhere else.
    if (!Number.isFinite(ms)) continue;
    if (ms >= startMs && ms < endMs) out.push(r);
  }
  return out;
}

// Same contract as the provider's tsMs: null/NaN sorts oldest.
function tsMsLocal(v) {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : new Date(v).getTime();
  return Number.isNaN(n) ? 0 : n;
}

/**
 * The array the screens get: newest-first, exactly as the whole-node read
 * produced.
 *
 * The parts arrive in ascending-key order within themselves and in ascending
 * day order between themselves, which is the order the whole-node read's own
 * Object.values() had — so a stable sort by timestamp leaves equal timestamps
 * in the same relative order as before. That matters more than it looks:
 * `groupCount` sorts by count and leaves ties alone, so "Top Product" can be
 * decided by the order two events happened to arrive in.
 */
export function mergeNewestFirst(parts) {
  const all = [];
  for (const p of parts) if (p && p.length) all.push(...p);
  return all.sort((a, b) => tsMsLocal(b.timestamp) - tsMsLocal(a.timestamp));
}

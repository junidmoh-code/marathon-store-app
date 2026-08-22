// ─── SOCIAL — THE SELL-THROUGH SIGNAL ────────────────────────────────────────
// "What actually sells", read from the tills, for the social generator's
// ranking. Same source, same window and the same counting rules as
// scripts/shopify/sell-through.mjs — which is the point: two answers to "what
// moves" that disagree would be worse than one.
//
// ── WHY THE TILLS AND NOT THE STOREFRONT ─────────────────────────────────────
// The online store went live weeks ago and barely anybody has been to it, so
// ranking on web traffic would rank noise. The tills have rung up thousands of
// units. One sale is one /insights_log entry with action "ready".
//
// ── WHY 56 DAYS ──────────────────────────────────────────────────────────────
// Attribution needs `productId` on the event, and that field only became
// reliable through 2026-06 (6.5% in May, 68.2% in June, ~99.7% since). The name
// fallback that used to cover the gap is dead — the AI naming pass rewrote the
// titles the historic events were typed against. Eight weeks is the deepest
// clean window; anything longer is a floor rather than a total, and
// `coverage` is returned on every run so a degraded window announces itself
// instead of quietly ranking on a third of the data.
//
// ── HOW THE NODE IS READ (NO WHOLE-NODE READ) ────────────────────────────────
// /insights_log has no `.indexOn` in the live rules, so orderByChild is
// unavailable. Push keys encode write time, so orderByKey() IS a time range —
// the trick src/insights/insightsLogRange.js documents, with a 48-hour pad for
// key/timestamp skew. Pages run BACKWARDS from newest and stop at the first
// page whose oldest key already predates the window, so nothing older is ever
// downloaded. The result is CACHED (see the caller) so a generation run does
// not re-page the log.
"use strict";

const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
const PAD_MS = 48 * 60 * 60 * 1000;
const SA_OFFSET_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// The window, the page size and the page ceiling. MAX_PAGES is a bound, not a
// target: at ~64k live entries and 4,000 a page, 56 days is a handful of pages.
// Hitting the ceiling is reported by the caller rather than passed off as a
// complete window.
const WINDOW_DAYS = 56;
const PAGE = 4000;
const MAX_PAGES = 20;
// How long a computed signal is reused before it is recomputed. A day: sales
// ranking does not move meaningfully faster than that, and re-paging the log
// on every Generate tap would be the expensive mistake this cache exists to
// avoid.
const SIGNAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The 8-character push-key prefix encoding `ms`. Deliberately a byte-for-byte
 * twin of pushKeyForMs in src/insights/insightsLogRange.js — the browser module
 * is ESM and this file is required by a CJS Cloud Function. social-signal.test.cjs
 * pins the two equal across a table of instants; if they ever diverge, this
 * side silently downloads the wrong window.
 */
function pushKeyForMs(ms) {
  let n = Math.max(0, Math.floor(Number(ms) || 0));
  let out = "";
  for (let i = 0; i < 8; i++) {
    out = PUSH_CHARS[n % 64] + out;
    n = Math.floor(n / 64);
  }
  return out;
}

/** Lower-bound key for "the last `days` SA days", padded. Twin of the ESM copy. */
function recentDaysStartKey(days, nowMs) {
  const d = Math.max(0, Math.floor(Number(days) || 0));
  const saNow = Number(nowMs) + SA_OFFSET_MS;
  const saMidnight = Math.floor(saNow / DAY_MS) * DAY_MS;
  const startMs = saMidnight - d * DAY_MS - SA_OFFSET_MS - PAD_MS;
  return { startKey: pushKeyForMs(startMs), startMs };
}

/**
 * Page a log node backwards by key until its oldest key predates the window.
 *
 * `dbRef(path)` is injected so this is testable without Firebase. It must
 * return something with .orderByKey(), .endAt(), .limitToLast() and
 * .once("value") — i.e. an admin.database().ref().
 */
async function pageBackwards(dbRef, node, fromKey, wantAction) {
  const rows = [];
  let endBeforeKey = null;
  let pages = 0;
  let truncated = false;
  for (;;) {
    let q = dbRef(node).orderByKey();
    q = endBeforeKey ? q.endAt(endBeforeKey).limitToLast(PAGE + 1) : q.limitToLast(PAGE);
    const val = (await q.once("value")).val() || {};
    pages++;
    const keys = Object.keys(val).sort();
    if (endBeforeKey) {
      // The cursor row belongs to the previous page — endAt is inclusive.
      const i = keys.indexOf(endBeforeKey);
      if (i >= 0) keys.splice(i, 1);
    }
    if (keys.length === 0) break;
    for (const k of keys) {
      const e = val[k];
      if (!e || typeof e !== "object") continue;
      if (wantAction && e.action !== wantAction) continue;
      rows.push(e);
    }
    // The OLDEST key on this page still sorts at or above the window start ⇒
    // there is more inside the window further back. Deliberately keys[0], not
    // the newest: testing the newest would stop a page early.
    if (keys[0] < fromKey) break;
    endBeforeKey = keys[0];
    if (keys.length < PAGE) break;   // reached the start of the node
    if (pages >= MAX_PAGES) { truncated = true; break; }
  }
  return { rows, pages, truncated };
}

// ── COMPOSITE KEYS — MIRRORED FROM THE REORDER ENGINE, NOT INVENTED ─────────
// The till's orderNumber RESETS DAILY, so the number alone collides across
// days; and an undo/redo writes the same sale twice. The fix is a
// (SA-date, orderNumber) composite — and it has to be the SAME composite the
// rest of the project uses, or a sale and its return produce different keys and
// the return silently fails to cancel anything.
//
// Two details are load-bearing, and an earlier draft of this file got both
// wrong. They were caught by a test, not by review:
//
//   THE DATE IS THE SA CALENDAR DATE, not an ISO slice of the timestamp. SA is
//     UTC+2, so a sale rung up at 23:30 UTC belongs to the NEXT SA day. Slicing
//     the ISO string keys it to the wrong day — for every sale after 22:00
//     local, every day.
//
//   A RETURN PREFERS ITS OWN `date` FIELD over its timestamp. `date` is the
//     ORDER's date; `timestamp` is when the return was logged. Today they are
//     almost always the same day (returns in this shop are same-day reversals,
//     `ledgerNote: "reversed"`), but a return processed the morning after would
//     key to the wrong day and cancel nothing — or, worse, cancel a different
//     customer's order that reused the number.
//
// saDateStringFromMs is IMPORTED rather than re-derived: it is the project's
// one source for SA calendar dates and this file has no business having an
// opinion about the timezone.
const { saDateStringFromMs } = require("./sa-time.cjs");

const isoToMs = (iso) => {
  const ms = Date.parse(String(iso || ""));
  return Number.isFinite(ms) ? ms : NaN;
};
const saDateOf = (iso) => {
  const ms = isoToMs(iso);
  return Number.isFinite(ms) ? saDateStringFromMs(ms) : "";
};

/** The key for a SALE. Twin of eventCompositeKey in functions/index.js. */
function compositeKey(e) {
  const num = e && (e.orderNumber ?? e.order_number);
  if (num === undefined || num === null || num === "") return null;
  return `${saDateOf(e.timestamp)}::${num}`;
}

/** The key for a RETURN. Twin of returnCompositeKey in functions/index.js. */
function returnKey(r) {
  const num = r && (r.orderNumber ?? r.order_number);
  if (num === undefined || num === null || num === "") return null;
  const date = (r.date && String(r.date)) || saDateOf(r.timestamp);
  return `${date}::${num}`;
}

/**
 * Units sold per product id over the window.
 * Returns { unitsByPid, totalUnits, attributedUnits, coverage, events }.
 *
 * `coverage` is the share of counted units that carried a productId. Below 0.9
 * the ranking is a FLOOR, not a total — the caller records it on the signal
 * node so a degraded window is visible rather than inferred.
 */
function tallyUnits(readyRows, returnRows, fromIso, toIso) {
  const inWindow = readyRows.filter((e) => e && e.timestamp >= fromIso && e.timestamp < toIso);

  // Returns first: a returned sale is not a sale, and dropping it after
  // de-duplication would be wrong the other way round (an undo pair whose
  // survivor was returned).
  const returned = new Set();
  for (const r of returnRows || []) {
    if (!r || typeof r !== "object") continue;
    if (r.timestamp && (r.timestamp < fromIso || r.timestamp >= toIso)) continue;
    const k = returnKey(r);
    if (k) returned.add(k);
  }

  const seen = new Set();
  const events = [];
  for (const e of inWindow) {
    const k = compositeKey(e);
    // An event with no order number cannot be de-duplicated OR matched against
    // a return. It is counted once — dropping it would understate the tills,
    // and the alternative (counting it many times) is worse.
    if (k) {
      if (returned.has(k)) continue;
      if (seen.has(k)) continue;
      seen.add(k);
    }
    events.push(e);
  }

  // ── A PRODUCT ID BECOMES AN RTDB KEY, SO IT MUST BE A LEGAL ONE ──────────
  // unitsByPid is written straight to /social_signal, where each pid is a KEY.
  // RTDB rejects keys containing . # $ / [ ] — and rejects the WHOLE write, not
  // the offending child. One malformed event anywhere in the 58-day window
  // ("SKU.123" typed into a till) therefore made the cache write throw, which
  // meant the signal was never cached, which meant every subsequent run
  // re-paged the entire log and threw again. The signal would be dead until
  // someone cleaned the log by hand. Same class as the retryHistory outage:
  // never let free text reach an RTDB key.
  //
  // Such an event still counts toward totalUnits (it was a real sale) but
  // cannot be attributed, which is exactly what `coverage` is for.
  const ILLEGAL_KEY = /[.#$/[\]]/;
  const unitsByPid = {};
  let totalUnits = 0, attributedUnits = 0, illegalPids = 0;
  for (const e of events) {
    const u = Math.max(1, Number(e.qty) || 1);
    totalUnits += u;
    const pid = typeof e.productId === "string" ? e.productId.trim() : "";
    if (!pid) continue;
    if (ILLEGAL_KEY.test(pid)) { illegalPids++; continue; }
    attributedUnits += u;
    unitsByPid[pid] = (unitsByPid[pid] || 0) + u;
  }
  return {
    unitsByPid,
    totalUnits,
    attributedUnits,
    coverage: totalUnits ? attributedUnits / totalUnits : 0,
    events: events.length,
    illegalPids,
  };
}

module.exports = {
  PUSH_CHARS, PAD_MS, WINDOW_DAYS, PAGE, MAX_PAGES, SIGNAL_TTL_MS,
  pushKeyForMs, recentDaysStartKey, pageBackwards, compositeKey, returnKey, tallyUnits,
};

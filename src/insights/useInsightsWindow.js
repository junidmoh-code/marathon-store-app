// ─── THE HOOK THE THREE ALL-TIME SCREENS USE ─────────────────────────────────
//
// Replaces `useInsightsLog()` — which downloaded all 35.99 MB of the node, ~97
// times a day, $3.19 — with a read of the window the screen is actually
// showing: rollup nodes for the finished days, a bounded live read for today
// and for any partial day at the edges.
//
// MEASURED on the live node, 2026-09-20, part by part rather than estimated.
// A default Insights mount (day mode, today, widened to yesterday for the
// Overview deltas):
//
//   yesterday, from its rollup node      82,423 B
//   today, one padded live key range    919,423 B
//   the day index                         8,992 B
//   the running totals + what is after
//     their cursor                            427 B
//                                      ───────────
//                                       1,011,265 B   against 35,990,882 B
//
// 97.2% less. All-time — Customers and the Admin product line — is the whole
// rollup plus today: 7.43 MB + 919 KB + the index, about 8.36 MB, 76.8% less.
// That one is the codec's saving and nothing more; a per-customer and a
// per-product index would take those two screens much further, and are the
// obvious next step rather than this one.
//
// Today's share is most of what is left, and it is a padded range: the key
// bound reaches 48 hours either side because a row's key can sit that far from
// its own timestamp. The rows that padding drags in are dropped by timestamp.
//
// What a screen gets back is the same array it got before, for that window:
// the same events, newest-first, in the same order. Every figure is still
// computed by the untouched production selectors from that array, which is why
// no number moves — and rollupWindow.test.js proves it against a real trading
// day rather than asserting it here.
//
// ── IT IS STILL LIVE ────────────────────────────────────────────────────────
//
// The read it replaces was a subscription, so a screen left open saw events
// land. A one-shot read would not, and "shows exactly what it shows today"
// covers that as much as it covers the numbers. So after the window is loaded,
// an onChildAdded tail follows /insights_log from a key a little below now,
// and rows that fall inside the window are appended. The tail is bounded, it
// delivers each row once, and it costs a few hundred bytes an event.
//
// The same backdating that the all-time reader has to allow for applies here
// (a device's push-key clock running behind — measured at up to 725 s in this
// repo), so the tail starts below `now` by the same pad and drops what it has
// already seen by key.
//
// ── A MIRRORED DEVICE READS NOTHING FROM THE NETWORK ────────────────────────
//
// If this device is serving /insights_log from its local copy (PRs #618/#620),
// the window comes from IndexedDB and the rollup is not touched at all. That is
// already the cheapest possible answer — the device downloaded the node once
// and follows it by change feed — and routing it back through the rollup would
// put it back on the network to save bytes it is no longer spending.
//
// ── A FAILED READ IS NOT AN EMPTY WINDOW ────────────────────────────────────
//
// Every figure on these screens is a count. An empty array renders as a quiet
// day rather than as an error, so a failed read keeps the last good array, sets
// `error`, and retries with a backoff — the same contract the all-time reader
// arrived at after review.

import { useEffect, useRef, useState } from "react";
import { onChildAdded, orderByKey, query, ref, startAt } from "firebase/database";
import { database } from "../firebase";
import { readWindow } from "./rollupStore";
import { isLegServing } from "../offline/serving";
import { storeBucketOf } from "./rollupCodec";
import { insertNewestFirst, TAIL_BACKDATE_PAD_MS, RETRY_BASE_MS, RETRY_MAX_MS } from "./insightsLogWholeRead";
import { pushKeyForMs } from "./insightsLogRange";
import { EMPTY_LOG } from "./InsightsLogContext";

/** The all-time counts, plus one event. Null stays null — an unknown total
 *  must not start counting from zero and look like a real one. */
function bumped(totals, bucket) {
  if (!totals) return totals;
  const next = { ...totals, n: (totals.n || 0) + 1 };
  if (bucket) next[bucket] = (next[bucket] || 0) + 1;
  return next;
}

// Same contract as everywhere else in this folder: null/NaN sorts oldest.
function tsMs(v) {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : new Date(v).getTime();
  return Number.isNaN(n) ? 0 : n;
}

/**
 * @param {object} args
 * @param {string} args.startIso window start, inclusive
 * @param {string} args.endIso   window end, exclusive
 * @param {boolean} [args.allTime] include rows that belong to no day
 * @param {boolean} [args.enabled] false while auth is not ready
 * @param {string} args.saDay the current SA date. NOT a timestamp: this is an
 *        effect dependency, and a millisecond clock would re-run the read on
 *        every render. A till is left open across midnight, though, so the day
 *        boundary has to move — the caller re-stamps this on a slow tick, the
 *        same way useInsightsLogRecentDays does.
 */
export function useInsightsWindow({ startIso, endIso, allTime = false, enabled = true, saDay }) {
  const [state, setState] = useState({
    log: EMPTY_LOG, loading: true, error: null, missingDays: [], corruptDays: [], totals: null,
  });
  // The tail appends to whatever the window read produced, so it needs the
  // current array without re-subscribing every time that array changes.
  const logRef = useRef(EMPTY_LOG);
  const seenRef = useRef(new Set());

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let retryTimer = null;
    let stopTail = null;

    // Stamped ONCE per read, not read from the clock on each use: the window,
    // the tail's lower bound and the "have I already got this row" test all
    // have to agree about when this read happened.
    const readAtMs = Date.now();
    const windowEndMs = Date.parse(endIso);
    const inWindow = (e) => {
      const ts = e && e.timestamp;
      if (typeof ts !== "string") return false;
      return ts >= startIso && ts < endIso;
    };

    const fromMirror = async () => {
      const [{ getMirrorDbHandle }, { readWholeLeg, MISS }] = await Promise.all([
        import("../offline/mirrorDbHandle"),
        import("../offline/localReads"),
      ]);
      const data = await readWholeLeg(await getMirrorDbHandle(), "insights");
      // MISS is "this copy cannot say", not "the log is empty". An empty array
      // would render every all-time figure as zero.
      if (data === MISS) throw new Error("offline mirror: insights leg cannot answer");
      const rows = Object.values(data || {}).filter(Boolean);
      const totals = { n: 0, pe: 0, trophy: 0, pine: 0, other: 0 };
      for (const e of rows) {
        const b = storeBucketOf(e);
        totals.n += 1;
        if (b) totals[b] += 1;
      }
      const log = rows
        .filter((e) => allTime || inWindow(e))
        .sort((a, b) => tsMs(b.timestamp) - tsMs(a.timestamp));
      return { log, plan: { missingDays: [], todaySA: null }, corruptDays: [], liveKeys: new Set(), totals };
    };

    const attempt = async (tryNo) => {
      try {
        const res = isLegServing("insights")
          ? await fromMirror()
          : await readWindow({ startIso, endIso, nowMs: readAtMs, allTime });
        if (cancelled) return;
        logRef.current = res.log;
        // The keys the live part of this read returned. The tail overlaps that
        // range on purpose (a backdated row has to be catchable), so without
        // this the overlapping rows would be counted twice.
        seenRef.current = res.liveKeys instanceof Set ? res.liveKeys : new Set();
        setState({
          log: res.log,
          loading: false,
          error: null,
          missingDays: res.plan.missingDays,
          corruptDays: res.corruptDays,
          // All-time per-store counts, for the sidebar's "N events in view".
          // The window the screen is looking at cannot produce that number, and
          // loading all of history to render it is the cost this change removes.
          totals: res.totals,
        });
        if (res.plan.missingDays.length || res.corruptDays.length) {
          // Loud, not silent: those days WERE read, from the log, so the
          // figures are right — but the rollup has a hole somebody should fix.
          console.warn(
            "insights rollup: read live instead of from a node —",
            { missing: res.plan.missingDays, corrupt: res.corruptDays },
          );
        }

        // The tail. Only worth opening for a window that reaches the present —
        // and never on a mirrored device, whose local copy has its own feed.
        if (windowEndMs >= readAtMs && !isLegServing("insights")) {
          const after = pushKeyForMs(readAtMs - TAIL_BACKDATE_PAD_MS);
          stopTail = onChildAdded(
            query(ref(database, "insights_log"), orderByKey(), startAt(after)),
            (child) => {
              if (cancelled) return;
              const key = child.key;
              if (seenRef.current.has(key)) return;
              seenRef.current.add(key);
              const row = child.val();
              if (!row) return;
              // The all-time total counts EVERY event, in or out of the
              // window. Leaving it at its mount-time value meant the rows on
              // screen grew through a trading day while the count above them
              // stayed still. (Sonnet architect review.)
              const bucket = storeBucketOf(row);
              if (!inWindow(row)) {
                setState((s) => ({ ...s, totals: bumped(s.totals, bucket) }));
                return;
              }
              logRef.current = insertNewestFirst(logRef.current, row);
              setState((s) => ({ ...s, log: logRef.current, totals: bumped(s.totals, bucket) }));
            },
            (err) => console.warn("insights rollup: tail failed:", err),
          );
        }
      } catch (err) {
        if (cancelled) return;
        console.warn("insights rollup: window read failed:", err);
        // Keep whatever is on screen. An empty array here renders as a quiet
        // day, which is worse than rendering nothing.
        setState((s) => ({ ...s, loading: false, error: err }));
        const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(3, tryNo));
        retryTimer = setTimeout(() => { retryTimer = null; attempt(tryNo + 1); }, wait);
      }
    };

    setState((s) => ({ ...s, loading: true }));
    attempt(0);

    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (stopTail) { try { stopTail(); } catch { /* teardown never throws */ } }
    };
  }, [startIso, endIso, allTime, enabled, saDay]);

  return state;
}

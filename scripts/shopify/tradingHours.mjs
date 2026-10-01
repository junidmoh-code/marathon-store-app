// ── When the Shopify reconciler runs (Mac mini) ─────────────────────────────
//
// launchd starts reconcile-runner.mjs every 2 minutes, around the clock. Most
// of those ticks find nothing to do, but they still read /shopify_publish (and,
// whenever anything is pending, far more): measured by the cost watch on 21–22
// Sep 2026 at ~6.4 MB an hour through the evening and ~1 MB an hour from 01:00
// to 05:00, with every shop shut and nobody pressing Publish.
//
// So, like refillHealthScan (functions: "every 60 minutes from 07:00 to 19:00",
// Africa/Johannesburg — PR #623), it works trading hours only:
//
//   07:00–19:00 SAST   every tick runs, exactly as before (19:00 included,
//                      the same last run the refill scan has)
//   06:30 SAST         ONE catch-up run, so anything published overnight is on
//                      the website before the doors open
//   otherwise          the tick exits at once: no database read, no Shopify
//                      call, no lock
//
// Nothing is lost by waiting: intent stays in /shopify_publish until a run
// applies it, and a run applies everything outstanding. A Publish pressed at
// 22:00 goes live at 06:30.
//
// SHOPIFY_RECONCILE_ALWAYS=1 in the environment runs every tick regardless —
// for a manual run at night, or if the owner wants the old behaviour back
// without a code change.

export const OPEN_MINUTE = 7 * 60;          // 07:00
export const CLOSE_MINUTE = 19 * 60;        // 19:00 — the 19:00 tick still runs
export const CATCH_UP_MINUTE = 6 * 60 + 30; // 06:30

// SAST is UTC+2 all year (no daylight saving).
function sast(ms) {
  const d = new Date(ms + 2 * 3600 * 1000);
  return {
    date: d.toISOString().slice(0, 10),
    minute: d.getUTCHours() * 60 + d.getUTCMinutes(),
    hour: d.getUTCHours(),
  };
}

/**
 * What this tick should do.
 *
 *   { run: true,  why: "trading-hours" | "catch-up" | "forced" }
 *   { run: false, why: "outside-trading-hours", logIdle }
 *
 * `state.catchUpDate` is the SAST date of the last catch-up run, so it happens
 * once a morning however many ticks land between 06:30 and 07:00.
 * `logIdle` is true on the first idle tick of each hour, so the log still
 * proves the schedule is alive without a line every two minutes all night.
 */
export function tickDecision({ now, state = {}, env = {} }) {
  const { date, minute, hour } = sast(now);
  if (env.SHOPIFY_RECONCILE_ALWAYS === "1") return { run: true, why: "forced" };
  if (minute >= OPEN_MINUTE && minute <= CLOSE_MINUTE + 1) return { run: true, why: "trading-hours" };
  if (minute >= CATCH_UP_MINUTE && minute < OPEN_MINUTE && state.catchUpDate !== date) {
    return { run: true, why: "catch-up", catchUpDate: date };
  }
  const idleKey = `${date}T${String(hour).padStart(2, "0")}`;
  return { run: false, why: "outside-trading-hours", logIdle: state.lastIdleLog !== idleKey, idleKey };
}

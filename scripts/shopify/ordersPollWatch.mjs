// ── Watchdog for the website-orders poller (pure core) ──────────────────────
//
// orders-poll.mjs runs inside every reconciler tick (reconcile-runner.mjs,
// launchd com.marathon.shopifyreconcile), about every 2 minutes from 07:00 to
// 19:00 SAST plus one 06:30 catch-up (tradingHours.mjs). Each run leaves one
// TOP-LEVEL line in logs/orders-poll.log:
//
//   2026/10/30, 17:57:57  orders: quiet (15 open)              ← a good run
//   2026/10/30, 15:02:50  orders: 0 new · 0 cancelled · …       ← a good run
//   2026/10/29, 10:05:07  ✗ orders poll failed: Token request…  ← a failed run
//   2026/10/29, 10:05:07  <head><title>504 Gateway Time-out…   ← body of the error (ignored)
//   2026/10/30, 15:04:54    ✓ #1864: fulfilled on Shopify…      ← detail of a run (indented, ignored)
//
// Nothing watched that file. On 29 Oct 2026 10:01–10:26 every run failed on a
// Shopify 504 and nobody knew; on 27 Oct the log "stopped" at 19:01, which was
// only the end of trading hours. This module decides, from the log text and the
// clock alone, whether the poller is down right now:
//
//   STALE      in trading hours and no new RUN line for 15 minutes (measured
//              from 07:00 at the earliest, so the overnight gap is never an
//              outage). Run lines only: a poller that crashes at start-up
//              every tick still writes stamped stack traces, which must not
//              count as a sign of life (architect + spec review).
//   FAILING    the last N runs (default 5) all failed. Failing runs come 1 to
//              4 minutes apart (29 Oct: 09:53, 09:54, 09:57, 09:58, 10:01), so
//              that is 5 to 20 minutes of failures.
//
// and, with the watchdog's state, whether to mail Junid: once when an outage
// starts, once when it is over. It is over only after RECOVER_RUNS good runs in
// a row (29 Oct had ONE good run, 10:12, in the middle of its outage: one good
// run would have meant two extra mails). A run whose summary counts per-order
// errors ("orders: … N ERROR(S)") is a good run: the poller ran. Outside trading hours it never mails (an
// outage still open at 19:00 stays open, and its recovery mail goes out in the
// morning once the poller is healthy again).

export const OPEN_MINUTE = 7 * 60;      // 07:00 SAST, the first trading-hours run
export const CLOSE_MINUTE = 19 * 60;    // 19:00 SAST, the last one
export const STALE_MS = 15 * 60 * 1000;
export const FAIL_RUNS = 5;
export const RECOVER_RUNS = 3;

const SAST_MS = 2 * 3600 * 1000;        // SAST is UTC+2 all year, no daylight saving

/** The SAST minute of the day and the epoch ms of that day's 07:00. */
export function sastClock(now) {
  const d = new Date(now + SAST_MS);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - SAST_MS;
  return { minute, openAt: midnight + OPEN_MINUTE * 60 * 1000 };
}

/** In trading hours: 07:00 to 19:00 SAST (19:00 included, as the runner). */
export function inTradingHours(now) {
  const { minute } = sastClock(now);
  return minute >= OPEN_MINUTE && minute <= CLOSE_MINUTE;
}

// The runner's stamp(): en-ZA, Africa/Johannesburg, "2026/10/30, 17:57:57".
const LINE = /^(\d{4})\/(\d{2})\/(\d{2}), (\d{2}):(\d{2}):(\d{2}) {2}(.*)$/;

/** Every stamped line → { at (epoch ms), text } — text keeps its indentation. */
export function parseLog(text) {
  const out = [];
  for (const raw of String(text || "").split("\n")) {
    const m = raw.match(LINE);
    if (!m) continue;
    const [, y, mo, d, h, mi, s, rest] = m;
    out.push({ at: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - SAST_MS, text: rest });
  }
  return out;
}

/**
 * The runs: one per top-level verdict line. `ok` is the run's summary
 * ("orders: …"); a top-level "✗ …" is a run that failed (Shopify refused, the
 * poll hung and was stopped, node could not start it). Indented lines are
 * details inside a run (a "✗ #1859: courier not booked" is the order's problem,
 * not the poller's), and the HTML of an error page is neither.
 */
export function runsOf(lines) {
  const runs = [];
  for (const l of lines) {
    if (/^orders: /.test(l.text)) runs.push({ at: l.at, ok: true, text: l.text });
    else if (/^✗ /.test(l.text)) runs.push({ at: l.at, ok: false, text: l.text });
  }
  return runs;
}

/**
 * What the log says right now.
 *   { inHours, stale, failing, down, healthy, lastLineAt, quietMs, runs }
 * `down` = stale or failing. `healthy` = not stale and the newest RECOVER_RUNS
 * runs were all good (an outage only ends on good runs in a row).
 * `lastLineAt` is the newest RUN line (stack traces and details are not runs).
 */
export function assess({ lines, now, staleMs = STALE_MS, failRuns = FAIL_RUNS, recoverRuns = RECOVER_RUNS }) {
  const inHours = inTradingHours(now);
  const all = runsOf(lines);
  const lastLineAt = all.length ? all[all.length - 1].at : null;
  const { openAt } = sastClock(now);
  const since = Math.max(lastLineAt ?? 0, openAt);
  const quietMs = now - since;
  const stale = inHours && quietMs >= staleMs;
  const lastN = all.slice(-failRuns);
  const failing = lastN.length === failRuns && lastN.every((r) => !r.ok);
  const lastGood = all.slice(-recoverRuns);
  const healthy = !stale && lastGood.length === recoverRuns && lastGood.every((r) => r.ok);
  return { inHours, stale, failing, down: stale || failing, healthy, lastLineAt, quietMs, runs: lastN };
}

const fmt = (ms) => new Date(ms + SAST_MS).toISOString().replace("T", " ").slice(0, 16);
const mins = (ms) => Math.round(ms / 60000);

/**
 * The watchdog's decision for this run.
 *   state: { outage: null | { since, reason } }
 *   → { mail: null | { subject, text }, state: next state, note: one log line }
 * The caller saves the new `state` BEFORE it sends the mail and puts the old
 * one back if the send fails, so a failed send is tried again on the next run.
 * Recovery counts only runs AFTER the outage began: the good runs from before a
 * poller died at 18:30 must not read as "working again" at 07:00 (architect
 * review 2).
 */
export function decide({ lines, now, state = {}, staleMs = STALE_MS, failRuns = FAIL_RUNS, recoverRuns = RECOVER_RUNS }) {
  const a = assess({ lines, now, staleMs, failRuns, recoverRuns });
  const outage = (state && typeof state === "object" && state.outage) || null;
  if (!a.inHours) return { mail: null, state: { outage }, note: `outside trading hours${outage ? " (an outage is still open)" : ""}`, assessment: a };

  const tail = a.runs.map((r) => `  ${fmt(r.at)}  ${r.text.slice(0, 160)}`).join("\n") || "  (no runs in the log)";
  if (a.down && !outage) {
    const reason = a.failing
      ? `the last ${failRuns} runs all failed`
      : `no new poll run in logs/orders-poll.log for ${mins(a.quietMs)} minutes`;
    const lastErr = a.failing ? a.runs[a.runs.length - 1].text.slice(0, 200) : null;
    return {
      mail: {
        subject: `Website orders poller is DOWN: ${reason}`,
        text: [
          `The website-orders poller (scripts/shopify/orders-poll.mjs, run by com.marathon.shopifyreconcile every 2 minutes) looks down since ${fmt(a.failing ? a.runs[0].at : a.lastLineAt ?? now)} SAST.`,
          "",
          `Why: ${reason}.`,
          lastErr ? `Latest error: ${lastErr}` : `Last poll run in the log: ${a.lastLineAt ? `${fmt(a.lastLineAt)} SAST` : "none"}.`,
          "",
          "While it is down, new website orders do not reach the app (no holds, no picks, no packing list) and nothing is fulfilled on Shopify.",
          "",
          "Last runs in the log:",
          tail,
          "",
          "Check: launchctl list | grep shopifyreconcile, and tail ~/marathon-store-app/logs/orders-poll.log and logs/shopify-reconcile.log.",
          "You get one more email when it is working again.",
        ].join("\n"),
      },
      state: { outage: { since: now, reason, startedAt: a.failing ? a.runs[0].at : a.lastLineAt } },
      note: `DOWN: ${reason} — mailing`,
      assessment: a,
    };
  }
  const began = outage ? Number(outage.startedAt ?? outage.since) || 0 : 0;
  const recovered = !!outage && a.healthy && runsOf(lines).slice(-recoverRuns).every((r) => r.at > began);
  if (recovered) {
    return {
      mail: {
        subject: "Website orders poller is working again",
        text: [
          `The website-orders poller is working again. Its last ${recoverRuns} runs were good (the latest ${fmt(a.runs[a.runs.length - 1].at)} SAST).`,
          "",
          `It was down from about ${fmt(began)} SAST (${outage.reason}), roughly ${mins(now - began)} minutes until this check.`,
          "Orders that came in meanwhile are picked up by the normal runs; nothing to do unless something looks missing.",
          "",
          "Last runs in the log:",
          tail,
        ].join("\n"),
      },
      state: { outage: null },
      note: "recovered — mailing",
      assessment: a,
    };
  }
  return { mail: null, state: { outage }, note: outage ? `still down (${outage.reason}); already mailed` : "ok", assessment: a };
}

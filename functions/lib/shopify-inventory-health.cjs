// ─── IS SHOPIFY STILL TELLING THE TRUTH ABOUT STOCK? (PURE) ──────────────────
// The decision half of shopifyInventoryHealthScan (functions/index.js), the
// watchdog Junid asked for on 2026-10-11 (docs/SHOPIFY-STOCK-TRUTH.md §4).
// It runs on Google's scheduler, never on the Mac mini — an alarm must not run
// on the machinery it watches — and reads two things the mini writes to
// /shopify_inventory_health:
//
//   lastPassAt  stamped by the reconciler every time a movement-ledger
//               inventory pass finishes with NO failures (reconcile.mjs)
//   lastSweep   the nightly stock-truth sweep's report (stock-truth-sweep.mjs)
//
// Three alarms, each its own signature so each fires once per incident and
// re-fires every six hours while it lasts (the poller watchdog's cadence):
//
//   pass        no successful inventory pass for 15+ minutes while the
//               reconciler is meant to be running (07:00–19:00 SAST; checked
//               from 07:15 to give the first ticks of the day room)
//   sweep       the last sweep found sizes Shopify would sell beyond the app,
//               was refused by its 25% guard, or could not correct something
//   sweepStale  no sweep has reported for 26+ hours — the nightly job is dead
//
// Kept away from firebase-admin and the clock so every case is tested as data
// (test/shopify-inventory-health.test.cjs).
"use strict";

const PASS_STALE_MS = 15 * 60 * 1000;
const SWEEP_STALE_MS = 26 * 60 * 60 * 1000;
const REALARM_MS = 6 * 60 * 60 * 1000;
// The reconciler's working day (scripts/shopify/tradingHours.mjs: 07:00–19:00
// plus the 19:00 tick). The pass alarm is judged inside this window only — a
// quiet night is the schedule, not an outage.
const PASS_WINDOW_START_MIN = 7 * 60 + 15;
const PASS_WINDOW_END_MIN = 19 * 60 + 2;

function sastMinute(ms) {
  const d = new Date(ms + 2 * 3600 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function shouldFire(lastAlarm, signature, nowMs) {
  if (!lastAlarm || lastAlarm.signature !== signature) return true;
  return nowMs - (Number(lastAlarm.at) || 0) >= REALARM_MS;
}

/** Did this sweep find anything that needs Junid to know? */
function sweepProblems(sweep) {
  if (!sweep) return [];
  const out = [];
  const f = sweep.found || {};
  if (sweep.refused) out.push(`the correction was REFUSED: ${sweep.refused}`);
  if ((f.oversellableUnits || 0) > 0) out.push(`${f.oversellableUnits} unit(s) on Shopify above what the app holds`);
  if ((f.unlimitedVariants || 0) > 0) out.push(`${f.unlimitedVariants} size(s) Shopify was not limiting at all (tracking off)`);
  const r = sweep.residual;
  if (r && ((r.oversellableUnits || 0) > 0 || (r.unlimitedVariants || 0) > 0)) {
    out.push(`STILL WRONG after correcting: ${r.oversellableUnits || 0} unit(s), ${r.unlimitedVariants || 0} unlimited size(s)`);
  }
  if ((sweep.commitFailures || []).length) out.push(`${sweep.commitFailures.length} listing(s) could not be corrected`);
  // A listing the sweep could not READ was never judged — it may be the one
  // overselling. Silence here would rebuild the original bug inside its check.
  if ((f.failed || 0) > 0) out.push(`${f.failed} listing(s) could not be checked (${(f.failures || []).slice(0, 3).join("; ")})`);
  return out;
}

/**
 * @param {number} nowMs     the server clock
 * @param {object} health    /shopify_inventory_health as stored
 * @returns {{ alarms: Array<{kind, signature, message}>, state: object, ok: boolean }}
 *   `state` is the alarm bookkeeping to write back at health/watchdog.
 */
function assessInventoryHealth({ nowMs, health }) {
  const h = health || {};
  const prev = h.watchdog?.lastAlarms || {};
  const alarms = [];
  const lastAlarms = { ...prev };

  // ── pass ──────────────────────────────────────────────────────────────────
  const minute = sastMinute(nowMs);
  const inWindow = minute >= PASS_WINDOW_START_MIN && minute <= PASS_WINDOW_END_MIN;
  const lastPassAt = Number.isFinite(h.lastPassAt) ? h.lastPassAt : null;
  const passAge = lastPassAt === null ? null : nowMs - lastPassAt;
  const passStale = inWindow && (passAge === null || passAge >= PASS_STALE_MS);
  if (passStale) {
    const signature = lastPassAt === null ? "never" : String(lastPassAt);
    if (shouldFire(prev.pass, signature, nowMs)) {
      alarms.push({
        kind: "pass", signature,
        message: (passAge === null
          ? "The Shopify inventory sync has NEVER completed a pass."
          : `The Shopify inventory sync has not completed a successful pass for ${Math.round(passAge / 60000)} minutes.`) +
          " Stock that sells in the shops is NOT reaching the website, so it can sell sizes the app no longer holds." +
          " Check the Mac mini is on and online, then: launchctl kickstart -k gui/501/com.marathon.shopifyreconcile" +
          " and read ~/marathon-store-app/logs/shopify-reconcile.log (failed products are named there).",
      });
      lastAlarms.pass = { at: nowMs, signature };
    }
  } else if (!inWindow) {
    // Outside the window the question is not asked; an alarm raised during
    // the day stays recorded so the morning does not re-announce it.
  } else if (prev.pass) {
    lastAlarms.pass = null; // recovered — the next outage is a new one
  }

  // ── sweep ─────────────────────────────────────────────────────────────────
  const sweep = h.lastSweep || null;
  const problems = sweepProblems(sweep);
  if (problems.length) {
    const signature = String(sweep.at);
    if (shouldFire(prev.sweep, signature, nowMs)) {
      const worst = (sweep.found?.worst || []).slice(0, 8)
        .map((w) => `${w.pid || w.gid}: ${(w.sizes || []).slice(0, 4).join("; ")}`).join(" | ");
      alarms.push({
        kind: "sweep", signature,
        message: `The nightly Shopify stock check found ${problems.join("; ")}.` +
          ` Auto-corrected: ${sweep.corrected || 0} listing(s)` +
          (sweep.commit ? "" : " (that run was a DRY RUN — nothing was written)") +
          (sweep.rollbackFile ? `; rollback file ${sweep.rollbackFile} on the mini` : "") +
          `. ${sweep.listed || 0} listings checked.` +
          (worst ? ` Worst: ${worst}.` : "") +
          " Full report: /shopify_inventory_health/lastSweep.",
      });
      lastAlarms.sweep = { at: nowMs, signature };
    }
  }

  // ── sweepStale ──────────────────────────────────────────────────────────────
  const sweepAt = Number.isFinite(sweep?.at) ? sweep.at : null;
  const sweepAge = sweepAt === null ? null : nowMs - sweepAt;
  if (sweepAge === null || sweepAge >= SWEEP_STALE_MS) {
    const signature = sweepAt === null ? "never" : String(sweepAt);
    if (shouldFire(prev.sweepStale, signature, nowMs)) {
      alarms.push({
        kind: "sweepStale", signature,
        message: (sweepAge === null
          ? "The nightly Shopify stock check has never reported."
          : `The nightly Shopify stock check has not reported for ${Math.round(sweepAge / 3600000)} hours.`) +
          " Nothing is catching what the per-tick sync misses. On the Mac mini:" +
          " launchctl kickstart -k gui/501/com.marathon.shopifystocksweep and read" +
          " ~/marathon-store-app/logs/shopify-stock-sweep.log.",
      });
      lastAlarms.sweepStale = { at: nowMs, signature };
    }
  } else if (prev.sweepStale) {
    lastAlarms.sweepStale = null;
  }

  return {
    alarms,
    ok: !passStale && !problems.length && sweepAge !== null && sweepAge < SWEEP_STALE_MS,
    passAgeMinutes: passAge === null ? null : Math.round(passAge / 60000),
    inWindow,
    state: { checkedAt: nowMs, lastAlarms },
  };
}

/** The log line Cloud Monitoring matches and emails. The marker is load-bearing. */
function alarmLine(alarm) {
  return `SHOPIFY_STOCK_ALARM [${alarm.kind}] ${alarm.message}`;
}

module.exports = {
  assessInventoryHealth, sweepProblems, alarmLine,
  PASS_STALE_MS, SWEEP_STALE_MS, REALARM_MS, PASS_WINDOW_START_MIN, PASS_WINDOW_END_MIN,
};

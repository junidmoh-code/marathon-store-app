// ─── IS THE MAILBOX POLLER ALIVE? (PURE) ─────────────────────────────────────
// On 2026-08-31 the Mac mini's launchd stopped firing the card recon poller at
// 01:16 with no error, no log line and no reboot — and the only witness was a
// heartbeat panel the owner has to open. This module is the DECISION half of
// the watchdog that fixes that: cardReconHealthScan (functions/index.js) runs
// on Google's scheduler — deliberately not on the mini, an alarm must not run
// on the machinery it watches — reads the poller's heartbeat, and asks this
// function what to do. Kept away from firebase-admin and the clock so the
// awkward cases (heartbeat missing entirely, a long outage, recovery, the
// re-alarm cadence) are testable as data.
//
// THE ALARM FIRES ONCE PER OUTAGE, NOT ONCE PER CHECK. The signature of an
// outage is the last heartbeat it strands — while that stays the same, one
// email; a long outage re-alarms every six hours so a Friday-night death is
// not one Friday-night email and silence all weekend. Recovery resets
// everything: the next outage is a new signature.
"use strict";

// The poller beats every ~2 minutes. Fifteen minutes of silence is seven
// missed beats — an outage, not a slow tick (the tick budget itself is 12).
const POLLER_STALE_MS = 15 * 60 * 1000;
// A continuing outage re-alarms this often.
const POLLER_REALARM_MS = 6 * 60 * 60 * 1000;

/**
 * @param {number}      nowMs      the server clock
 * @param {number|null} lastRunAt  heartbeat's lastRunAt (null = no heartbeat node at all)
 * @param {object|null} lastAlarm  { at, signature } — what was last alerted on
 * @returns {{ok:boolean, staleMinutes:number|null, alarm:boolean, signature:string|null, recovered:boolean}}
 */
function assessPollerHealth({ nowMs, lastRunAt, lastAlarm }) {
  const hasBeat = Number.isInteger(lastRunAt);
  const ageMs = hasBeat ? nowMs - lastRunAt : null;
  const ok = hasBeat && ageMs <= POLLER_STALE_MS;
  if (ok) {
    // `recovered` says an alarm went out for an outage that is now over — the
    // scan logs it (info, not the marker) so the log tells a whole story.
    return { ok: true, staleMinutes: Math.max(0, Math.round(ageMs / 60000)), alarm: false, signature: null, recovered: !!lastAlarm };
  }
  // The outage's identity is the heartbeat it stranded. A missing node gets a
  // constant one — "never" is one outage, however long it lasts.
  const signature = hasBeat ? String(lastRunAt) : "never";
  const alreadyAlarmed = lastAlarm?.signature === signature;
  const alarm = !alreadyAlarmed || (nowMs - (lastAlarm?.at ?? 0) > POLLER_REALARM_MS);
  return {
    ok: false,
    staleMinutes: hasBeat ? Math.round(ageMs / 60000) : null,
    alarm,
    signature,
    recovered: false,
  };
}

module.exports = { assessPollerHealth, POLLER_STALE_MS, POLLER_REALARM_MS };

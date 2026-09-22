// ─── OFFLINE MIRROR — A DEVICE NOBODY IS USING STOPS LISTENING ───────────────
//
// Measured 22 Sep 2026 (cost watch): with every shop shut, the bill still rose
// through the evening, partly from devices left open — a desktop tab behind
// another window, a tablet on a counter — holding their database connection and
// running a mirror pass every minute for nobody.
//
// On a MIRRORED device (the copy is complete, verified and serving — see
// servingDecision.js) nothing on screen needs the live connection to be
// correct: the rows are on disk. So after IDLE_MS of nobody using the device,
// this closes it — firebase's goOffline, which parks every listener the SDK
// holds, and the mirror's own pass loop and change signal — and reopens all of
// it the instant somebody comes back.
//
// ── WHAT COUNTS AS "NOBODY IS USING IT" ─────────────────────────────────────
//
//   HIDDEN for IDLE_MS — another tab, another app, a locked screen. At any
//     hour: nobody can be watching a page they cannot see.
//
//   VISIBLE but untouched for IDLE_MS — ONLY outside trading hours
//     (07:00–19:00 SAST). During the day a visible screen nobody is touching
//     is very often a screen somebody is WATCHING: the warehouse order queue,
//     the refill board. Freezing that would stop new orders appearing on it,
//     and staff would have no way to know. At night it is a device left on.
//
// ── WHEN IT NEVER SUSPENDS ──────────────────────────────────────────────────
//
//   - the device is not mirrored (not serving anything locally) — a live
//     device's screens need the live connection to show anything at all;
//   - anything is busy (updateChecker's busy registry: an assistant cart with
//     lines in it, an open count, a hub sneaker count, and the mirror's own
//     writes not yet confirmed by the feed) — a write that is queued or an
//     order in progress is never parked behind a suspend;
//   - the TV (#tv): it is always on and never touched, by design.
//
// ── NOTHING IS MISSED ───────────────────────────────────────────────────────
//
// Resume runs a mirror pass at once, which reads the change feed FROM THE
// CURSOR STORED ON THE DEVICE — every change made while it was suspended, and
// nothing it already has. goOnline re-subscribes the small live nodes the
// screens hold. Never a fresh download. (bootstrap.js suspendLive/resumeLive.)

export const IDLE_MS = 15 * 60 * 1000;
// How often the idle clock is looked at. Coarse on purpose: the deadline is
// fifteen minutes, and a check a minute costs nothing.
export const IDLE_CHECK_MS = 60 * 1000;
export const TRADING_OPEN_HOUR_SAST = 7;
export const TRADING_CLOSE_HOUR_SAST = 19;

// The activity that says "somebody is here". Passive listeners only.
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel", "focus"];

/** Hour of day in SAST (UTC+2, no daylight saving), 0–23. */
export function sastHour(ms) {
  return new Date(ms + 2 * 3600 * 1000).getUTCHours();
}

export function isTradingHours(ms) {
  const h = sastHour(ms);
  return h >= TRADING_OPEN_HOUR_SAST && h < TRADING_CLOSE_HOUR_SAST;
}

/**
 * Pure: should a device in this state be suspended right now?
 */
export function shouldSuspend({
  now, hidden, hiddenSince, lastActivityAt, mirrored, busy, watchSurface,
}) {
  if (!mirrored || busy || watchSurface) return false;
  if (hidden) return hiddenSince !== null && now - hiddenSince >= IDLE_MS;
  if (isTradingHours(now)) return false;
  return now - lastActivityAt >= IDLE_MS;
}

/**
 * Watch the page and suspend/resume through the injected functions.
 *
 * `suspend` and `resume` do the work (MirrorGate wires them to goOffline /
 * goOnline and the mirror runtime); this only decides WHEN. Returns a stop().
 */
export function startIdleSuspend({
  suspend, resume,
  isMirrored, isBusy,
  isWatchSurface = () => false,
  doc = typeof document !== "undefined" ? document : null,
  win = typeof window !== "undefined" ? window : null,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const hiddenNow = () => doc?.visibilityState === "hidden";
  let lastActivityAt = now();
  let hiddenSince = hiddenNow() ? now() : null;
  let suspended = false;

  const doResume = () => {
    if (!suspended) return;
    suspended = false;
    try { resume(); } catch (err) { console.warn("offline mirror: resume failed —", err?.message ?? err); }
  };

  const check = () => {
    if (suspended) {
      // Nothing on this device may go on believing it is mirrored once it is
      // not — a switch turned off from the office reaches a suspended device
      // only after it reconnects, but a hint dropped locally (sign-out, a
      // failed leg) must reopen the connection now.
      if (!isMirrored()) doResume();
      return;
    }
    const verdict = shouldSuspend({
      now: now(),
      hidden: hiddenNow(),
      hiddenSince,
      lastActivityAt,
      mirrored: isMirrored(),
      busy: isBusy(),
      watchSurface: isWatchSurface(),
    });
    if (!verdict) return;
    suspended = true;
    try { suspend(); } catch (err) {
      suspended = false;
      console.warn("offline mirror: suspend failed —", err?.message ?? err);
    }
  };

  const onActivity = () => {
    lastActivityAt = now();
    doResume();
  };
  const onVisibility = () => {
    if (hiddenNow()) { if (hiddenSince === null) hiddenSince = now(); return; }
    hiddenSince = null;
    onActivity();              // coming back to the page IS activity
  };

  doc?.addEventListener?.("visibilitychange", onVisibility);
  for (const e of ACTIVITY_EVENTS) win?.addEventListener?.(e, onActivity, { passive: true, capture: true });
  const interval = setIntervalFn(check, IDLE_CHECK_MS);

  return {
    check,
    isSuspended: () => suspended,
    stop() {
      clearIntervalFn(interval);
      doc?.removeEventListener?.("visibilitychange", onVisibility);
      for (const e of ACTIVITY_EVENTS) win?.removeEventListener?.(e, onActivity, { capture: true });
      doResume();
    },
  };
}

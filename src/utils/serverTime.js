// ─── SERVER-CORRECTED TIME ────────────────────────────────────────────────────
// The single source of truth for every timestamp this app WRITES.
//
// Why this module exists: on 2026-07-17 a till whose DATE was set one day behind
// (clock correct to the second, date 24h out) placed orders stamped "yesterday".
// Two things broke:
//   1. It reset the shared /orderCounter — its day key never matched the stored
//      one — re-issuing 001 and OVERWRITING live orders. 47 orders were destroyed
//      before the counter was pinned to server time (PR #236).
//   2. Its orders stamped createdAt in the past, so the warehouse queue (which
//      filters to "today") never showed them. The customer waited for an order
//      no picker could see.
//
// #236 fixed only the counter's day key. This module generalises that anchor:
// a device's clock must be irrelevant to the DATA it writes.
//
// /.info/serverTimeOffset is the RTDB server clock minus this device's clock.
// Adding it yields server time on a device with any clock. It is client-side
// metadata — no security rules, no round-trip, available while offline from the
// last connection — so this stays synchronous and can never block a sale.
//
// Deliberately dependency-free: App.jsx owns the single binding (it already
// holds the firebase handle) and pushes the offset in via setServerTimeOffsetMs.
// Importing firebase here would drag a live socket into every unit test of every
// module that needs a timestamp.
//
// NOT for elapsed time ("3 mins ago", timers, animations). Those subtract the
// device clock from itself, so a wrong clock cancels out; the offset only adds
// noise. Use Date.now() directly for durations.

// 0 until the first /.info/serverTimeOffset value lands. A 0 offset degrades to
// the device clock — the old behaviour — rather than blocking a sale.
let offsetMs = 0;

const SA_OFFSET_MS = 2 * 60 * 60 * 1000; // SA is UTC+2 year-round, no DST.

// A wrong clock no longer corrupts data (that's the point of this module), which
// means it also stops announcing itself. ClockWarningBanner subscribes here so a
// misconfigured device says so out loud instead of hiding. Kept as a plain
// listener set rather than a store: one value, a handful of subscribers.
const listeners = new Set();

export function setServerTimeOffsetMs(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return;
  if (v === offsetMs) return;
  offsetMs = v;
  for (const fn of listeners) {
    try { fn(offsetMs); } catch { /* a broken subscriber must never break a sale */ }
  }
}

export function getServerTimeOffsetMs() {
  return offsetMs;
}

/** Subscribe to offset changes. Fires immediately with the current value.
 *  Returns an unsubscribe fn. */
export function onServerTimeOffsetChange(fn) {
  listeners.add(fn);
  // Guarded like the notify loop: subscribing must not throw into the caller
  // (App's render tree) just because one subscriber is broken.
  try { fn(offsetMs); } catch { /* ignore */ }
  return () => listeners.delete(fn);
}

/** Epoch ms per the SERVER, regardless of this device's clock. */
export function serverNowMs() {
  return Date.now() + offsetMs;
}

/** ISO instant per the server — the value to persist. */
export function serverNowIso() {
  return new Date(serverNowMs()).toISOString();
}

/** "YYYY-MM-DD" in SA time, per the server. Shift then read UTC parts so the
 *  device's timezone never enters. */
export function saDateString() {
  return new Date(serverNowMs() + SA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Hour of day (0–23) in SA time, per the server. */
export function saHour() {
  return new Date(serverNowMs() + SA_OFFSET_MS).getUTCHours();
}

/** Counter day key. Output MUST stay byte-identical to saTodayKey() in
 *  functions/lib/refill-engine.cjs — the engine draws from the same
 *  /refillCounter, and if the two formulas ever disagree they reset each
 *  other, which is the exact bug that destroyed 47 orders. Note the 0-based
 *  month: "2026-6-17" is 17 July. */
export function saTodayKey() {
  const d = new Date(serverNowMs() + SA_OFFSET_MS);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

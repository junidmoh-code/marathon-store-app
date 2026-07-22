// ─── DURATION FORMATTING + REFILL-AGE TONE ───────────────────────────────────
// Pure display helpers for the refill-request age/delay view. No date capture and
// no timezone here — elapsed math is done by the caller with the canonical
// server-time helper (serverNowMs, src/utils/serverTime.js) so a wrong device
// clock never skews the age. These functions only turn a millisecond span into a
// short human string and a colour tone.

// A compact elapsed/duration label: minutes under an hour, "Hh Mm" under a day,
// "Dd Hh" beyond (the oldest open request is ~9 days, so days must read cleanly).
// Negative / non-finite spans render "—" rather than a nonsense number.
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return "<1m";
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const HOUR_MS = 3600e3;

// Age tone for a refill request. Thresholds are the owner's confirmed scale
// (2026-07-22), chosen against the real fulfilled-delay spread (median ~16h):
//   normal  < 12h   — inside the same-day norm for this (batched) process
//   amber   12–24h  — past same-day; worth an eye
//   red     ≥ 24h   — over a full day = the chase list
// Returns a stable token ("normal" | "amber" | "red"); the caller maps it to a
// colour, so this stays pure and unit-testable with no UI dependency.
export function refillAgeTone(ms, { amberHours = 12, redHours = 24 } = {}) {
  if (!Number.isFinite(ms) || ms < 0) return "normal";
  if (ms >= redHours * HOUR_MS) return "red";
  if (ms >= amberHours * HOUR_MS) return "amber";
  return "normal";
}

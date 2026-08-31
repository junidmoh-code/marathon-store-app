// ── HOW THE PUBLISHER LOOKS FROM THE BROWSER ─────────────────────────────────
// The publisher is a launchd agent on a Mac mini. The browser cannot see
// whether it is running; all it has is the heartbeat the publisher writes to
// /social_health/publisher/lastTickAt on every tick.
//
// So this is the whole of the browser's knowledge, and the judgement it makes
// has to be honest about that. In particular: "no heartbeat at all" is NOT the
// same as "the publisher is dead". A fresh database, a cleared node, or a
// publisher that has never run since the heartbeat was added all look
// identical from here, and telling the owner his publisher is down when it
// might simply never have written is how a status light stops being believed.
//
// The thresholds are set against the real failure: the publisher ticks every
// two minutes, and on 31 Aug 2026 it stopped for 625 of them.
export const TICK_MINUTES = 2;
export const WARN_MINUTES = 15;     // ~7 missed ticks — the watchdog's own line
export const DOWN_MINUTES = 45;     // no plausible slow run reaches this

export function publisherStatus(lastTickAt, nowMs) {
  if (!Number.isFinite(lastTickAt) || lastTickAt <= 0) {
    return { state: "unknown", minutes: null, text: "No heartbeat recorded yet." };
  }
  // A tick from the future is a clock problem, not health. Report it rather
  // than letting a negative age render as "0 minutes ago" and read as healthy.
  if (lastTickAt > nowMs + 60_000) {
    return { state: "unknown", minutes: null, text: "Heartbeat is in the future — check the clock on the Mac mini." };
  }
  const minutes = Math.max(0, Math.floor((nowMs - lastTickAt) / 60000));
  if (minutes >= DOWN_MINUTES) {
    return { state: "down", minutes, text: `Publisher has not ticked for ${formatAge(minutes)}.` };
  }
  if (minutes >= WARN_MINUTES) {
    return { state: "late", minutes, text: `Publisher last ticked ${formatAge(minutes)} ago.` };
  }
  return { state: "ok", minutes, text: minutes <= TICK_MINUTES ? "Publisher is ticking." : `Publisher ticked ${formatAge(minutes)} ago.` };
}

export function formatAge(minutes) {
  if (!Number.isFinite(minutes)) return "—";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

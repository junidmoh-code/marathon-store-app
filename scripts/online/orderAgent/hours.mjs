// ── Trading hours for the order agent's clocks (Junid's brief, 14 Nov 2026) ──
// "Nudge the picking location's staff after 2 trading hours; escalate to Junid after 4."
// A trading hour is an hour THAT LOCATION is open (Junid, 14 Nov 2026): by default Mon–Sat 09:00–18:00 and
// Sun 09:00–14:00; Concrete Mon–Fri 09:00–17:00, Sat 09:00–16:00, Sun 09:00–14:00 SAST (no daylight saving:
// SAST = UTC+2 all year). The agent itself runs 08:00–18:30 every day. PURE.
export const SAST_OFFSET_MS = 2 * 3600e3;
export const TRADING = Object.freeze({ 0: [9, 14], 1: [9, 18], 2: [9, 18], 3: [9, 18], 4: [9, 18], 5: [9, 18], 6: [9, 18] });
export const TRADING_BY_LOCATION = Object.freeze({
  concrete: Object.freeze({ 0: [9, 14], 1: [9, 17], 2: [9, 17], 3: [9, 17], 4: [9, 17], 5: [9, 17], 6: [9, 16] }),
});
export const tradingFor = (location) => TRADING_BY_LOCATION[location] || TRADING;
export const RUN_FROM_HOUR = 8;
export const RUN_TO_MS = 18 * 3600e3 + 30 * 60e3; // last run starts by 18:30 (two chances for the 18:00 summary)
export const RUN_EVERY_MS = 15 * 60e3;
export const SUMMARY_HOUR = 18;

const D = 86400e3;
/** { y, m, d, dow, hour, minute, dayKey, dayStartMs } of a moment in SAST. */
export function sast(ms) {
  const t = new Date(Number(ms) + SAST_OFFSET_MS);
  const dayStartMs = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - SAST_OFFSET_MS;
  const p = (n) => String(n).padStart(2, "0");
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay(), hour: t.getUTCHours(), minute: t.getUTCMinutes(), dayKey: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`, dayStartMs };
}
export const dayKey = (ms) => sast(ms).dayKey;
export const hhmm = (ms) => { const s = sast(ms); return `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`; };

/** Trading milliseconds between two moments at a location (default hours when none is named; 0 when to ≤ from). */
export function tradingMsBetween(fromMs, toMs, location = null) {
  const table = tradingFor(location);
  const from = Number(fromMs), to = Number(toMs);
  if (!(from > 0) || !(to > from)) return 0;
  let total = 0;
  for (let day = sast(from).dayStartMs; day < to; day += D) {
    const [o, c] = table[sast(day + 12 * 3600e3).dow];
    const a = Math.max(from, day + o * 3600e3), b = Math.min(to, day + c * 3600e3);
    if (b > a) total += b - a;
  }
  return total;
}
export const tradingHoursBetween = (fromMs, toMs, location = null) => tradingMsBetween(fromMs, toMs, location) / 3600e3;

/** Is the agent meant to run at this moment (08:00–18:15 SAST, every day)? */
export function inRunWindow(ms) {
  const s = sast(ms);
  const into = Number(ms) - s.dayStartMs;
  return into >= RUN_FROM_HOUR * 3600e3 && into <= RUN_TO_MS;
}
/** The next moment the agent should run, from `ms`. */
export function nextRunAt(ms) {
  if (inRunWindow(ms)) return Number(ms) + RUN_EVERY_MS;
  const s = sast(ms);
  const todayStart = s.dayStartMs + RUN_FROM_HOUR * 3600e3;
  return Number(ms) < todayStart ? todayStart : todayStart + D;
}

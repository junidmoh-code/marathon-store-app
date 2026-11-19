// ─── BLACK FRIDAY 2026 — the schedule maths (SAST, the daily window, the plan). Pure. ─
"use strict";
// ── the schedule ─────────────────────────────────────────────────────────────
// Times are SAST (UTC+2, no daylight saving). Pure functions of their inputs.
const SAST_MS = 2 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const CAMPAIGN_END_MS = Date.parse("2026-11-27T20:00:00+02:00");
const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const NOW_GAP_MS = 3 * 60 * 1000;
const CLAIM_MS = 10 * 60 * 1000;
const hm = (s) => { const m = HM_RE.exec(String(s || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const sastDayStart = (t) => Math.floor((t + SAST_MS) / DAY_MS) * DAY_MS - SAST_MS;

/** The first moment at or after t inside the daily window [from, to). Pure. */
function intoWindow(t, fromMin, toMin) {
  const day = sastDayStart(t);
  const open = day + fromMin * 60000, close = day + toMin * 60000;
  if (t < open) return open;
  if (t >= close) return open + DAY_MS;
  return t;
}
/** t moved forward by `ms` of window time (time outside the window doesn't count). Pure. */
function addWindowTime(t, ms, fromMin, toMin) {
  let at = intoWindow(t, fromMin, toMin), left = ms;
  for (let i = 0; i < 400 && left > 0; i++) {
    const close = sastDayStart(at) + toMin * 60000;
    if (at + left < close) return at + left;
    left -= close - at;
    at = intoWindow(close, fromMin, toMin);
  }
  return at;
}
/** Window time between a and b. Pure. */
function windowTimeBetween(a, b, fromMin, toMin) {
  let total = 0, at = intoWindow(a, fromMin, toMin);
  for (let i = 0; i < 400 && at < b; i++) {
    const close = sastDayStart(at) + toMin * 60000;
    total += Math.min(close, b) - at;
    at = intoWindow(close, fromMin, toMin);
  }
  return total;
}

/** A schedule as typed on the card → a clean one, or { error }. Pure. */
function cleanSchedule(raw, nowMs) {
  const r = raw || {};
  const mode = ["gap", "spread", "now"].includes(r.mode) ? r.mode : null;
  if (!mode) return { error: "Choose a gap, spread evenly, or post all now." };
  const from = r.from || "08:00", to = r.to || "20:00";
  const fromMin = hm(from), toMin = hm(to);
  if (fromMin === null || toMin === null || toMin <= fromMin) return { error: "The daily window must be like 08:00 to 20:00." };
  const start = mode === "now" ? nowMs : Number(r.start);
  if (!Number.isFinite(start) || start <= 0) return { error: "Choose a start date and time." };
  const out = { mode, from, to, start };
  if (mode === "gap") {
    const g = Number(r.gapMin);
    if (!(Number.isFinite(g) && g >= 5 && g <= 24 * 60)) return { error: "The gap must be between 5 minutes and 24 hours." };
    out.gapMin = Math.round(g);
  }
  if (mode === "spread") {
    const u = Number(r.until);
    if (!(Number.isFinite(u) && u > Math.max(start, nowMs))) return { error: "\"Spread evenly until\" must be after the start." };
    out.until = Math.min(u, CAMPAIGN_END_MS);
  }
  return out;
}

/**
 * Which approved group posts when. `queue`: [{ key, approvedAt, price, part }]
 * (approved, complete, not yet posted). → { key: dueMs }.
 * prevPlan: the plan as it stands. A group already in it KEEPS ITS TIME (a tap
 * never pulls the next group forward); only new groups are placed, after the
 * last kept time. A confirm passes no prevPlan: a fresh plan. A time past the
 * end of the campaign (27 Nov 20:00) is left out. Pure.
 */
function planSchedule(queue, schedule, nowMs, prevPlan = null) {
  const s = schedule;
  if (!s || !queue.length) return {};
  const order = [...queue].sort((a, b) => (a.approvedAt - b.approvedAt) || (a.price - b.price) || ((a.part || 1) - (b.part || 1)) || (a.key < b.key ? -1 : 1));
  const plan = {};
  const prev = prevPlan || {};
  for (const g of order) if (Number(prev[g.key]) > 0) plan[g.key] = Number(prev[g.key]);
  const fresh = order.filter((g) => !plan[g.key]);
  if (!fresh.length) return plan;
  const kept = Object.values(plan);
  const lastKept = kept.length ? Math.max(...kept) : null;
  if (s.mode === "now") {
    const t0 = Math.max(nowMs, s.start, lastKept ? lastKept + NOW_GAP_MS : 0);
    fresh.forEach((g, i) => { const t = t0 + i * NOW_GAP_MS; if (t < CAMPAIGN_END_MS) plan[g.key] = t; });
    return plan;
  }
  const fromMin = hm(s.from), toMin = hm(s.to);
  let step;
  if (s.mode === "gap") step = s.gapMin * 60000;
  else {
    const from = intoWindow(Math.max(s.start, nowMs, lastKept || 0), fromMin, toMin);
    const span = windowTimeBetween(from, Math.min(s.until, CAMPAIGN_END_MS), fromMin, toMin);
    // After kept groups, the new ones share the time left after the last of them (the first one a step later);
    // with none kept, the first posts at the start and n groups share the span in n equal steps.
    // (One step of room is always left at the end, so the last never lands on the window's close.)
    step = lastKept ? Math.floor(span / (fresh.length + 1)) : (fresh.length > 1 ? Math.floor(span / fresh.length) : 0);
  }
  let t = lastKept ? addWindowTime(Math.max(lastKept, nowMs), step, fromMin, toMin) : intoWindow(Math.max(s.start, nowMs), fromMin, toMin);
  for (const g of fresh) {
    if (t >= CAMPAIGN_END_MS) break;
    plan[g.key] = t;
    t = addWindowTime(t, step, fromMin, toMin);
  }
  return plan;
}

/** Is t inside the schedule's daily window? ("now" mode has none.) Pure. */
function inWindow(schedule, t) {
  if (!schedule || schedule.mode === "now") return true;
  return intoWindow(t, hm(schedule.from), hm(schedule.to)) === t;
}

module.exports = { CAMPAIGN_END_MS, CLAIM_MS, cleanSchedule, planSchedule, inWindow, intoWindow, addWindowTime, windowTimeBetween };

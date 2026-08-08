// ─── BATCHED RELEASE WINDOWS (owner spec 2026-08-08) ─────────────────────────
// Staff used to pick refill requests one or two at a time all day. The owner
// wants two batched picks a day instead — so requests are still RAISED the
// moment demand appears (the data stays true at all times; nothing about
// request creation, engine cadence or stock writes changes), but they only
// become VISIBLE AS PICKABLE WORK in the hub queue at fixed release times.
//
// This module is the whole mechanism: a request is "released" when it was
// created at or before the most recent release instant. That makes the gate a
// PURE FUNCTION of (createdAt, now, config) — no stored state, no sweep, no
// server half, nothing to migrate. Consequences that fall out for free:
//   • a request raised 13:55 is pickable at 14:00 (last release ≥ createdAt);
//   • a request raised 14:05 waits for the next window (06:00 next day);
//   • a released request that nobody picked STAYS released through every later
//     window (the last release instant only ever moves forward past createdAt);
//   • everything that predates the feature is already released.
//
// The gate is PRESENTATION-ONLY and applied in exactly one place — the pick
// queue (Hub2RefillQueue). Every other consumer of /refill_requests (the
// engine's reconcile/satisfied/rejection-learning passes, MoveExcess netting,
// Missing Sneakers dedupe, Refill History, held-card visibility) keeps reading
// the full open set. Hiding a request from those would change real behaviour;
// hiding it from the picker only changes when it becomes work.
//
// CONFIG — console-editable, no deploy:
//   /config/refillEngine/releaseWindows = ["06:00", "14:00"]
// Accepted values: an array (or RTDB numeric-keyed object) of "HH:MM" SA-time
// strings; invalid entries are dropped; absent / empty / all-invalid falls back
// to DEFAULT_RELEASE_TIMES. An explicit `false` disables batching entirely
// (continuous release — the pre-feature behaviour) as the emergency escape
// hatch, mirroring the fail-safe grammar of the engine's other switches.
//
// TIME — SA wall clock (UTC+2 year-round, no DST — same constant as
// serverTime.js), computed from the server-corrected clock the caller passes
// in (serverNowMs()). A UTC day boundary has bitten this project before; all
// arithmetic here shifts to SA, works in SA, then shifts back.
//
// URGENT OVERRIDE — an admin can release one request early by stamping
//   earlyRelease: { at, by, reason }
// on the request (see releaseEarlyPatch). Its presence releases the row for
// everyone, permanently, and records who did it and why.

export const DEFAULT_RELEASE_TIMES = ["06:00", "14:00"];

const SA_OFFSET_MS = 2 * 60 * 60 * 1000; // SA is UTC+2 year-round, no DST.
const DAY_MS = 24 * 60 * 60 * 1000;

// "HH:MM" → minutes-of-day, or null when not a valid wall-clock time.
// Deliberately strict: config typos must fall back, never half-apply.
export function parseTimeOfDay(s) {
  if (typeof s !== "string") return null;
  const m = /^([0-9]{1,2}):([0-9]{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Normalise the raw /config/refillEngine/releaseWindows value.
 *  → { disabled: true }                    when batching is switched off (=== false)
 *  → { disabled: false, minutes, labels }  minutes-of-day sorted ascending, deduped
 *  Absent / invalid / empty input falls back to DEFAULT_RELEASE_TIMES. */
export function parseReleaseTimes(raw) {
  if (raw === false) return { disabled: true, minutes: [], labels: [] };
  // RTDB hands back contiguous numeric keys as a real array; a sparse edit in
  // the console arrives as an object — accept both.
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? Object.values(raw) : []);
  const minutes = [...new Set(list.map(parseTimeOfDay).filter((v) => v !== null))].sort((a, b) => a - b);
  if (!minutes.length) {
    const dflt = DEFAULT_RELEASE_TIMES.map(parseTimeOfDay);
    return { disabled: false, minutes: dflt, labels: [...DEFAULT_RELEASE_TIMES] };
  }
  const labels = minutes.map((v) => `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`);
  return { disabled: false, minutes, labels };
}

// Epoch ms of the most recent release instant at or before `nowMs`.
// Shift to SA, find today's latest passed time (or yesterday's latest), shift back.
export function lastReleaseMs(nowMs, windows) {
  const saNow = nowMs + SA_OFFSET_MS;
  const saMidnight = Math.floor(saNow / DAY_MS) * DAY_MS;
  const minsNow = (saNow - saMidnight) / 60000;
  const passed = windows.minutes.filter((m) => m <= minsNow);
  const saRelease = passed.length
    ? saMidnight + Math.max(...passed) * 60000
    : saMidnight - DAY_MS + Math.max(...windows.minutes) * 60000;
  return saRelease - SA_OFFSET_MS;
}

// Epoch ms of the next release instant strictly after `nowMs`.
export function nextReleaseMs(nowMs, windows) {
  const saNow = nowMs + SA_OFFSET_MS;
  const saMidnight = Math.floor(saNow / DAY_MS) * DAY_MS;
  const minsNow = (saNow - saMidnight) / 60000;
  const upcoming = windows.minutes.filter((m) => m > minsNow);
  const saRelease = upcoming.length
    ? saMidnight + Math.min(...upcoming) * 60000
    : saMidnight + DAY_MS + Math.min(...windows.minutes) * 60000;
  return saRelease - SA_OFFSET_MS;
}

/** Is this request visible as pickable work right now?
 *  Released when: batching is disabled · the admin released it early · its
 *  createdAt is unparseable (fail-OPEN — bad data must never hide real work;
 *  every pre-feature row and every engine row has a parseable createdAt) · or
 *  it was created at or before the most recent release instant. */
export function isReleased(request, nowMs, windows) {
  if (!windows || windows.disabled) return true;
  if (request?.earlyRelease) return true;
  const createdMs = Date.parse(request?.createdAt || "");
  if (!Number.isFinite(createdMs)) return true;
  return createdMs <= lastReleaseMs(nowMs, windows);
}

/** Split open requests into released (pickable) vs waiting (accumulating). */
export function partitionReleased(requests, nowMs, windows) {
  const released = [], waiting = [];
  for (const r of requests || []) (isReleased(r, nowMs, windows) ? released : waiting).push(r);
  return { released, waiting };
}

// SA wall-clock "HH:MM" of an epoch instant (for "next release at 14:00").
export function saTimeLabel(ms) {
  const sa = new Date(ms + SA_OFFSET_MS);
  return `${String(sa.getUTCHours()).padStart(2, "0")}:${String(sa.getUTCMinutes()).padStart(2, "0")}`;
}

/** The patch an admin writes to release one request early, out of band.
 *  Records WHO and WHY — both are required; the caller must not write without
 *  a reason. Written under its own key so it can never collide with engine
 *  fields, and its mere presence is the release signal (see isReleased). */
export function releaseEarlyPatch({ nowIso, uid, reason }) {
  const why = String(reason || "").trim();
  if (!why) return null;
  return { earlyRelease: { at: nowIso, by: uid || null, reason: why } };
}

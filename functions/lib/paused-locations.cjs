// ─── PAUSED LOCATIONS — the engine stands down for ONE location ───────────────
// Junid, 6 Nov 2026: Hub 3 is being physically recounted from zero. While it is,
// the refill engine must not treat Hub 3 as a destination at all — no new
// request, no resize, no withdrawal of the requests already open there, no
// write-off of a cell staff are counting. Everything else in the network runs
// exactly as before.
//
//   /config/refillEngine/pausedLocations/{locationId} = true
//
// Only `true` pauses. Absent, false, or any other value is "not paused", so a
// missing or junk node can never quietly stop a location's refills — and with
// nothing paused every function here hands back its input unchanged (the same
// object), so a scan with the flag clear is byte-identical to one before this
// module existed.
//
// This is NOT policy. No target, no category policy, no route and no request
// rule is read or changed here: the plan is computed exactly as it always is,
// and the paused location's share of it is simply not applied. Open Hub 3
// requests are left as they are (their closes, resizes and withdrawals are held
// too), so un-pausing resumes from where the engine left off.
//
// Set and cleared together with /settings/hubSneakerCount/countMode/{loc} by the
// Hub Count card's toggle (src/components/stock/hubCountStore.js
// setHubCountMode) and by scripts/hub3-count-reset.mjs.
"use strict";

/** The set of paused location ids in an engine config. */
function pausedLocationSet(config) {
  const node = config && config.pausedLocations;
  const out = new Set();
  if (!node || typeof node !== "object") return out;
  for (const [loc, v] of Object.entries(node)) if (v === true) out.add(loc);
  return out;
}

function isLocationPaused(config, loc) {
  return pausedLocationSet(config).has(loc);
}

// Every plan list whose entries name a destination cell. Each entry carries
// `dest` (engine shape).
const DEST_LISTS = ["intents", "closes", "satisfiedClosures", "resizes", "retryOps", "streakOps"];

// Is this plan entry held? Only when its DESTINATION is paused — Junid asked
// for Hub 3 to be skipped "as a destination entirely", and nothing more.
//
// NOT held (reported to Junid, not decided here — CLAUDE.md): an engine
// withdrawal of a SHOP request whose SOURCE is the paused hub. With Hub 3 at 0
// the scan withdraws open Pine/Concrete requests served from Hub 3 as
// "awaiting_upstream"; they are re-raised from Hub 3's counted cells.
function held(key, e, paused) {
  return !!e && paused.has(e.dest);
}

/**
 * Drop the paused locations' share of an engine plan. Returns the SAME plan
 * object when nothing is paused (identity: the unpaused scan is unchanged).
 * Otherwise a shallow copy with every destination list filtered, plus
 * `pausedDropped` — how many entries were held, by list — for the run record.
 */
function withoutPausedDestinations(plan, paused) {
  if (!plan || !paused || paused.size === 0) return plan;
  const out = { ...plan };
  const dropped = {};
  for (const key of DEST_LISTS) {
    const list = plan[key];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((e) => !held(key, e, paused));
    if (kept.length !== list.length) dropped[key] = list.length - kept.length;
    out[key] = kept;
  }
  out.pausedDropped = dropped;
  return out;
}

/** Refusal write-offs at a paused location are held too (they write /stock). */
function withoutPausedWriteoffs(writeoffs, paused) {
  if (!Array.isArray(writeoffs) || !paused || paused.size === 0) return writeoffs;
  return writeoffs.filter((w) => !(w && paused.has(w.loc)));
}

module.exports = { pausedLocationSet, isLocationPaused, withoutPausedDestinations, withoutPausedWriteoffs, DEST_LISTS };

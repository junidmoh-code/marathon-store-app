// ─── SHELF CHECKS — heal the counts a little every day (PURE) ────────────────
//
// Junid, 24 Nov 2026 (Commit 7 of his decisions on docs/audits/web-unavailable-
// 2026-11-24). Each shop and hub gets a short daily list of its riskiest
// shelves, on the screens it already uses:
//   1. "count wrong by more than one" — a shelf that rejected a website pick
//      while showing TWO OR MORE (the count was not changed, the shelf is held
//      off the website: scripts/shopify/pickableStock.mjs);
//   2. then the single pieces untouched longest that the website lists.
// Staff TAP, never type: Found / Not found on a single piece (or scan it);
// the real number from a small picker on a shelf showing several.
//
//   /shelf_checks/{loc}/open/{pid}__{sizeKey} = { pid, sizeKey, shown, why, lastMoved, addedAt, addedDay, holdAt? }
//   /shelf_checks/{loc}/done/{saDate}/{id}    = { result, shown, counted?, by, byName, at, why }
//   /shelf_checks/{loc}/days/{saDate}         = { listed, found, notFound, counted, corrected }
//   /config/onlineOrders/shelfChecks          = { off?: true, perDay?: 20 }
//
// Server-only nodes: every read and write goes through the callables in
// index.js (Admin SDK), so no database rule is needed for them.
"use strict";

const SHELF_CHECKS_PATH = "shelf_checks";
const SHELF_CONFIG_PATH = "config/onlineOrders/shelfChecks";
const PER_DAY_DEFAULT = 20;
const SHOPS = Object.freeze(["marathon-pe", "trophy", "concrete", "marathon-pine"]);
const HUBS = Object.freeze(["hub1", "hub2", "hub3"]);
// Central gets the "wrong by more than one" shelves only: nearly all of its singles are stock on its way out.
const CHECK_LOCATIONS = Object.freeze([...SHOPS, ...HUBS, "central"]);
// The sources a shelf comes onto the list from, in the order a day's list is filled (Junid, 24 Nov 2026 evening):
//   web_reject     a website rejection wrote the shelf down (one piece): is it there after all?
//   store_reject   a store customer's order, a refill or a transfer was refused there, or a shop said "not found
//                  anywhere" — the count is NOT changed; the shelf is held off the website until it is checked
//   wrong_by_more  a website rejection while the shelf showed two or more (held, count unchanged)
//   not_selling    stock on the shelf, no sale or outbound movement for 21 days
//   old_single     one piece, untouched longest
const WHY = Object.freeze({ WEB: "web_reject", STORE: "store_reject", MORE: "wrong_by_more", IDLE: "not_selling", OLD: "old_single" });
const WHY_ORDER = Object.freeze([WHY.WEB, WHY.STORE, WHY.MORE, WHY.IDLE, WHY.OLD]);
const rankOf = (why) => { const i = WHY_ORDER.indexOf(why); return i < 0 ? WHY_ORDER.length : i; };
const MAX_COUNT = 30;

const keyOk = (k) => typeof k === "string" && k !== "" && !/[.#$[\]/]/.test(k);
const itemId = (pid, sizeKey) => `${pid}__${sizeKey}`;
const cellQty = (cell) => (cell && typeof cell === "object" ? Number(cell.qty) || 0 : Number(cell) || 0);
const cellStamp = (cell) => { const t = cell && typeof cell === "object" ? Date.parse(cell.updatedAt) : NaN; return Number.isFinite(t) ? t : null; };

const RECHECK_DAYS_DEFAULT = 30;
const IDLE_DAYS_DEFAULT = 21;
/**
 * /config/onlineOrders/shelfChecks → the settings in force.
 *   off            the whole routine off
 *   perDay         the day's list per place (20)
 *   perDayAt.{loc} one place's own number, instead of perDay
 *   recheckDays    a shelf settled by a person is not asked again for this long unless a NEW rejection arrives (30)
 *   idleDays       "not selling": stock on the shelf, no sale or outbound movement for this long (21)
 *   shops.{loc}.on a shop's own Shelf check tab (Display Checks) — OFF until Junid turns it on, shop by shop
 */
function configFrom(c) {
  const o = c && typeof c === "object" ? c : {};
  const int = (v, d, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : d; };
  const shops = {};
  for (const loc of SHOPS) shops[loc] = !!(o.shops && o.shops[loc] && o.shops[loc].on === true);
  // A place's own number (perDayAt/<place>), else the common one.
  const perDay = int(o.perDay, PER_DAY_DEFAULT, 1, 200);
  const perDayAt = {};
  for (const loc of CHECK_LOCATIONS) if (o.perDayAt && o.perDayAt[loc] != null) perDayAt[loc] = int(o.perDayAt[loc], perDay, 1, 200);
  return {
    on: o.off !== true,
    perDay,
    perDayAt,
    recheckDays: int(o.recheckDays, RECHECK_DAYS_DEFAULT, 0, 365),
    idleDays: int(o.idleDays, IDLE_DAYS_DEFAULT, 1, 120),
    shops,
  };
}

/** The day's number at one place. PURE. */
const perDayFor = (cfg, loc) => (cfg.perDayAt && cfg.perDayAt[loc]) || cfg.perDay;

/** Is the routine running at this place? Hubs and Central always (while on); a shop only once Junid has turned it on. PURE. */
const placeOn = (cfg, loc) => !!cfg.on && (SHOPS.includes(loc) ? cfg.shops[loc] === true : CHECK_LOCATIONS.includes(loc));

/** Who may work the list of one place: its own screen's permission. */
function shelfAccess({ isSuper, perms, loc }) {
  if (!CHECK_LOCATIONS.includes(loc)) return false;
  if (isSuper) return true;
  const p = Array.isArray(perms) ? perms : [];
  if (SHOPS.includes(loc)) return p.includes("display_checks");
  if (HUBS.includes(loc)) return p.includes("warehouse");
  return p.includes("source");
}

/**
 * Tonight's top-up for one place. Unchecked items ROLL OVER: what is open
 * stays, and the list is only filled back up to `perDay`.
 *   open      { [id]: item } as stored
 *   more      [{ pid, sizeKey, shown, holdAt }]            standing holds on shelves showing 2+
 *   singles   [{ pid, sizeKey, at }]                       lone pieces the website lists, any order
 * → { add: { [id]: item }, listed }   (items to write; `listed` = open after the top-up)
 */
function planTopUp({ open = {}, more = [], singles = [], perDay = PER_DAY_DEFAULT, nowMs, saDate }) {
  const have = new Set(Object.keys(open || {}));
  const add = {};
  const room = () => perDay - have.size;
  const push = (id, item) => { if (room() > 0 && !have.has(id)) { add[id] = item; have.add(id); } };
  for (const m of [...more].sort((a, b) => Number(a.holdAt) - Number(b.holdAt))) {
    if (!keyOk(m.pid) || !keyOk(m.sizeKey) || !(Number(m.shown) > 1)) continue;
    push(itemId(m.pid, m.sizeKey), { pid: m.pid, sizeKey: m.sizeKey, shown: Number(m.shown), why: WHY.MORE, holdAt: Number(m.holdAt) || null, lastMoved: m.lastMoved ?? null, addedAt: nowMs, addedDay: saDate });
  }
  for (const s of [...singles].sort((a, b) => Number(a.at) - Number(b.at))) {
    if (!keyOk(s.pid) || !keyOk(s.sizeKey) || !Number.isFinite(Number(s.at))) continue;
    push(itemId(s.pid, s.sizeKey), { pid: s.pid, sizeKey: s.sizeKey, shown: 1, why: WHY.OLD, lastMoved: Number(s.at), addedAt: nowMs, addedDay: saDate });
  }
  return { add, listed: have.size };
}

/** Rejections: a new one re-asks a shelf even inside the recheck window. */
const REJECTION_WHYS = Object.freeze([WHY.WEB, WHY.STORE, WHY.MORE]);

/**
 * TONIGHT'S LIST FOR ONE PLACE (Junid, 24 Nov 2026 evening). PURE.
 * A steady rotation, never a "clear everything": the list is the `perDay` most important shelves, in the order
 * web_reject → store_reject → wrong_by_more → not_selling → old_single, oldest first inside each. What was not
 * checked yesterday ROLLS OVER and is ranked again with tonight's candidates (a new rejection can push a quieter
 * item back into the pool; it comes back when there is room).
 *   open        { [id]: item }   as stored (rolled over)
 *   candidates  [{ pid, sizeKey, why, shown, at, ref?, src?, mvId?, lastMoved? }]   `at` orders "oldest first"
 *   checked     { [id]: ms }     when each shelf was last settled by a person
 *   onTheWay    (id) => units    a shelf with stock still travelling is left off until its cutoff passes
 * → { open: { [id]: item }, added: [id], dropped: [id], skipped: { recent, travelling }, bySource }
 */
function planDay({ open = {}, candidates = [], checked = {}, onTheWay = () => 0, perDay = PER_DAY_DEFAULT, recheckDays = RECHECK_DAYS_DEFAULT, nowMs, saDate }) {
  const pool = new Map();
  const skipped = { recent: 0, travelling: 0 };
  const better = (a, b) => rankOf(a.why) < rankOf(b.why) || (rankOf(a.why) === rankOf(b.why) && Number(a.at) < Number(b.at));
  for (const [id, item] of Object.entries(open || {})) {
    if (!item || !keyOk(item.pid) || !keyOk(item.sizeKey)) continue;
    // A rolled shelf that has stock on the way now waits for its cutoff like any other.
    if (onTheWay(id) > 0) { skipped.travelling += 1; continue; }
    pool.set(id, { ...item, at: Number.isFinite(Number(item.at)) ? Number(item.at) : Number(item.lastMoved) || Number(item.addedAt) || 0, rolled: true });
  }
  for (const c of candidates || []) {
    if (!c || !keyOk(c.pid) || !keyOk(c.sizeKey) || !WHY_ORDER.includes(c.why) || !Number.isFinite(Number(c.at))) continue;
    const id = itemId(c.pid, c.sizeKey);
    if (onTheWay(id) > 0) { skipped.travelling += 1; continue; }
    const last = Number(checked && checked[id]);
    const recent = Number.isFinite(last) && last > 0 && nowMs - last < recheckDays * 864e5;
    // Inside the recheck window only a rejection that came AFTER the check brings it back.
    if (recent && !(REJECTION_WHYS.includes(c.why) && Number(c.at) > last)) { skipped.recent += 1; continue; }
    const item = { pid: c.pid, sizeKey: c.sizeKey, shown: Number(c.shown) || 0, why: c.why, at: Number(c.at), lastMoved: c.lastMoved ?? null, addedAt: nowMs, addedDay: saDate };
    for (const k of ["ref", "src", "mvId", "holdAt"]) if (c[k] != null && c[k] !== "") item[k] = c[k];
    const cur = pool.get(id);
    if (!cur) pool.set(id, item);
    // The same shelf from a stronger source (or newer evidence for it): the list shows the stronger reason; a rolled
    // item keeps the day it was first listed.
    else if (better(item, cur) || (cur.rolled && item.why === cur.why)) pool.set(id, { ...item, addedAt: cur.addedAt ?? nowMs, addedDay: cur.addedDay ?? saDate, rolled: cur.rolled });
  }
  const ranked = [...pool.entries()].sort(([, a], [, b]) => rankOf(a.why) - rankOf(b.why) || Number(a.at) - Number(b.at) || 0);
  const keep = ranked.slice(0, perDay);
  const out = {}, added = [], bySource = {};
  for (const [id, item] of keep) {
    const { rolled, ...stored } = item;
    out[id] = stored;
    if (!rolled) added.push(id);
    bySource[item.why] = (bySource[item.why] || 0) + 1;
  }
  const dropped = ranked.slice(perDay).filter(([, it]) => it.rolled).map(([id]) => id);
  return { open: out, added, dropped, skipped, bySource, candidates: pool.size };
}

/**
 * Is an open item still the shelf it was listed for? A shelf that moved since
 * (a sale, a delivery, a count) has been touched by a person: it leaves the list.
 */
function itemStale(item, cell) {
  if (!item) return true;
  if (cellQty(cell) !== Number(item.shown)) return true;
  const stamp = cellStamp(cell);
  return item.lastMoved != null && stamp != null && stamp > Number(item.lastMoved);
}

/**
 * What an answer does. PURE.
 *   result    "found" | "not_found" | "count"   (count: the number tapped)
 *   onTheWay  units sent to this shelf that have not landed yet (functions/lib/on-the-way.cjs). A person can
 *             only count what is ON the shelf, so the count is set to counted + on the way (Junid, 24 Nov 2026
 *             evening); 0 = the rule as it always was.
 * → { kind: "touch" | "write_down" | "adjust", delta?, target, outcome } | { error }
 */
function answerPlan({ item, cell, result, count, onTheWay = 0 }) {
  if (!item) return { error: "gone" };
  if (itemStale(item, cell)) return { error: "stale" };
  const shown = Number(item.shown);
  const otw = Math.max(0, Number(onTheWay) || 0);
  if (item.why === WHY.WEB && item.mvId) {
    // A shelf a website rejection already wrote down: the question is only "is it there after all?".
    if (result === "found") return { kind: "restore", outcome: "found", target: shown + 1 };
    if (result === "not_found") return { kind: "touch", outcome: "notFound", target: shown, confirmsWriteDown: true };
    return { error: "bad_result" };
  }
  // What should be ON the shelf: what it shows less what is still travelling.
  const physical = shown - otw;
  if (result === "found") return physical <= 1 ? { kind: "touch", outcome: "found", target: shown } : { error: "pick_a_number" };
  if (result === "not_found") {
    if (physical >= 2) return { error: "pick_a_number" };
    // Nothing should be there yet (it is all on the way): the answer agrees with the count.
    if (physical <= 0) return { kind: "touch", outcome: "notFound", target: shown };
    // The one piece that should be there is not: the single-piece write-down (it leaves what is on the way on the
    // count and undoes itself if the piece turns up — functions/lib/web-writedown.cjs).
    return { kind: "write_down", outcome: "notFound", target: otw };
  }
  if (result === "count") {
    // A real number only: nothing, a string or a blank must never read as "none on the shelf".
    const n = typeof count === "number" ? count : NaN;
    if (!Number.isInteger(n) || n < 0 || n > MAX_COUNT) return { error: "bad_count" };
    const target = n + otw;
    if (target === shown) return { kind: "touch", outcome: shown - otw === 1 ? "found" : "counted", target };
    // A single piece counted as none is the same write-down as Not found, so it undoes itself the same way.
    if (physical === 1 && n === 0) return { kind: "write_down", outcome: "notFound", target: otw };
    return { kind: "adjust", delta: target - shown, outcome: "corrected", target };
  }
  return { error: "bad_result" };
}

/** The record of one answer, kept per day (what was asked, why, what the person said, what changed). PURE. */
function doneRow({ item, plan, result, count, otw = 0, uid, name, nowMs, unitsCorrected = 0 }) {
  const out = { result: plan.outcome, shown: Number(item.shown), by: uid, byName: name || null, at: nowMs, why: item.why || null };
  if (result === "count") out.counted = Number(count);
  if (otw > 0) out.onTheWay = otw;
  if (plan.target != null && plan.target !== Number(item.shown)) out.setTo = plan.target;
  if (unitsCorrected) out.units = unitsCorrected;
  if (item.src) out.src = item.src;
  if (item.ref) out.ref = item.ref;
  return out;
}

/**
 * One day's counters after an answer. PURE (a transaction body).
 *   found / notFound / counted / corrected   what the answers were (as before)
 *   units                                     units the counts were changed by
 *   by.{why}                                  answers per source
 */
function bumpDay(d, { outcome, why, units = 0 }) {
  const cur = d && typeof d === "object" ? { ...d } : {};
  cur[outcome] = (Number(cur[outcome]) || 0) + 1;
  if (units) cur.units = (Number(cur.units) || 0) + Number(units);
  if (why && keyOk(why)) cur.by = { ...(cur.by && typeof cur.by === "object" ? cur.by : {}), [why]: (Number(cur.by && cur.by[why]) || 0) + 1 };
  return cur;
}

/**
 * Progress for one place (Junid's view, Settings → Online orders). PURE.
 *   days  { [saDate]: counters }  (up to eight weeks)
 *   open  { [id]: item }          today's list
 * → { open, openBySource, days (last 14, newest first), weeks (last 8, newest first), checked14, wrong14 }
 */
function progressOf(days, open) {
  const dayRow = ([day, d]) => {
    const found = Number(d.found) || 0, notFound = Number(d.notFound) || 0, counted = Number(d.counted) || 0, corrected = Number(d.corrected) || 0;
    return { day, listed: Number(d.listed) || 0, checked: found + notFound + counted + corrected, found: found + counted, fixed: notFound + corrected, notFound, counted, corrected, units: Number(d.units) || 0, by: d.by && typeof d.by === "object" ? d.by : {}, added: d.added && typeof d.added === "object" ? d.added : {} };
  };
  const all = Object.entries(days || {}).filter(([, d]) => d && typeof d === "object").sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(dayRow);
  const rows = all.slice(0, 14);
  const sum = (list, k) => list.reduce((n, r) => n + r[k], 0);
  // Weeks start on Monday (SA calendar days).
  const weekOf = (day) => { const t = Date.parse(`${day}T12:00:00Z`); const dow = (new Date(t).getUTCDay() + 6) % 7; return new Date(t - dow * 864e5).toISOString().slice(0, 10); };
  const weeks = new Map();
  for (const r of all) {
    const w = weekOf(r.day);
    const cur = weeks.get(w) || { week: w, checked: 0, found: 0, fixed: 0, units: 0 };
    cur.checked += r.checked; cur.found += r.found; cur.fixed += r.fixed; cur.units += r.units;
    weeks.set(w, cur);
  }
  const openBySource = {};
  for (const it of Object.values(open || {})) if (it && it.why) openBySource[it.why] = (openBySource[it.why] || 0) + 1;
  return { open: Object.keys(open || {}).length, openBySource, days: rows, weeks: [...weeks.values()].slice(0, 8), checked14: sum(rows, "checked"), wrong14: sum(rows, "notFound") + sum(rows, "corrected") };
}

module.exports = {
  SHELF_CHECKS_PATH, SHELF_CONFIG_PATH, PER_DAY_DEFAULT, RECHECK_DAYS_DEFAULT, IDLE_DAYS_DEFAULT, SHOPS, HUBS, CHECK_LOCATIONS, WHY, WHY_ORDER, REJECTION_WHYS, rankOf, MAX_COUNT, placeOn, perDayFor, planDay,
  itemId, cellQty, cellStamp, configFrom, shelfAccess, planTopUp, itemStale, answerPlan, progressOf, doneRow, bumpDay,
};

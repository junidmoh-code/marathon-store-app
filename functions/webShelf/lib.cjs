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

function configFrom(c) {
  const o = c && typeof c === "object" ? c : {};
  const n = Number(o.perDay);
  return { on: o.off !== true, perDay: Number.isInteger(n) && n >= 1 && n <= 200 ? n : PER_DAY_DEFAULT };
}

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
  if (item.why === WHY.WEB) {
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

/** Progress for one place over the days given. PURE. days: { [saDate]: counters } */
function progressOf(days, open) {
  const rows = Object.entries(days || {}).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 14).map(([day, d]) => {
    const found = Number(d.found) || 0, notFound = Number(d.notFound) || 0, counted = Number(d.counted) || 0, corrected = Number(d.corrected) || 0;
    return { day, listed: Number(d.listed) || 0, checked: found + notFound + counted + corrected, found, notFound, counted, corrected };
  });
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  return { open: Object.keys(open || {}).length, days: rows, checked14: sum("checked"), wrong14: sum("notFound") + sum("corrected") };
}

module.exports = {
  SHELF_CHECKS_PATH, SHELF_CONFIG_PATH, PER_DAY_DEFAULT, SHOPS, HUBS, CHECK_LOCATIONS, WHY, WHY_ORDER, rankOf, MAX_COUNT,
  itemId, cellQty, cellStamp, configFrom, shelfAccess, planTopUp, itemStale, answerPlan, progressOf, doneRow, bumpDay,
};

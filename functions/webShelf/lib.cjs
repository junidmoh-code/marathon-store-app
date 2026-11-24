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
const WHY = Object.freeze({ MORE: "wrong_by_more", OLD: "old_single" });
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
 *   result  "found" | "not_found" | "count"   (count: the number tapped)
 * → { kind: "touch" | "write_down" | "adjust", delta?, outcome } | { error }
 */
function answerPlan({ item, cell, result, count }) {
  if (!item) return { error: "gone" };
  if (itemStale(item, cell)) return { error: "stale" };
  const shown = Number(item.shown);
  if (result === "found") return shown === 1 ? { kind: "touch", outcome: "found" } : { error: "pick_a_number" };
  if (result === "not_found") return shown === 1 ? { kind: "write_down", outcome: "notFound" } : { error: "pick_a_number" };
  if (result === "count") {
    // A real number only: nothing, a string or a blank must never read as "none on the shelf".
    const n = typeof count === "number" ? count : NaN;
    if (!Number.isInteger(n) || n < 0 || n > MAX_COUNT) return { error: "bad_count" };
    if (n === shown) return { kind: "touch", outcome: shown === 1 ? "found" : "counted" };
    // A single piece counted as none is the same write-down as Not found, so it undoes itself the same way.
    if (shown === 1 && n === 0) return { kind: "write_down", outcome: "notFound" };
    return { kind: "adjust", delta: n - shown, outcome: "corrected" };
  }
  return { error: "bad_result" };
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
  SHELF_CHECKS_PATH, SHELF_CONFIG_PATH, PER_DAY_DEFAULT, SHOPS, HUBS, CHECK_LOCATIONS, WHY, MAX_COUNT,
  itemId, cellQty, cellStamp, configFrom, shelfAccess, planTopUp, itemStale, answerPlan, progressOf,
};

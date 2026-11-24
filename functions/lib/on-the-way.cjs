// ─── STOCK ON THE WAY IS NEVER COUNTED AS MISSING ────────────────────────────
//
// Junid, 24 Nov 2026 (evening brief, commit 2). A refill or transfer credits the
// RECEIVING shelf the moment it is sent, but the pieces travel on the next
// morning run. Until they land, a shelf can honestly show more than is on it:
// a person who counts it then, or a place that rejects a pick from it, is not
// proof the count is wrong. So, for one shelf (product, size, location):
//
//   ON THE WAY = units moved INTO it by a transfer, refill or fulfilment, each
//   one until the delivery cutoff of the next trading day after it was sent
//   (default 11:00 SAST; Sunday is not a trading day for the run by default).
//
// and everything that judges a shelf reads it:
//   a) the daily shelf check leaves a shelf with units on the way off its list;
//   b) a count entered on such a shelf sets counted + on the way (both logged);
//   c) a website rejection writes the shelf down to the on-the-way number, never
//      below it (functions/lib/web-writedown.cjs);
//   d) the 60-day old-single rule already sees such a shelf as touched — the
//      arrival stamps the cell's updatedAt — so it needs nothing from here.
//
// WHERE IT COMES FROM. The movements already logged (/stock_movements, indexed
// on `ts`). shelfChecksTick (functions/webShelf/tick.js) reads only the NEW rows
// every ten minutes and keeps one small working set:
//
//   /shelf_on_the_way/{loc}/{pid}/{sizeKey}/{movementId} = { q, until, at }
//   /shelf_on_the_way_due/{untilMs}/{loc}~{pid}~{sizeKey}~{movementId} = true   (expiry index)
//   /shelf_on_the_way_meta = { cursor, ranAt, rows }
//
// A row lives only until its cutoff; the expiry index lets the tick delete it
// without reading the set. Readers of ONE shelf read one small node, and also
// look at the cell's own last movement, so a transfer sent in the last ten
// minutes (not yet seen by the tick) still counts.
//
// Settings: /config/onlineOrders/shelfChecks/onTheWay = { off?, cutoffHour?, closedDays? }
//
// Nothing here reads or writes a policy, a target or a request. It never moves
// stock. `db` is injected (firebase-admin Database or a test fake).
"use strict";

const { SAST_OFFSET_MS } = require("./sa-time.cjs");

const OTW_PATH = "shelf_on_the_way";
const OTW_DUE_PATH = "shelf_on_the_way_due";
const OTW_META_PATH = "shelf_on_the_way_meta";
const OTW_CONFIG_PATH = "config/onlineOrders/shelfChecks/onTheWay";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DEFAULTS = Object.freeze({ cutoffHour: 11, closedDays: Object.freeze(["Sun"]) });
// Never a shelf: "in transit" is the road itself, and an arrival FROM it is the
// piece landing (it is no longer on the way).
const NOT_A_SHELF = new Set(["in_transit"]);
// A `received` credit is on the way only when it is a refill's (an uncounted
// refill leg: "hub2_refill_uncounted", "clothing_cr_uncounted"), never a
// supplier delivery typed in at Central.
const REFILL_RECEIPT = /refill|clothing_cr|clothing_order|fulfil/i;

const keyOk = (k) => typeof k === "string" && k !== "" && !/[.#$[\]/~]/.test(k);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

// Mirror of admin-movement.cjs stockCellKey (the client's fold): the ledger keeps the RAW size.
function sizeKeyOf(size) {
  const s = size == null ? "" : String(size).trim();
  if (!s || s === "Free Size") return "_";
  return s.replace(/[.#$/[\]\s]/g, "_");
}

function configFrom(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const h = Number(c.cutoffHour);
  const days = Array.isArray(c.closedDays) ? c.closedDays.map((d) => String(d).slice(0, 3)).filter((d) => WEEKDAYS.includes(d)) : null;
  return {
    on: c.off !== true,
    cutoffHour: Number.isInteger(h) && h >= 0 && h <= 23 ? h : DEFAULTS.cutoffHour,
    // Every day closed would never end a delivery: fall back to the default.
    closedDays: days && days.length < 7 ? [...new Set(days)] : [...DEFAULTS.closedDays],
  };
}

/**
 * When a piece sent at `tsMs` has landed: the cutoff hour (SAST) of the first
 * trading day strictly AFTER the SA calendar day it was sent on. PURE.
 */
function untilMs(tsMs, cfg = configFrom(null)) {
  const t = Number(tsMs);
  if (!Number.isFinite(t)) return null;
  const sa = new Date(t + SAST_OFFSET_MS);
  // SA midnight of the day it was sent, as a UTC instant.
  let day = Date.UTC(sa.getUTCFullYear(), sa.getUTCMonth(), sa.getUTCDate());
  for (let i = 0; i < 8; i += 1) {
    day += 864e5;
    if (!cfg.closedDays.includes(WEEKDAYS[new Date(day).getUTCDay()])) break;
  }
  return day + cfg.cutoffHour * 3600e3 - SAST_OFFSET_MS;
}

/**
 * The shelf one movement puts units INTO by a transfer, refill or fulfilment,
 * or null. PURE.  → { loc, pid, sizeKey, q } | null
 */
function inboundLeg(m) {
  if (!m || typeof m !== "object" || !m.productId || !m.to) return null;
  const to = String(m.to);
  if (NOT_A_SHELF.has(to) || (m.from && NOT_A_SHELF.has(String(m.from))) || m.from === m.to) return null;
  const q = num(m.qty);
  if (!(q > 0)) return null;
  const isTransfer = m.type === "transfer_out" || m.type === "transfer_in";
  const isRefillReceipt = m.type === "received" && REFILL_RECEIPT.test(String(m.reason || ""));
  if (!isTransfer && !isRefillReceipt) return null;
  const pid = String(m.productId);
  const sizeKey = sizeKeyOf(m.size);
  if (!keyOk(to) || !keyOk(pid) || !keyOk(sizeKey)) return null;
  return { loc: to, pid, sizeKey, q };
}

const tsOf = (m) => { const t = Date.parse((m && (m.ts || m.appliedAt)) || ""); return Number.isFinite(t) ? t : null; };

/**
 * Rows the tick should keep, from a batch of ledger rows. PURE.
 *   movements  { [movementId]: row }
 * → [{ loc, pid, sizeKey, mvId, q, at, until }]   only those still on the way at nowMs
 */
function rowsFromMovements(movements, nowMs, cfg = configFrom(null)) {
  const out = [];
  for (const [mvId, m] of Object.entries(movements || {})) {
    if (!keyOk(mvId)) continue;
    const leg = inboundLeg(m);
    if (!leg) continue;
    const at = tsOf(m);
    if (at == null) continue;
    const until = untilMs(at, cfg);
    if (until == null || until <= nowMs) continue;
    out.push({ ...leg, mvId, at, until });
  }
  return out;
}

/** Units on the way in one shelf's node ({ [mvId]: { q, until } }). PURE. */
function sumOnTheWay(node, nowMs) {
  let n = 0;
  for (const r of Object.values(node || {})) if (r && num(r.until) > nowMs) n += Math.max(0, num(r.q));
  return n;
}

/** Units that were on the way into one shelf at instant `atMs`, from ledger rows of that shelf. PURE. */
function onTheWayAt(rows, atMs, cfg = configFrom(null)) {
  let n = 0;
  for (const m of rows || []) {
    const t = tsOf(m);
    if (t == null || t > atMs) continue;
    const u = untilMs(t, cfg);
    if (u != null && u > atMs && inboundLeg(m)) n += num(m.qty);
  }
  return n;
}

const read = async (db, path) => (await db.ref(path).once("value")).val();
const shelfPath = (loc, pid, sizeKey) => `${OTW_PATH}/${loc}/${pid}/${sizeKey}`;

let cfgCache = null;
async function readConfig(db, nowMs = Date.now()) {
  if (cfgCache && nowMs - cfgCache.at < 60e3) return cfgCache.cfg;
  let cfg;
  try { cfg = configFrom(await read(db, OTW_CONFIG_PATH)); } catch { cfg = configFrom(null); }
  cfgCache = { at: nowMs, cfg };
  return cfg;
}
function forgetConfig() { cfgCache = null; }

/**
 * Units on the way into ONE shelf now.
 *   cell   the cell as the caller just read it (optional): its own last movement
 *          is looked at too, so a transfer the tick has not seen yet still counts.
 * → { qty, rows: { [mvId]: { q, until } } }       0 when the rule is switched off
 */
async function readOnTheWay(db, { loc, pid, sizeKey, cell = undefined, nowMs = Date.now() }) {
  if (!keyOk(loc) || !keyOk(pid) || !keyOk(sizeKey)) return { qty: 0, rows: {} };
  const cfg = await readConfig(db, nowMs);
  if (!cfg.on) return { qty: 0, rows: {}, off: true };
  const rows = { ...((await read(db, shelfPath(loc, pid, sizeKey))) || {}) };
  const mvId = cell && typeof cell === "object" ? cell.mv : null;
  if (keyOk(mvId) && !rows[mvId]) {
    try {
      const m = await read(db, `stock_movements/${mvId}`);
      const leg = inboundLeg(m);
      const at = tsOf(m);
      if (leg && leg.loc === loc && leg.pid === pid && leg.sizeKey === sizeKey && at != null) {
        const until = untilMs(at, cfg);
        if (until > nowMs) rows[mvId] = { q: leg.q, until, at };
      }
    } catch { /* the tick's rows still stand */ }
  }
  return { qty: sumOnTheWay(rows, nowMs), rows };
}

/**
 * The tick: fold the NEW ledger rows into the working set and drop what has
 * landed. Reads stock_movements by `ts` from (cursor − overlap) only.
 *   readSince(isoFrom) → { [mvId]: row }   injected: a `ts`-ordered range read
 * → { read, kept, expired, cursor }
 */
const OVERLAP_MS = 20 * 60e3;
const FIRST_RUN_LOOKBACK_MS = 4 * 864e5;
async function trackOnTheWay(db, { nowMs, readSince, log = () => {} }) {
  const cfg = await readConfig(db, nowMs);
  const meta = (await read(db, OTW_META_PATH)) || {};
  const cursorMs = Date.parse(meta.cursor || "");
  const fromMs = Number.isFinite(cursorMs) ? cursorMs - OVERLAP_MS : nowMs - FIRST_RUN_LOOKBACK_MS;
  const movements = (await readSince(new Date(fromMs).toISOString())) || {};
  const rows = cfg.on ? rowsFromMovements(movements, nowMs, cfg) : [];
  const upd = {};
  for (const r of rows) {
    upd[`${shelfPath(r.loc, r.pid, r.sizeKey)}/${r.mvId}`] = { q: r.q, until: r.until, at: r.at };
    upd[`${OTW_DUE_PATH}/${r.until}/${r.loc}~${r.pid}~${r.sizeKey}~${r.mvId}`] = true;
  }
  // The cursor is the newest `ts` seen (never the server clock: a device's late row with an older ts is caught by the overlap).
  let newest = Number.isFinite(cursorMs) ? cursorMs : fromMs;
  for (const m of Object.values(movements)) { const t = tsOf(m); if (t != null && t > newest && t <= nowMs + 5 * 60e3) newest = t; }
  // Landed: everything due at or before now, found through the expiry index alone.
  const due = (await db.ref(OTW_DUE_PATH).orderByKey().endAt(String(nowMs)).once("value")).val() || {};
  let expired = 0;
  for (const [untilKey, byShelf] of Object.entries(due)) {
    for (const k of Object.keys(byShelf || {})) {
      const [loc, pid, sizeKey, mvId] = k.split("~");
      if (keyOk(loc) && keyOk(pid) && keyOk(sizeKey) && keyOk(mvId)) { upd[`${shelfPath(loc, pid, sizeKey)}/${mvId}`] = null; expired += 1; }
    }
    upd[`${OTW_DUE_PATH}/${untilKey}`] = null;
  }
  upd[OTW_META_PATH] = { cursor: new Date(newest).toISOString(), ranAt: nowMs, read: Object.keys(movements).length, kept: rows.length };
  await db.ref().update(upd);
  log(`on the way: ${Object.keys(movements).length} ledger rows read, ${rows.length} on the way kept, ${expired} landed`);
  return { read: Object.keys(movements).length, kept: rows.length, expired, cursor: upd[OTW_META_PATH].cursor };
}

/** The whole working set, flattened (the nightly list build reads it once: a small node). */
async function readAllOnTheWay(db, nowMs = Date.now()) {
  const cfg = await readConfig(db, nowMs);
  if (!cfg.on) return new Map();
  const all = (await read(db, OTW_PATH)) || {};
  const out = new Map();
  for (const [loc, byPid] of Object.entries(all)) for (const [pid, bySize] of Object.entries(byPid || {})) for (const [sizeKey, node] of Object.entries(bySize || {})) {
    const q = sumOnTheWay(node, nowMs);
    if (q > 0) out.set(`${loc}|${pid}|${sizeKey}`, q);
  }
  return out;
}

module.exports = {
  OTW_PATH, OTW_DUE_PATH, OTW_META_PATH, OTW_CONFIG_PATH, DEFAULTS, OVERLAP_MS,
  configFrom, untilMs, inboundLeg, rowsFromMovements, sumOnTheWay, onTheWayAt, sizeKeyOf,
  readOnTheWay, trackOnTheWay, readAllOnTheWay, readConfig, forgetConfig,
};

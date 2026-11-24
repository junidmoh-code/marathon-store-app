// ─── DAILY SHELF CHECKS — tonight's list for every place (Mac mini, after the 02:30 sweep) ──
//
//   node scripts/online/shelf-checks.mjs --build [--commit] [--singles <file>] [--held <file>]
//   node scripts/online/shelf-checks.mjs --progress
//
// Junid, 24 Nov 2026 (functions/webShelf/lib.cjs has the rules), made a permanent
// daily routine the same evening: every place heals a few counts every day —
// never a big count, never "clear everything", a steady rotation. For each place
// (Hubs 1–3, Central, and each shop Junid has switched on) the list is filled to
// the day's number (/config/onlineOrders/shelfChecks/perDay, 20) in this order,
// oldest first inside each:
//
//   1. web_reject    a website rejection wrote the shelf down (/online_writedowns): is it there after all?
//   2. store_reject  any other rejection held the shelf (/online_cell_holds, a store kind — functions/lib/shelf-rejects.cjs)
//   3. wrong_by_more a website rejection while the shelf showed two or more (a website hold)
//   4. not_selling   stock on the shelf, no sale or outbound movement for 21 days (logs/shelf-last-out.json,
//                    folded forward from the ledger each night; at Marathon PE and Trophy the stock audit card's
//                    clothing rotation is respected — a product in its current batch, or walked by it within the
//                    recheck window, is not asked here too)
//   5. old_single    one piece, untouched longest (logs/shelf-singles.json, from the sweep)
//
// Left off: a shelf with stock still on the way (until the delivery cutoff,
// functions/lib/on-the-way.cjs); a shelf settled by a person within the recheck
// window (30 days) unless a NEW rejection arrived since.
//
// WRITES only under /shelf_checks (each place's open list, its `listed` and
// `added` counters for the day, and the pruned `checked` stamps). DRY RUN
// unless --commit. No stock is touched.
// READS: the hold node per product, the write-down working set, each place's
// open list and checked stamps, the on-the-way working set, the stock audit's
// batch and stamps (two shops), one cell per candidate from those working sets,
// and the ledger rows since last night (folded into the local file). Never a
// whole node of stock or the ledger. The bytes downloaded are printed.
import { existsSync, readFileSync, statSync, mkdirSync } from "fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "url";
import { adminRequire } from "../adminRequire.mjs";
import { CELL_HOLDS_PATH, holdStands, cellQty, cellStampMs } from "../shopify/pickableStock.mjs";
import { serverNowMs } from "../shopify/publishNode.mjs";
import { foldLastOut, notSelling, pruneLastOut, loadLastOut, saveLastOut } from "./shelfLastOut.mjs";

const require = createRequire(import.meta.url);
const L = require("../../functions/webShelf/lib.cjs");
const O = require("../../functions/lib/on-the-way.cjs");
const R = require("../../functions/lib/shelf-rejects.cjs");
const { WRITEDOWNS_PATH } = require("../../functions/lib/web-writedown.cjs");
const { saDateStringFromMs } = require("../../functions/lib/sa-time.cjs");
const DB_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const LOGS = new URL("../../logs/", import.meta.url);
const SINGLES_DEFAULT = fileURLToPath(new URL("shelf-singles.json", LOGS));
const HELD_DEFAULT = fileURLToPath(new URL("shelf-held.json", LOGS));
const LAST_OUT_FILE = fileURLToPath(new URL("shelf-last-out.json", LOGS));
const FRESH_MS = 12 * 3600e3;
const SEED_DAYS = 35;
const NAME = { hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3", "marathon-pe": "Marathon PE", trophy: "Trophy", concrete: "Concrete", "marathon-pine": "Pine", central: "Central" };
// The stock audit card's rotation (functions/lib/stock-audit.cjs Tab B) covers these shops' clothing.
const AUDIT_STATE = "settings/stockAudit/state/batch";
const AUDIT_ROTATION = "settings/stockAudit/rotation";
const WEB_WRITEDOWN_KINDS = new Set(["hub_out_of_stock", "shop_not_found", "central_not_found", "backfill"]);

/**
 * PURE. Every candidate per place, from the working sets the build reads.
 *   writeDowns  [{ pid, sizeKey, loc, row, cell }]   /online_writedowns rows with their cells
 *   holds       [{ pid, sizeKey, loc, hold, cell }]  /online_cell_holds rows with their cells
 *   singles     [{ pid, loc, sizeKey, at }]          the sweep's lone pieces
 *   idle        [{ loc, pid, sizeKey, shown, at, lastMoved }]   not-selling shelves (oldest first)
 *   auditSkip   (loc, pid) => true when the stock audit card is asking (or has just asked) about that product
 */
export function candidatesByPlace({ writeDowns = [], holds = [], singles = [], idle = [], auditSkip = () => false }) {
  const out = Object.fromEntries(L.CHECK_LOCATIONS.map((loc) => [loc, []]));
  const push = (loc, c) => { if (out[loc]) out[loc].push(c); };
  for (const w of writeDowns) {
    // Only a write-down a REJECTION made (the check's own Not found is already a person's answer), still exactly as it left the shelf.
    if (!w.row || !w.row.mvId || !WEB_WRITEDOWN_KINDS.has(w.row.kind) || !w.cell || w.cell.mv !== w.row.mvId) continue;
    push(w.loc, { pid: w.pid, sizeKey: w.sizeKey, why: L.WHY.WEB, shown: cellQty(w.cell), at: Number(w.row.at), lastMoved: cellStampMs(w.cell), mvId: w.row.mvId, ref: w.row.orderNumber != null ? `website order #${w.row.orderNumber}` : w.row.orderId ? `website order ${w.row.orderId}` : null, src: w.row.kind });
  }
  for (const h of holds) {
    if (!holdStands(h.hold, h.cell)) continue;
    const shown = cellQty(h.cell);
    const base = { pid: h.pid, sizeKey: h.sizeKey, shown, at: Number(h.hold.at), holdAt: Number(h.hold.at), lastMoved: cellStampMs(h.cell), src: h.hold.kind || null, ref: h.hold.orderId || null };
    if (R.isStoreHold(h.hold)) push(h.loc, { ...base, why: L.WHY.STORE });
    // A website hold: two or more shown is "wrong by more"; one shown (the write-down did not run) is asked like a single.
    else push(h.loc, { ...base, why: shown > 1 ? L.WHY.MORE : L.WHY.WEB, ref: h.hold.orderId ? `website order ${h.hold.orderId}` : null });
  }
  for (const s of idle) if (!auditSkip(s.loc, s.pid)) push(s.loc, { pid: s.pid, sizeKey: s.sizeKey, why: L.WHY.IDLE, shown: s.shown, at: s.at, lastMoved: s.lastMoved ?? null });
  // Central's own lone pieces are not listed (stock on its way out); its other sources are.
  for (const s of singles) if (s.loc !== "central" && !auditSkip(s.loc, s.pid)) push(s.loc, { pid: s.pid, sizeKey: s.sizeKey, why: L.WHY.OLD, shown: 1, at: Number(s.at), lastMoved: Number(s.at) });
  return out;
}

/** PURE. (loc, pid) → is the stock audit card asking about it (current batch, not yet walked) or has it within `days`? */
export function auditSkipper({ batch = {}, rotation = {}, nowMs, days }) {
  return (loc, pid) => {
    const b = batch[loc];
    const stamp = Number(rotation?.[loc]?.[pid]?.at);
    const walked = Number.isFinite(stamp) && stamp > 0;
    if (b && Array.isArray(b.pids) && b.pids.includes(pid) && !(walked && stamp >= Number(b.at || 0))) return true;
    return walked && nowMs - stamp < days * 864e5;
  };
}

function fresh(file) { return existsSync(file) && Date.now() - statSync(file).mtimeMs <= FRESH_MS; }

async function main() {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const COMMIT = argv.includes("--commit");
  const admin = adminRequire(import.meta.url)("firebase-admin");
  const app = admin.initializeApp({ databaseURL: DB_URL });
  const db = admin.database();
  const token = (await app.options.credential.getAccessToken()).access_token;
  let bytes = 0;
  const rest = async (path, query = "") => {
    const res = await fetch(`${DB_URL}/${path}.json${query ? `?${query}` : ""}`, { headers: { Authorization: `Bearer ${token}` } });
    const t = await res.text(); bytes += t.length;
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${t.slice(0, 200)}`);
    return JSON.parse(t);
  };

  if (argv.includes("--progress")) {
    for (const loc of L.CHECK_LOCATIONS) {
      const p = L.progressOf(await rest(`${L.SHELF_CHECKS_PATH}/${loc}/days`, `orderBy=%22$key%22&limitToLast=14`), await rest(`${L.SHELF_CHECKS_PATH}/${loc}/open`));
      console.log(`${NAME[loc] || loc}: ${p.open} open ${JSON.stringify(p.openBySource)} · last 14 days: ${p.checked14} checked, ${p.wrong14} wrong`);
    }
    process.exit(0);
  }
  if (!argv.includes("--build")) { console.error("usage: shelf-checks.mjs --build [--commit] [--singles <file>] [--held <file>] | --progress"); process.exit(2); }

  const cfg = L.configFrom(await rest(L.SHELF_CONFIG_PATH));
  if (!cfg.on) { console.log("switched off (config/onlineOrders/shelfChecks/off)"); process.exit(0); }
  const nowMs = await serverNowMs(db);
  const saDate = saDateStringFromMs(nowMs);

  // ── the sweep's files: lone pieces and every shelf showing stock ──
  const singlesFile = opt("--singles") || SINGLES_DEFAULT;
  const heldFile = opt("--held") || HELD_DEFAULT;
  const singles = fresh(singlesFile) ? JSON.parse(readFileSync(singlesFile, "utf8")).singles || [] : [];
  const held = fresh(heldFile) ? JSON.parse(readFileSync(heldFile, "utf8")).held || [] : [];
  if (!singles.length) console.log(`no fresh lone-piece list at ${singlesFile} (the sweep writes it): no old single pieces tonight`);
  if (!held.length) console.log(`no fresh list of shelves holding stock at ${heldFile} (the sweep writes it): no not-selling shelves tonight`);

  // ── when each shelf last sold or sent something out: the local file, folded forward from the ledger ──
  mkdirSync(LOGS, { recursive: true });
  let lastOut = loadLastOut(LAST_OUT_FILE);
  const fromIso = lastOut?.cursor ? new Date(Date.parse(lastOut.cursor) - 30 * 60e3).toISOString() : new Date(nowMs - SEED_DAYS * 864e5).toISOString();
  if (!lastOut) { lastOut = { cursor: null, since: fromIso, last: {} }; console.log(`first run: reading the ledger back ${SEED_DAYS} days once, to ${fromIso}`); }
  const ledger = (await rest("stock_movements", `orderBy=${encodeURIComponent('"ts"')}&startAt=${encodeURIComponent(`"${fromIso}"`)}`)) || {};
  lastOut = pruneLastOut(foldLastOut(lastOut, ledger, nowMs), nowMs);
  const idleAll = notSelling(held, lastOut, { nowMs, idleDays: cfg.idleDays });
  console.log(`ledger rows folded: ${Object.keys(ledger).length} · shelves holding stock: ${held.length} · not selling for ${cfg.idleDays}+ days: ${idleAll.length}`);

  // ── the working sets: write-downs and holds, each with its cell ──
  const writeDowns = [], holds = [];
  const wd = (await rest(WRITEDOWNS_PATH)) || {};
  for (const [pid, bySize] of Object.entries(wd)) for (const [sizeKey, byLoc] of Object.entries(bySize || {})) for (const [loc, row] of Object.entries(byLoc || {})) writeDowns.push({ pid, sizeKey, loc, row, cell: await rest(`stock/${loc}/${pid}/${sizeKey}`) });
  const holdPids = Object.keys((await rest(CELL_HOLDS_PATH, "shallow=true")) || {});
  for (const pid of holdPids) {
    const node = (await rest(`${CELL_HOLDS_PATH}/${pid}`)) || {};
    for (const [sizeKey, byLoc] of Object.entries(node)) for (const [loc, hold] of Object.entries(byLoc || {})) holds.push({ pid, sizeKey, loc, hold, cell: await rest(`stock/${loc}/${pid}/${sizeKey}`) });
  }

  // ── the stock audit card's rotation (Marathon PE and Trophy clothing): never asked twice ──
  const auditSkip = auditSkipper({ batch: (await rest(AUDIT_STATE)) || {}, rotation: { "marathon-pe": (await rest(`${AUDIT_ROTATION}/marathon-pe`)) || {}, trophy: (await rest(`${AUDIT_ROTATION}/trophy`)) || {} }, nowMs, days: cfg.recheckDays });

  const otw = await O.readAllOnTheWay(db, nowMs);
  const by = candidatesByPlace({ writeDowns, holds, singles: singles.map((s) => ({ ...s })), idle: idleAll, auditSkip });
  for (const loc of L.CHECK_LOCATIONS) {
    if (!L.placeOn(cfg, loc)) { console.log(`${NAME[loc] || loc}: switched off (config/onlineOrders/shelfChecks/shops/${loc}/on) · ${by[loc].length} candidates waiting`); continue; }
    const [open, checked] = await Promise.all([rest(`${L.SHELF_CHECKS_PATH}/${loc}/open`), rest(`${L.SHELF_CHECKS_PATH}/${loc}/checked`)]);
    const plan = L.planDay({ open: open || {}, candidates: by[loc], checked: checked || {}, onTheWay: (id) => { const [pid, sizeKey] = id.split("__"); return otw.get(`${loc}|${pid}|${sizeKey}`) || 0; }, perDay: cfg.perDay, recheckDays: cfg.recheckDays, nowMs, saDate });
    const addedBy = {};
    for (const id of plan.added) addedBy[plan.open[id].why] = (addedBy[plan.open[id].why] || 0) + 1;
    console.log(`${NAME[loc] || loc}: ${Object.keys(plan.open).length} of ${cfg.perDay} · ${JSON.stringify(plan.bySource)} · ${plan.added.length} new, ${plan.dropped.length} back to the pool · left off: ${plan.skipped.travelling} on the way, ${plan.skipped.recent} checked recently · ${by[loc].length} candidates`);
    if (!COMMIT) continue;
    await db.ref(`${L.SHELF_CHECKS_PATH}/${loc}/open`).set(plan.open);
    await db.ref(`${L.SHELF_CHECKS_PATH}/${loc}/days/${saDate}`).update({ listed: Object.keys(plan.open).length, added: addedBy });
    // Stamps older than the recheck window decide nothing any more.
    const prune = {};
    for (const [id, t] of Object.entries(checked || {})) if (!(nowMs - Number(t) < cfg.recheckDays * 864e5)) prune[id] = null;
    if (Object.keys(prune).length) await db.ref(`${L.SHELF_CHECKS_PATH}/${loc}/checked`).update(prune);
  }
  // The local cache is saved on a dry run too: it is only what the ledger already says, and saves reading it twice.
  saveLastOut(LAST_OUT_FILE, lastOut);
  console.log(`${COMMIT ? "" : "dry run: nothing written. Add --commit. · "}downloaded ${(bytes / 1e6).toFixed(2)} MB`);
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e?.message || e); process.exit(1); });

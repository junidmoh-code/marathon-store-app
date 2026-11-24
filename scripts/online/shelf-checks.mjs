// ─── DAILY SHELF CHECKS — tonight's top-up (Mac mini, after the 02:30 sweep) ──
//
//   node scripts/online/shelf-checks.mjs --build [--commit] [--singles <file>]
//   node scripts/online/shelf-checks.mjs --progress
//
// Junid, 24 Nov 2026 (functions/webShelf/lib.cjs has the rules). For each shop
// and hub: what is still open ROLLS OVER, and the list is filled back up to the
// day's number (/config/onlineOrders/shelfChecks/perDay, 20) with
//   1. the shelves held as "count wrong by more than one" (/online_cell_holds
//      rows that still stand on a shelf showing two or more), then
//   2. the single pieces untouched longest that the website lists — taken from
//      logs/shelf-singles.json, which the nightly stock-truth sweep writes from
//      the cells it reads anyway (so this costs no extra stock read).
// WRITES only under /shelf_checks. DRY RUN unless --commit. No stock is touched.
// READS: the hold node's keys (shallow) and each held product's own rows and
// cells, each place's open list, the settings node. No whole-node read.
import { existsSync, readFileSync, statSync } from "fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "url";
import { adminRequire } from "../adminRequire.mjs";
import { shallowKeys } from "../lib/rtdbPaged.mjs";
import { CELL_HOLDS_PATH, holdStands, cellQty, cellStampMs } from "../shopify/pickableStock.mjs";
import { serverNowMs } from "../shopify/publishNode.mjs";

const L = createRequire(import.meta.url)("../../functions/webShelf/lib.cjs");
const { saDateStringFromMs } = createRequire(import.meta.url)("../../functions/lib/sa-time.cjs");
const DB_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const SINGLES_DEFAULT = fileURLToPath(new URL("../../logs/shelf-singles.json", import.meta.url));
const SINGLES_MAX_AGE_MS = 12 * 3600e3;
const NAME = { hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3", "marathon-pe": "Marathon PE", trophy: "Trophy", concrete: "Concrete", "marathon-pine": "Pine", central: "Central" };

/** PURE. The candidates per place from the sweep's lone pieces and the standing holds. */
export function candidatesByPlace(singles, holds) {
  const out = Object.fromEntries(L.CHECK_LOCATIONS.map((loc) => [loc, { more: [], singles: [] }]));
  for (const h of holds || []) {
    if (!out[h.loc] || !holdStands(h.hold, h.cell)) continue;
    const shown = cellQty(h.cell);
    if (shown > 1) out[h.loc].more.push({ pid: h.pid, sizeKey: h.sizeKey, shown, holdAt: Number(h.hold.at), lastMoved: cellStampMs(h.cell) });
  }
  // Central's own lone pieces are not listed (stock on its way out); its "wrong by more" shelves are.
  for (const s of singles || []) if (out[s.loc] && s.loc !== "central") out[s.loc].singles.push({ pid: s.pid, sizeKey: s.sizeKey, at: Number(s.at) });
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const COMMIT = argv.includes("--commit");
  const admin = adminRequire(import.meta.url)("firebase-admin");
  const app = admin.initializeApp({ databaseURL: DB_URL });
  const db = admin.database();
  const get = async (p) => (await db.ref(p).get()).val();

  if (argv.includes("--progress")) {
    for (const loc of L.CHECK_LOCATIONS) {
      const p = L.progressOf((await db.ref(`${L.SHELF_CHECKS_PATH}/${loc}/days`).orderByKey().limitToLast(14).get()).val(), await get(`${L.SHELF_CHECKS_PATH}/${loc}/open`));
      console.log(`${NAME[loc] || loc}: ${p.open} open · last 14 days: ${p.checked14} checked, ${p.wrong14} wrong`);
    }
    process.exit(0);
  }
  if (!argv.includes("--build")) { console.error("usage: shelf-checks.mjs --build [--commit] [--singles <file>] | --progress"); process.exit(2); }

  const cfg = L.configFrom(await get(L.SHELF_CONFIG_PATH));
  if (!cfg.on) { console.log("switched off (config/onlineOrders/shelfChecks/off)"); process.exit(0); }
  const file = opt("--singles") || SINGLES_DEFAULT;
  let singles = [];
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs <= SINGLES_MAX_AGE_MS) singles = JSON.parse(readFileSync(file, "utf8")).singles || [];
  else console.log(`no fresh lone-piece list at ${file} (the sweep writes it): only the "wrong by more than one" shelves are added tonight`);
  const holds = [];
  for (const pid of await shallowKeys(app, CELL_HOLDS_PATH)) {
    const node = (await get(`${CELL_HOLDS_PATH}/${pid}`)) || {};
    for (const [sizeKey, byLoc] of Object.entries(node)) for (const [loc, hold] of Object.entries(byLoc || {})) holds.push({ pid, sizeKey, loc, hold, cell: await get(`stock/${loc}/${pid}/${sizeKey}`) });
  }
  const nowMs = await serverNowMs(db);
  const saDate = saDateStringFromMs(nowMs);
  const by = candidatesByPlace(singles, holds);
  for (const loc of L.CHECK_LOCATIONS) {
    const open = (await get(`${L.SHELF_CHECKS_PATH}/${loc}/open`)) || {};
    const plan = L.planTopUp({ open, more: by[loc].more, singles: by[loc].singles, perDay: cfg.perDay, nowMs, saDate });
    const added = Object.values(plan.add);
    console.log(`${NAME[loc] || loc}: ${Object.keys(open).length} rolled over + ${added.length} added (${added.filter((a) => a.why === L.WHY.MORE).length} wrong by more, ${added.filter((a) => a.why === L.WHY.OLD).length} old single) = ${plan.listed} of ${cfg.perDay} · candidates: ${by[loc].more.length} wrong by more, ${by[loc].singles.length} lone pieces`);
    if (!COMMIT) continue;
    if (added.length) await db.ref(`${L.SHELF_CHECKS_PATH}/${loc}/open`).update(plan.add);
    await db.ref(`${L.SHELF_CHECKS_PATH}/${loc}/days/${saDate}/listed`).set(plan.listed);
  }
  if (!COMMIT) console.log("dry run: nothing written. Add --commit.");
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e?.message || e); process.exit(1); });

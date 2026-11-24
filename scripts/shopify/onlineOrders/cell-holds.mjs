// ─── SHELF HOLDS — list, back-fill, prune, roll back ─────────────────────────
//
//   node scripts/shopify/onlineOrders/cell-holds.mjs --list
//   node scripts/shopify/onlineOrders/cell-holds.mjs --from <rejections.json> [--commit]
//   node scripts/shopify/onlineOrders/cell-holds.mjs --prune [--commit]
//   node scripts/shopify/onlineOrders/cell-holds.mjs --rollback <file> [--commit]
//   node scripts/shopify/onlineOrders/cell-holds.mjs --stale [--commit]
//   node scripts/shopify/onlineOrders/cell-holds.mjs --stale-off <file> [--commit]
//
// The rule is in ../pickableStock.mjs: a cell (product, size, place) that
// rejected a website pick is not counted for the website and not routed to
// until the cell moves again. The poller and the Display Checks function write
// a hold at the moment of a rejection; this tool does the three other jobs.
//
//   --from      THE BACK-FILL. Takes the audit's rejections.json (every hub Out
//               of Stock and shop Not found on a website pick since #1768) and
//               writes a hold for each cell that is STILL exactly as it was
//               when it was rejected: still showing a piece, not moved since.
//               A cell that has moved since is left alone (its count has been
//               touched, so it is trusted). Stamped with the rejection's own
//               time, so it ends on the next movement like any other hold.
//   --prune     Removes holds that no longer stand (the cell moved or is
//               empty). Housekeeping only: a dead row hides nothing.
//   --rollback  Removes the holds a back-fill wrote, each only if it is still
//               the row that back-fill wrote, and tells the website.
//
//   --old-single  THE OLD SINGLE PIECE WITH NOTHING BEHIND IT (pickableStock.mjs,
//               Junid 24 Nov 2026: a size is not sold on the website when every
//               place holding it shows one piece, each untouched 60 days or
//               more, and nothing is at Central, a hub or in transit). Lists
//               every size that rule takes off the website right now. With
//               --was <stale-single file>: also says, for the sizes the retired
//               14-day Marathon PE rule had hidden, which came back and which
//               the new rule still catches. With --commit: writes the rollback
//               file and tells the website about every product in either list.
//   --old-single-off <file>  Switches the rule off (config .../pickable/oldSingle/off)
//               and tells the website about every product in the file.
//
//   --write-down  A REJECTION CORRECTS THE COUNT, SINGLE PIECES ONLY (Junid, 24 Nov
//               2026 — functions/lib/web-writedown.cjs). Every standing hold
//               whose shelf shows exactly ONE piece is written to zero as a
//               `web_not_found` stock movement naming the order that was
//               rejected; a hold on a shelf showing two or more is listed as
//               "count wrong by more than one" and left alone. With --commit:
//               writes the rollback file first.
//   --write-down-rollback <file>  Puts back each piece that file wrote down, only
//               where the shelf has not moved since.
//
// DRY RUN unless --commit. NO STOCK IS TOUCHED by any mode but --write-down and
// its rollback: the other modes only write rows under /online_cell_holds and
// the website's dirty counters. Every
// --from --commit writes a rollback file first (~/marathon-rollbacks/), listing
// every size taken off the website and how to put it back.
//
// READS: exact paths only — one cell per rejected shelf, one hold node per
// product. No whole-node read (the hold node's KEYS are listed shallow).
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { adminRequire } from "../../adminRequire.mjs";
import { shallowKeys } from "../../lib/rtdbPaged.mjs";
import { CELL_HOLDS_PATH, PICKABLE_CONFIG_PATH, SHOP_LOCATIONS, PIPELINE_ONLY_LOCATIONS, cellQty, cellStampMs, holdRow, holdStands, pickableTree, rulesFrom } from "../pickableStock.mjs";
import { networkTotals } from "../inventory.mjs";
import { locationNames } from "../inventorySync.mjs";
import { serverNowMs } from "../publishNode.mjs";
import { createRequire } from "node:module";
const { writeDownSingle, restoreFound, WRITEDOWNS_PATH } = createRequire(import.meta.url)("../../../functions/lib/web-writedown.cjs");

const DB_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const DIRTY_PATHS = ["shopify_inventory_dirty", "shopify_inventory_dirty_concrete"];
const LOC_NAME = { hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3", "marathon-pe": "Marathon PE", trophy: "Trophy", concrete: "Concrete", "marathon-pine": "Pine" };
const sizeLabel = (k) => (k === "_" ? "one size" : String(k).replace(/_/g, "."));

/**
 * PURE. Which holds a back-fill writes.
 *   rejections  [{ pid, sizeKey, loc, at, kind, orderId, line, order, product }]
 *   cells       { "pid|sizeKey|loc": cell }     the live cells
 *   existing    { "pid|sizeKey|loc": hold }     holds already there
 * → { write: [{ path, value, pid, sizeKey, loc, product, order, qty }], skipped: { moved, empty, held } }
 */
export function planBackfill(rejections, cells, existing = {}) {
  const latest = new Map();
  for (const r of rejections) {
    const key = `${r.pid}|${r.sizeKey}|${r.loc}`;
    if (!latest.has(key) || latest.get(key).at < r.at) latest.set(key, r);
  }
  const write = [];
  const skipped = { moved: 0, empty: 0, held: 0, unkeyable: 0 };
  for (const [key, r] of latest) {
    const cell = cells[key] ?? null;
    if (cellQty(cell) <= 0) { skipped.empty += 1; continue; }
    if (!holdStands({ at: r.at }, cell)) { skipped.moved += 1; continue; }
    if (existing[key] && Number(existing[key].at) >= r.at && holdStands(existing[key], cell)) { skipped.held += 1; continue; }
    const row = holdRow({ pid: r.pid, sizeKey: r.sizeKey, loc: r.loc, at: r.at, kind: r.kind, orderId: r.orderId, line: r.line, qty: cellQty(cell), by: "backfill 2026-11-24" });
    if (!row) { skipped.unkeyable += 1; continue; }
    write.push({ ...row, pid: r.pid, sizeKey: r.sizeKey, loc: r.loc, product: r.product || r.pid, order: r.order || "", qty: cellQty(cell), cellStamp: cellStampMs(cell) });
  }
  return { write, skipped };
}

/** PURE. Which hold rows are dead (cell moved or empty). holds: [{ pid, sizeKey, loc, hold, cell }] */
export const deadHolds = (holds) => holds.filter((h) => !holdStands(h.hold, h.cell));
// A dead row is still the note "this shelf rejected a website pick on that day", which routing's trust score reads
// (routing.mjs shelfRisk, `rejectedDays`). It is only cleared once it is older than this.
export const KEEP_DEAD_HOLD_MS = 45 * 864e5;
/** PURE. The dead rows old enough to remove. */
export const prunableHolds = (holds, nowMs) => deadHolds(holds).filter((h) => !(nowMs - Number(h.hold?.at) < KEEP_DEAD_HOLD_MS));

async function main() {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); if (i < 0) return null; const v = argv[i + 1]; if (!v || v.startsWith("--")) { console.error(`${n} needs a value`); process.exit(2); } return v; };
  const COMMIT = argv.includes("--commit");
  const admin = adminRequire(import.meta.url)("firebase-admin");
  const app = admin.initializeApp({ databaseURL: DB_URL });
  const db = admin.database();
  const get = async (p) => (await db.ref(p).get()).val();
  const markDirty = async (pids) => { for (const pid of pids) for (const node of DIRTY_PATHS) await db.ref(`${node}/${pid}`).set(admin.database.ServerValue.increment(1)); };

  const allHolds = async () => {
    const out = [];
    for (const pid of await shallowKeys(app, CELL_HOLDS_PATH)) {
      const node = (await get(`${CELL_HOLDS_PATH}/${pid}`)) || {};
      for (const [sizeKey, byLoc] of Object.entries(node)) for (const [loc, hold] of Object.entries(byLoc || {})) {
        out.push({ pid, sizeKey, loc, hold, cell: await get(`stock/${loc}/${pid}/${sizeKey}`) });
      }
    }
    return out;
  };

  if (argv.includes("--list") || argv.includes("--prune")) {
    const holds = await allHolds();
    const dead = deadHolds(holds);
    const standing = holds.filter((h) => !dead.includes(h));
    console.log(`shelf holds: ${holds.length} rows, ${standing.length} standing (${standing.reduce((n, h) => n + cellQty(h.cell), 0)} pieces off the website), ${dead.length} ended`);
    if (argv.includes("--list")) for (const h of standing) console.log(`  ${h.pid} size ${sizeLabel(h.sizeKey)} at ${LOC_NAME[h.loc] || h.loc}: ${cellQty(h.cell)} on paper, rejected ${new Date(h.hold.at).toISOString()} (${h.hold.kind}, order ${h.hold.orderId})`);
    if (argv.includes("--prune")) {
      const old = prunableHolds(holds, Date.now());
      if (!COMMIT) console.log(`dry run: would remove ${old.length} ended row(s) older than 45 days (${dead.length - old.length} newer ended rows stay as routing's "rejected lately" note). Add --commit.`);
      else {
        let removed = 0;
        for (const h of old) {
          // Only the row that was judged: a fresh rejection written meanwhile is kept.
          const res = await db.ref(`${CELL_HOLDS_PATH}/${h.pid}/${h.sizeKey}/${h.loc}`).transaction((cur) => (cur == null ? null : Number(cur.at) === Number(h.hold.at) ? null : undefined));
          if (res.committed && !res.snapshot.exists()) removed += 1;
        }
        console.log(`removed ${removed} ended row(s)`);
      }
    }
    process.exit(0);
  }

  if (argv.includes("--old-single")) {
    const rules = rulesFrom(await get(PICKABLE_CONFIG_PATH));
    if (!rules.oldSingle) { console.log("the old-single-piece rule is switched off (config/onlineOrders/pickable/oldSingle/off)"); process.exit(0); }
    const wasFile = opt("--was");
    const was = wasFile ? JSON.parse(readFileSync(wasFile, "utf8")).items || [] : [];
    const nowMs = Date.now();
    // Exact-path reads over REST: thousands of them, and the Admin SDK answers
    // one-off reads one at a time (about 0.2 s each from here).
    const token = (await app.options.credential.getAccessToken()).access_token;
    const rest = async (path) => {
      const res = await fetch(`${DB_URL}/${path}.json`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`read of /${path} failed: ${res.status}`);
      return res.json();
    };
    // Only products that are listed AND have a cell node at a shop (the only places the rule can catch).
    const listed = new Set((await shallowKeys(app, "shopify_sync")).filter((k) => !k.startsWith("_")));
    const atShop = new Set(was.map((x) => x.pid));
    for (const loc of SHOP_LOCATIONS) for (const pid of await shallowKeys(app, `stock/${loc}`)) if (listed.has(pid)) atShop.add(pid);
    const pids = [...atShop];
    const locs = await locationNames(db);
    const items = [];
    const wasNow = new Map(); // "pid|size" of the retired rule's list → what the website may sell now
    let bytes = 0;
    const DAY = 864e5;
    for (let i = 0; i < pids.length; i += 24) {
      await Promise.all(pids.slice(i, i + 24).map(async (pid) => {
        // The shops first: a product with no lone old piece at a shop costs four small reads and stops.
        const own = {};
        for (const loc of SHOP_LOCATIONS) { const c = await rest(`stock/${loc}/${pid}`); bytes += JSON.stringify(c ?? null).length; if (c) own[loc] = { [pid]: c }; }
        const wanted = was.some((x) => x.pid === pid);
        const maybe = Object.values(own).some((per) => Object.values(per[pid] || {}).some((c) => cellQty(c) === 1 && cellStampMs(c) != null && nowMs - cellStampMs(c) >= rules.oldSingle.days * DAY));
        if (!maybe && !wanted) return;
        const map = await rest(`shopify_sync/${pid}`);
        if (!map?.variants) return;
        const tree = { ...own };
        await Promise.all(locs.filter((loc) => !SHOP_LOCATIONS.includes(loc)).map(async (loc) => { const c = await rest(`stock/${loc}/${pid}`); bytes += JSON.stringify(c ?? null).length; if (c) tree[loc] = { [pid]: c }; }));
        // In transit and the stockroom: never counted for the website, but they ARE a pipeline behind a size.
        const pipe = {};
        for (const loc of PIPELINE_ONLY_LOCATIONS) { const c = await rest(`stock/${loc}/${pid}`); bytes += JSON.stringify(c ?? null).length; if (c) pipe[loc] = { [pid]: c }; }
        for (const loc of PIPELINE_ONLY_LOCATIONS) delete tree[loc];
        const holdsNode = await rest(`${CELL_HOLDS_PATH}/${pid}`);
        const sizes = Object.keys(map.variants);
        const before = networkTotals(pickableTree(tree, pid, holdsNode, { ...rules, oldSingle: null }, nowMs).tree, pid, sizes);
        const { tree: after, hidden } = pickableTree(tree, pid, holdsNode, rules, nowMs, pipe);
        const now = networkTotals(after, pid, sizes);
        const p = (await rest(`products/${pid}`)) || {};
        bytes += JSON.stringify(p).length;
        const meta = { product: p.name || pid, category: p.category || "", subcategory: p.subcategory || p.categoryKey || "", brand: p.brand || "" };
        for (const x of was.filter((w) => w.pid === pid)) wasNow.set(`${pid}|${x.size}`, { ...x, ...meta, websiteUnderOldRule: x.websiteNow, websiteNow: now[Object.keys(now).find((k) => sizeLabel(k) === x.size)] ?? 0, stillHidden: hidden.some((h) => h.why === "old_single" && sizeLabel(h.sizeKey) === x.size) });
        const seen = new Set();
        for (const h of hidden.filter((x) => x.why === "old_single")) {
          if (!(h.sizeKey in before) || seen.has(h.sizeKey)) continue; // a size the listing does not carry; one row per size
          seen.add(h.sizeKey);
          const at = hidden.filter((x) => x.why === "old_single" && x.sizeKey === h.sizeKey);
          items.push({ pid, ...meta, size: sizeLabel(h.sizeKey), places: at.map((x) => LOC_NAME[x.loc] || x.loc).join(" + "), lastMoved: new Date(Math.max(...at.map((x) => x.at))).toISOString().slice(0, 10), websiteBefore: before[h.sizeKey], websiteNow: now[h.sizeKey] });
        }
      }));
    }
    items.sort((a, b) => a.product.localeCompare(b.product) || a.size.localeCompare(b.size));
    console.log(`${pids.length} listed product(s) with stock cells at a shop checked · read ${bytes} bytes`);
    console.log(`old single pieces with nothing behind them (every holder one piece, untouched ${rules.oldSingle.days}+ days, nothing at Central / a hub / in transit): ${items.length} size(s) on ${new Set(items.map((x) => x.pid)).size} product(s)`);
    for (const x of items) console.log(`    ${x.product} · size ${x.size} · ${x.places} · last moved ${x.lastMoved} · website ${x.websiteBefore} → ${x.websiteNow}`);
    const wasRows = [...wasNow.values()];
    if (wasFile) {
      const back = wasRows.filter((x) => !x.stillHidden);
      console.log(`the retired 14-day Marathon PE rule had ${was.length} size(s) listed (${was.filter((x) => x.websiteNow === 0).length} sold out because of it): ${back.length} are counted again; ${wasRows.length - back.length} are still off the website under the new rule; ${was.length - wasRows.length} no longer listed`);
    }
    const dir = join(homedir(), "marathon-rollbacks");
    const file = join(dir, `old-single-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    const body = {
      what: `Sizes not sold on the website under the old-single-piece rule (every place holding the size shows one piece, each untouched ${rules.oldSingle.days} days or more, nothing at Central, a hub or in transit). No stock count was changed and no product was unpublished. This run also retired the 14-day Marathon PE rule: "retired" lists the sizes that rule had hidden and what each may sell now.`,
      restore: `node scripts/shopify/onlineOrders/cell-holds.mjs --old-single-off ${file} --commit   (switches the rule off and tells the website; every size is back within a few minutes in trading hours). Each size also returns by itself the moment one of its shelves has a sale, a delivery, a transfer or a count.`,
      writtenAt: new Date().toISOString(), rule: rules.oldSingle, items, retired: wasRows,
    };
    if (!COMMIT) {
      const out = opt("--out");
      if (out) { writeFileSync(out, JSON.stringify(body, null, 1)); console.log(`dry run: nothing written to the database; the list is in ${out}`); }
      else console.log("dry run: nothing written. Add --commit.");
      process.exit(0);
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(body, null, 1));
    console.log(`rollback file: ${file}`);
    const tell = new Set([...items.map((x) => x.pid), ...was.map((x) => x.pid)]);
    await markDirty(tell);
    console.log(`the website is told: ${tell.size} product(s) marked for the next push`);
    process.exit(0);
  }

  const oldSingleOff = opt("--old-single-off");
  if (oldSingleOff) {
    const file = JSON.parse(readFileSync(oldSingleOff, "utf8"));
    const pids = new Set((file.items || []).map((x) => x.pid));
    if (!COMMIT) { console.log(`dry run: would switch the old-single-piece rule off and tell the website about ${pids.size} product(s). Add --commit.`); process.exit(0); }
    await db.ref(`${PICKABLE_CONFIG_PATH}/oldSingle/off`).set(true);
    await markDirty(pids);
    console.log(`rule switched off; ${pids.size} product(s) marked for the next push`);
    process.exit(0);
  }

  if (argv.includes("--write-down")) {
    const holds = (await allHolds()).filter((h) => holdStands(h.hold, h.cell));
    const single = holds.filter((h) => cellQty(h.cell) === 1);
    const more = holds.filter((h) => cellQty(h.cell) > 1);
    const names = {};
    for (const pid of new Set(holds.map((h) => h.pid))) names[pid] = (await get(`products/${pid}/name`)) || pid;
    const row = (h) => `${names[h.pid]} · size ${sizeLabel(h.sizeKey)} · ${LOC_NAME[h.loc] || h.loc} · ${cellQty(h.cell)} on paper · rejected ${new Date(h.hold.at).toISOString().slice(0, 16)} (order ${h.hold.orderId})`;
    console.log(`standing holds: ${holds.length} shelf cell(s)`);
    console.log(`  to write to zero (the shelf shows exactly one piece): ${single.length}`);
    for (const h of single) console.log(`    ${row(h)}`);
    console.log(`  count wrong by more than one (NOT changed; stays held off the website until a person counts it): ${more.length} shelf cell(s), ${more.reduce((n, h) => n + cellQty(h.cell), 0)} piece(s) on paper`);
    for (const h of more) console.log(`    ${row(h)}`);
    if (!COMMIT) { console.log("dry run: nothing written. Add --commit."); process.exit(0); }
    const dir = join(homedir(), "marathon-rollbacks");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `write-down-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    const plan = single.map((h) => ({ pid: h.pid, sizeKey: h.sizeKey, loc: h.loc, product: names[h.pid], size: sizeLabel(h.sizeKey), place: LOC_NAME[h.loc] || h.loc, rejectedAt: Number(h.hold.at), orderId: h.hold.orderId || null, line: h.hold.line ?? null, by: h.hold.by || null }));
    writeFileSync(file, JSON.stringify({
      what: "Shelves written to zero on 24 Nov 2026: each rejected a website pick, has not moved since, and showed exactly one piece. Each is a `web_not_found` stock movement of one unit.",
      restore: `node scripts/shopify/onlineOrders/cell-holds.mjs --write-down-rollback ${file} --commit   (puts each piece back as a \`web_found\` movement, only where that shelf has not moved since). Each one also puts itself back if the piece is later sold, picked or marked Found there.`,
      writtenAt: new Date().toISOString(), items: plan, countWrongByMoreThanOne: more.map((h) => ({ pid: h.pid, product: names[h.pid], size: sizeLabel(h.sizeKey), place: LOC_NAME[h.loc] || h.loc, onPaper: cellQty(h.cell), rejectedAt: Number(h.hold.at), orderId: h.hold.orderId || null })),
    }, null, 1));
    console.log(`rollback file: ${file}`);
    let done = 0;
    const nowIso = new Date(await serverNowMs(db)).toISOString();
    for (const w of plan) {
      const res = await writeDownSingle(db, { pid: w.pid, sizeKey: w.sizeKey, size: w.size === "one size" ? "_" : w.size, loc: w.loc, kind: "backfill", orderId: w.orderId, orderNumber: null, line: w.line, by: null, at: w.rejectedAt, idTag: `backfill_${w.orderId}_${w.line}_${w.rejectedAt}` }, { nowIso });
      if (res.ok && res.wroteDown) done += 1; else console.log(`    left alone: ${w.product} size ${w.size} at ${w.place} (${res.reason || (res.movedSince ? "moved since" : `shows ${res.qty}`)})`);
    }
    await markDirty(new Set(plan.map((w) => w.pid)));
    console.log(`written to zero: ${done} shelf cell(s); the website is told`);
    process.exit(0);
  }

  const wdRollback = opt("--write-down-rollback");
  if (wdRollback) {
    const file = JSON.parse(readFileSync(wdRollback, "utf8"));
    let back = 0, kept = 0;
    const nowIso = new Date(await serverNowMs(db)).toISOString();
    const pids = new Set();
    for (const w of file.items || []) {
      const rowNow = await get(`${WRITEDOWNS_PATH}/${w.pid}/${w.sizeKey}/${w.loc}`);
      const cell = await get(`stock/${w.loc}/${w.pid}/${w.sizeKey}`);
      // Only a write-down this file made, on a shelf nothing has touched since.
      const mine = rowNow && Number(rowNow.at) === Number(w.rejectedAt) && rowNow.kind === "backfill" && cell && cell.mv === rowNow.mvId;
      if (!mine) { kept += 1; continue; }
      if (!COMMIT) { back += 1; continue; }
      const res = await restoreFound(db, { pid: w.pid, sizeKey: w.sizeKey, loc: w.loc, why: "rollback" }, { nowIso });
      if (res.ok && res.restored) { back += 1; pids.add(w.pid); } else kept += 1;
    }
    if (COMMIT) await markDirty(pids);
    console.log(`${COMMIT ? "put back" : "dry run: would put back"} ${back} piece(s); ${kept} left alone (the shelf moved since, or it was already put back)`);
    process.exit(0);
  }

  const rollbackFile = opt("--rollback");
  if (rollbackFile) {
    const file = JSON.parse(readFileSync(rollbackFile, "utf8"));
    let removed = 0, kept = 0;
    const pids = new Set();
    for (const h of file.holds) {
      const mine = (cur) => cur && Number(cur.at) === Number(h.value.at) && cur.by === h.value.by;
      if (!COMMIT) { if (mine(await get(h.path))) removed += 1; else kept += 1; continue; }
      // Only the row this back-fill wrote, judged and removed in one step.
      let wasMine = false;
      const res = await db.ref(h.path).transaction((cur) => { wasMine = !!cur && mine(cur); return cur == null ? null : wasMine ? null : undefined; });
      if (res.committed && wasMine) { removed += 1; pids.add(h.pid); } else kept += 1;
    }
    if (COMMIT) await markDirty(pids);
    console.log(`${COMMIT ? "removed" : "dry run: would remove"} ${removed} hold(s); ${kept} left alone (gone already, or replaced by a newer rejection)`);
    process.exit(0);
  }

  const from = opt("--from");
  if (!from) { console.error("usage: cell-holds.mjs --list | --from <rejections.json> [--commit] | --prune [--commit] | --rollback <file> [--commit] | --old-single [--was <file>] [--commit] | --old-single-off <file> [--commit] | --write-down <rejections.json> [--commit] | --write-down-rollback <file> [--commit]"); process.exit(2); }
  const rejections = JSON.parse(readFileSync(from, "utf8"));
  const keys = [...new Set(rejections.map((r) => `${r.pid}|${r.sizeKey}|${r.loc}`))];
  const cells = {};
  const existing = {};
  let bytes = 0;
  for (const key of keys) {
    const [pid, sizeKey, loc] = key.split("|");
    cells[key] = await get(`stock/${loc}/${pid}/${sizeKey}`);
    existing[key] = await get(`${CELL_HOLDS_PATH}/${pid}/${sizeKey}/${loc}`);
    bytes += JSON.stringify(cells[key] ?? null).length + JSON.stringify(existing[key] ?? null).length;
  }
  const plan = planBackfill(rejections, cells, existing);
  console.log(`${rejections.length} rejection(s) on ${keys.length} shelf cell(s) · read ${bytes} bytes`);
  console.log(`  to hold: ${plan.write.length} cell(s), ${plan.write.reduce((n, w) => n + w.qty, 0)} piece(s) off the website`);
  console.log(`  left alone: ${plan.skipped.moved} moved since (trusted again) · ${plan.skipped.empty} already empty · ${plan.skipped.held} already held`);
  for (const w of plan.write) console.log(`    ${w.product} · size ${sizeLabel(w.sizeKey)} · ${LOC_NAME[w.loc] || w.loc} · ${w.qty} on paper · rejected ${new Date(w.value.at).toISOString().slice(0, 16)} (${w.order})`);
  if (!COMMIT) { console.log("dry run: nothing written. Add --commit."); process.exit(0); }

  const dir = join(homedir(), "marathon-rollbacks");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `cell-holds-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({
    what: "Shelf holds written by the 24 Nov 2026 back-fill: sizes taken off the website because that shelf rejected a website pick and has not moved since. No stock count was changed.",
    restore: `node scripts/shopify/onlineOrders/cell-holds.mjs --rollback ${file} --commit   (removes exactly these holds and tells the website; each size is back on sale within about two minutes in trading hours). Each hold also ends by itself the next time that shelf has a sale, a delivery, a transfer or a count.`,
    writtenAt: new Date().toISOString(),
    holds: plan.write.map((w) => ({ path: w.path, value: w.value, pid: w.pid, product: w.product, size: sizeLabel(w.sizeKey), place: LOC_NAME[w.loc] || w.loc, piecesOffTheWebsite: w.qty, rejectedOnOrder: w.order })),
  }, null, 1));
  console.log(`rollback file: ${file}`);
  for (const w of plan.write) await db.ref(w.path).set(w.value);
  await markDirty(new Set(plan.write.map((w) => w.pid)));
  console.log(`written: ${plan.write.length} hold(s); the website is told (${new Set(plan.write.map((w) => w.pid)).size} product(s) marked for the next push)`);
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e?.message || e); process.exit(1); });

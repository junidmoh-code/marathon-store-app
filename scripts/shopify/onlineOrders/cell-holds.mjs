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
//   --stale     THE LONE STALE PIECE (pickableStock.mjs: one piece at Marathon
//               PE untouched for over 14 days is not counted for the website).
//               Lists every size that rule takes off the website right now.
//               With --commit: writes the rollback file and tells the website,
//               so the sizes go this tick instead of at the 02:30 sweep. The
//               rule itself lives in code and config, not in rows.
//   --stale-off Switches that rule off (config .../pickable/staleSingle/off)
//               and tells the website about every product in the file.
//
// DRY RUN unless --commit. NO STOCK IS TOUCHED by any mode: the only writes are
// rows under /online_cell_holds and the website's dirty counters. Every
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
import { CELL_HOLDS_PATH, PICKABLE_CONFIG_PATH, cellQty, cellStampMs, holdRow, holdStands, pickableTree, rulesFrom } from "../pickableStock.mjs";
import { networkTotals } from "../inventory.mjs";
import { locationNames } from "../inventorySync.mjs";

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
      if (!COMMIT) console.log(`dry run: would remove ${dead.length} ended row(s). Add --commit.`);
      else {
        let removed = 0;
        for (const h of dead) {
          // Only the row that was judged: a fresh rejection written meanwhile is kept.
          const res = await db.ref(`${CELL_HOLDS_PATH}/${h.pid}/${h.sizeKey}/${h.loc}`).transaction((cur) => (cur && Number(cur.at) === Number(h.hold.at) ? null : undefined));
          if (res.committed) removed += 1;
        }
        console.log(`removed ${removed} ended row(s)`);
      }
    }
    process.exit(0);
  }

  if (argv.includes("--stale")) {
    const rules = rulesFrom(await get(PICKABLE_CONFIG_PATH));
    if (!rules.staleSingle) { console.log("the lone-stale-piece rule is switched off (config/onlineOrders/pickable/staleSingle/off)"); process.exit(0); }
    const nowMs = Date.now();
    // Exact-path reads over REST: thousands of them, and the Admin SDK answers
    // one-off reads one at a time (about 0.2 s each from here).
    const token = (await app.options.credential.getAccessToken()).access_token;
    const rest = async (path) => {
      const res = await fetch(`${DB_URL}/${path}.json`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`read of /${path} failed: ${res.status}`);
      return res.json();
    };
    // Only products that are listed AND have a cell node at one of the rule's places.
    const listed = new Set((await shallowKeys(app, "shopify_sync")).filter((k) => !k.startsWith("_")));
    const atPlace = new Set();
    for (const loc of rules.staleSingle.locations) for (const pid of await shallowKeys(app, `stock/${loc}`)) if (listed.has(pid)) atPlace.add(pid);
    const pids = [...atPlace];
    const locs = await locationNames(db);
    const items = [];
    let bytes = 0;
    for (let i = 0; i < pids.length; i += 24) {
      await Promise.all(pids.slice(i, i + 24).map(async (pid) => {
        // The rule's own places first: most products have no lone piece there and cost one small read.
        const own = {};
        for (const loc of rules.staleSingle.locations) { const c = await rest(`stock/${loc}/${pid}`); bytes += JSON.stringify(c ?? null).length; if (c) own[loc] = { [pid]: c }; }
        if (!pickableTree(own, pid, null, { holds: false, staleSingle: rules.staleSingle }, nowMs).hidden.length) return;
        const map = await rest(`shopify_sync/${pid}`);
        if (!map?.variants) return;
        const tree = { ...own };
        await Promise.all(locs.filter((loc) => !tree[loc]).map(async (loc) => { const c = await rest(`stock/${loc}/${pid}`); bytes += JSON.stringify(c ?? null).length; if (c) tree[loc] = { [pid]: c }; }));
        const holdsNode = await rest(`${CELL_HOLDS_PATH}/${pid}`);
        const sizes = Object.keys(map.variants);
        const before = networkTotals(pickableTree(tree, pid, holdsNode, { ...rules, staleSingle: null }, nowMs).tree, pid, sizes);
        const { tree: after, hidden } = pickableTree(tree, pid, holdsNode, rules, nowMs);
        const now = networkTotals(after, pid, sizes);
        const name = (await rest(`products/${pid}/name`)) || pid;
        for (const h of hidden.filter((x) => x.why === "stale_single")) {
          if (!(h.sizeKey in before)) continue; // a size the listing does not carry
          items.push({ pid, product: name, size: sizeLabel(h.sizeKey), place: LOC_NAME[h.loc] || h.loc, lastMoved: new Date(h.at).toISOString().slice(0, 10), websiteBefore: before[h.sizeKey], websiteNow: now[h.sizeKey] });
        }
      }));
    }
    items.sort((a, b) => a.product.localeCompare(b.product) || a.size.localeCompare(b.size));
    const gone = items.filter((x) => x.websiteNow === 0);
    console.log(`${pids.length} listed product(s) with stock cells at ${rules.staleSingle.locations.join(", ")} checked · read ${bytes} bytes of stock`);
    console.log(`lone stale pieces (one piece at ${rules.staleSingle.locations.map((l) => LOC_NAME[l] || l).join(", ")}, untouched over ${rules.staleSingle.days} days): ${items.length} size(s) on ${new Set(items.map((x) => x.pid)).size} product(s)`);
    console.log(`  ${gone.length} size(s) are sold out on the website because of it; ${items.length - gone.length} stay on sale from another place`);
    for (const x of items) console.log(`    ${x.product} · size ${x.size} · last moved ${x.lastMoved} · website ${x.websiteBefore} → ${x.websiteNow}`);
    if (!COMMIT) { console.log("dry run: nothing written. Add --commit."); process.exit(0); }
    const dir = join(homedir(), "marathon-rollbacks");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `stale-single-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({
      what: `Sizes taken off the website by the lone-stale-piece rule (one piece at ${rules.staleSingle.locations.join(", ")} whose count has not moved for over ${rules.staleSingle.days} days). No stock count was changed and no product was unpublished: the size's website quantity is lower by that one piece.`,
      restore: `node scripts/shopify/onlineOrders/cell-holds.mjs --stale-off ${file} --commit   (switches the rule off and tells the website; every size is back within about two minutes in trading hours). Each size also returns by itself the next time that cell has a sale, a delivery, a transfer or a count.`,
      writtenAt: new Date().toISOString(), rule: rules.staleSingle, items,
    }, null, 1));
    console.log(`rollback file: ${file}`);
    await markDirty(new Set(items.map((x) => x.pid)));
    console.log(`the website is told: ${new Set(items.map((x) => x.pid)).size} product(s) marked for the next push`);
    process.exit(0);
  }

  const staleOff = opt("--stale-off");
  if (staleOff) {
    const file = JSON.parse(readFileSync(staleOff, "utf8"));
    const pids = new Set((file.items || []).map((x) => x.pid));
    if (!COMMIT) { console.log(`dry run: would switch the lone-stale-piece rule off and tell the website about ${pids.size} product(s). Add --commit.`); process.exit(0); }
    await db.ref(`${PICKABLE_CONFIG_PATH}/staleSingle/off`).set(true);
    await markDirty(pids);
    console.log(`rule switched off; ${pids.size} product(s) marked for the next push`);
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
      const res = await db.ref(h.path).transaction((cur) => (cur == null ? null : mine(cur) ? null : undefined));
      if (res.committed && !res.snapshot.exists() && (await get(h.path)) == null) { removed += 1; pids.add(h.pid); } else kept += 1;
    }
    if (COMMIT) await markDirty(pids);
    console.log(`${COMMIT ? "removed" : "dry run: would remove"} ${removed} hold(s); ${kept} left alone (gone already, or replaced by a newer rejection)`);
    process.exit(0);
  }

  const from = opt("--from");
  if (!from) { console.error("usage: cell-holds.mjs --list | --from <rejections.json> [--commit] | --prune [--commit] | --rollback <file> [--commit] | --stale [--commit] | --stale-off <file> [--commit]"); process.exit(2); }
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

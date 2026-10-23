// ─── STOCK-TRUTH AUDIT — every live variant, app against website ─────────────
//
//   node scripts/shopify/stock-truth-audit.mjs
//   node scripts/shopify/stock-truth-audit.mjs --pid p123 [--pid p456] [--handle <storefront handle>]
//   node scripts/shopify/stock-truth-audit.mjs --json <file>
//
// READ-ONLY. No RTDB write, no Shopify mutation (the bulk READ query is the
// only Shopify operation, the same one the nightly sweep runs).
//
// THREE VIEWS OF ONE VARIANT, side by side:
//   app       the online pool the pusher would write: networkTotals (the
//             pusher's own function, excluded locations dropped) less website
//             holds — computed by planProduct, the pusher's own comparison
//   shopify   on_hand at Shopify's single location (what was last pushed)
//   sellable  what Shopify is actually selling: on_hand − committed if
//             tracked+DENY, unlimited otherwise
// and a fourth, from OUTSIDE the admin API altogether: the public storefront's
// /products.json `available` flag — what a customer's browser is told.
//
// For every --pid (and for every variant offered at zero), the per-location
// breakdown INCLUDING the excluded locations, so "gone at this shop" can be
// told apart from "gone everywhere".
//
// HOW IT READS. /shopify_publish by its `state` index (the sweep's query),
// /locations, then per listed product: its id map, its website holds and one
// /stock cell set per location — point reads, never a whole node. Movements
// since the last sweep come from /stock_movements' `ts` index. The bytes read
// are printed.
import { createRequire } from "module";
import { writeFileSync } from "fs";
import { graphql } from "./client.mjs";
import { planProduct, isListedOnShopify, HEALTH_PATH, DIRTY_PATH, reservedBySize, releasedBySize } from "./inventorySync.mjs";
import { networkTotals, requireSingleLocation, ONLINE_EXCLUDED_LOCATIONS } from "./inventory.mjs";
import { readShopSnapshot } from "./bulkSnapshot.mjs";
import { ONLINE_RESERVATIONS_PATH } from "../../src/utils/onlineOrders.js";
import { sellable, causeOfOver, auditSummary } from "./stockAudit.mjs";
import { SEARCH_INDEX_PATH } from "./searchIndexDoc.mjs";
import { shallowKeys } from "../lib/rtdbPaged.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const flags = process.argv.slice(2);
const FOCUS = new Set(flags.flatMap((f, i) => (f === "--pid" ? [flags[i + 1]] : [])));
const FOCUS_HANDLES = new Set(flags.flatMap((f, i) => (f === "--handle" ? [flags[i + 1]] : [])));
const JSON_OUT = flags.includes("--json") ? flags[flags.indexOf("--json") + 1] : null;
const STOREFRONT = process.env.STOREFRONT_URL || "https://marathonclub.co.za";
const log = (s = "") => console.log(s);

let bytes = 0;
const get = async (path, q = (r) => r) => {
  const v = (await q(db.ref(path)).get()).val();
  bytes += Buffer.byteLength(JSON.stringify(v ?? null));
  return v;
};

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// The public storefront, as a browser sees it: gid → Map(variant title → available).
async function storefront() {
  const out = new Map();
  for (let page = 1; page < 100; page++) {
    const res = await fetch(`${STOREFRONT}/products.json?limit=250&page=${page}`, { headers: { "user-agent": "Mozilla/5.0 marathon-stock-audit" } });
    if (!res.ok) throw new Error(`storefront products.json page ${page}: HTTP ${res.status}`);
    const { products } = await res.json();
    if (!products?.length) break;
    for (const p of products) {
      out.set(`gid://shopify/Product/${p.id}`, { handle: p.handle, title: p.title, variants: new Map(p.variants.map((v) => [String(v.title), v.available === true])) });
    }
  }
  return out;
}

const qtyOf = (cell) => (cell !== null && typeof cell === "object" ? cell.qty : cell);

async function main() {
  const t0 = Date.now();
  const locIds = Object.keys((await get("locations")) || {});
  const health = await get(HEALTH_PATH);
  const lastSweepAt = Number(health?.lastSweep?.at) || null;
  const listedNodes = (await get("shopify_publish", (r) => r.orderByChild("state").equalTo("live"))) || {};
  const pids = Object.keys(listedNodes).filter((p) => isListedOnShopify(listedNodes[p])).sort();
  log(`listed on Shopify: ${pids.length}; locations: ${locIds.join(", ")}`);
  log(`excluded from online: ${[...ONLINE_EXCLUDED_LOCATIONS].join(", ")}`);
  log(`last nightly sweep: ${lastSweepAt ? new Date(lastSweepAt).toISOString() : "never"}; movement pass heartbeat: ${health?.lastPassAt ? new Date(health.lastPassAt).toISOString() : "none"}`);

  const locId = await requireSingleLocation(graphql);
  const [snapshot, sf] = await Promise.all([readShopSnapshot(graphql, locId), storefront()]);
  log(`Shopify snapshot: ${snapshot.size} active product(s); public storefront: ${sf.size} product(s)`);

  // Movements since the last sweep, by pid (ts index).
  const movedSince = new Set();
  if (lastSweepAt) {
    const rows = (await get("stock_movements", (r) => r.orderByChild("ts").startAt(new Date(lastSweepAt).toISOString()))) || {};
    for (const m of Object.values(rows)) if (m?.productId) movedSince.add(m.productId);
  }
  const dirty = new Set(await shallowKeys(admin.app(), DIRTY_PATH));
  if (lastSweepAt && Date.now() - lastSweepAt > 36 * 3600e3) log(`⚠ the last nightly sweep is ${Math.round((Date.now() - lastSweepAt) / 3600e3)} h old — the movement window read is wide`);

  const rows = [];
  const products = new Map();   // pid → { gid, cells per location, sizes }
  const issues = { noMap: [], inactive: [], deadMap: [], partialMap: [] };
  await pool(pids, 12, async (pid) => {
    const map = await get(`shopify_sync/${pid}`);
    if (!map?.variants) { issues.noMap.push(pid); return; }
    const gid = map.shopifyProductId;
    const shop = snapshot.get(gid);
    if (!shop) { issues.inactive.push(pid); return; }
    const sizes = Object.keys(map.variants);
    const tree = {};
    const cellSets = await Promise.all(locIds.map((loc) => get(`stock/${loc}/${pid}`)));
    locIds.forEach((loc, i) => { if (cellSets[i]) tree[loc] = { [pid]: cellSets[i] }; });
    const holds = await get(`${ONLINE_RESERVATIONS_PATH}/${pid}`);
    const totals = networkTotals(tree, pid, sizes);
    const allLoc = networkTotals(tree, pid, sizes, new Set());
    const plan = planProduct({ map, variants: shop.variants, baseline: shop.baseline, totals, reserved: reservedBySize(holds), released: releasedBySize(holds), committed: shop.committed });
    if (plan.allUnknown) issues.deadMap.push(pid);
    else if (plan.stale.staleVariants?.length) issues.partialMap.push(`${pid}: ${plan.stale.staleVariants.join(",")}`);
    products.set(pid, { gid, tree, sizes, name: listedNodes[pid]?.cleanName || null });
    const vByItem = new Map(shop.variants.map((v) => [v.inventoryItemId, v]));
    for (const it of [...plan.known, ...plan.unknown]) {
      const v = vByItem.get(it.inventoryItemId) || {};
      const onHand = shop.baseline.has(it.inventoryItemId) ? shop.baseline.get(it.inventoryItemId) : null;
      const committed = shop.committed.get(it.inventoryItemId) || 0;
      const row = {
        pid, gid, sizeKey: it.sizeKey, title: v.title ?? null,
        app: it.quantity, shopify: onHand ?? 0, committed,
        // An id-map item with no variant on the listing cannot be bought.
        sellable: v.inventoryItemId ? sellable({ onHand, committed, tracked: v.tracked, inventoryPolicy: v.inventoryPolicy }) : 0,
        tracked: v.tracked, inventoryPolicy: v.inventoryPolicy,
        allLocations: it.unmapped ? 0 : allLoc[it.sizeKey] ?? 0,
        excludedUnits: it.unmapped ? 0 : (allLoc[it.sizeKey] ?? 0) - (totals[it.sizeKey] ?? 0),
        // Stale = the listing has no such variant. A variant with no level at
        // the location is real and stays in the comparison (on_hand unknown → 0).
        unmapped: !!it.unmapped, staleMap: !it.unmapped && !vByItem.has(it.inventoryItemId),
        storefront: sf.get(gid)?.variants.get(String(v.title)) ?? null,
      };
      if (row.shopify > row.app) row.cause = causeOfOver(row, { dirty: dirty.has(pid), movedSinceSweep: movedSince.has(pid) });
      rows.push(row);
    }
  });

  // Published listings with no LISTED app product behind them.
  const listedGids = new Set([...products.values()].map((p) => p.gid));
  const orphanGids = [...sf.keys()].filter((g) => !listedGids.has(g));
  for (const g of orphanGids) {
    const shop = snapshot.get(g);
    for (const v of shop?.variants || []) {
      const onHand = shop.baseline.get(v.inventoryItemId) ?? 0;
      const committed = shop.committed.get(v.inventoryItemId) || 0;
      const row = { pid: null, gid: g, sizeKey: `unmanaged:${v.title}`, title: v.title, app: 0, shopify: onHand, committed,
        // An id-map item with no variant on the listing cannot be bought.
        sellable: v.inventoryItemId ? sellable({ onHand, committed, tracked: v.tracked, inventoryPolicy: v.inventoryPolicy }) : 0, unmanaged: true,
        storefront: sf.get(g)?.variants.get(String(v.title)) ?? null };
      if (row.shopify > 0) row.cause = "unmanaged";
      rows.push(row);
    }
  }

  const s = auditSummary(rows);
  // The customer's view: storefront says available while the app pool is 0.
  const sfAtZero = rows.filter((r) => r.app === 0 && r.storefront === true);
  // Units the app holds that are NOT already committed to an open web order,
  // on a listing the storefront shows (storefront null = not on the Online Store).
  const sfMissingButApp = rows.filter((r) => r.app - (r.committed || 0) > 0 && r.storefront === false);

  log("\n══ AUDIT ══");
  log(`variants compared: ${s.variants} (${products.size} listed products + ${orphanGids.length} storefront listing(s) with no listed app product)`);
  log(`Shopify ABOVE the app: ${s.above} variant(s), ${s.unitsAbove} unit(s)`);
  log(`Shopify BELOW the app: ${s.below} variant(s), ${s.unitsBelow} unit(s)`);
  log(`equal: ${s.equal}; id-map items Shopify does not have (not compared): ${s.staleMap}`);
  log(`sellable on Shopify at ZERO app stock: ${s.sellableAtZero} variant(s) (${s.sellableAtZeroUnits} unit(s), ${s.unlimitedAtZero} unlimited)`);
  log(`public storefront says AVAILABLE at zero app stock: ${sfAtZero.length} variant(s)`);
  log(`public storefront says SOLD OUT with app stock: ${sfMissingButApp.length} variant(s)`);
  log("by cause (Shopify above app):");
  for (const [c, b] of Object.entries(s.byCause).sort((a, b) => b[1].units - a[1].units)) log(`  ${c.padEnd(18)} ${b.variants} variant(s), ${b.units} unit(s)`);
  log(`listed but no id map: ${issues.noMap.length}; listed but not ACTIVE on Shopify: ${issues.inactive.length}; id map unknown to Shopify: ${issues.deadMap.length}; id map partly unknown: ${issues.partialMap.length}`);
  for (const l of issues.partialMap.slice(0, 20)) log(`  partial id map — ${l}`);
  for (const r of sfAtZero.slice(0, 40)) log(`  ⚠ ${r.pid || r.gid} ${r.sizeKey}: storefront available, app ${r.app}, Shopify on_hand ${r.shopify} committed ${r.committed} — ${r.cause || "?"}`);

  // Search index: does its cached inStock agree with Shopify's sellable now?
  let idxChecked = 0, idxStale = 0; const idxStaleList = [];
  await pool([...products.keys()], 12, async (pid) => {
    const doc = await get(`${SEARCH_INDEX_PATH}/docs/${pid}`);
    if (!doc) return;
    idxChecked++;
    const live = rows.filter((r) => r.pid === pid).some((r) => r.sellable > 0);
    if (!!doc.inStock !== live) { idxStale++; if (idxStaleList.length < 20) idxStaleList.push(`${pid}: index inStock=${!!doc.inStock}, Shopify sellable=${live}`); }
  });
  log(`\nsearch index: ${idxChecked} doc(s) checked, ${idxStale} with a stale inStock`);
  for (const l of idxStaleList) log(`  ${l}`);

  // Per-location breakdown for every focus pid (or storefront handle).
  for (const [pid, p] of products) if (FOCUS_HANDLES.has(sf.get(p.gid)?.handle)) FOCUS.add(pid);
  for (const pid of FOCUS) {
    const p = products.get(pid);
    if (!p) { log(`\n${pid}: not among the listed, active products`); continue; }
    log(`\n── ${pid} ${p.gid} ${sf.get(p.gid)?.handle || ""} ──`);
    const locs = locIds.filter((l) => p.tree[l]);
    log(`size   ${locs.map((l) => (ONLINE_EXCLUDED_LOCATIONS.has(l) ? `${l}*` : l).padStart(10)).join(" ")}   pool  shopify committed sellable storefront`);
    for (const r of rows.filter((x) => x.pid === pid)) {
      const cells = locs.map((l) => String(qtyOf(p.tree[l][pid]?.[r.sizeKey]) ?? "·").padStart(10)).join(" ");
      log(`${String(r.sizeKey).padEnd(6)} ${cells}   ${String(r.app).padStart(4)}  ${String(r.shopify).padStart(7)} ${String(r.committed).padStart(9)} ${String(r.sellable).padStart(8)} ${String(r.storefront).padStart(10)}`);
    }
    log("(* = excluded from online availability)");
  }

  log(`\nrtdb read: ${bytes.toLocaleString()} B in ${Math.round((Date.now() - t0) / 1000)} s`);
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), summary: s, sfAtZero, sfMissingButApp, issues, rows: rows.filter((r) => r.shopify !== r.app || r.sellable === Infinity || (r.storefront != null && (r.storefront === true) !== (r.sellable > 0))) }, (k, v) => (v === Infinity ? "unlimited" : v), 1));
}

main().then(() => process.exit(0)).catch((e) => { console.error(`✗ audit failed: ${e?.stack || e}`); process.exit(1); });

// ─── TARGETS PIPELINE · STEP 1: DEMAND EXTRACTION ─────────────────────────────
// Builds the deterministic demand aggregates that feed the three-AI stock-target
// analysis (see plan: AI-Driven Inventory Refill). ALL math happens HERE, in
// code — the AI models later receive these pre-computed aggregates and only
// exercise judgment on top of them; they never re-derive arithmetic.
//
// DATA SOURCES (read-only, via the firebase CLI so owner credentials apply —
// anon SDK reads of /stock are denied since the 2026-07-10 rules hardening):
//   • /stock_movements  — 90-day ts-windowed ledger query (sold/return = truth
//                         for fulfilled demand; captures walk-in POS sales)
//   • /insights_log     — action:"out_of_stock" events = UNFULFILLED demand the
//                         ledger can't see (a size never in stock never sells)
//   • /stock            — current qty at marathon-pe / trophy / hub2 / central
//   • /products         — clothing classification + size runs + names
//
// OUTPUT: scripts/targets/out/demand-aggregates-<date>.json  (model input)
//         scripts/targets/out/coverage-<date>.md             (honesty report)
//
// RUN:  npx vite-node scripts/targets/extract-demand.mjs
// (vite-node, not plain node — reuses src/utils/clothingSold.js, which imports
// extensionless ESM. The netting/velocity logic is THE production logic.)

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { nettedSoldRows, saDateOf, saStartIso, sizeSortKey } from "../../src/utils/clothingSold.js";
import { inferProductType } from "../../src/utils/insights.js";
import { decodeSizeKey } from "../../src/utils/sizeKey.js";

const PROJECT = "marathon-club";
const WINDOW_DAYS = 90;
const STORES = ["marathon-pe", "trophy"];           // the two AI-targeted shops
const STOCK_LOCS = ["marathon-pe", "trophy", "hub2", "central"];
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");

const today = saDateOf(new Date().toISOString());
const windowStartSa = saDateOf(new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString());
const windowStartIso = saStartIso(windowStartSa);

// ── fetch helpers ─────────────────────────────────────────────────────────────
function fbGet(dbPath, extraArgs = []) {
  // -o <file>, NOT stdout: the CLI exits before flushing large stdout payloads,
  // silently truncating multi-MB responses (bit us at ~4.9MB on /stock_movements).
  const tmp = path.join(OUT_DIR, `.fetch${Math.random().toString(36).slice(2)}.json`);
  const args = ["database:get", dbPath, "--project", PROJECT, "-o", tmp, ...extraArgs];
  process.stderr.write(`  fetching ${dbPath} ${extraArgs.join(" ")}\n`);
  execFileSync("firebase", args, { stdio: ["ignore", "ignore", "inherit"] });
  const parsed = JSON.parse(readFileSync(tmp, "utf8"));
  rmSync(tmp, { force: true });
  return parsed;
}

mkdirSync(OUT_DIR, { recursive: true });

console.error(`Demand extraction — window ${windowStartSa} → ${today} (${WINDOW_DAYS}d)`);
const movementsObj = fbGet("/stock_movements", ["--order-by", "ts", "--start-at", JSON.stringify(windowStartIso)]) || {};
const insightsObj = fbGet("/insights_log") || {};
const products = fbGet("/products") || {};
const stock = {};
for (const loc of STOCK_LOCS) stock[loc] = fbGet(`/stock/${loc}`) || {};

const movements = Object.values(movementsObj);

// ── clothing product set ──────────────────────────────────────────────────────
const isClothingProduct = (p) => inferProductType({ productType: p?.productType, size: (p?.sizes || [])[0] }) === "clothing";
const clothingIds = new Set(Object.keys(products).filter((id) => isClothingProduct(products[id])));

// name → productId fallback join for legacy insights events (pre-2026-06-10 have
// no productId). Lossy by design — every fallback hit is counted in coverage.
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const idByName = new Map();
for (const id of clothingIds) { const n = norm(products[id].name); if (n && !idByName.has(n)) idByName.set(n, id); }

// ── fulfilled demand: netted sold rows from the ledger (production logic) ─────
const productsById = products;
const soldRows = nettedSoldRows({ movements, productsById, windowStartSaDate: windowStartSa })
  .filter((r) => STORES.includes(r.store) && clothingIds.has(r.pid));

// actual ledger coverage can be shorter than 90d — velocity must use real days
const earliestSa = soldRows.reduce((min, r) => (r.saDate && r.saDate < min ? r.saDate : min), today);
const actualDays = Math.max(1, Math.round((new Date(today) - new Date(earliestSa)) / 864e5) + 1);

const bucketOf = (saDate) => {
  const age = Math.round((new Date(today) - new Date(saDate)) / 864e5);
  return age < 30 ? 0 : age < 60 ? 1 : 2;                 // m1 / m2 / m3
};

// (store,pid,size) → {sold90, sold30, sold7, monthly:[m1,m2,m3]}
const soldAgg = new Map();
for (const r of soldRows) {
  const k = `${r.store}|${r.pid}|${r.size}`;
  const a = soldAgg.get(k) || { sold90: 0, sold30: 0, sold7: 0, monthly: [0, 0, 0] };
  a.sold90 += r.qty;
  a.monthly[bucketOf(r.saDate)] += r.qty;
  if (bucketOf(r.saDate) === 0) a.sold30 += r.qty;
  const age = Math.round((new Date(today) - new Date(r.saDate)) / 864e5);
  if (age < 7) a.sold7 += r.qty;
  soldAgg.set(k, a);
}

// ── unfulfilled demand: OOS events (global per pid+size — store attribution on
// insights events is unreliable, stated in the model prompt) ──────────────────
let oosNameJoins = 0, oosUnmatched = 0;
const oosAgg = new Map(); // pid|size → count
for (const e of Object.values(insightsObj)) {
  if (!e || e.action !== "out_of_stock" || !e.timestamp) continue;
  if (saDateOf(e.timestamp) < windowStartSa) continue;
  let pid = e.productId && clothingIds.has(e.productId) ? e.productId : null;
  if (!pid && e.productId) continue;                       // known but not clothing
  if (!pid) {
    pid = idByName.get(norm(e.productName)) || null;
    if (pid) oosNameJoins++; else { oosUnmatched++; continue; }
  }
  if (inferProductType({ productType: products[pid]?.productType, size: e.size }) !== "clothing") continue;
  const k = `${pid}|${e.size}`;
  oosAgg.set(k, (oosAgg.get(k) || 0) + 1);
}

// ── current stock (decode cell keys back to raw sizes; clamp negatives) ───────
const qtyAt = (loc, pid, size) => {
  const cell = stock[loc]?.[pid]?.[String(size)] ?? stock[loc]?.[pid]?.[String(size).replace(/\./g, "_")];
  const q = typeof cell?.qty === "number" ? cell.qty : 0;
  return q;
};
let negativeCells = 0;
for (const loc of STOCK_LOCS) for (const pid of Object.keys(stock[loc] || {}))
  for (const sz of Object.keys(stock[loc][pid] || {})) if ((stock[loc][pid][sz]?.qty ?? 0) < 0) negativeCells++;

// ── assemble per-product rows ─────────────────────────────────────────────────
// A product participates if it has ANY signal: sold, OOS, or stock at any of the
// four locations. Sizes = union of product.sizes[], sold sizes, OOS sizes, and
// stocked sizes (so a size the catalog forgot but the ledger saw still appears).
const rows = [];
const activeIds = new Set();
for (const k of soldAgg.keys()) activeIds.add(k.split("|")[1]);
for (const k of oosAgg.keys()) activeIds.add(k.split("|")[0]);
for (const loc of STOCK_LOCS) for (const pid of Object.keys(stock[loc] || {}))
  if (clothingIds.has(pid) && Object.values(stock[loc][pid] || {}).some((c) => (c?.qty ?? 0) > 0)) activeIds.add(pid);

for (const pid of activeIds) {
  if (!clothingIds.has(pid)) continue;
  const p = products[pid] || {};
  const sizeSet = new Set((p.sizes || []).map(String));
  for (const [k] of soldAgg) { const [st, id, sz] = k.split("|"); if (id === pid) sizeSet.add(sz); }
  for (const [k] of oosAgg) { const [id, sz] = k.split("|"); if (id === pid) sizeSet.add(sz); }
  for (const loc of STOCK_LOCS) for (const szKey of Object.keys(stock[loc]?.[pid] || {}))
    if ((stock[loc][pid][szKey]?.qty ?? 0) !== 0) sizeSet.add(decodeSizeKey(szKey));

  const sizes = [...sizeSet].filter((s) => s && s !== "_")
    .sort((a, b) => sizeSortKey(a) - sizeSortKey(b) || a.localeCompare(b));
  if (!sizes.length) continue;

  const sizeRows = {};
  for (const size of sizes) {
    const perStore = {};
    let combinedVelDay = 0;
    for (const store of STORES) {
      const a = soldAgg.get(`${store}|${pid}|${size}`) || { sold90: 0, sold30: 0, sold7: 0, monthly: [0, 0, 0] };
      const qty = qtyAt(store, pid, size);
      const velDay = a.sold90 / actualDays;
      combinedVelDay += velDay;
      perStore[store] = {
        sold90: a.sold90, sold30: a.sold30, sold7: a.sold7, monthly: a.monthly,
        qty, negative: qty < 0 || undefined,
        velocityPerWeek: +(velDay * 7).toFixed(2),
        daysOfCover: velDay > 0 ? +(Math.max(qty, 0) / velDay).toFixed(1) : null,
        baselineTarget: Math.round(velDay * 2),           // deterministic: 2 days of cover
      };
    }
    sizeRows[size] = {
      ...perStore,
      oos90: oosAgg.get(`${pid}|${size}`) || 0,
      hub2Qty: qtyAt("hub2", pid, size),
      centralQty: qtyAt("central", pid, size),
      hub2BaselineTarget: Math.round(combinedVelDay * 2), // hub buffer ≈ 2 days of BOTH stores
    };
  }
  rows.push({
    productId: pid, name: p.name || "Unknown", subcategory: p.subcategory || p.category || null,
    catalogSizes: (p.sizes || []).map(String), sizes: sizeRows,
  });
}
rows.sort((a, b) => {
  const sold = (r) => Object.values(r.sizes).reduce((t, s) => t + STORES.reduce((u, st) => u + (s[st]?.sold90 || 0), 0), 0);
  return sold(b) - sold(a);
});

// ── write outputs ─────────────────────────────────────────────────────────────
const meta = {
  generatedAt: new Date().toISOString(),
  windowStartSa, windowEndSa: today, requestedDays: WINDOW_DAYS, actualLedgerDays: actualDays,
  stores: STORES, stockLocations: STOCK_LOCS,
  counts: {
    movementsFetched: movements.length,
    nettedSoldUnits: soldRows.reduce((t, r) => t + r.qty, 0),
    clothingProductsInCatalog: clothingIds.size,
    productsWithSignal: rows.length,
    oosEventsCounted: [...oosAgg.values()].reduce((a, b) => a + b, 0),
    oosNameJoinFallbacks: oosNameJoins, oosUnmatchedDropped: oosUnmatched,
    negativeStockCells: negativeCells,
  },
};
const outJson = path.join(OUT_DIR, `demand-aggregates-${today}.json`);
writeFileSync(outJson, JSON.stringify({ meta, products: rows }, null, 1));

const covLines = [
  `# Demand extraction coverage — ${today}`, "",
  `- Window: ${windowStartSa} → ${today} (requested ${WINDOW_DAYS}d, **actual ledger coverage ${actualDays}d** — velocity math uses the actual figure)`,
  `- Movements fetched (windowed): ${meta.counts.movementsFetched}`,
  `- Netted clothing units sold at ${STORES.join(" + ")}: ${meta.counts.nettedSoldUnits}`,
  `- Clothing products in catalog: ${meta.counts.clothingProductsInCatalog}; with demand/stock signal: ${meta.counts.productsWithSignal}`,
  `- OOS (unfulfilled-demand) events in window: ${meta.counts.oosEventsCounted} (${oosNameJoins} matched by name-fallback, ${oosUnmatched} dropped unmatched)`,
  `- Negative stock cells across ${STOCK_LOCS.join("/")}: ${negativeCells} (clamped to 0 for cover math; flagged per-row)`,
  "", `Output: ${path.basename(outJson)}`,
];
const covPath = path.join(OUT_DIR, `coverage-${today}.md`);
writeFileSync(covPath, covLines.join("\n") + "\n");
console.error(covLines.join("\n"));
console.error(`\nWrote ${outJson}`);

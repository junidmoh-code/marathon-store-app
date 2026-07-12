// ─── EXCESS AUDIT — full recomputation against LIVE inventory ─────────────────
// Owner request (2026-07-12): audit the excess calculations before continuing.
// Recomputes excess for ALL of marathon-pe / trophy / hub2 straight from the
// live /stock and /stock_targets nodes (no caps, no snapshots), prints
// per-location totals and per-product samples with the raw numbers, and
// cross-checks the engine's exception counts. Read-only.
//
// Rules audited (engine + UI use the identical THREE-STATE logic, v5):
//   configured target  → excess = qty − target (hub2 ≥ 1, stores ≥ 2)
//   explicit target 0  → deliberately excluded: every unit is excess
//   NO target          → NOT excess; counted separately as "No Target Configured"
//
// RUN:  node scripts/targets/_audit-excess.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(OUT_DIR, { recursive: true });
const PROJECT = "marathon-club";
const LOCS = ["hub2", "marathon-pe", "trophy"];

function fbGet(dbPath) {
  const tmp = path.join(OUT_DIR, `.ax${Math.random().toString(36).slice(2)}.json`);
  execFileSync("firebase", ["database:get", dbPath, "--project", PROJECT, "-o", tmp], { stdio: ["ignore", "ignore", "inherit"] });
  const v = JSON.parse(readFileSync(tmp, "utf8"));
  rmSync(tmp, { force: true });
  return v;
}

const products = fbGet("/products") || {};
const targets = fbGet("/stock_targets") || {};
const exceptions = fbGet("/stock_exceptions/latest") || {};
const stock = {};
for (const loc of LOCS) stock[loc] = fbGet(`/stock/${loc}`) || {};

const isClothing = (p) => p?.productType === "clothing" ||
  (!p?.productType && (p?.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s))));

console.log("EXCESS AUDIT — recomputed from live /stock + /stock_targets\n");
const grand = { lines: 0, units: 0, noTargetProducts: 0, noTargetUnits: 0 };
for (const loc of LOCS) {
  const minEx = loc === "hub2" ? 1 : 2;
  const rows = [];
  const noTarget = new Map(); // pid → units (stock with no target node — surfaced, never excess)
  for (const [pid, bySize] of Object.entries(stock[loc] || {})) {
    if (!isClothing(products[pid])) continue;
    const hasAnyTarget = !!targets?.[loc]?.[pid];
    for (const [sizeKey, cell] of Object.entries(bySize || {})) {
      const qty = typeof cell?.qty === "number" ? cell.qty : 0;
      if (!hasAnyTarget) { if (qty > 0) noTarget.set(pid, (noTarget.get(pid) || 0) + qty); continue; }
      const t = targets?.[loc]?.[pid]?.[sizeKey];
      if (!t || typeof t.target !== "number") continue;   // untargeted size on a managed product: unjudged
      const excess = qty - t.target;
      const lineMin = t.target === 0 ? 1 : minEx;
      if (excess >= lineMin) rows.push({ pid, name: products[pid]?.name || pid, sizeKey, qty, target: t.target, excess, untargeted: false });
    }
  }
  grand.noTargetProducts += noTarget.size;
  grand.noTargetUnits += [...noTarget.values()].reduce((a, b) => a + b, 0);
  rows.sort((a, b) => b.excess - a.excess);
  const units = rows.reduce((t, r) => t + r.excess, 0);
  grand.lines += rows.length; grand.units += units;
  console.log(`── ${loc.toUpperCase()} — rule: surplus ≥ ${minEx} on configured targets (target 0 = all excess)`);
  console.log(`   ${rows.length} excess size-lines, ${units} surplus units · ${noTarget.size} products / ${[...noTarget.values()].reduce((a, b) => a + b, 0)} units AWAITING TARGET (not excess)`);
  const byProduct = new Map();
  for (const r of rows) { if (!byProduct.has(r.pid)) byProduct.set(r.pid, []); byProduct.get(r.pid).push(r); }
  let shown = 0;
  for (const [pid, prows] of byProduct) {
    if (shown++ >= 5) break;
    console.log(`   • ${prows[0].name.slice(0, 48)}`);
    for (const r of prows) {
      console.log(`       ${r.sizeKey.padEnd(5)} current ${String(r.qty).padStart(2)}  target ${String(r.target).padStart(2)}${r.untargeted ? " (no target — buffer rule)" : ""}  → excess ${r.excess}`);
    }
  }
  console.log("");
}
console.log(`NETWORK TOTAL: ${grand.lines} excess size-lines / ${grand.units} surplus units · ${grand.noTargetProducts} product-locations / ${grand.noTargetUnits} units awaiting target configuration`);
console.log(`\nEngine's last scan reported excess count: ${exceptions?.excess?.count ?? "(pre-deploy shape)"} at ${exceptions?.computedAt || "?"}`);
console.log("(the scan recomputes every 15 min — after the re-seed its next run should match this audit)");

// ─── TARGETS PIPELINE · OWNER OVERRIDE: STANDARD POLICY ───────────────────────
// The owner reviewed the three-model comparison and overrode it with a flat
// standardized run (2026-07-12 decision):
//
//   S=2  M=3  L=3  XL=2  XXL=2  XXXL=1
//
// applied identically to marathon-pe, trophy AND hub2, for every ACTIVE
// clothing product — "active" = the demand-signal set from extract-demand
// (sold or OOS in the window). Products that become active later self-activate
// via the engine's default run, which carries the same numbers. Store excess is
// deliberately NOT targeted for removal (stores self-correct through sales);
// hub2 excess above this run is what the Move Excess tool surfaces.
//
// Emits out/approved-targets.csv in the exact schema seed-targets.mjs consumes,
// so the normal preview → --commit path applies unchanged.
//
// RUN:  node scripts/targets/apply-standard-policy.mjs

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
const STANDARD_RUN = { S: 2, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 1 };
const LOCATIONS = ["marathon-pe", "trophy", "hub2"];

const aggFile = readdirSync(OUT_DIR).filter((f) => f.startsWith("demand-aggregates-")).sort().pop();
const { meta, products } = JSON.parse(readFileSync(path.join(OUT_DIR, aggFile), "utf8"));

// Active = demand signal in the window (same set the models analyzed).
const active = products.filter((p) => Object.values(p.sizes).some((s) =>
  (s["marathon-pe"]?.sold90 || 0) + (s.trophy?.sold90 || 0) + (s.oos90 || 0) > 0));

const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const rows = [["productId", "name", "location", "size", "final", "finalMinQty"].join(",")];
let cells = 0;
for (const p of active) {
  // Owner refinement (2026-07-12, after first shadow scan): a size is "carried"
  // only with EVIDENCE it actually exists for this product — sold, demanded
  // (OOS event), or physically held anywhere in the network. Catalog sizes[]
  // alone is NOT enough: catalogs list the full S–XXXL run for products that
  // never stocked half of it, which flooded the scan with 3,363 phantom
  // missing-size warnings.
  const carried = Object.entries(p.sizes)
    .filter(([size, s]) => STANDARD_RUN[size] != null && (
      (s["marathon-pe"]?.sold90 || 0) + (s.trophy?.sold90 || 0) + (s.oos90 || 0) > 0 ||
      (s["marathon-pe"]?.qty || 0) > 0 || (s.trophy?.qty || 0) > 0 ||
      (s.hub2Qty || 0) > 0 || (s.centralQty || 0) > 0
    ))
    .map(([size]) => size);
  for (const loc of LOCATIONS) {
    for (const size of carried) {
      const target = STANDARD_RUN[size];
      rows.push([p.productId, esc(p.name), loc, size, target, Math.ceil(target / 2)].join(","));
      cells++;
    }
  }
}

const outPath = path.join(OUT_DIR, "approved-targets.csv");
writeFileSync(outPath, rows.join("\n") + "\n");
console.error(`Standard policy applied: ${active.length} active products × ${LOCATIONS.length} locations → ${cells} target cells`);
console.error(`(window ${meta.windowStartSa} → ${meta.windowEndSa}; run S2 M3 L3 XL2 XXL2 XXXL1)`);
console.error(`Wrote ${outPath} — next: node scripts/targets/seed-targets.mjs (preview), then --commit`);

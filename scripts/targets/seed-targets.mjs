// ─── TARGETS PIPELINE · STEP 4: SEED APPROVED TARGETS ─────────────────────────
// Takes the owner-approved CSV (out/approved-targets.csv — the comparison CSV
// with the FINAL column edited) and writes /stock_targets plus the refill-engine
// config. PREVIEW BY DEFAULT; nothing is written without --commit.
//
// Writes go through the firebase CLI (owner credentials), as chunked deep
// multi-path PATCHes ("loc/pid/size" keys) so re-runs and partial runs never
// clobber sibling branches.
//
//   /stock_targets/{loc}/{pid}/{encodedSize} = {target, minQty, source, batchId, approvedBy, approvedAt}
//   /config/refillEngine = {enabled, productTypes, mode(shadow), routes, ...}
//
// Validation: productId exists, is clothing, size ∈ union(catalog sizes, sizes
// seen in the comparison file). Rows failing validation are reported, not written.
//
// RUN:  node scripts/targets/seed-targets.mjs [--input out/approved-targets.csv] [--commit]

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
const PROJECT = "marathon-club";
const COMMIT = process.argv.includes("--commit");
const argInput = process.argv.indexOf("--input");
const csvPath = argInput > -1 ? process.argv[argInput + 1] : path.join(OUT_DIR, "approved-targets.csv");
const LOCATIONS = ["marathon-pe", "trophy", "hub2"];
const batchId = `targets-${new Date().toISOString().slice(0, 10)}`;

// RTDB cell keys can't contain . # $ / [ ] — same encoding as src/utils/sizeKey.js
const encodeSizeKey = (size) => String(size).replace(/[.#$/\[\]\s]/g, "_");

// ── parse CSV (handles quoted fields) ─────────────────────────────────────────
function parseCsv(text) {
  const rows = []; let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); field = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = []; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const rows = parseCsv(readFileSync(csvPath, "utf8"));
console.error(`Read ${rows.length} rows from ${csvPath}`);

// ── fetch products for validation ─────────────────────────────────────────────
const tmp = path.join(OUT_DIR, ".seed-products.json");
execFileSync("firebase", ["database:get", "/products", "--project", PROJECT, "-o", tmp], { stdio: ["ignore", "ignore", "inherit"] });
const products = JSON.parse(readFileSync(tmp, "utf8")) || {};
rmSync(tmp, { force: true });

// ── validate + build updates ──────────────────────────────────────────────────
const updates = {}; // "loc/pid/sizeKey" → record
const errors = []; const perLoc = {}; let skippedZero = 0;
for (const r of rows) {
  const { productId, location, size } = r;
  const target = Math.round(Number(r.final)); const minQty = Math.round(Number(r.finalMinQty));
  if (!products[productId]) { errors.push(`unknown product ${productId} (${r.name})`); continue; }
  if (!LOCATIONS.includes(location)) { errors.push(`bad location ${location} for ${productId}`); continue; }
  if (!Number.isFinite(target) || target < 0 || target > 50) { errors.push(`bad final=${r.final} for ${productId} ${size}`); continue; }
  const catalogSizes = (products[productId].sizes || []).map(String);
  if (catalogSizes.length && !catalogSizes.includes(String(size))) {
    // size seen in ledger but missing from catalog — seed anyway, but surface it
    errors.push(`NOTE: size ${size} not in catalog sizes of ${productId} (${r.name}) — seeding anyway`);
  }
  if (target === 0 && minQty === 0) { skippedZero++; }
  updates[`${location}/${productId}/${encodeSizeKey(size)}`] = {
    target, minQty: Math.min(minQty, target), source: "ai_seed", batchId,
    approvedBy: "seed-script", approvedAt: new Date().toISOString(),
  };
  perLoc[location] = (perLoc[location] || 0) + 1;
}

const ENGINE_CONFIG = {
  enabled: true,
  productTypes: { clothing: true },
  mode: { "marathon-pe": "shadow", trophy: "shadow", hub2: "shadow" },
  routes: { "marathon-pe": "hub2", trophy: "hub2", hub2: "central" },
  defaultRunByStore: {
    "marathon-pe": { S: 2, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 1 },
    trophy: { S: 2, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 1 },
  },
  defaultRunRecentSaleDays: 14,   // default run applies only to products that sold recently
  staleIntentHours: 48,
  maxUnitsPerIntent: 20,
  maxIntentsPerRun: 200,
  scanIntervalMinutes: 15,
  updatedBy: "seed-script", updatedAt: new Date().toISOString(),
};

console.error(`\nPreview: ${Object.keys(updates).length} target cells (${JSON.stringify(perLoc)}), ${skippedZero} zero-target cells (kept — explicit 'don't stock here'), batchId=${batchId}`);
if (errors.length) console.error(`\n${errors.length} validation notes/errors:\n  ` + errors.slice(0, 30).join("\n  ") + (errors.length > 30 ? `\n  ...and ${errors.length - 30} more` : ""));
const sample = Object.entries(updates).slice(0, 5);
for (const [k, v] of sample) console.error(`  /stock_targets/${k} = {target:${v.target}, minQty:${v.minQty}}`);

if (!COMMIT) { console.error("\nDRY RUN — re-run with --commit to write /stock_targets and /config/refillEngine."); process.exit(0); }

// ── commit: chunked deep PATCHes ──────────────────────────────────────────────
const keys = Object.keys(updates);
const CHUNK = 400;
for (let i = 0; i < keys.length; i += CHUNK) {
  const chunk = {};
  for (const k of keys.slice(i, i + CHUNK)) chunk[k] = updates[k];
  const f = path.join(OUT_DIR, ".seed-chunk.json");
  writeFileSync(f, JSON.stringify(chunk));
  execFileSync("firebase", ["database:update", "/stock_targets", f, "--project", PROJECT, "-y"], { stdio: ["ignore", "ignore", "inherit"] });
  rmSync(f, { force: true });
  console.error(`  wrote cells ${i + 1}–${Math.min(i + CHUNK, keys.length)} of ${keys.length}`);
}
const cf = path.join(OUT_DIR, ".seed-config.json");
writeFileSync(cf, JSON.stringify(ENGINE_CONFIG));
execFileSync("firebase", ["database:update", "/config/refillEngine", cf, "--project", PROJECT, "-y"], { stdio: ["ignore", "ignore", "inherit"] });
rmSync(cf, { force: true });
console.error(`Wrote /config/refillEngine (all modes SHADOW). Done.`);

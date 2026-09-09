// ─── ARMED-CATEGORY TARGET-ROW CENSUS — READ ONLY ─────────────────────────────
//
// WRITES NOTHING. Counts, per location and per categoryKey, the explicit
// /stock_targets rows that exist, plus the category-map legs that are armed
// and whether each is carriage-scoped. Run it BEFORE and AFTER a change that
// must leave already-armed categories untouched, and diff the two files.
//
// It is the evidence for the hard constraint on the 2026-09-09 seating gate:
// "Hub 1's armed sneakers and the whole clothing arming must come through this
// change completely untouched." A count is the cheapest thing that cannot be
// argued with.
//
// Paged reads only. Usage:
//   node scripts/census-armed-target-rows.mjs            → var/armed-rows-census-<stamp>.json
//   node scripts/census-armed-target-rows.mjs A.json B.json   → prints the diff of two runs

import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { adminRequire } from "./adminRequire.mjs";
import { readMapPaged } from "./lib/rtdbPaged.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));

if (args.length === 2) {
  const a = JSON.parse(readFileSync(args[0], "utf8")), b = JSON.parse(readFileSync(args[1], "utf8"));
  const keys = [...new Set([...Object.keys(a.rowsByLocCat), ...Object.keys(b.rowsByLocCat)])].sort();
  let diffs = 0;
  console.log(`\n  ${"loc / category".padEnd(34)} ${"before".padStart(8)} ${"after".padStart(8)}`);
  for (const k of keys) {
    const x = a.rowsByLocCat[k] || 0, y = b.rowsByLocCat[k] || 0;
    if (x !== y) diffs++;
    console.log(`  ${k.padEnd(34)} ${String(x).padStart(8)} ${String(y).padStart(8)}${x !== y ? "   ← CHANGED" : ""}`);
  }
  console.log(`\n  explicit rows total: ${a.totalRows} → ${b.totalRows}   (${diffs} loc/category cell${diffs === 1 ? "" : "s"} changed)`);
  const legs = [...new Set([...Object.keys(a.legs), ...Object.keys(b.legs)])].sort();
  console.log(`\n  ${"category map leg".padEnd(34)} ${"before".padEnd(26)} ${"after".padEnd(26)}`);
  for (const k of legs) {
    const x = a.legs[k] || "(absent)", y = b.legs[k] || "(absent)";
    console.log(`  ${k.padEnd(34)} ${String(x).padEnd(26)} ${String(y).padEnd(26)}${x !== y ? "   ← CHANGED" : ""}`);
  }
  console.log("");
  process.exit(0);
}

const require = adminRequire(import.meta.url);
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = process.env.OUT || join(ROOT, "var", `armed-rows-census-${STAMP}.json`);

(async () => {
  const config = (await db.ref("config/refillEngine").once("value")).val() || {};
  const locs = Object.keys((await db.ref("locations").once("value")).val() || {});
  const products = await readMapPaged(db, "products", { pageSize: 500 });
  const catOf = (pid) => products[pid]?.categoryKey || (products[pid] ? "(no categoryKey)" : "(unknown product)");

  const rowsByLocCat = {};
  let totalRows = 0;
  for (const loc of locs) {
    const t = await readMapPaged(db, `stock_targets/${loc}`, { pageSize: 500 });
    for (const [pid, bySize] of Object.entries(t)) {
      if (!bySize || typeof bySize !== "object") continue;
      const n = Object.values(bySize).filter((r) => r && typeof r === "object").length;
      const k = `${loc} / ${catOf(pid)}`;
      rowsByLocCat[k] = (rowsByLocCat[k] || 0) + n;
      totalRows += n;
    }
  }
  const legs = {};
  for (const [cat, entry] of Object.entries(config.categoryPolicy || {})) {
    for (const [loc, leg] of Object.entries(entry || {})) {
      if (loc === "perSize" || !leg || typeof leg !== "object") continue;
      const shape = leg.sizes ? `per-size×${Object.keys(leg.sizes).length}` : `uniform ${leg.target}`;
      legs[`${cat} @ ${loc}`] = `${shape}${leg.carriedOnly === true ? " carried-only" : " ALL"}`;
    }
  }
  for (const [g, grp] of Object.entries(config.policyGroups || {})) {
    for (const [loc, leg] of Object.entries(grp?.policy || {})) {
      if (loc === "perSize" || !leg || typeof leg !== "object") continue;
      legs[`group:${g} @ ${loc}`] = `${grp.armed ? "ARMED" : "dormant"} ${leg.sizes ? `per-size×${Object.keys(leg.sizes).length}` : `uniform ${leg.target}`}${leg.carriedOnly === true ? " carried-only" : " ALL"}`;
    }
  }
  const out = { takenAt: new Date().toISOString(), totalRows, rowsByLocCat, legs };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\n  explicit /stock_targets rows: ${totalRows}`);
  for (const k of Object.keys(rowsByLocCat).sort()) console.log(`    ${k.padEnd(34)} ${String(rowsByLocCat[k]).padStart(6)}`);
  console.log(`\n  category map legs:`);
  for (const k of Object.keys(legs).sort()) console.log(`    ${k.padEnd(34)} ${legs[k]}`);
  console.log(`\n  → ${OUT}\n`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

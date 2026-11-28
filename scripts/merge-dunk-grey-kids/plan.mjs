#!/usr/bin/env node
// ─── STEP 2 — PLAN (dry run, writes nothing) ─────────────────────────────────
// Re-reads everything (investigate.mjs), then works out per location and size
// what the merge will do — with the merge's OWN disposition rule — and checks
// that the combined total of the two products is unchanged. Lists every
// blocker that would stop step 3.
//
//   node scripts/merge-dunk-grey-kids/plan.mjs [--out file.json]
import { writeFileSync } from "fs";
import { createRequire } from "module";
import { adminRequire } from "../adminRequire.mjs";
import { investigate } from "./investigate.mjs";
import { buildPlan, blockers } from "./core.mjs";

const { countedCellKeys } = createRequire(import.meta.url)("../../functions/lib/merge-disposition.cjs");

export function planFrom(inv) {
  // The merge's own reading of the count records (countedCellKeys), fed only
  // the records of the two products at each location the duplicate holds.
  const countedByLoc = {};
  for (const [loc, recs] of Object.entries(inv.countedByLoc || {})) {
    countedByLoc[loc] = countedCellKeys(Object.fromEntries(recs.map((r) => [r.key, r.rec])));
  }
  const plan = buildPlan({ keepStock: inv.raw.keepStock, removeStock: inv.raw.removeStock, countedByLoc, sizeMap: inv.sizeMap });
  const block = blockers({ problems: inv.sameProductProblems, plan, refs: inv.refs });
  return { plan, blockers: block, safeToApply: block.length === 0 };
}

export function printPlan({ plan, blockers: block }, log = console.log) {
  log("loc          size  duplicate → original (before → after)  action");
  for (const r of plan.rows) {
    log(`${r.loc.padEnd(12)} ${String(r.size).padEnd(5)} ${String(r.duplicateQty).padStart(9)} → ${String(r.originalBefore).padStart(3)} → ${String(r.originalAfter).padEnd(18)} ${r.action}`);
  }
  const t = plan.totals;
  log(`\nOriginal ${t.keepBefore} + duplicate ${t.removeBefore} = ${t.combinedBefore} before; ${t.keepAfter} + 0 = ${t.combinedAfter} after — ${plan.totalsUnchanged ? "UNCHANGED ✓" : "CHANGED ✗"}`);
  log(block.length ? `\nBLOCKED — step 3 will refuse:\n${block.map((b) => `  • ${b}`).join("\n")}` : "\nNo blockers — step 3 may run.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const require = adminRequire(import.meta.url);
  const admin = require("firebase-admin");
  admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
  const inv = await investigate(admin.database());
  const out = planFrom(inv);
  printPlan(out);
  const i = process.argv.indexOf("--out");
  if (i > 0) writeFileSync(process.argv[i + 1], JSON.stringify({ at: inv.at, ...out }, null, 2));
  process.exit(0);
}

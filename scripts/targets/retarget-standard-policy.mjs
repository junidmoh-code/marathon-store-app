// ─── RETARGET to the REDUCED standard run (owner policy 2026-07-13) ───────────
// During physical stocking both stores were full before half the range was out:
// the original standard (S2 M3 L3 XL2 XXL2 XXXL1) is too high. New approved
// standard for marathon-pe, trophy AND hub2:
//
//     S=1  M=2  L=2  XL=1  XXL=1  XXXL=1
//
// This script rewrites every EXISTING standard-policy target cell to the new
// quantities and updates /config/refillEngine/defaultRunByStore to match, so
// the engine, the Decision Queue wizard prefill, and the Introduce Existing
// migration all share one policy. Everything downstream (excess, below-target,
// refill requests, Health, Move Excess) recomputes on the next 15-min scan —
// the engine is stateless — and open requests that the lower targets make
// obsolete are withdrawn automatically by the self-reversal rule (PR #207).
//
// SCOPE — deliberately narrow:
//   • only cells whose source starts with "standard_policy" (the seeded runs
//     and the Introduce Existing migration) — human decisions (source
//     "manual", "excluded", target 0) are NEVER touched;
//   • only standard letter sizes (S–XXXL);
//   • only cells whose target actually changes.
//
// PREVIEW BY DEFAULT; nothing is written without --commit.
// RUN:  node scripts/targets/retarget-standard-policy.mjs [--commit]
//
// Writes go through the firebase CLI (owner credentials) as chunked deep
// PATCHes — same mechanism as seed-targets.mjs.

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const PROJECT = "marathon-club";
const COMMIT = process.argv.includes("--commit");
const NEW_RUN = { S: 1, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 1 };
const LOCS = ["marathon-pe", "trophy", "hub2"];
const STD = /^(S|M|L|XL|XXL|XXXL)$/i;
const now = new Date().toISOString();
const batchId = `retarget-${now.slice(0, 10)}`;

const tmp = mkdtempSync(path.join(os.tmpdir(), "retarget-"));
// -o file, not stdout: the CLI truncates large payloads on a pipe (observed
// 728KB of a 758KB node) but flushes files completely.
const fetch = (p) => {
  const f = path.join(tmp, "fetch.json");
  execFileSync("firebase", ["database:get", p, "--project", PROJECT, "-o", f], { stdio: ["ignore", "ignore", "inherit"] });
  const val = JSON.parse(readFileSync(f, "utf8"));
  rmSync(f, { force: true });
  return val || {};
};

console.error("Fetching live /stock_targets and /config/refillEngine …");
const targets = fetch("/stock_targets");
const config = fetch("/config/refillEngine");

const updates = {};
const stats = { changed: 0, alreadyNew: 0, skippedManual: 0, skippedExcluded: 0, skippedNonStandard: 0, byLoc: {} };
for (const loc of LOCS) {
  for (const [pid, bySize] of Object.entries(targets[loc] || {})) {
    for (const [sizeKey, cellVal] of Object.entries(bySize || {})) {
      if (!cellVal || typeof cellVal.target !== "number") continue;
      const src = String(cellVal.source || "");
      if (!src.startsWith("standard_policy")) {
        if (src === "excluded" || cellVal.target === 0) stats.skippedExcluded++;
        else stats.skippedManual++;
        continue;
      }
      if (cellVal.target === 0) { stats.skippedExcluded++; continue; }   // explicit exclusion — a human decision
      if (!STD.test(sizeKey)) { stats.skippedNonStandard++; continue; }
      const t = NEW_RUN[sizeKey.toUpperCase()];
      if (cellVal.target === t) { stats.alreadyNew++; continue; }
      updates[`${loc}/${pid}/${sizeKey}`] = {
        ...cellVal,
        target: t, minQty: t > 0 ? Math.ceil(t / 2) : 0,
        source: "standard_policy_v3", batchId,
        updatedBy: "retarget-script", updatedAt: now,
      };
      stats.changed++;
      stats.byLoc[loc] = (stats.byLoc[loc] || 0) + 1;
    }
  }
}

const newConfigRun = {
  "defaultRunByStore/marathon-pe": NEW_RUN,
  "defaultRunByStore/trophy": NEW_RUN,
  "defaultRunByStore/hub2": NEW_RUN,   // now explicit — was implicit fallback
  updatedAt: now, updatedBy: "retarget-script",
};

console.error(`\nPreview (${batchId}):`);
console.error(`  cells to retarget: ${stats.changed}  ${JSON.stringify(stats.byLoc)}`);
console.error(`  already at new policy: ${stats.alreadyNew} · manual kept: ${stats.skippedManual} · explicit-0 kept: ${stats.skippedExcluded} · non-standard sizes kept: ${stats.skippedNonStandard}`);
console.error(`  config.defaultRunByStore → ${JSON.stringify(NEW_RUN)} for ${LOCS.join(", ")}`);
for (const [k, v] of Object.entries(updates).slice(0, 5)) console.error(`  e.g. ${k}: target ${v.target}, minQty ${v.minQty}`);

if (!COMMIT) {
  console.error("\nPREVIEW ONLY — run again with --commit to write.");
  process.exit(0);
}

const keys = Object.keys(updates);
const CHUNK = 400;
for (let i = 0; i < keys.length; i += CHUNK) {
  const chunk = {};
  for (const k of keys.slice(i, i + CHUNK)) chunk[k] = updates[k];
  const f = path.join(tmp, "chunk.json");
  writeFileSync(f, JSON.stringify(chunk));
  execFileSync("firebase", ["database:update", "/stock_targets", f, "--project", PROJECT, "-f"], { stdio: ["ignore", "ignore", "inherit"] });
  rmSync(f, { force: true });
  console.error(`  wrote cells ${i + 1}–${Math.min(i + CHUNK, keys.length)} of ${keys.length}`);
}
const cf = path.join(tmp, "config.json");
writeFileSync(cf, JSON.stringify(newConfigRun));
execFileSync("firebase", ["database:update", "/config/refillEngine", cf, "--project", PROJECT, "-f"], { stdio: ["ignore", "ignore", "inherit"] });
rmSync(cf, { force: true });
console.error(`Wrote /config/refillEngine defaultRunByStore. Done — the next scan reconciles everything (withdrawals included).`);

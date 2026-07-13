// ─── RETARGET to the split standard policy (owner, 2026-07-13) ────────────────
// During physical stocking both stores were full before half the range was out:
// the original standard is too high FOR THE SHOPS. Approved policy:
//
//   marathon-pe / trophy:  S=1  M=2  L=2  XL=1  XXL=1  XXXL=1   (reduced)
//   hub2:                  S=2  M=3  L=3  XL=2  XXL=2  XXXL=1   (unchanged —
//     the buffer supplies BOTH shops and must cover simultaneous deficits)
//
// This script rewrites every EXISTING standard-policy SHOP target cell to the
// reduced quantities (hub2 cells stay on the buffer run — they already carry
// it, so hub2 rewrites are naturally zero) and updates /config/refillEngine/defaultRunByStore to match, so
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
// Owner correction 2026-07-13: the reduction applies to the SHOPS only.
// Hub 2 keeps the ORIGINAL buffer quantities — it supplies both stores.
const STORE_RUN = { S: 1, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 1 };
const HUB2_RUN  = { S: 2, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 1 };
const RUN_BY_LOC = { "marathon-pe": STORE_RUN, trophy: STORE_RUN, hub2: HUB2_RUN };
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
      const t = RUN_BY_LOC[loc][sizeKey.toUpperCase()];
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
  "defaultRunByStore/marathon-pe": STORE_RUN,
  "defaultRunByStore/trophy": STORE_RUN,
  "defaultRunByStore/hub2": HUB2_RUN,   // explicit: hub2 keeps the deeper buffer
  updatedAt: now, updatedBy: "retarget-script",
};

console.error(`\nPreview (${batchId}):`);
console.error(`  cells to retarget: ${stats.changed}  ${JSON.stringify(stats.byLoc)}`);
console.error(`  already at new policy: ${stats.alreadyNew} · manual kept: ${stats.skippedManual} · explicit-0 kept: ${stats.skippedExcluded} · non-standard sizes kept: ${stats.skippedNonStandard}`);
console.error(`  config runs → stores ${JSON.stringify(STORE_RUN)} · hub2 ${JSON.stringify(HUB2_RUN)}`);
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

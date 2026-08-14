// ── One-time migration: old publish states → awaiting | live | blocked ───────
// The 2026-08-14 state model collapses the Approve → Nominate → Live chain to
// a single Publish action. This script rewrites every existing
// /shopify_publish node into the new vocabulary:
//
//   none      → awaiting                       (was: seen, maybe name-approved)
//   nominated → awaiting                       (the nominate step no longer exists)
//   draft     → live + liveState/desiredState "off"   (exists on Shopify, NOT published)
//   live      → live + liveState/desiredState "on"    (published to the Online Store)
//   blocked   → blocked                        (unchanged)
//   awaiting/live/blocked already carrying liveState  → untouched (idempotent)
//
// desiredState is seeded EQUAL to the confirmed liveState so no node wakes up
// pending — the reconciler sees zero diffs after a clean migration.
//
//   node scripts/shopify/migrate-live-state.mjs            dry run (default) — plan + counts only
//   node scripts/shopify/migrate-live-state.mjs --commit   write the plan
//
// Writes are per-node MERGES (update()) touching only the state fields —
// cleanName / condition / nameApprovedAt / stamps survive untouched. Safe to
// re-run: a second pass finds nothing to change. Runs with Admin SDK
// credentials (rules bypassed), so it works before OR after the owner pastes
// the new console rule block.
import { createRequire } from "module";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";

const COMMIT = process.argv.includes("--commit");

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

// → the merge to apply, or null when the node is already in the new model.
export function planMigration(node) {
  if (!node || typeof node !== "object") return null;
  switch (node.state) {
    case "none":
    case "nominated":
      return { state: "awaiting" };
    case "draft":
      return { state: "live", liveState: "off", desiredState: "off" };
    case "live":
      // Old-model live (no liveState) was storefront-visible; new-model live
      // nodes already carry a confirmed liveState and are left alone.
      if (node.liveState === "on" || node.liveState === "off") return null;
      return { state: "live", liveState: "on", desiredState: "on" };
    case "blocked":
    case "awaiting":
      return null;
    default:
      // Unknown state string — surface it, never guess.
      throw new Error(`unrecognised state ${JSON.stringify(node.state)} — refusing to migrate this node`);
  }
}

const all = (await db.ref("shopify_publish").get()).val() || {};
const entries = Object.entries(all);
const countsOf = (nodes) => {
  const c = {};
  for (const n of nodes) {
    const key = n?.liveState ? `${n.state}+${n.liveState}` : String(n?.state);
    c[key] = (c[key] || 0) + 1;
  }
  return c;
};

const plans = [];
for (const [pid, node] of entries) {
  assertSafeSegment(pid, "productId");
  const merge = planMigration(node);
  if (merge) plans.push({ pid, node, merge });
}

// Sanity: a migration can never touch more nodes than exist (STOP condition
// from the owner spec — a plan bigger than the tree means the read or the
// planner is broken).
if (plans.length > entries.length) {
  console.error(`🛑 plan wants to change ${plans.length} nodes but only ${entries.length} exist — aborting`);
  process.exit(1);
}

console.log(`/shopify_publish nodes: ${entries.length}`);
console.log(`BEFORE by state: ${JSON.stringify(countsOf(entries.map(([, n]) => n)))}`);
console.log(`nodes to change: ${plans.length}`);
for (const { pid, node, merge } of plans) {
  const to = merge.liveState ? `${merge.state}+${merge.liveState}` : merge.state;
  console.log(`  ${pid}: ${node.state} → ${to}`);
}
const after = entries.map(([pid, n]) => {
  const p = plans.find((x) => x.pid === pid);
  return p ? { ...n, ...p.merge } : n;
});
console.log(`AFTER by state:  ${JSON.stringify(countsOf(after))}`);

if (!COMMIT) {
  console.log("\ndry run — nothing written. Re-run with --commit to apply.");
  process.exit(0);
}

for (const { pid, merge } of plans) {
  await db.ref(`shopify_publish/${pid}`).update({
    ...merge,
    updatedAt: Date.now(),
    updatedBy: "script:migrate-live-state",
  });
  console.log(`✓ ${pid} migrated`);
}
console.log(`\nmigrated ${plans.length} node(s).`);
process.exit(0);

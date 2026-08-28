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
import { planMigration } from "./migrateLiveStatePlan.mjs";
import { serverNowMs } from "./publishNode.mjs";
import { buildOffRecord, offAuditFields } from "../../src/components/shopify/publishAudit.js";

const COMMIT = process.argv.includes("--commit");

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

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

// Apply as per-node TRANSACTIONS that re-derive the plan from the CURRENT
// value — the survey read above is only the preview. A page write landing in
// between (e.g. the new UI upgrading a legacy node itself, with a desiredState
// the operator just set) must never be clobbered by a stale merge.
let applied = 0;
for (const { pid } of plans) {
  // EVERY path to off writes a record, and this is a path to off: a legacy
  // "draft" node becomes live+off here. It is a one-shot migration that has
  // already run, so this is belt and braces — but "no exceptions" is the rule,
  // and an exception nobody could name is how the last audit gap happened
  // (spec review, 2026-08-28).
  const at = await serverNowMs(db);
  const result = await db.ref(`shopify_publish/${pid}`).transaction((cur) => {
    const merge = planMigration(cur);
    if (!merge) return cur; // already migrated by the time we got here
    const audit = merge.liveState === "off"
      ? offAuditFields(cur, buildOffRecord({
          at,
          actor: "script:migrate-live-state",
          reasonCode: "script",
          detail: `migrated from the legacy state "${cur?.state}" — a draft existed on Shopify but was never published`,
        }), at)
      : {};
    return { ...cur, ...merge, ...audit, updatedAt: at, updatedBy: "script:migrate-live-state" };
  });
  if (!result.committed) { console.error(`✗ ${pid}: transaction did not commit`); continue; }
  applied += 1;
  console.log(`✓ ${pid} migrated`);
}
console.log(`\nmigrated ${applied} node(s).`);
process.exit(0);

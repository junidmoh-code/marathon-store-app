// ── Collection membership for products that are ALREADY live ─────────────────
// The reconciler assigns collections when a product's intent CHANGES. A product
// that was already on the storefront before collections existed never changes
// intent, so the reconciler never looks at it — which is exactly the 11 live
// products this program started with. This script is the backfill, and because
// it re-plans from Shopify's current membership every time, it stays useful
// afterwards as the audit-and-repair pass:
//
//   node scripts/shopify/sync-collections.mjs            dry run (default)
//   node scripts/shopify/sync-collections.mjs --commit    apply
//   node scripts/shopify/sync-collections.mjs --commit --pids a,b   only these
//
// Worklist: every /shopify_publish node CONFIRMED on (state "live", liveState
// "on"). Products that are off are skipped — the reconciler already stripped
// their membership when it took them down, and re-adding it here would put an
// unpublished product back in the aisles.
//
// Writes: Shopify collection membership ONLY (productUpdate collectionsToJoin /
// collectionsToLeave). No RTDB writes at all — not /shopify_publish, not
// /shopify_sync. Nothing is created, archived, deleted or unpublished.
import { createRequire } from "module";
import { graphql } from "./client.mjs";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import { resolveCollection, COLLECTION_BY_KEY } from "./collectionMap.mjs";
import {
  collectionGidsByKey, manualGidsFrom, planCollectionMembership,
  readProductCollections, applyCollectionMembership,
} from "./collections.mjs";
import { readAllPublishNodes } from "./publishNode.mjs";

const flags = process.argv.slice(2);
const COMMIT = flags.includes("--commit");
const pidIdx = flags.indexOf("--pids");
const pidArg = pidIdx !== -1 ? flags[pidIdx + 1] : null;
if (pidIdx !== -1 && (!pidArg || pidArg.startsWith("--"))) {
  console.error("--pids needs a comma-separated productId list");
  process.exit(2);
}
const ONLY = pidArg ? new Set(pidArg.split(",")) : null;

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const collectionGids = await collectionGidsByKey(db);
const managedGids = manualGidsFrom(collectionGids);
if (!managedGids.length) {
  console.error("no storefront collections recorded at /shopify_sync/_collections — run ensure-collections.mjs --commit first");
  process.exit(1);
}
console.log(`${managedGids.length} manual collections recorded`);

const all = await readAllPublishNodes(db);
const live = Object.entries(all).filter(
  ([pid, n]) => (!ONLY || ONLY.has(pid)) && n?.state === "live" && n?.liveState === "on"
);
console.log(`${live.length} products confirmed ON the storefront`);
console.log(COMMIT ? "MODE: commit\n" : "MODE: dry run — nothing written\n");

const results = [];
for (const [pid, node] of live) {
  assertSafeSegment(pid, "productId");
  const mapNode = (await db.ref(`shopify_sync/${pid}`).get()).val();
  const gid = mapNode?.shopifyProductId;
  const name = node.cleanName || pid;
  if (!gid) {
    results.push({ pid, name, status: "no-map", detail: "confirmed live but has no /shopify_sync entry — reconcile it first" });
    continue;
  }
  const product = (await db.ref(`products/${pid}`).get()).val();
  if (!product) {
    results.push({ pid, name, status: "no-record", detail: "no /products record" });
    continue;
  }

  const r = resolveCollection(product);
  const desired = r.status === "mapped" ? (collectionGids[r.collectionKey] ?? null) : null;
  const label =
    r.status !== "mapped" ? `⚠ ${r.status}: ${r.reason}`
    : desired ? COLLECTION_BY_KEY.get(r.collectionKey).title
    : `⚠ "${r.collectionKey}" has no recorded id`;

  try {
    const plan = planCollectionMembership(await readProductCollections(graphql, gid), desired, managedGids);
    if (!plan.join.length && !plan.leave.length) {
      results.push({ pid, name, status: r.status === "mapped" && desired ? "already-correct" : "no-collection", detail: label });
      continue;
    }
    if (COMMIT) await applyCollectionMembership(graphql, gid, plan);
    results.push({
      pid, name,
      status: COMMIT ? "changed" : "would-change",
      detail: `${label} · join ${plan.join.length}, leave ${plan.leave.length}`,
    });
  } catch (e) {
    results.push({ pid, name, status: "failed", detail: String(e?.message || e) });
  }
}

console.log("══ COLLECTION MEMBERSHIP ══");
for (const r of results) {
  const icon = r.status === "failed" || r.status.startsWith("no-") ? "✗" : "✓";
  console.log(`${icon} ${r.pid.padEnd(16)} ${r.status.padEnd(16)} ${r.name}`);
  console.log(`    ${r.detail}`);
}
const tally = {};
for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
console.log("\n" + Object.entries(tally).map(([k, n]) => `${k}: ${n}`).join("  ·  "));
if (!COMMIT) console.log("\ndry run — Shopify untouched. Re-run with --commit to apply.");
process.exit(results.some((r) => r.status === "failed") ? 1 : 0);

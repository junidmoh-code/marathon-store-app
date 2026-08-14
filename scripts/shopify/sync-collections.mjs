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
// Worklist: EVERY product with a /shopify_sync mapping — i.e. everything that
// is ours on Shopify — and the desired membership follows its confirmed state:
//
//   confirmed ON (state "live", liveState "on") → joins its mapped collection
//   anything else (live-off, blocked, awaiting)  → leaves every managed one
//
// The off/blocked half is not busywork. The reconciler strips membership on the
// OFF path, but only when an intent CHANGES — a product taken down before
// collections existed, or one left blocked by a refusal (markBlocked consumes
// desiredState, so the worklist never revisits it), keeps whatever membership
// it had. This is the pass that notices. Re-adding is impossible: an unmapped
// or non-live product is planned against `null`, which only ever leaves.
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
const confirmedOn = (n) => n?.state === "live" && n?.liveState === "on";
const worklist = Object.entries(all).filter(([pid]) => !ONLY || ONLY.has(pid));
console.log(`${worklist.length} publishing nodes · ${worklist.filter(([, n]) => confirmedOn(n)).length} confirmed ON the storefront`);
console.log(COMMIT ? "MODE: commit\n" : "MODE: dry run — nothing written\n");

const results = [];
for (const [pid, node] of worklist) {
  assertSafeSegment(pid, "productId");
  const mapNode = (await db.ref(`shopify_sync/${pid}`).get()).val();
  const gid = mapNode?.shopifyProductId;
  const name = node.cleanName || pid;
  if (!gid) {
    // Nothing of ours exists on Shopify for this record, so there is no
    // membership to hold. Only worth saying out loud when it claims to be live.
    if (confirmedOn(node)) {
      results.push({ pid, name, status: "no-map", detail: "confirmed live but has no /shopify_sync entry — reconcile it first" });
    }
    continue;
  }

  // A product that is not confirmed ON belongs in NO managed collection,
  // whatever its record says — desired null only ever leaves.
  let desired = null;
  let label = `not on the storefront (state ${node?.state}/${node?.liveState ?? "—"}) — leaves every managed collection`;
  if (confirmedOn(node)) {
    const product = (await db.ref(`products/${pid}`).get()).val();
    if (!product) {
      results.push({ pid, name, status: "no-record", detail: "confirmed live but no /products record" });
      continue;
    }
    const r = resolveCollection(product);
    desired = r.status === "mapped" ? (collectionGids[r.collectionKey] ?? null) : null;
    label =
      r.status !== "mapped" ? `⚠ ${r.status}: ${r.reason}`
      : desired ? COLLECTION_BY_KEY.get(r.collectionKey).title
      : `⚠ "${r.collectionKey}" has no recorded id`;
  }

  try {
    const plan = planCollectionMembership(await readProductCollections(graphql, gid), desired, managedGids);
    if (!plan.join.length && !plan.leave.length) {
      // Silent for the vast majority: an off product in no collection is the
      // normal resting state and printing it would bury the real rows.
      if (confirmedOn(node)) {
        results.push({ pid, name, status: desired ? "already-correct" : "no-collection", detail: label });
      }
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

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
// Worklist: the UNION of /shopify_publish nodes and /shopify_sync product
// entries — every product this program has ever reviewed or put on Shopify.
// (Not "everything on Shopify": it never asks Shopify what exists. A product
// created outside this program is invisible here, deliberately — it is not
// ours to touch.)
//
// What happens to each is sweepIntent's call, not this file's — see
// collections.mjs. In short: confirmed-ON joins its mapped collection;
// a publish in flight is LEFT ALONE; a product Shopify holds ACTIVE with no
// matching record is reported as drift and never stripped; everything else
// leaves every managed collection.
//
// The leave half is not busywork. The reconciler strips membership on the OFF
// path, but only when an intent CHANGES — a product taken down before
// collections existed, or one left blocked by a refusal (markBlocked consumes
// desiredState, so the worklist never revisits it), keeps whatever membership
// it had. This is the pass that notices.
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
  readProductCollections, applyCollectionMembership, sweepIntent,
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
const ONLY = pidArg ? new Set(pidArg.split(",").map((x) => x.trim()).filter(Boolean)) : null;

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

const confirmedOn = (n) => n?.state === "live" && n?.liveState === "on";

// THE WORKLIST IS THE UNION of /shopify_publish and the /shopify_sync product
// map. Walking only the publish nodes would silently miss a product that IS
// ours on Shopify but has no publish node — the live census has exactly one
// (a slice-1 round-trip draft), and it is precisely the class this sweep
// exists for. Worse, `--pids` on such a product printed a clean report and
// exited 0: a false success for a product the operator named explicitly.
// A pid with no publish node reads as not-confirmed-ON, so it can only ever
// LEAVE collections, never join one.
const publishNodes = await readAllPublishNodes(db);
const syncNodes = (await db.ref("shopify_sync").get()).val() || {};
const pids = [...new Set([
  ...Object.keys(publishNodes),
  ...Object.keys(syncNodes).filter((k) => k !== "_collections"),
])].filter((pid) => !ONLY || ONLY.has(pid)).sort();
// A named pid this program has never heard of is almost always a typo, and a
// typo that exits 0 is the false success this script exists to stop producing.
const unknownPids = ONLY ? [...ONLY].filter((pid) => !pids.includes(pid)) : [];
console.log(`${pids.length} products in scope · ${pids.filter((pid) => confirmedOn(publishNodes[pid])).length} confirmed ON the storefront`);
console.log(COMMIT ? "MODE: commit\n" : "MODE: dry run — nothing written\n");

const results = [];
for (const pid of pids) {
  assertSafeSegment(pid, "productId");

  // RE-READ the publish node, per product, at the moment it is judged — the
  // snapshot above is only a worklist. Freshness alone is NOT enough, though:
  // the reconciler joins the collection, publishes and goes ACTIVE before it
  // writes confirmLiveState, so a perfectly fresh read can correctly say
  // "awaiting" about a product that is already live and already in its
  // collection. sweepIntent is what closes that; see collections.mjs.
  const node = (await db.ref(`shopify_publish/${pid}`).get()).val();
  const live = confirmedOn(node);
  const mapNode = (await db.ref(`shopify_sync/${pid}`).get()).val();
  const gid = mapNode?.shopifyProductId;
  const name = node?.cleanName || pid;
  if (!gid) {
    // Nothing of ours exists on Shopify for this record, so there is no
    // membership to hold. Worth saying out loud when it claims to be live —
    // or whenever the operator named this pid and is owed an answer.
    if (live || ONLY) {
      results.push({
        pid, name,
        status: live ? "no-map" : "nothing-to-do",
        detail: live ? "confirmed live but has no /shopify_sync entry — reconcile it first"
                     : "not live and nothing of ours on Shopify — nothing to do",
      });
    }
    continue;
  }

  // A product that is not confirmed ON belongs in NO managed collection,
  // whatever its record says — desired null only ever leaves.
  let desired = null;
  let label = node
    ? `not on the storefront (state ${node.state}/${node.liveState ?? "—"}) — leaves every managed collection`
    : "on Shopify but never reviewed (no /shopify_publish node) — leaves every managed collection";
  if (live) {
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
    const { collections, status: shopifyStatus } = await readProductCollections(graphql, gid);
    const intent = sweepIntent(node, shopifyStatus);
    if (intent.action === "hold" || intent.action === "drift") {
      // Never plans a leave, so it can never strip a listing it does not
      // understand. "hold" is routine and quiet unless named; "drift" means
      // something is genuinely wrong and always speaks up.
      if (intent.action === "drift" || ONLY) {
        results.push({ pid, name, status: intent.action === "drift" ? "live-drift" : "publish-in-flight", detail: intent.reason });
      }
      continue;
    }
    const plan = planCollectionMembership(collections, desired, managedGids);
    if (!plan.join.length && !plan.leave.length) {
      // Silent for the vast majority: an off product in no collection is the
      // normal resting state and printing it would bury the real rows. But an
      // EXPLICITLY NAMED pid is a question, and silence is not an answer —
      // --pids always reports, whatever the outcome.
      if (live || ONLY) {
        results.push({
          pid, name,
          status: live ? (desired ? "already-correct" : "no-collection") : "nothing-to-do",
          detail: label,
        });
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

for (const pid of unknownPids) {
  results.push({ pid, name: pid, status: "unknown-pid", detail: "no /shopify_publish node and no /shopify_sync entry — this program has never seen this product id" });
}

console.log("══ COLLECTION MEMBERSHIP ══");
// The icon and the exit code must agree. "no-collection" is a DOCUMENTED
// outcome (a deliberately unmapped category such as Price Products) — a notice,
// ⚠, exit 0. "no-map" and "no-record" mean a product claims to be live and
// ISN'T ours, or has no record at all: those are broken, ✗, and they now fail
// the run. Marking them ✗ while exiting 0 was the same contradiction demoting
// no-collection was supposed to remove.
const BAD = new Set(["failed", "no-map", "no-record", "unknown-pid", "live-drift"]);
for (const r of results) {
  const icon = BAD.has(r.status) ? "✗" : (r.status === "no-collection" || r.status === "publish-in-flight") ? "⚠" : "✓";
  console.log(`${icon} ${r.pid.padEnd(16)} ${r.status.padEnd(16)} ${r.name}`);
  console.log(`    ${r.detail}`);
}
const tally = {};
for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
console.log("\n" + Object.entries(tally).map(([k, n]) => `${k}: ${n}`).join("  ·  "));
if (!COMMIT) console.log("\ndry run — Shopify untouched. Re-run with --commit to apply.");
process.exit(results.some((r) => BAD.has(r.status)) ? 1 : 0);

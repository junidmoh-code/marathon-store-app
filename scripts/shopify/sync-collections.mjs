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
// collections.mjs. In short: a product with an unapplied intent (either
// direction) is LEFT ALONE, because the reconciler owns it; a product where the
// record and the shop disagree with no intent to explain it is reported as
// DRIFT and never touched, in either direction; a settled live product joins
// its mapped collection; everything else leaves every managed collection.
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
import { resolveCollection, COLLECTION_BY_KEY, MANUAL_KEYS } from "./collectionMap.mjs";
import {
  collectionGidsByKey, manualGidsFrom, planCollectionMembership,
  readProductCollections, applyCollectionMembership, sweepIntent,
  requireOnlineStorePublication,
} from "./collections.mjs";
import { readAllPublishNodes } from "./publishNode.mjs";
import { isProductRecordKey } from "./idMap.mjs";

const flags = process.argv.slice(2);
const COMMIT = flags.includes("--commit");
const pidIdx = flags.indexOf("--pids");
const pidArg = pidIdx !== -1 ? flags[pidIdx + 1] : null;
if (pidIdx !== -1 && (!pidArg || pidArg.startsWith("--"))) {
  console.error("--pids needs a comma-separated productId list");
  process.exit(2);
}
const ONLY = pidArg ? new Set(pidArg.split(",").map((x) => x.trim()).filter(Boolean)) : null;
if (ONLY && ONLY.size === 0) {
  // A truthy but EMPTY set would filter the worklist to nothing and exit 0 —
  // the same false success --pids validation exists to prevent.
  console.error("--pids parsed to an empty list");
  process.exit(2);
}

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

// Visibility is a CHANNEL fact, so the sweep needs the Online Store publication
// before it can judge anything. Resolved once, from the same lookup the
// reconciler uses.
// STRICT: this script can LEAVE collections, so a wrong publication would read
// the whole live catalogue as unpublished and clear it out. A title guess is
// not good enough for that.
// Strict mode THROWS by design (no online_store channel, no publication at all,
// or a truncated walk). Those are expected refusals, not crashes — they get the
// same treatment as reconcile.mjs gives them: the message, and exit 1.
let onlinePublicationId;
try {
  onlinePublicationId = await requireOnlineStorePublication(graphql, { strict: true });
} catch (e) {
  console.error(String(e?.message || e));
  process.exit(1);
}
const collectionGids = await collectionGidsByKey(db);
const managedGids = manualGidsFrom(collectionGids);
if (!managedGids.length) {
  console.error("no storefront collections recorded at /shopify_sync/_collections — run ensure-collections.mjs --commit first");
  process.exit(1);
}
console.log(`${managedGids.length} manual collections recorded`);

// ── HARD PRE-FLIGHT: every mapped lane must EXIST before anything is moved ───
// The destructive half of this sweep is `leave`. A product whose mapped
// collection has no recorded id resolves to desired = null, and
// planCollectionMembership then plans "leave every managed collection, join
// nothing" — which is indistinguishable, at the mutation, from "this product
// belongs nowhere".
//
// That is exactly the state right after a CATEGORY_MAP change lands and before
// ensure-collections.mjs has created the new collections. Running --commit in
// that window would strip every affected live product out of its old
// collection and leave it in NO collection: reachable only through New In and
// its direct URL, and worse than the mis-filing this exists to fix. The old
// code did notice — status "no-id", counted BAD, exit 1 — but only in the
// summary, long after the mutations had gone out.
//
// So the check moves to the front and refuses the WHOLE COMMIT RUN. The dry run
// still proceeds and reports, because seeing the problem is the point of a dry
// run. `ensure-collections.mjs --commit` is the one-command cure.
const missingLaneKeys = MANUAL_KEYS.filter((key) => !collectionGids[key]);
if (missingLaneKeys.length) {
  const msg =
    `${missingLaneKeys.length} manual collection(s) named by CATEGORY_MAP have no recorded id: ` +
    `${missingLaneKeys.join(", ")}`;
  if (COMMIT) {
    console.error(`REFUSING THE RUN — ${msg}.`);
    console.error(
      "Committing now would plan a LEAVE with no JOIN for every product mapped to them, " +
      "stripping live products out of their current collection into none at all. " +
      "Run `node scripts/shopify/ensure-collections.mjs --commit` first, then re-run this."
    );
    process.exit(1);
  }
  console.error(`  ⚠ ${msg} — a commit run would be REFUSED until ensure-collections.mjs --commit has run\n`);
}

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
  ...Object.keys(syncNodes).filter(isProductRecordKey),   // skips _collections, _reconcile, _claims
])].filter((pid) => !ONLY || ONLY.has(pid)).sort();
// A named pid this program has never heard of is almost always a typo, and a
// typo that exits 0 is the false success this script exists to stop producing.
const unknownPids = ONLY ? [...ONLY].filter((pid) => !pids.includes(pid)) : [];
console.log(`${pids.length} products in scope · ${pids.filter((pid) => confirmedOn(publishNodes[pid])).length} confirmed ON the storefront`);
console.log(COMMIT ? "MODE: commit\n" : "MODE: dry run — nothing written\n");

const results = [];
for (const pid of pids) {
  assertSafeSegment(pid, "productId");

  const mapNode = (await db.ref(`shopify_sync/${pid}`).get()).val();
  const gid = mapNode?.shopifyProductId;
  // Declared out here so a throw inside the try still reports a usable name.
  let name = pid;
  // The publish node is read LATER, after Shopify — see the loop body. Only the
  // no-mapping branch needs it early, and it re-reads for itself.
  if (!gid) {
    const node = (await db.ref(`shopify_publish/${pid}`).get()).val();
    const live = confirmedOn(node);
    name = node?.cleanName || pid;
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

  try {
    // ORDER MATTERS. Shopify is read FIRST, then the publish node. The reverse
    // leaves a window: the reconciler could join a collection and start
    // publishing between the two reads, and a node fetched before that would
    // say "awaiting" about a product whose membership the sweep is about to
    // strip. Reading Shopify first means anything the reconciler did before it
    // is visible in the membership; anything it does after cannot be in the
    // `leave` list, because `leave` is computed from that same earlier read.
    const { collections, published, status } = await readProductCollections(graphql, gid, onlinePublicationId);
    const node = (await db.ref(`shopify_publish/${pid}`).get()).val();
    const live = confirmedOn(node);
    name = node?.cleanName || pid;

    const intent = sweepIntent(node, { published, status });
    if (intent.action === "hold" || intent.action === "drift") {
      // Neither plans a leave, so neither can strip a listing it does not
      // understand. Both ALWAYS report: a held product that silently vanished
      // from the report is how a whole batch mid-publish became invisible, and
      // a tally that does not sum is its own kind of lie.
      results.push({
        pid, name,
        status: intent.action === "drift" ? "live-drift" : "reconciler-busy",
        detail: intent.reason,
      });
      continue;
    }

    // A product that is not confirmed ON belongs in NO managed collection,
    // whatever its record says — desired null only ever leaves.
    let desired = null;
    let missingId = false;
    let excludedLive = false;
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
      // A mapped category whose collection was never CREATED is a different
      // thing from one deliberately mapped nowhere, and it has a one-command
      // cure (ensure-collections.mjs --commit). Reporting it as the documented
      // no-collection outcome would hide a live product with no home behind a
      // status that exits 0.
      missingId = r.status === "mapped" && !desired;
      // NOT MERCHANDISE, and CONFIRMED LIVE. This sweep can take it out of
      // every managed collection (desired is null, so the plan is all-leave),
      // but it cannot unpublish it — that is the reconciler's job, and the
      // reconciler now refuses these outright. So say so loudly and exit
      // non-zero: a price record on the storefront is not a "no collection"
      // notice, it is a defect that needs `reconcile.mjs` run with the
      // product's desiredState set to "off".
      excludedLive = r.status === "excluded";
      label =
        r.status !== "mapped" ? `⚠ ${r.status}: ${r.reason}`
        : desired ? COLLECTION_BY_KEY.get(r.collectionKey).title
        : `⚠ "${r.collectionKey}" has no recorded id`;
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
          status: live
          ? (desired ? "already-correct" : excludedLive ? "excluded-but-live" : missingId ? "no-id" : "no-collection")
          : "nothing-to-do",
          detail: label,
        });
      }
      continue;
    }
    if (COMMIT) await applyCollectionMembership(graphql, gid, plan);
    results.push({
      pid, name,
      status: excludedLive ? "excluded-but-live" : COMMIT ? "changed" : "would-change",
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
const BAD = new Set(["failed", "no-map", "no-record", "unknown-pid", "live-drift", "no-id", "excluded-but-live"]);
for (const r of results) {
  const icon = BAD.has(r.status) ? "✗" : (r.status === "no-collection" || r.status === "reconciler-busy") ? "⚠" : "✓";
  console.log(`${icon} ${r.pid.padEnd(16)} ${r.status.padEnd(16)} ${r.name}`);
  console.log(`    ${r.detail}`);
}
const tally = {};
for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
console.log("\n" + Object.entries(tally).map(([k, n]) => `${k}: ${n}`).join("  ·  "));
// Rows in the normal resting state (off, in no collection) are deliberately
// quiet — but a tally that does not account for the worklist is its own kind of
// lie, so the gap is stated rather than left for someone to notice.
const quiet = pids.length - results.filter((r) => r.status !== "unknown-pid").length;
if (quiet > 0) console.log(`reported ${pids.length - quiet} of ${pids.length} — ${quiet} settled and in no managed collection (nothing to say)`);
if (!COMMIT) console.log("\ndry run — Shopify untouched. Re-run with --commit to apply.");
process.exit(results.some((r) => BAD.has(r.status)) ? 1 : 0);

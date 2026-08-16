// ── Backfill: turn inventory tracking ON for everything already pushed ───────
// Every product this program created before 2026-08-16 has UNTRACKED variants:
// `reconcile.mjs` built them with `productSet` and never populated
// `ProductVariantSetInput.inventoryItem`, whose `tracked` defaults to FALSE on
// that path. Shopify therefore ignored every quantity the reconciler wrote —
// the storefront showed every size as available for ever, nothing could show
// sold out, the shop could oversell, and ABC / sell-through stayed empty.
//
// The reconciler now sets tracking at creation AND re-checks it on every run
// (see inventory.mjs), so anything it touches from here on repairs itself. This
// script is for the products it will NOT touch again — the ones already live,
// whose intent is settled and whose worklist entry is therefore empty.
//
//   node scripts/shopify/backfill-inventory-tracking.mjs                dry run
//   node scripts/shopify/backfill-inventory-tracking.mjs --commit       apply
//   node scripts/shopify/backfill-inventory-tracking.mjs --commit --pids a,b
//   node scripts/shopify/backfill-inventory-tracking.mjs --live-only    only products confirmed ON
//
// WHAT IT DOES, per product, in this order:
//   1. reads the mapped Shopify product's variants
//   2. sets inventoryItem.tracked = true and inventoryPolicy = DENY on any
//      variant that is not already both
//   3. re-pushes the CURRENT network quantity for every mapped size from
//      /stock — because tracking makes those numbers authoritative for the
//      first time, and a number written weeks ago is not the truth today
//
// Step 3 is not optional. Flipping tracking on stale numbers would put the
// storefront's idea of stock live without checking it, which is the same class
// of bug in the other direction.
//
// WRITES: Shopify variants + inventory levels ONLY. No RTDB writes at all —
// not /shopify_publish, not /shopify_sync. Nothing is created, published,
// unpublished, archived or deleted. Safe to re-run: a product that is already
// tracked with current quantities costs one read and no mutation.
import { createRequire } from "module";
import { graphql } from "./client.mjs";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import {
  networkTotals, requireSingleLocation, setAvailable,
  untrackedVariants, enforceTracking,
} from "./inventory.mjs";
import { readAllPublishNodes } from "./publishNode.mjs";

const flags = process.argv.slice(2);
const COMMIT = flags.includes("--commit");
const LIVE_ONLY = flags.includes("--live-only");
const pidIdx = flags.indexOf("--pids");
const pidArg = pidIdx !== -1 ? flags[pidIdx + 1] : null;
if (pidIdx !== -1 && (!pidArg || pidArg.startsWith("--"))) {
  console.error("--pids needs a comma-separated productId list");
  process.exit(2);
}
const ONLY = pidArg ? new Set(pidArg.split(",").map((x) => x.trim()).filter(Boolean)) : null;
if (ONLY && ONLY.size === 0) {
  console.error("--pids parsed to an empty list");
  process.exit(2);
}

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const confirmedOn = (n) => n?.state === "live" && n?.liveState === "on";

const syncNodes = (await db.ref("shopify_sync").get()).val() || {};
const publishNodes = await readAllPublishNodes(db);
const pids = Object.keys(syncNodes)
  .filter((k) => k !== "_collections")
  .filter((pid) => !ONLY || ONLY.has(pid))
  .filter((pid) => !LIVE_ONLY || confirmedOn(publishNodes[pid]))
  .sort();

const unknownPids = ONLY ? [...ONLY].filter((pid) => !pids.includes(pid)) : [];
for (const pid of unknownPids) {
  console.error(`  ✗ ${pid}: no /shopify_sync entry — this program has never pushed it`);
}

console.log(`${pids.length} mapped products in scope` +
  (LIVE_ONLY ? " (confirmed ON only)" : "") +
  ` · ${pids.filter((p) => confirmedOn(publishNodes[p])).length} confirmed ON the storefront`);
console.log(COMMIT ? "MODE: commit\n" : "MODE: dry run — nothing written\n");

// The stock tree is read ONCE per location rather than per product: the live
// tree is large and a per-product walk of every location would be thousands of
// reads for a job that touches at most a few hundred products.
const locNames = Object.keys((await db.ref("stock").get()).val() || {});

const locId = await requireSingleLocation(graphql);
const results = [];

for (const pid of pids) {
  assertSafeSegment(pid, "productId");
  const map = syncNodes[pid];
  const gid = map?.shopifyProductId;
  const variantMap = map?.variants || {};
  if (!gid || !Object.keys(variantMap).length) {
    results.push({ pid, status: "no-map", detail: "mapping has no product id or no variants" });
    continue;
  }
  try {
    const back = await graphql(
      `query ($id: ID!) {
        product(id: $id) {
          id title status
          variants(first: 100) { pageInfo { hasNextPage } nodes {
            id title inventoryPolicy inventoryItem { id tracked }
          } }
        }
      }`,
      { id: gid }
    );
    const bp = back.product;
    if (!bp) { results.push({ pid, status: "gone", detail: `${gid} not found — the ID map points at a deleted product` }); continue; }
    if (bp.variants.pageInfo.hasNextPage) { results.push({ pid, status: "too-many", detail: ">100 variants unpaginated" }); continue; }

    // Only variants THIS PROGRAM mapped are touched. A variant added by hand in
    // the admin is not ours, and flipping its tracking on could put a number on
    // the storefront that nobody in this system is maintaining.
    const mappedVariantIds = new Set(Object.values(variantMap).map((v) => v.shopifyVariantId));
    const rows = bp.variants.nodes
      .filter((v) => mappedVariantIds.has(v.id))
      .map((v) => ({ variantId: v.id, tracked: v.inventoryItem?.tracked, inventoryPolicy: v.inventoryPolicy }));
    const untracked = untrackedVariants(rows);

    // Current network quantity per mapped size, from /stock.
    const cells = {};
    for (const loc of locNames) {
      const c = (await db.ref(`stock/${loc}/${pid}`).get()).val();
      if (c) cells[loc] = { [pid]: c };
    }
    // networkTotals keys by stockSizeKey; the ID map is already keyed the same
    // way (encodeSizeKey), and the reconciler refuses any record where the two
    // disagree — so the map's own keys are the size list to price.
    const sizeKeys = Object.keys(variantMap);
    const totals = networkTotals(cells, pid, sizeKeys);
    const items = Object.entries(variantMap).map(([sizeKey, v]) => ({
      inventoryItemId: v.shopifyInventoryItemId,
      quantity: totals[sizeKey] ?? 0,
    }));

    if (!COMMIT) {
      results.push({
        pid, status: untracked.length ? "would-track" : "already-tracked",
        detail: `${bp.title} · ${untracked.length}/${rows.length} variant(s) to track · quantities ${JSON.stringify(totals)}`,
      });
      continue;
    }

    if (untracked.length) await enforceTracking(graphql, gid, untracked.map((r) => r.variantId));
    await setAvailable(graphql, locId, items);
    results.push({
      pid, status: untracked.length ? "tracked" : "quantities-refreshed",
      detail: `${bp.title} · ${untracked.length} variant(s) tracked · quantities ${JSON.stringify(totals)}`,
    });
  } catch (e) {
    results.push({ pid, status: "failed", detail: String(e?.message || e) });
  }
}

const BAD = new Set(["failed", "no-map", "gone", "too-many"]);
for (const r of results) {
  const icon = BAD.has(r.status) ? "✗" : r.status.startsWith("already") ? "·" : "✓";
  console.log(`${icon} ${r.pid.padEnd(16)} ${r.status.padEnd(20)} ${r.detail}`);
}
const tally = {};
for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
console.log(`\n${Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join(" · ") || "nothing in scope"}`);
if (!COMMIT) console.log("dry run — Shopify untouched. Re-run with --commit to apply.");
process.exit(results.some((r) => BAD.has(r.status)) || unknownPids.length ? 1 : 0);

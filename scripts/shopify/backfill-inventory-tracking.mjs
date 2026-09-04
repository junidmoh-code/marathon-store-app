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
// unpublished, archived or deleted.
//
// Safe to re-run, and idempotent — but NOT free on a re-run: step 3 always
// fires, because a quantity is only correct as of the moment it is written.
// setAvailable is an absolute compare-and-set, so a re-run converges rather
// than double-counting. Only step 2 is conditional (an already-tracked product
// sends no tracking mutation at all).
import { createRequire } from "module";
import { graphql } from "./client.mjs";
import { assertSafeSegment, encodeSizeKey, stockSizeKey } from "../../src/utils/sizeKey.js";
import { findSizeCollisions } from "./sizeOrder.mjs";
import { isProductRecordKey } from "./idMap.mjs";
import { shallowKeys } from "../lib/rtdbPaged.mjs";
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
const mappedPids = Object.keys(syncNodes)
  .filter(isProductRecordKey)   // _collections, _reconcile, _claims, and any future sibling
  .filter((pid) => !ONLY || ONLY.has(pid));
const pids = mappedPids
  .filter((pid) => !LIVE_ONLY || confirmedOn(publishNodes[pid]))
  .sort();

// Computed against the MAPPED set, before --live-only narrows it. Otherwise a
// named pid that is mapped but simply not live was reported as "this program
// has never pushed it", which is a false reason on a true refusal.
const unknownPids = ONLY ? [...ONLY].filter((pid) => !mappedPids.includes(pid)) : [];
for (const pid of unknownPids) {
  console.error(`  ✗ ${pid}: no /shopify_sync entry — this program has never pushed it`);
}
if (ONLY && LIVE_ONLY) {
  for (const pid of mappedPids.filter((p) => !pids.includes(p))) {
    console.error(`  · ${pid}: mapped but not confirmed ON — skipped by --live-only`);
  }
}

console.log(`${pids.length} mapped products in scope` +
  (LIVE_ONLY ? " (confirmed ON only)" : "") +
  ` · ${pids.filter((p) => confirmedOn(publishNodes[p])).length} confirmed ON the storefront`);
console.log(COMMIT ? "MODE: commit\n" : "MODE: dry run — nothing written\n");

// The LOCATION NAMES, and nothing else. A `db.ref("stock").get()` here would
// pull the entire tree — every location x every product x every size — to read
// off ten top-level keys, and this project has a Firebase bandwidth-cost
// incident on record. shallowKeys is the REST ?shallow=true read the census
// scripts already use for exactly this: it returns the keys and none of the
// weight.
const locNames = await shallowKeys(admin.app(), "stock");

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

    // ── THE SIZE-KEY GUARD, done against the RAW catalogue tokens ───────────
    // The first attempt at this compared the ID MAP's keys — and those are
    // ALREADY encodeSizeKey'd, so both functions are idempotent on them and the
    // check could never fire. `encodeSizeKey("Free_Size")` is `"Free_Size"`;
    // only the RAW token `"Free Size"` diverges (`encodeSizeKey` → "Free_Size",
    // `stockSizeKey` → "_"). reconcile.mjs gets this right because it compares
    // the raw token from `product.sizes`; the backfill has to read the record
    // to do the same. (Spec review, 2026-08-16.)
    //
    // Why it matters: networkTotals re-applies stockSizeKey to whatever size
    // list it is given and drops any cell whose key is not in the list. A
    // divergent token means the real /stock cell is never summed, the total
    // reads 0, and this script would then TRACK the variant and set it to zero
    // in the same pass — real stock turned into a silent, instant sold-out.
    // The same class of bug this PR exists to fix, pointing the other way.
    // ── REFUSING TO RE-PRICE IS NOT REFUSING TO TRACK ───────────────────────
    // Every refusal below is about a product whose DATA is broken, and those
    // products are already live and already untracked — that is, already
    // infinitely sellable. Skipping them entirely would leave the worse of the
    // two conditions standing on exactly the products with the worst data.
    // So each refusal tracks first and declines only the re-pricing: the
    // variant keeps whatever quantity setAvailable last wrote, which is a real
    // number, and stops being infinite. (Review finding, 2026-08-16.)
    const refuseButTrack = async (status, detail) => {
      let note = "";
      if (COMMIT && untracked.length) {
        try {
          await enforceTracking(graphql, gid, untracked.map((r) => r.variantId));
          note = ` · TRACKED ${untracked.length} variant(s) anyway (quantities left as last written — they are no longer infinite)`;
        } catch (e) {
          note = ` · ⚠ AND could not be tracked (${String(e?.message || e)}) — it is live and still oversellable`;
        }
      } else if (untracked.length) {
        note = ` · would still TRACK ${untracked.length} variant(s) (no re-pricing)`;
      }
      results.push({ pid, status, detail: detail + note });
    };

    const product = (await db.ref(`products/${pid}`).get()).val();
    if (!product) {
      await refuseButTrack("no-record", `${bp.title} · mapped and live but no /products record`);
      continue;
    }
    const rawSizes = Array.isArray(product.sizes) ? product.sizes
      : product.sizes && typeof product.sizes === "object" ? Object.values(product.sizes) : [];
    if (!rawSizes.length) {
      await refuseButTrack("no-sizes", `${bp.title} · record has no sizes array`);
      continue;
    }
    const divergent = rawSizes.filter((t) => encodeSizeKey(t) !== stockSizeKey(t));
    if (divergent.length) {
      await refuseButTrack("size-key-mismatch",
        `${bp.title} · size token(s) ${divergent.map((t) => JSON.stringify(t)).join(", ")} key differently in /stock and the ID map — pricing them would read 0 and sell out real stock. Normalise the record and re-map first.`);
      continue;
    }

    // Two catalogue tokens that encode to the SAME variant key would put two
    // entries with the same inventoryItemId into one inventorySetQuantities
    // call, which Shopify rejects. The reconciler guards this with
    // findSizeCollisions; the backfill never ran it, and the switch from
    // Object.entries(variantMap) to rawSizes removed the free de-duplication
    // that had been hiding it.
    const collisions = findSizeCollisions(rawSizes);
    if (collisions.length) {
      await refuseButTrack("size-collision", `${bp.title} · ${collisions.join("; ")}`);
      continue;
    }

    // Every catalogue size must have a mapped variant — the backfill's
    // equivalent of the reconciler's missingSizes refusal. The reconciler never
    // revisits a settled live product, so a size added to the record AFTER
    // publish has no variant and nothing else would ever notice. Report it
    // rather than quietly pricing the subset that happens to be mapped.
    const missingSizes = rawSizes.filter((t) => !(encodeSizeKey(t) in variantMap));
    if (missingSizes.length) {
      await refuseButTrack("unmapped-size",
        `${bp.title} · catalogue size(s) ${missingSizes.join(", ")} have no Shopify variant — the size set changed after this product went live. Fix the product (or the record) before trusting its inventory.`);
      continue;
    }

    // Current network quantity per RAW size token, from /stock. One request per
    // location, ALL IN FLIGHT AT ONCE rather than ten sequential round-trips
    // per product.
    const perLoc = await Promise.all(
      locNames.map((loc) => db.ref(`stock/${loc}/${pid}`).get().then((snap) => [loc, snap.val()]))
    );
    const cells = {};
    for (const [loc, c] of perLoc) if (c) cells[loc] = { [pid]: c };
    // networkTotals takes RAW tokens and returns them keyed by stockSizeKey;
    // the guard above has established that equals encodeSizeKey, which is how
    // the ID map is keyed — so the two line up by proof, not by assumption.
    const totals = networkTotals(cells, pid, rawSizes);
    const items = rawSizes.map((t) => ({
      inventoryItemId: variantMap[encodeSizeKey(t)].shopifyInventoryItemId,
      quantity: totals[stockSizeKey(t)] ?? 0,
    }));

    // THE OTHER DIRECTION, and it is a regression this script introduced when
    // the pricing loop moved from the ID map's keys to the record's sizes: a
    // variant that is MAPPED but whose size has LEFT the catalogue. The
    // one-size collapses did exactly that to hundreds of records. It is still
    // in variantMap, so it gets tracked — but it fell out of `items`, so it
    // kept whatever quantity setAvailable last wrote, months ago, typically
    // NON-ZERO. Tracked at a stale non-zero number is a promise to sell
    // something the app no longer counts.
    //
    // The record no longer lists that size, so the app holds no stock for it:
    // zero is not a guess, it is the truth. Zeroing also makes the reconciler's
    // "tracked at whatever it holds (usually 0)" argument true rather than
    // hopeful.
    const catalogueKeys = new Set(rawSizes.map((t) => encodeSizeKey(t)));
    const retiredKeys = Object.keys(variantMap).filter((k) => !catalogueKeys.has(k));
    for (const k of retiredKeys) {
      items.push({ inventoryItemId: variantMap[k].shopifyInventoryItemId, quantity: 0 });
    }

    if (!COMMIT) {
      results.push({
        pid, status: untracked.length ? "would-track" : "already-tracked",
        detail: `${bp.title} · ${untracked.length}/${rows.length} variant(s) to track · quantities ${JSON.stringify(totals)}` +
          (retiredKeys.length ? ` · ${retiredKeys.length} retired size(s) (${retiredKeys.join(", ")}) to zero` : ""),
      });
      continue;
    }

    if (untracked.length) await enforceTracking(graphql, gid, untracked.map((r) => r.variantId));
    await setAvailable(graphql, locId, items);
    results.push({
      pid, status: untracked.length ? "tracked" : "quantities-refreshed",
      detail: `${bp.title} · ${untracked.length} variant(s) tracked · quantities ${JSON.stringify(totals)}` +
        (retiredKeys.length ? ` · ${retiredKeys.length} retired size(s) zeroed (${retiredKeys.join(", ")})` : ""),
    });
  } catch (e) {
    results.push({ pid, status: "failed", detail: String(e?.message || e) });
  }
}

const BAD = new Set(["failed", "no-map", "no-record", "no-sizes", "gone", "too-many", "size-key-mismatch", "size-collision", "unmapped-size"]);
for (const r of results) {
  const icon = BAD.has(r.status) ? "✗" : r.status.startsWith("already") ? "·" : "✓";
  console.log(`${icon} ${r.pid.padEnd(16)} ${r.status.padEnd(20)} ${r.detail}`);
}
const tally = {};
for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
console.log(`\n${Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join(" · ") || "nothing in scope"}`);
if (!COMMIT) console.log("dry run — Shopify untouched. Re-run with --commit to apply.");
process.exit(results.some((r) => BAD.has(r.status)) || unknownPids.length ? 1 : 0);

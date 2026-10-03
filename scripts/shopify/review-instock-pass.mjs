#!/usr/bin/env node
// ── ONE FULL PASS: hide every review-list product with no sellable stock ─────
// docs/SHOPIFY-REVIEW-INSTOCK.md. The /stock trigger + reconcile tick keep
// /config/shopifyReviewHidden current from then on. This seeds it once, and it
// can be re-run at any time, for example after products are switched off or
// their sizes are edited with no stock movement. It converges, so a second run
// writes nothing.
//
//   node scripts/shopify/review-instock-pass.mjs            # dry run: counts only
//   node scripts/shopify/review-instock-pass.mjs --commit   # write the hidden set
//
// Writes ONLY /config/shopifyReviewHidden/{pid}. It never writes
// /shopify_publish, /products or Shopify, and nothing is published or
// unpublished.
//
// The verdict per product is reviewStock.verdictFor over reviewStock's
// hasSellableStock (= networkTotals, the website's arithmetic), over the SAME
// filtered location list the reconcile tick uses (inventorySync.locationNames).
// The tick and this pass therefore cannot disagree about a product.
//
// It reads the catalogue, the publish nodes and each COUNTED location's stock,
// paged. That is a one-off cost of a few MB, not something any tick does.
//
// STOPS (exit 2) if /stock holds a location that /locations does not list.
// Such a location's units are invisible to the tick's arithmetic, so sellable
// stock could not be determined reliably there.

import { createRequire } from "module";
import { readMapPaged, shallowKeys } from "../lib/rtdbPaged.mjs";
import { isPriceRecord } from "../../src/utils/productCategory.js";
import { isOn } from "../../src/components/shopify/publishState.js";
import { ONLINE_EXCLUDED_LOCATIONS } from "./inventory.mjs";
import { locationNames } from "./inventorySync.mjs";
import { hasSellableStock, verdictFor, reviewBucket, HIDDEN_PATH, AUTOPUBLISH_QUEUE_PATH, REVIEW_MIN_UNITS } from "./reviewStock.mjs";
import { normalizedState } from "../../src/components/shopify/publishState.js";
import { readiness } from "./autoPublish.mjs";

const COMMIT = process.argv.includes("--commit");

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

// ── Is every location with stock known? ─────────────────────────────────────
const stockLocs = [...(await shallowKeys(admin.app(), "stock"))];
const known = new Set(Object.keys((await db.ref("locations").get()).val() || {}));
const unknownLocs = stockLocs.filter((l) => !known.has(l) && !ONLINE_EXCLUDED_LOCATIONS.has(l));
if (unknownLocs.length) {
  console.error(`STOP: /stock has location(s) not in /locations: ${unknownLocs.join(", ")} — sellable stock cannot be determined reliably there.`);
  process.exit(2);
}
const locs = await locationNames(db);
console.log(`counted locations (${locs.length}): ${locs.join(", ")}`);
console.log(`excluded: ${[...ONLINE_EXCLUDED_LOCATIONS].join(", ")}`);

const products = await readMapPaged(db, "products");
const nodes = await readMapPaged(db, "shopify_publish");
const tree = {};
for (const loc of locs) tree[loc] = await readMapPaged(db, `stock/${loc}`);
const hiddenNow = (await db.ref(HIDDEN_PATH).get()).val() || {};

const tally = { inList: 0, hide: 0, keep: 0, unjudgeable: 0 };
const byBucket = {};
const byBrand = {};
const updates = {};
let toHide = 0, toShow = 0, toQueue = 0;
const queuedNow = (await db.ref(AUTOPUBLISH_QUEUE_PATH).get()).val() || {};
// What the auto-publish agent would do with each eligible product right now.
const ready = { now: 0, why: {}, samples: [] };
for (const [pid, p] of Object.entries(products)) {
  if (!p || typeof p !== "object" || isPriceRecord(p)) continue;
  const node = nodes[pid] || null;
  const sizes = p.sizes;
  const sellable = isOn(node) ? null : hasSellableStock(tree, pid, sizes);
  const { verdict } = verdictFor({ node, sizes, sellable });
  if (!isOn(node)) {
    tally.inList++;
    if (sellable === null) tally.unjudgeable++;
  }
  if (verdict === "hide") {
    tally.hide++;
    const b = reviewBucket(node);
    byBucket[b] = (byBucket[b] || 0) + 1;
    const brand = String(p.brand || "").trim() || "(no brand)";
    byBrand[brand] ??= { total: 0, awaiting: 0, "in review": 0, blocked: 0 };
    byBrand[brand].total++;
    byBrand[brand][b]++;
    if (hiddenNow[pid] == null) { updates[`${HIDDEN_PATH}/${pid}`] = admin.database.ServerValue.TIMESTAMP; toHide++; }
  } else {
    if (!isOn(node)) tally.keep++;
    // In the review list with enough stock → the auto-publish agent's queue.
    // Blocked products need a person and are left out.
    if (verdictFor({ node, sizes, sellable }).inReview && normalizedState(node) !== "blocked") {
      const r = readiness(p, node);
      if (r.ready) {
        ready.now++;
        if (ready.samples.length < 25) ready.samples.push(`${pid}  ${String(p.name).trim().slice(0, 40).padEnd(40)} → ${r.name}${r.viaProposal ? "  (AI suggestion)" : ""}`);
      } else {
        const k = r.why.replace(/:.*$/, "");
        ready.why[k] = (ready.why[k] || 0) + 1;
      }
    }
    if (verdictFor({ node, sizes, sellable }).inReview && normalizedState(node) !== "blocked" && !queuedNow[pid]) {
      updates[`${AUTOPUBLISH_QUEUE_PATH}/${pid}/queuedAt`] = admin.database.ServerValue.TIMESTAMP;
      toQueue++;
    }
    if (hiddenNow[pid] != null) { updates[`${HIDDEN_PATH}/${pid}`] = null; toShow++; }
  }
}
// Entries for products that no longer exist are removed. A hidden entry
// for nothing would be harmless, but it is noise.
for (const pid of Object.keys(hiddenNow)) {
  if (!products[pid]) { updates[`${HIDDEN_PATH}/${pid}`] = null; toShow++; }
}

console.log(`\nreview list today (publishable, not live+on): ${tally.inList}`);
console.log(`  → hidden (fewer than ${REVIEW_MIN_UNITS} sellable units online): ${tally.hide}`);
console.log(`  → remain in review:                  ${tally.keep}` +
  (tally.unjudgeable ? `  (incl. ${tally.unjudgeable} with no sizes — never hidden)` : ""));
console.log(`\nhidden by state:`);
for (const b of ["awaiting", "in review", "blocked"]) console.log(`  ${b.padEnd(10)} ${byBucket[b] || 0}`);
console.log(`\nhidden by brand (top 40):`);
const brands = Object.entries(byBrand).sort((a, b) => b[1].total - a[1].total);
for (const [brand, c] of brands.slice(0, 40)) {
  console.log(`  ${brand.slice(0, 28).padEnd(28)} ${String(c.total).padStart(5)}   awaiting ${c.awaiting} · in review ${c["in review"]} · blocked ${c.blocked}`);
}
if (brands.length > 40) console.log(`  … ${brands.length - 40} more brands`);
console.log(`\nauto-publish if switched on: ${ready.now} ready now`);
for (const [k, n] of Object.entries(ready.why).sort((a, b) => b[1] - a[1])) console.log(`  waiting — ${k}: ${n}`);
console.log(`\nsample of what would go live (catalogue name → listing name):`);
for (const line of ready.samples) console.log(`  ${line}`);
console.log(`\nwrites: +${toHide} hidden, -${toShow} un-hidden, +${toQueue} queued for auto-publish`);

if (!COMMIT) { console.log("\nDRY RUN — nothing written. Re-run with --commit."); process.exit(0); }

const paths = Object.keys(updates);
for (let i = 0; i < paths.length; i += 500) {
  const chunk = {};
  for (const k of paths.slice(i, i + 500)) chunk[k] = updates[k];
  await db.ref().update(chunk);
}
const after = Object.keys((await db.ref(HIDDEN_PATH).get()).val() || {}).length;
console.log(`\nCOMMITTED. /${HIDDEN_PATH} now holds ${after} product(s).`);
process.exit(0);

// ─── INVENTORY, CONTINUOUSLY — the half that stops an oversell ───────────────
//
// THE BUG THIS EXISTS TO CLOSE. reconcile.mjs pushes inventory exactly ONCE,
// inside the block that applies a product's publish INTENT. Its worklist is
// "every node whose intent differs from its confirmed state", so a product that
// is already live and on is skipped on every subsequent tick — and its
// inventory is never written again. Stock then moves in the app for weeks
// while Shopify keeps the number it was given on the day it went live.
//
// Measured on 2026-08-27 across 283 live variants: 15 had drifted, 14 of them
// with SHOPIFY HIGHER than the app, and two were offering stock against an app
// count of zero. Those two were sellable and unfulfillable at the same time.
//
// ── WHAT THIS MODULE DOES ────────────────────────────────────────────────────
// Recomputes the network total for a product and writes it to Shopify. That is
// all. It is deliberately the SAME arithmetic reconcile.mjs uses at publish
// time — networkTotals + setAvailable — because two functions computing "what
// is sellable" is how the answer starts depending on which one ran last.
//
// ── DIRECTION, AND WHAT THIS DOES NOT DO ─────────────────────────────────────
// APP → SHOPIFY only. The app is the book of record for what physically
// exists; Shopify is a shop window onto it. The reverse direction (a web sale
// reaching the app) is a webhook, not a sweep, and lives in functions/ — a
// poll cannot be the mechanism for money that has already changed hands.
//
// ── WHY IT IS DRIVEN BY MARKERS AND NOT BY READING /stock ────────────────────
// /stock is ~5.36 MB. Reading it whole every two minutes to find what moved is
// ~2.6 GB a day to discover that usually nothing did. Instead a Cloud Function
// trigger writes a one-key marker when a cell changes, and this sweep reads
// only the markers. A quiet shop costs one small read per tick.

import { networkTotals, requireSingleLocation, setAvailable } from "./inventory.mjs";

// The node the trigger writes to and this sweep drains.
export const DIRTY_PATH = "shopify_inventory_dirty";

// A ceiling per run, the same shape as the search-index sweep's. A count that
// touches a thousand products must not turn one tick into a twenty-minute
// Shopify session holding the lockfile — it takes a bite and the next tick
// takes the next. Markers are only cleared for what was actually pushed, so
// nothing is lost by stopping early.
export const MAX_PER_RUN = 40;

/**
 * What Shopify SHOULD be showing for this product, from the app's own cells.
 *
 * Reads only this product's cells, one location at a time — never the whole
 * /stock node. Returns null when the product has no id map, which is not an
 * error: a product that was never pushed to Shopify has nothing to correct.
 */
export async function desiredFor(db, pid, locNames = null) {
  const map = (await db.ref(`shopify_sync/${pid}`).get()).val();
  if (!map?.variants) return null;
  const sizes = Object.keys(map.variants);
  // ── THE LOCATION NAMES COME FROM /locations, NOT FROM /stock ───────────────
  // The first version did Object.keys(await db.ref("stock").get()) to learn the
  // location names — which pulls the WHOLE /stock node, 5.36 MB, to read ten
  // strings off the top of it. Once per product, over 866 products, that is
  // ~4.6 GB of reads per full run, and it is why the first correction pass was
  // on course to take hours. /locations is a ten-row config node.
  const locs = locNames || Object.keys((await db.ref("locations").get()).val() || {});
  const tree = {};
  for (const loc of locs) {
    const cells = (await db.ref(`stock/${loc}/${pid}`).get()).val();
    if (cells) tree[loc] = { [pid]: cells };
  }
  return { map, totals: networkTotals(tree, pid, sizes) };
}

/** The location names, read once and passed down. */
export async function locationNames(db) {
  return Object.keys((await db.ref("locations").get()).val() || {});
}

/**
 * Push one product's inventory. Returns what changed, or why it did not.
 *
 * `commit: false` computes and compares without writing, so the CLI can show
 * the drift before anyone corrects it — the same dry-run discipline
 * reconcile.mjs already has.
 */
export async function syncProduct(db, graphql, pid, { commit = false, locationId = null, locNames = null } = {}) {
  const desired = await desiredFor(db, pid, locNames);
  if (!desired) return { pid, skipped: "no shopify_sync id map" };
  const { map, totals } = desired;

  const items = Object.entries(map.variants)
    .filter(([, v]) => v.shopifyInventoryItemId)
    .map(([sizeKey, v]) => ({ sizeKey, inventoryItemId: v.shopifyInventoryItemId, quantity: totals[sizeKey] ?? 0 }));
  if (!items.length) return { pid, skipped: "no mapped inventory items" };

  const locId = locationId || await requireSingleLocation(graphql);

  // Read Shopify's side first, so a no-op costs one query and no mutation, and
  // so the report can say what the drift WAS rather than only that it is gone.
  const q = await graphql(
    `query ($ids: [ID!]!, $loc: ID!) {
      nodes(ids: $ids) { ... on InventoryItem { id inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { name quantity } } } }
    }`,
    { ids: items.map((i) => i.inventoryItemId), loc: locId }
  );
  const currentById = new Map();
  for (const n of q.nodes ?? []) {
    if (!n?.id) continue;
    currentById.set(n.id, n.inventoryLevel?.quantities?.find((x) => x.name === "available")?.quantity ?? 0);
  }

  // ── AN ID SHOPIFY DOES NOT KNOW COSTS ONE VARIANT, NOT THE PRODUCT ────────
  // One live product's id map points at inventory items that no longer exist
  // on the shop. inventorySetQuantities rejects the WHOLE mutation on a single
  // unknown id, so sending the stale ones meant that product's four
  // oversellable variants stayed oversellable — the id map is stale, and the
  // correction it blocked was the thing that mattered.
  //
  // The read-back above already says which ids Shopify knows: an id missing
  // from its response is one it cannot resolve. Those are dropped from the
  // write and reported, rather than being allowed to veto their neighbours.
  const known = items.filter((i) => currentById.has(i.inventoryItemId));
  const unknown = items.filter((i) => !currentById.has(i.inventoryItemId));

  const drift = known
    .map((i) => ({ ...i, shopify: currentById.get(i.inventoryItemId) }))
    .filter((i) => i.shopify !== i.quantity);

  const stale = unknown.length ? { staleVariants: unknown.map((i) => i.sizeKey) } : {};
  if (!known.length) return { pid, ok: false, why: `every mapped inventory item is unknown to Shopify — the id map is stale`, ...stale };
  if (!drift.length) return { pid, ok: true, drift: [], changed: 0, ...stale };
  if (!commit) return { pid, ok: true, drift, changed: 0, dryRun: true, ...stale };

  // Write EVERY mapped item, not just the drifted ones. inventorySetQuantities
  // is absolute, and sending the full set means one call whose result is the
  // whole truth for this product rather than a patch whose correctness depends
  // on the read above still being current.
  await setAvailable(graphql, locId, known.map(({ inventoryItemId, quantity }) => ({ inventoryItemId, quantity })));
  return { pid, ok: true, drift, changed: drift.length, ...stale };
}

/**
 * Drain the dirty markers.
 *
 * A marker is cleared ONLY after its product has been pushed. A crash between
 * the push and the clear re-pushes the same numbers next tick, which is
 * harmless — the write is absolute, not a delta. Clearing first and crashing
 * would lose the change silently, which is the failure this whole module
 * exists to prevent, so the order is not an accident.
 */
export async function sweepDirty(db, graphql, { commit = false, isLive, max = MAX_PER_RUN, log = () => {} } = {}) {
  const markers = (await db.ref(DIRTY_PATH).get()).val() || {};
  const pids = Object.keys(markers);
  if (!pids.length) return { seen: 0, pushed: 0, cleared: 0, results: [] };

  const locId = commit ? await requireSingleLocation(graphql) : null;
  const locNames = await locationNames(db);
  const results = [];
  let pushed = 0, cleared = 0;
  for (const pid of pids.slice(0, max)) {
    // A marker for a product that is not on the storefront is not an error and
    // not work — it is cleared, because leaving it would make the node grow
    // forever with every stock movement on everything we do not sell online.
    if (!isLive(pid)) {
      if (commit) { await db.ref(`${DIRTY_PATH}/${pid}`).remove(); cleared++; }
      continue;
    }
    try {
      const r = await syncProduct(db, graphql, pid, { commit, locationId: locId, locNames });
      results.push(r);
      if (r.changed) pushed++;
      if (commit) { await db.ref(`${DIRTY_PATH}/${pid}`).remove(); cleared++; }
    } catch (e) {
      // The marker STAYS on a failure, so the next tick retries it. This is the
      // whole reason the marker is a separate node and not a timestamp compared
      // against a cursor: a failed push must not be able to look like a done one.
      results.push({ pid, ok: false, why: String(e?.message || e) });
      log(`  ⚠ inventory push failed for ${pid}: ${String(e?.message || e)}`);
    }
  }
  return { seen: pids.length, pushed, cleared, results, remaining: Math.max(0, pids.length - max) };
}

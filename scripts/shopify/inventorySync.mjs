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
//
// AND A BACKSTOP UNDER IT. A marker that is never written fails silently — the
// product simply stays wrong — which is the exact failure this module exists to
// end, so it cannot be the module's own residue. sweepBacklog at the foot of
// this file walks every live product a slice at a time, reading no marker and
// clearing none. Markers are the fast path, not the only path.

import {
  networkTotals, requireSingleLocation, setAvailable, readAvailable, readLevels,
  readProductVariants, untrackedVariants, enforceTracking,
  ONLINE_EXCLUDED_LOCATIONS,
} from "./inventory.mjs";
import { ONLINE_RESERVATIONS_PATH, heldUnits } from "../../src/utils/onlineOrders.js";

// The node the trigger writes to and this sweep drains.
export const DIRTY_PATH = "shopify_inventory_dirty";

// The heartbeat and the nightly sweep's report. Written by the reconciler
// (lastPassAt — a movement pass with no failures) and stock-truth-sweep.mjs
// (lastSweep); read by shopifyInventoryHealthScan (functions/index.js), which
// emails Junid when either says the storefront may be selling what the app
// does not hold. Server-only: Admin SDK on both sides, no client rule needed.
export const HEALTH_PATH = "shopify_inventory_health";

/**
 * Does this product have a Shopify listing whose quantities must be kept true?
 *
 * `state: "live"` means the reconciler created it on Shopify. `liveState` only
 * says whether it is on the ONLINE STORE: switching a product off unpublishes
 * that one channel, and on 2026-10-11 33 switched-off products were still
 * published to Facebook & Instagram — buyable, and skipped by every inventory
 * path because they were not "on". A listing that exists is kept true.
 */
export function isListedOnShopify(node) {
  return node?.state === "live";
}

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
  // locationNames() rather than a raw /locations read, so the caller that
  // passes nothing gets the same FILTERED list as the sweep that passes one —
  // otherwise the cheap path and the convenient path read different shelves.
  const locs = locNames || (await locationNames(db));
  // One point read per location, issued together: the same bytes as reading
  // them in turn, at one round trip's latency instead of eight.
  const tree = {};
  const cellSets = await Promise.all(locs.map((loc) => db.ref(`stock/${loc}/${pid}`).get().then((s) => s.val())));
  locs.forEach((loc, i) => { if (cellSets[i]) tree[loc] = { [pid]: cellSets[i] }; });
  // Website-order holds for this product: ONE point read of its own
  // reservation node (docs/ONLINE-ORDERS.md), read with the stock it adjusts.
  const reserved = reservedBySize(await readReservations(db, pid));
  return { map, totals: networkTotals(tree, pid, sizes), reserved };
}

// /online_reservations/{pid} → { [sizeKey]: units held by open website orders }.
// A failed read must not stop a push (the push is what corrects oversell); it
// is logged and treated as no holds — today's behaviour.
async function readReservations(db, pid) {
  try {
    return (await db.ref(`${ONLINE_RESERVATIONS_PATH}/${pid}`).get()).val();
  } catch (e) {
    console.error(`  ⚠ ${pid}: website-order holds unreadable (${String(e?.message || e)}) — pushed without them`);
    return null;
  }
}

export function reservedBySize(node) {
  const out = {};
  for (const [sizeKey, cell] of Object.entries(node || {})) {
    const n = heldUnits(cell);
    if (n > 0) out[sizeKey] = n;
  }
  return out;
}

/**
 * ── WEBSITE HOLDS, WITHOUT HIDING A UNIT TWICE ────────────────────────────────
 * Units to take off the app's count for one size before it is pushed as
 * on_hand: max(0, reserved − committed).
 *
 * `reserved` is what open website orders hold in the app (/online_reservations),
 * from arrival until Yasmin packs them — the app's stock only falls at the pack.
 * `committed` is what Shopify itself is holding for unfulfilled orders, and
 * Shopify already keeps that off sale (available = on_hand − committed). So:
 *   order open on both sides       reserved 1, committed 1 → subtract 0
 *   fulfilled in the Shopify admin  reserved 1, committed 0 → subtract 1
 *     (Shopify lowered on_hand itself; pushing the app's un-lowered count
 *      would put the sold unit back on sale — the gap PUSHED_QUANTITY's note
 *      in inventory.mjs describes)
 *   not yet pulled in by the poller reserved 0, committed 1 → subtract 0
 * Subtracting the whole reservation instead would show every open order's
 * unit as gone twice. `committed` unknown (no level read) counts as 0, which
 * only ever under-sells.
 */
export function onlineHoldAdjustment(reserved, committed) {
  const r = Math.max(0, Number(reserved) || 0);
  const c = Math.max(0, Number(committed) || 0);
  return Math.max(0, r - c);
}

/**
 * The location names that can affect what the storefront is told, read once
 * and passed down.
 *
 * FILTERED AT THE SOURCE, not only inside networkTotals. A location in
 * ONLINE_EXCLUDED_LOCATIONS cannot change the answer — networkTotals drops it
 * either way — so fetching its cells is a point read per product per sweep
 * bought for nothing. With in_transit, hub3 and marathon-pine excluded that is
 * three reads saved on every product on every pass, and the backstop walks the
 * whole live catalogue continuously.
 *
 * networkTotals still filters. This is a saving, never the guarantee: the
 * guarantee has to live next to the arithmetic, where a caller that passes its
 * own locNames (the CLI does) cannot route around it.
 */
export async function locationNames(db) {
  return Object.keys((await db.ref("locations").get()).val() || {})
    .filter((id) => !ONLINE_EXCLUDED_LOCATIONS.has(id));
}

/**
 * Push one product's inventory. Returns what changed, or why it did not.
 *
 * `commit: false` computes and compares without writing, so the CLI can show
 * the drift before anyone corrects it — the same dry-run discipline
 * reconcile.mjs already has.
 */
/**
 * PURE: compare one product's Shopify state with the app's truth.
 *
 *   map       /shopify_sync/{pid}
 *   variants  every variant on the Shopify product (readProductVariants), or
 *             null when it could not be read
 *   baseline  Map(inventoryItemId → on_hand) for the items Shopify answered
 *   totals    the app's online pool per size key (networkTotals)
 *
 * The ONE comparison both the per-tick push (syncProduct) and the nightly
 * sweep's bulk snapshot (stock-truth-sweep.mjs) use, so "what is wrong with
 * this listing" cannot depend on which of them asked.
 */
export function planProduct({ map, variants, baseline, totals, reserved = null, committed = null }) {
  const mapped = Object.entries(map?.variants || {})
    .filter(([, v]) => v?.shopifyInventoryItemId)
    .map(([sizeKey, v]) => ({ sizeKey, inventoryItemId: v.shopifyInventoryItemId }));
  const mappedIds = new Set(mapped.map((i) => i.inventoryItemId));
  // A variant on OUR product that the id map does not name is still buyable.
  // The app holds no stock against it by definition, so its truth is 0 —
  // which also fails toward unbuyable when the map is stale for that size.
  const unmapped = (variants || [])
    .filter((v) => v.inventoryItemId && !mappedIds.has(v.inventoryItemId))
    .map((v) => ({ sizeKey: `unmapped:${v.title}`, inventoryItemId: v.inventoryItemId, unmapped: true }));
  const items = [
    // Website holds come off here, per size, so every push path — the
    // per-tick sync, the nightly sweep's judgement, the CLI — subtracts them
    // the same way. `reserved` null (an older caller) subtracts nothing.
    ...mapped.map((i) => ({
      ...i,
      quantity: Math.max(0, (totals[i.sizeKey] ?? 0) -
        onlineHoldAdjustment(reserved?.[i.sizeKey], committed?.get?.(i.inventoryItemId))),
    })),
    // An unmapped item Shopify did not answer for is simply not written: it is
    // not one of ours to report as stale, and it cannot be compare-and-set.
    ...unmapped.filter((i) => baseline.has(i.inventoryItemId)).map((i) => ({ ...i, quantity: 0 })),
  ];

  // ── AN ID SHOPIFY DOES NOT KNOW COSTS ONE VARIANT, NOT THE PRODUCT ────────
  // One live product's id map points at inventory items that no longer exist
  // on the shop. inventorySetQuantities rejects the WHOLE mutation on a single
  // unknown id, so sending the stale ones meant that product's four
  // oversellable variants stayed oversellable — the id map is stale, and the
  // correction it blocked was the thing that mattered.
  //
  // The baseline read already says which ids Shopify knows: an id missing from
  // it is one it cannot resolve. Those are dropped from the write and
  // reported, rather than being allowed to veto their neighbours.
  const known = items.filter((i) => baseline.has(i.inventoryItemId));
  const unknown = items.filter((i) => !baseline.has(i.inventoryItemId));

  const drift = known
    .map((i) => ({ ...i, shopify: baseline.get(i.inventoryItemId) }))
    .filter((i) => i.shopify !== i.quantity);

  // Variants Shopify is NOT limiting by quantity, named by size so a report
  // can say which sizes were unlimited and what the app actually held there.
  const sizeByItem = new Map(items.map((i) => [i.inventoryItemId, i]));
  const untracked = untrackedVariants(variants || []).map((v) => ({
    variantId: v.variantId,
    inventoryItemId: v.inventoryItemId,
    sizeKey: sizeByItem.get(v.inventoryItemId)?.sizeKey ?? `unmapped:${v.title}`,
    app: sizeByItem.get(v.inventoryItemId)?.quantity ?? 0,
    shopify: baseline.get(v.inventoryItemId) ?? null,
    tracked: v.tracked ?? null,
    inventoryPolicy: v.inventoryPolicy ?? null,
  }));

  return {
    mapped, known, unknown, drift, untracked,
    // Not one mapped item is known to Shopify: deleted product, or stale map.
    allUnknown: !known.some((i) => !i.unmapped),
    stale: unknown.length ? { staleVariants: unknown.map((i) => i.sizeKey) } : {},
    // What each side holds for this product, for the nightly sweep's report
    // and its "would this correction zero most of the shop?" guard.
    meta: {
      gid: map?.shopifyProductId ?? null,
      shopifyUnits: known.reduce((n, i) => n + Math.max(0, baseline.get(i.inventoryItemId) || 0), 0),
      appUnits: known.reduce((n, i) => n + i.quantity, 0),
    },
  };
}

export async function syncProduct(db, graphql, pid, { commit = false, locationId = null, locNames = null } = {}) {
  // ── ORDER OF READS IS LOAD-BEARING ─────────────────────────────────────────
  // Shopify is read BEFORE /stock, and the value it gives is the compare-and-set
  // baseline for the write at the end. That ordering is the whole protection
  // against overwriting a sale: it makes the compare-and-set span the entire
  // operation, so anything that sells between here and the mutation fails the
  // write instead of being silently replaced by a number that predates it.
  // Reading Shopify after /stock — which is what this did — guarded a window of
  // microseconds and left the window that mattered wide open.
  const map = (await db.ref(`shopify_sync/${pid}`).get()).val();
  // `permanent`: retrying cannot change this answer, so a queue must not hold
  // for it (movementSync.mjs) — it is reported, and the nightly sweep owns it.
  if (!map?.variants) return { pid, skipped: "no shopify_sync id map", permanent: true };
  if (!Object.values(map.variants).some((v) => v?.shopifyInventoryItemId)) {
    return { pid, skipped: "no mapped inventory items", permanent: true };
  }

  const locId = locationId || await requireSingleLocation(graphql);

  // ── A NUMBER IS ONLY A LIMIT WHILE SHOPIFY IS COUNTING ────────────────────
  // Every variant on the product, with its tracking state, read BEFORE the
  // baseline so the baseline can cover the variants the id map does not name.
  // Until 2026-10-11 this function wrote correct quantities to 337 variants
  // that had tracking OFF — Shopify ignored every one of them and sold those
  // sizes without limit (docs/SHOPIFY-STOCK-TRUTH.md). Tracking was checked
  // only at publish; it is now checked every time a product is synced.
  // A failed tracking read does not stop the quantities being corrected — they
  // are still the truth — but the product is then NOT reported done (ok:false
  // below), so every path that queues it retries until tracking is checked.
  let variants = null;
  let trackingError = null;
  try {
    variants = await readProductVariants(graphql, map.shopifyProductId);
  } catch (e) {
    trackingError = String(e?.message || e);
  }
  const mappedIds = Object.values(map.variants).map((v) => v?.shopifyInventoryItemId).filter(Boolean);
  const extraIds = (variants || []).map((v) => v.inventoryItemId).filter((id) => id && !mappedIds.includes(id));
  const { onHand: baseline, committed } = await readLevels(graphql, locId, [...mappedIds, ...extraIds]);

  // NOW the stock snapshot, strictly after the baseline.
  const desired = await desiredFor(db, pid, locNames);
  if (!desired) return { pid, skipped: "no shopify_sync id map", permanent: true };
  const plan = planProduct({ map, variants, baseline, totals: desired.totals, reserved: desired.reserved, committed });
  const { known, drift, untracked, stale, meta } = plan;

  // ── AN ENTIRELY UNKNOWN ID MAP HAS TWO VERY DIFFERENT CAUSES ──────────────
  // "The id map is stale" was the whole diagnosis, and it is the less
  // interesting half. The 2026-09-05 correction run refused 7 products this
  // way; every one of them turned out to have been DELETED FROM SHOPIFY while
  // the app still recorded state:"live", liveState:"on". Those are not
  // overselling — they are the opposite: products the shop believes it is
  // selling online and is not, with nothing anywhere saying so.
  //
  // One extra query, asked ONLY on the path that has already failed, turns an
  // ambiguous message into a fact. Nothing is written: what a deleted product
  // should do to its publish node is a separate question with a separate
  // answer, and guessing it here would be a third way this file could quietly
  // disagree with the storefront.
  // ── …AND A STALE MAP ON A PRODUCT THAT IS STILL THERE IS STILL SELLING ──
  // When Shopify still lists the product, its real variants are all
  // "unmapped" — the app cannot say which of its sizes they are, so it holds
  // none of them, and the plan sets each to 0 (and switches tracking on).
  // Under-selling a product until it is re-mapped is the safe direction; a
  // listing nobody can reconcile selling whatever Shopify last held is not.
  // The answer is still reported as a refusal, and it is PERMANENT — no tick
  // can repair an id map — so no queue holds for it.
  const staleButListed = plan.allUnknown && Array.isArray(variants) && variants.length > 0;
  if (plan.allUnknown && !staleButListed) {
    let gone = null;   // null = could not be established — NOT "present"
    try {
      const probe = await graphql(`query ($id: ID!) { product(id: $id) { id } }`, { id: map.shopifyProductId });
      gone = probe?.product == null;
    } catch { /* a probe that fails answers nothing, and must not mask the real refusal */ }
    return {
      pid, gid: map.shopifyProductId ?? null, ok: false, productGone: gone, permanent: true,
      why: gone
        ? `DELETED FROM SHOPIFY (${map.shopifyProductId}) — the app still records this product as live and on, and it is not on the storefront at all`
        : `every mapped inventory item is unknown to Shopify — the id map is stale`,
      ...stale,
    };
  }
  const unchecked = trackingError
    ? { ok: false, why: `inventory tracking could not be read (${trackingError}) — quantities ${commit ? "written" : "compared"}, tracking unchecked; retried` }
    : staleButListed
      ? { ok: false, permanent: true, why: `every mapped inventory item is unknown to Shopify — the id map is stale; the listing's ${variants.length} variant(s) are held at 0 until it is re-mapped` }
      : {};
  if (!drift.length && !untracked.length) return { pid, ok: true, drift: [], untracked: [], changed: 0, ...meta, ...stale, ...unchecked };
  if (!commit) return { pid, ok: true, drift, untracked, changed: 0, dryRun: true, ...meta, ...stale, ...unchecked };

  // Tracking FIRST, then the numbers. Switching tracking on makes the
  // quantities Shopify already holds binding for the few hundred milliseconds
  // until the write below lands — strictly safer than the unlimited state it
  // replaces — and the write then sets every size to the app's truth. A
  // failure here throws: the caller keeps the product queued and retries,
  // because an untracked variant is the oversell this module exists to end.
  if (untracked.length) {
    await enforceTracking(graphql, map.shopifyProductId, untracked.map((u) => u.variantId));
  }

  // Write EVERY known item, not just the drifted ones. inventorySetQuantities
  // is absolute, and sending the full set means one call whose result is the
  // whole truth for this product rather than a patch whose correctness depends
  // on the baseline still being current — which the compare-and-set decides.
  await setAvailable(
    graphql, locId,
    known.map(({ inventoryItemId, quantity }) => ({ inventoryItemId, quantity })),
    baseline,
  );
  return { pid, ok: true, drift, untracked, trackingFixed: untracked.length, changed: drift.length + untracked.length, ...meta, ...stale, ...unchecked };
}

// ─── CLEARING A MARKER IS THE DANGEROUS HALF ─────────────────────────────────
// The marker-driven design has exactly one safety property: a failed push must
// not be able to look like a done one. Two ways the first version broke it, and
// both were found in review of PR #559 before this ever ran:
//
//   1. syncProduct can answer `ok: false` WITHOUT calling Shopify — the "every
//      mapped inventory item is unknown to Shopify" branch. Clearing on that
//      answer stops a product with an all-stale id map from ever retrying: it
//      is oversellable, and it is now silent about it.
//   2. A marker written AFTER desiredFor() read /stock, but before the clear,
//      was deleted along with the one being processed. The stock movement it
//      stood for is then never pushed, and Shopify keeps an obsolete quantity
//      until some unrelated movement on the same product marks it again.
//
// The fix for both is the same idea: the marker carries a REVISION, and the
// clear is a compare-and-set against the revision that was actually processed.
//
// THE REVISION IS A COUNTER, NOT A TIMESTAMP. The trigger writes it with RTDB's
// atomic increment, so every stock change bumps it and two changes in the same
// millisecond are still two revisions. A timestamp at millisecond resolution
// cannot say that, and "the two writes landed in the same millisecond" is
// precisely the race this guard exists for.
//
// clearMarker is exported so its logic can be tested against a fake ref without
// a network, and so nothing else in this file can clear a marker unguarded.

/**
 * Remove a marker ONLY if it still reads as the revision that was processed.
 * Returns true when it was cleared, false when a newer revision was found and
 * deliberately left standing for the next tick.
 */
//
// `path` is the marker node. It defaults to the inventory markers; the review
// list's markers (reviewStock.mjs) are cleared by this same guarded function
// rather than a second copy of the trap documented below.
export async function clearMarker(db, pid, revision, path = DIRTY_PATH) {
  const res = await db.ref(`${path}/${pid}`).transaction((current) => {
    // ── NO ABORT MAY BE REACHABLE FROM `current == null` ──────────────────
    // This returned `undefined` here, and it was a no-op dressed as a success.
    // runTransaction attaches a listener and runs this callback SYNCHRONOUSLY
    // against the local cache first — which is null in a fresh process, which
    // every reconciler tick is. Returning undefined aborts THERE: it unwatches
    // and resolves committed:false without ever asking the server. An abort is
    // the one outcome that never reaches the wire, so the callback was never
    // re-invoked with the true value and no marker was ever deleted.
    //
    // It was invisible from the log, because the return below reads
    // `snapshot.val()` — which on that aborted first pass is the cached null.
    // So every run reported every marker cleared while the node grew:
    //
    //   10:10:56  inventory: 10 marker(s) · 0 pushed · 10 cleared · 10 still marked
    //
    // Caught by reading the live node rather than believing the line. This is
    // the trap already written down from PR #551 (scripts/shopify/idMap.mjs,
    // five review rounds) and it was walked into again here, which is the
    // argument for the test fake below now modelling the optimistic null pass
    // instead of only the tidy one.
    //
    // Returning `null` for an absent marker is the safe equivalent: a write of
    // null to a key that does not exist changes nothing, and — crucially — it
    // is a WRITE, so the callback is re-invoked with the server's value.
    if (current === null || current === undefined) return null;
    // A DIFFERENT value means the trigger wrote again after this run read it.
    // That write stands for a stock movement this run did not push, so the
    // marker must survive: returning it unchanged leaves it standing.
    if (current !== revision) return current;
    return null; // same revision, push succeeded → clear it
  });
  // What the node HOLDS decides, not `committed` — an already-absent marker is
  // a successful clear in every sense that matters to the caller's count.
  const after = res.snapshot.val();
  return after === null || after === undefined;
}

/**
 * Drain the dirty markers.
 *
 * A marker is cleared ONLY after its product has been pushed, and only when it
 * still holds the revision this run processed. A crash between the push and the
 * clear re-pushes the same numbers next tick, which is harmless — the write is
 * absolute, not a delta. Clearing first and crashing would lose the change
 * silently, which is the failure this whole module exists to prevent, so the
 * order is not an accident.
 *
 * `isLive` may be sync or async: the reconciler answers it with a per-pid read
 * of /shopify_publish (at most `max` small reads), the CLI from a set it
 * already holds.
 */
export async function sweepDirty(db, graphql, { commit = false, isLive, max = MAX_PER_RUN, cursor = null, log = () => {} } = {}) {
  const markers = (await db.ref(DIRTY_PATH).get()).val() || {};
  const allPids = Object.keys(markers).sort();
  if (!allPids.length) return { seen: 0, pushed: 0, cleared: 0, kept: 0, remaining: 0, nextCursor: null, results: [] };

  // ── THE WINDOW ROTATES, OR THE ZOMBIES EAT IT ──────────────────────────────
  // This took `Object.keys(markers).slice(0, max)`. RTDB returns children in
  // KEY ORDER, not insertion order, and a marker whose push can never succeed
  // is never cleared — by design, since a failed push must not look like a done
  // one. The live shop already has 7 such products (live+on in the app, deleted
  // from Shopify). They sort where they sort, and they would sit at the front
  // of the very same slice on every tick for ever. Once the stuck count reaches
  // `max`, every genuinely new drift is starved out of the fast path
  // completely, and nothing in the log distinguishes a healthy queue from one
  // full of zombies.
  //
  // So the slice starts AFTER the last pid the previous run looked at and wraps.
  // Stuck markers still cost their share of a tick's budget — they must, since
  // nothing else knows they are stuck — but they cost it once per rotation
  // instead of on every tick. With `max` at or above the marker count the
  // rotation is a no-op and everything is still handled in one tick.
  const start = cursor ? allPids.findIndex((p) => p > cursor) : 0;
  const from = start === -1 ? 0 : start;
  const pids = allPids.length <= max
    ? allPids
    : Array.from({ length: max }, (_, i) => allPids[(from + i) % allPids.length]);

  const locId = commit ? await requireSingleLocation(graphql) : null;
  const locNames = await locationNames(db);
  const results = [];
  let pushed = 0, cleared = 0, kept = 0;
  for (const pid of pids.slice(0, max)) {
    // The revision as it stood when this run read the node. Everything below
    // clears against THIS value or not at all.
    const revision = markers[pid];
    // ── EVERY PER-PID FAILURE COSTS ONE PID, NEVER THE BATCH ──────────────
    // The not-live clear used to sit OUTSIDE this try, which was survivable
    // only while clearMarker structurally could not throw: it returned
    // `undefined` for an absent marker, and that aborts the transaction against
    // the local cache — resolving, never rejecting, without a network call.
    //
    // The #564 fix returns `null` there instead, precisely so the write reaches
    // the server. That made this a real round trip, and therefore a call that
    // CAN reject: a non-ok PUT response, or 25 retries lost to contention, and
    // the SDK rejects the promise. One transient blip on one de-listed
    // product's marker would then throw out of this loop and cost the whole
    // tick — up to 40 products getting no inventory correction at all, instead
    // of "39 pushed, 1 kept for retry". That is the availability property this
    // module exists to protect, broken by the fix for a different bug in it.
    //
    // So the whole body is guarded, and the isLive() call is inside it too —
    // the reconciler answers that with a per-pid RTDB read, which can fail for
    // exactly the same reasons.
    try {
      // A marker for a product that is not on the storefront is not an error and
      // not work — it is cleared, because leaving it would make the node grow
      // forever with every stock movement on everything we do not sell online.
      // Still revision-guarded: "not live" was read at the top of this run too.
      if (!(await isLive(pid))) {
        if (commit && await clearMarker(db, pid, revision)) cleared++;
        continue;
      }
      const r = await syncProduct(db, graphql, pid, { commit, locationId: locId, locNames });
      results.push(r);
      if (r.changed) pushed++;
      // ── ONLY ok === true CLEARS ──────────────────────────────────────────
      // This asked `r.ok !== false`, and syncProduct has a THIRD answer: a
      // `skipped` result — "no shopify_sync id map", "no mapped inventory
      // items" — which carries no `ok` field at all. `undefined !== false` is
      // true, so those cleared the marker after doing nothing, and printed
      // nothing either. That is reachable: /shopify_publish and /shopify_sync
      // go out of step (reconcileScope.mjs documents it), so a product can read
      // live+on with no id map, and every stock movement on it would mark, skip
      // and clear in silence — the exact failure this module exists to end,
      // rebuilt inside the fix for it.
      //
      // The rule is now the narrow one: a marker is cleared when a push
      // SUCCEEDED, and in no other case. Everything else keeps its marker and
      // says why.
      if (commit && r.ok === true) {
        if (await clearMarker(db, pid, revision)) cleared++; else kept++;
      } else if (commit) {
        kept++;
        log(`  ⚠ ${pid}: ${r.why || r.skipped || "not pushed"} — marker kept for the next tick`);
      }
    } catch (e) {
      // The marker STAYS on a failure, so the next tick retries it. This is the
      // whole reason the marker is a separate node and not a timestamp compared
      // against a cursor: a failed push must not be able to look like a done one.
      results.push({ pid, ok: false, why: String(e?.message || e) });
      if (commit) kept++;
      log(`  ⚠ inventory push failed for ${pid}: ${String(e?.message || e)}`);
    }
  }
  // ── THE COUNT IS READ BACK, NOT COMPUTED ──────────────────────────────────
  // This used to be `pids.length - max`, which reports 0 remaining for a
  // single-marker dry run that cleared nothing, and 0 for a run whose only
  // product failed. Both are the same lie — "the queue is empty" — told at the
  // exact moment it is not.
  //
  // Arithmetic on the numbers this run knows about is still a lie, just a
  // smaller one: the trigger can mark a DIFFERENT product while this run is
  // pushing, and a run that cleared every marker it started with would report
  // an empty queue with that new one sitting in it. The node is the only thing
  // that knows, so the node is asked. One small read at the end of a run that
  // already did real work.
  const left = (await db.ref(DIRTY_PATH).get()).val() || {};
  return {
    // `seen` is what is ON THE NODE, not what this run's window looked at —
    // the CLI prints it as "markers seen", and a rotating window would otherwise
    // make that number shrink while the queue grew. `results.length` is the
    // count actually processed.
    seen: allPids.length, pushed, cleared, kept, results,
    remaining: Object.keys(left).length,
    // Where the next run picks up. Null when this run saw the whole node, so a
    // shrinking queue returns to a plain front-to-back sweep instead of
    // carrying a cursor nothing needs.
    nextCursor: allPids.length <= max ? null : (pids.at(-1) ?? null),
  };
}

// ─── THE BACKSTOP: A SLOW PASS OVER EVERY LIVE PRODUCT ───────────────────────
//
// WHY A MARKER-DRIVEN SWEEP IS NOT ENOUGH ON ITS OWN. Every way the marker can
// fail to be written ends in the SAME silent state — a product whose storefront
// quantity is wrong and which is announcing nothing about it. The trigger runs
// with retry:false (it sits on the busiest write path in the database and must
// never put a retry storm there), a Cloud Function can fail or be throttled,
// and a marker can be lost to a bug not yet written. That failure mode is
// exactly the one this whole module exists to end, so it cannot be left as the
// module's own residue.
//
// So the markers are the FAST path, not the only path. This walks the live
// product list a slice at a time and pushes each product's inventory whether or
// not anything marked it. It reads no marker and clears none: the two paths
// share syncProduct and nothing else, so a bug in the marker bookkeeping cannot
// disable the backstop and vice versa.
//
// COST, AND HOW LONG A FULL PASS ACTUALLY TAKES. It rides the reconciler's
// existing sweep cadence, so it re-uses a live set that tick has already read,
// and takes MAX_PER_RUN (40) products from where it stopped last time. That
// cadence is 30 minutes by day and 3 hours overnight, plus any tick that
// applied an intent. At 1,152 live products that is ~29 sweeps, so a FULL PASS
// IS ROUGHLY 14 DAYTIME HOURS — not "a few times a day", which is what this
// comment said until the arithmetic was done. Sized deliberately: this is the
// floor under a marker that never arrived, not the mechanism. The markers are
// what make a movement reach Shopify in one tick.
//
// A product with no drift costs ONE Shopify query and no mutation, so a slice
// of 40 on a healthy shop is 40 cheap reads and nothing else.
//
// THE CURSOR IS A PRODUCT ID, NOT AN OFFSET. An offset into a list whose length
// changes silently skips or repeats products when a product goes live or comes
// off. A pid says "carry on after this one" against a sorted list, so a
// disappearing product costs the pass nothing at all.

/**
 * Push a slice of the live products, starting after `cursor`.
 * Returns the pid to carry into the next run — null when the pass wrapped,
 * which is what makes a full cycle observable rather than assumed.
 */
export async function sweepBacklog(db, graphql, { livePids, cursor = null, commit = false, max = MAX_PER_RUN, log = () => {} } = {}) {
  const all = [...new Set(livePids || [])].sort();
  if (!all.length) return { checked: 0, pushed: 0, nextCursor: null, wrapped: true, results: [] };

  // "After the cursor" by VALUE. A cursor naming a product that has since gone
  // off the storefront still orders correctly against the remaining ids, so the
  // pass resumes where it meant to instead of restarting.
  const start = cursor ? all.findIndex((p) => p > cursor) : 0;
  const from = start === -1 ? all.length : start;
  const slice = all.slice(from, from + max);
  const wrapped = from + max >= all.length;

  const locId = commit ? await requireSingleLocation(graphql) : null;
  const locNames = await locationNames(db);
  const results = [];
  let pushed = 0;
  for (const pid of slice) {
    try {
      const r = await syncProduct(db, graphql, pid, { commit, locationId: locId, locNames });
      results.push(r);
      if (r.changed) pushed++;
    } catch (e) {
      // A failure costs this product its turn and nothing else. The next full
      // cycle comes back to it; there is no state to corrupt because the
      // backstop keeps none beyond the cursor.
      results.push({ pid, ok: false, why: String(e?.message || e) });
      log(`  ⚠ inventory backstop failed for ${pid}: ${String(e?.message || e)}`);
    }
  }
  return {
    checked: slice.length,
    pushed,
    // Wrapping returns null so the next pass starts from the top — including at
    // products that were added while this cycle was part-way through.
    nextCursor: wrapped ? null : (slice.at(-1) ?? cursor),
    wrapped,
    results,
  };
}

// ─── A LISTING THE APP DOES NOT KNOW ─────────────────────────────────────────
// A product that is ACTIVE and published on Shopify, but that no listed app
// product maps to, has no stock in the app by definition — so under Junid's
// rule (the app is the only source of truth for what can be sold online) its
// truth is 0 in every size. On 2026-10-11 three hand-made "Men's tracksuits
// tech fleece" listings from May and July were on the Online Store with 6
// units each and no app record at all.
//
// Same discipline as syncProduct: Shopify's numbers are read first as the
// compare-and-set baseline, tracking is switched on before the write, and the
// write is absolute. Nothing is deleted, unpublished or renamed — only the
// quantity, which the sweep's rollback file can put back.
export async function zeroUnmanagedListing(graphql, productGid, { commit = false, locationId = null } = {}) {
  const variants = await readProductVariants(graphql, productGid);
  if (!variants) return { gid: productGid, ok: false, why: "Shopify has no such product" };
  const locId = locationId || await requireSingleLocation(graphql);
  const ids = variants.map((v) => v.inventoryItemId).filter(Boolean);
  const baseline = await readAvailable(graphql, locId, ids);
  const drift = variants
    .filter((v) => baseline.has(v.inventoryItemId) && baseline.get(v.inventoryItemId) !== 0)
    .map((v) => ({ sizeKey: `unmanaged:${v.title}`, inventoryItemId: v.inventoryItemId, quantity: 0, shopify: baseline.get(v.inventoryItemId) }));
  const untracked = untrackedVariants(variants).map((v) => ({
    variantId: v.variantId, inventoryItemId: v.inventoryItemId, sizeKey: `unmanaged:${v.title}`,
    app: 0, shopify: baseline.get(v.inventoryItemId) ?? null, tracked: v.tracked ?? null, inventoryPolicy: v.inventoryPolicy ?? null,
  }));
  const shopifyUnits = [...baseline.values()].reduce((n, q) => n + Math.max(0, q || 0), 0);
  const base = { gid: productGid, ok: true, unmanaged: true, drift, untracked, shopifyUnits, appUnits: 0 };
  if (!drift.length && !untracked.length) return { ...base, changed: 0 };
  if (!commit) return { ...base, changed: 0, dryRun: true };
  if (untracked.length) await enforceTracking(graphql, productGid, untracked.map((u) => u.variantId));
  await setAvailable(graphql, locId, ids.filter((id) => baseline.has(id)).map((id) => ({ inventoryItemId: id, quantity: 0 })), baseline);
  return { ...base, trackingFixed: untracked.length, changed: drift.length + untracked.length };
}

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
  // ── AN ENTIRELY UNKNOWN ID MAP HAS TWO VERY DIFFERENT CAUSES ──────────────
  // "The id map is stale" was the whole diagnosis, and it is the less
  // interesting half. The 2026-09-05 correction run refused 7 products this
  // way; every one of them turned out to have been DELETED FROM SHOPIFY while
  // the app still recorded state:"live", liveState:"on". Those are not
  // overselling — they are the opposite: seven products the shop believes it is
  // selling online and is not, with nothing anywhere saying so.
  //
  // One extra query, asked ONLY on the path that has already failed (7 products
  // out of 1,152), turns an ambiguous message into a fact. Nothing is written:
  // what a deleted product should do to its publish node is a separate question
  // with a separate answer, and guessing it here would be a third way this file
  // could quietly disagree with the storefront.
  if (!known.length) {
    let gone = null;   // null = could not be established — NOT "present"
    try {
      const probe = await graphql(`query ($id: ID!) { product(id: $id) { id } }`, { id: map.shopifyProductId });
      gone = probe?.product == null;
    } catch { /* a probe that fails answers nothing, and must not mask the real refusal */ }
    return {
      pid, ok: false, productGone: gone,
      why: gone
        ? `DELETED FROM SHOPIFY (${map.shopifyProductId}) — the app still records this product as live and on, and it is not on the storefront at all`
        : `every mapped inventory item is unknown to Shopify — the id map is stale`,
      ...stale,
    };
  }
  if (!drift.length) return { pid, ok: true, drift: [], changed: 0, ...stale };
  if (!commit) return { pid, ok: true, drift, changed: 0, dryRun: true, ...stale };

  // Write EVERY mapped item, not just the drifted ones. inventorySetQuantities
  // is absolute, and sending the full set means one call whose result is the
  // whole truth for this product rather than a patch whose correctness depends
  // on the read above still being current.
  await setAvailable(graphql, locId, known.map(({ inventoryItemId, quantity }) => ({ inventoryItemId, quantity })));
  return { pid, ok: true, drift, changed: drift.length, ...stale };
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
export async function clearMarker(db, pid, revision) {
  const res = await db.ref(`${DIRTY_PATH}/${pid}`).transaction((current) => {
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

// ── The publish reconciler: desiredState intent → Shopify reality ────────────
// The page writes INTENT only (the browser can never hold the client secret);
// this owner-run script is the ONLY thing that talks to Shopify. It reads
// /shopify_publish, finds every product whose desiredState ("on"|"off")
// differs from its confirmed state (state/liveState), and applies the
// difference:
//
//   turning ON  — ensure the product exists on Shopify (create it as the old
//                 publish-run did when there is no /shopify_sync map, else
//                 reconcile the mapped product's fields from the current
//                 record), JOIN THE STOREFRONT COLLECTION its category maps to,
//                 then re-run the FULL compliance validator against the
//                 CANONICAL Shopify object at that moment, re-sync inventory,
//                 and publish to the Online Store sales channel. ANY failure
//                 refuses and marks the node blocked — the apply-time validator
//                 is the only thing between a mis-click and a public listing.
//   turning OFF — unpublish from the Online Store sales channel and LEAVE every
//                 managed collection. Never archive, never delete, never touch
//                 the ID map: the product, its handle and its /shopify_sync
//                 entry all survive so the switch can go back on, and turning
//                 it on re-joins the collection from the map.
//
// COLLECTIONS. The category → collection map is repo data (collectionMap.mjs);
// the collection ids come from /shopify_sync/_collections and are never guessed.
// A product whose category has no mapping is a LOUD WARNING here, not a silent
// skip and not a refusal: it goes live in no collection and stays reachable
// through the New In smart collection and its own URL. Smart collections (New
// In / Sale / Under R500) are Shopify's — nothing here writes their membership.
// A collection built by hand in the admin is never emptied by this script.
//
// Confirmed state is written back (confirmLiveState) so the page's pending
// marker clears. Idempotent: desired == confirmed is skipped, so a re-run
// after a partial failure resumes exactly where it stopped.
//
//   node scripts/shopify/reconcile.mjs                     dry run (default) — a table of what it WOULD do
//   node scripts/shopify/reconcile.mjs --commit            apply (hard cap RECONCILE_MAX_APPLY/run, shared with the page)
//   node scripts/shopify/reconcile.mjs --commit --pids a,b only these records
//
// Boundaries (owner spec 2026-08-14):
//   • RTDB writes: /shopify_publish and /shopify_sync ONLY.
//   • Shopify products with no /shopify_sync entry are LEGACY — never listed,
//     never touched. This script only ever addresses gids from the ID map it
//     wrote itself (plus products it creates and maps in the same breath).
//   • Nodes still in pre-migration states (none/nominated/draft) are skipped
//     loudly — run migrate-live-state.mjs first.
import { createRequire } from "module";
import { graphql } from "./client.mjs";
import { encodeSizeKey, stockSizeKey, assertSafeSegment } from "../../src/utils/sizeKey.js";
import { isPriceRecord } from "../../src/utils/productCategory.js";
import { sortSizes, displaySizeName, findSizeCollisions } from "./sizeOrder.mjs";
import { cleanTitleFor, isTriggerFree, triggersInText } from "../../src/utils/shopifyTriggers.js";
import {
  VENDOR, CONDITIONS, buildDescriptionHtml, buildHandle, buildSeo, buildTags,
  validatePayload,
} from "./compliance.mjs";
import { buildMediaPlan, preflightPhotoUrls, attachMedia, mediaFingerprint } from "./media.mjs";
import {
  networkTotals, requireSingleLocation, setAvailable,
  TRACKED_VARIANT, untrackedVariants, enforceTracking,
} from "./inventory.mjs";
import { buildMapping, writeIdMap, claimShopifyProduct, releaseClaim } from "./idMap.mjs";
import { adoptionVerdict, requestFreshName } from "./adopt.mjs";
import { readAllPublishNodes, confirmLiveState, markBlocked, KEEP_EXISTING_OFF_REASON } from "./publishNode.mjs";
// Scoped reading — the worklist, the live set and the /stock location keys, all
// obtained WITHOUT a whole-node read. See reconcileScope.mjs for the watermark
// contract and its three backstops.
import {
  planScan, nextRetrySet, nextWatermark, fullScanIntervalMs, isMissingIndexError,
  removeMappingIfUnchanged,
  readReconcileState, writeReconcileState,
  readChangedPublishNodes, readLivePids, makeStockLocationResolver,
} from "./reconcileScope.mjs";
// Storefront collections. The map is repo data (collectionMap.mjs); the gids
// are read from /shopify_sync/_collections and NEVER guessed — a product joins
// a collection that already exists or joins none. Nothing here creates a
// collection mid-publish; that is ensure-collections.mjs's job.
import {
  collectionGidsByKey, manualGidsFrom, planCollectionMembership,
  readProductCollections, applyCollectionMembership, requireOnlineStorePublication,
} from "./collections.mjs";
import { resolveCollection, COLLECTION_BY_KEY } from "./collectionMap.mjs";
// The storefront search index. Kept in step at the moment the reconciler
// CONFIRMS a state, so it tracks the storefront within one tick rather than
// waiting for a rebuild. Best-effort by design — see searchIndexWrite.mjs.
import { indexProductLive, unindexProduct, sweepSearchIndex } from "./searchIndexWrite.mjs";
import { SEARCH_IDENTITY_PATH } from "../../src/utils/searchIdentity.js";
// The per-run cap is SHARED with the page's batch-selection cap — one place,
// so the UI can never promise a batch this script won't take in one run.
// Sizing rationale (measured against the live shop's rate limiter) lives on
// the constant.
import { RECONCILE_MAX_APPLY as MAX_APPLY, normalizePhotoList } from "../../src/components/shopify/publishShared.js";
const UPDATED_BY = "script:reconcile";
const flags = process.argv.slice(2);
const COMMIT = flags.includes("--commit");
const pidIdx = flags.indexOf("--pids");
const pidArg = pidIdx !== -1 ? flags[pidIdx + 1] : null;
if (pidIdx !== -1 && (!pidArg || pidArg.startsWith("--"))) {
  console.error("--pids needs a comma-separated productId list");
  process.exit(2);
}
const ONLY = pidArg ? new Set(pidArg.split(",")) : null;
// Force a whole-node scan on a commit tick. The scheduler never passes it; it
// exists so a person can prove, in one command, that the incremental path is
// not hiding work from them — and so the before/after byte figures in the PR
// could be measured against the SAME code.
const FULL = flags.includes("--full");

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

// Confirmed = what the reconciler last verified against Shopify. A node that
// never reached state "live" is confirmed off — nothing is on the storefront.
const confirmedOn = (node) => node?.state === "live" && node?.liveState === "on";

// ── What this run cost, in bytes ─────────────────────────────────────────────
// Approximate (serialized JSON length, not wire bytes: RTDB REST does not gzip
// and the SDK framing is small, so it is within a few percent) and reported on
// every commit run. A loop that was 45–79% of the whole database's traffic gets
// to say out loud what it spends.
let rtdbBytes = 0;
const meter = (label, val) => {
  const n = val == null ? 4 : JSON.stringify(val).length;
  rtdbBytes += n;
  if (n >= 100_000) console.log(`  rtdb: ${label} — ${n.toLocaleString()} B`);
};

// Location keys for the inventory read, memoised for the life of the process.
const stockLocationKeys = makeStockLocationResolver(admin.app(), { meter });

// ── Worklist: every node whose intent differs from its confirmed state ───────
// A DRY RUN always reads everything: it is a person asking "what is outstanding
// across the whole shop?", and answering that from a five-minute window would
// be a lie. Only the scheduled commit tick reads incrementally.
const runStartedAt = Date.now();
const scanState = COMMIT ? await readReconcileState(db, { meter }) : null;
const scan = COMMIT && !ONLY
  ? planScan({ state: scanState, nowMs: runStartedAt, force: FULL })
  : { mode: "full", since: null, why: ONLY ? "--pids" : "dry run" };
const retryPids = Object.keys(scanState?.retry || {});
const readWholeNode = async () => {
  const v = await readAllPublishNodes(db);
  meter("shopify_publish (whole node)", v);
  return v;
};
let scanMode = scan.mode;
let scanWhy = scan.why;
let all;
// Retry pids whose individual read failed this tick. They were NOT evaluated,
// so they must not be counted as attempted below — otherwise a transient blip
// would quietly drop a product from the retry set and it would never be tried
// again.
const unreadable = new Set();
if (scanMode === "incremental") {
  try {
    all = await readChangedPublishNodes(db, {
      since: scan.since, retryPids, meter,
      onUnreadable: (pid, e) => {
        unreadable.add(pid);
        console.error(`  ⚠ could not read retry pid ${pid} (${String(e?.message || e)}) — kept for the next tick`);
      },
    });
  } catch (e) {
    // The index is not optional to RTDB: an unindexed orderByChild is REFUSED,
    // not silently sorted. Falling back to the whole-node read keeps this tick
    // correct at exactly the price it used to pay — and says so, every tick,
    // until somebody pastes the index.
    if (!isMissingIndexError(e, "updatedAt")) throw e;
    console.error('  ⚠ /shopify_publish has no ".indexOn": "updatedAt" — this tick fell back to reading the WHOLE node ' +
      "(~2 MB, the old cost). Paste the index from docs/SHOPIFY-SYNC.md §9.1 to make it cheap; nothing else needs changing.");
    scanMode = "full";
    scanWhy = "no updatedAt index — fell back";
    all = await readWholeNode();
  }
} else {
  all = await readWholeNode();
}
if (COMMIT) {
  console.log(`scan: ${scanMode} (${scanWhy})` +
    (scanMode === "incremental" ? ` · ${Object.keys(all).length} node(s) in window, ${retryPids.length} retry` : ""));
}
const worklist = [];
const skippedLegacy = [];
for (const [pid, node] of Object.entries(all)) {
  if (ONLY && !ONLY.has(pid)) continue;
  if (["none", "nominated", "draft"].includes(node?.state)) {
    skippedLegacy.push({ pid, state: node.state });
    continue;
  }
  const want = node?.desiredState;
  if (want !== "on" && want !== "off") continue; // no intent expressed
  if ((want === "on") === confirmedOn(node)) continue; // already there
  worklist.push({ pid, node, want });
}
for (const s of skippedLegacy) {
  console.error(`  ⚠ ${s.pid}: pre-migration state "${s.state}" — run migrate-live-state.mjs first, skipped`);
}
console.log(`nodes with unapplied intent: ${worklist.length}`);
// A DRY RUN with nothing to do is genuinely nothing to do. A COMMIT run is not:
// the search-index sweep at the end of this file is what repairs a stale index,
// and an idle shop is exactly when drift accumulates unnoticed. Exiting here on
// a commit tick is how the index got 173 products behind in the first place.
if (!worklist.length && !COMMIT) { console.log("nothing to do."); process.exit(0); }

// ── Dry run: the table of what WOULD happen, from RTDB alone ─────────────────
// (No Shopify credentials touched: the action column needs only the ID map.)
if (!COMMIT) {
  // The recorded collection ids, so the table can distinguish "maps to X" from
  // "maps to X, which does not exist on the shop yet".
  const dryRunGids = await collectionGidsByKey(db);
  console.log("\npid              action            collection        title / note");
  for (const { pid, node, want } of worklist) {
    assertSafeSegment(pid, "productId");
    const mapNode = (await db.ref(`shopify_sync/${pid}`).get()).val();
    // The dry run is a PREVIEW, so it must say REFUSE where the commit run
    // would refuse. Showing "CREATE+PUBLISH" for a product the ON path rejects
    // outright would preview the opposite of what happens.
    const dryProduct = want === "on" ? (await db.ref(`products/${pid}`).get()).val() : null;
    let action;
    if (want === "off") action = "UNPUBLISH";
    else if (isPriceRecord(dryProduct)) action = "REFUSE (not merchandise)";
    else action = mapNode?.shopifyProductId ? "PUBLISH" : "CREATE+PUBLISH";
    const title = node.cleanName || "(lexicon at apply time)";
    // The collection is resolvable from RTDB alone, so the dry run shows it —
    // including the "none" answers, which are the ones worth seeing BEFORE a
    // publish rather than in the run log after it.
    // An UNPUBLISH also fires collection LEAVES on the commit run — the dry run
    // is meant to be a complete preview, so it says so instead of showing "—".
    let collection = want === "off" ? "leaves collections" : "—";
    if (want === "on") {
      const r = resolveCollection(dryProduct);
      // "mapped but no recorded id" is a NO-COLLECTION outcome too — the map
      // names a collection that has never been created. Showing its title here
      // would promise a home the publish cannot deliver, which is exactly the
      // answer the dry run exists to surface.
      if (r.status !== "mapped") collection = `⚠ ${r.status}`;
      else if (!dryRunGids[r.collectionKey]) collection = "⚠ no id yet";
      else collection = COLLECTION_BY_KEY.get(r.collectionKey).title;
    }
    console.log(`${pid.padEnd(16)} ${action.padEnd(17)} ${collection.padEnd(17)} "${title}"`);
  }
  console.log(`\ndry run — nothing written, Shopify untouched. Re-run with --commit to apply (cap ${MAX_APPLY}/run).`);
  process.exit(0);
}

// Does Shopify agree this product is gone? Asked ONLY to decide whether a
// userErrors refusal is a permanent "it was deleted" or a transient failure to
// be retried. A query that itself fails answers "not gone" — the safe answer,
// because it leaves the intent standing.
async function productIsAbsent(gid) {
  try {
    const q = await graphql(`query ($id: ID!) { product(id: $id) { id } }`, { id: gid });
    return q?.product == null;
  } catch {
    return false;
  }
}

// ── Commit path ──────────────────────────────────────────────────────────────
if (!worklist.length) console.log("no intents to apply — running the search-index sweep only.");
let capped = worklist;
if (worklist.length > MAX_APPLY) {
  console.error(`⚠ ${worklist.length} intents — applying the first ${MAX_APPLY} only (hard cap; re-run for the rest)`);
  capped = worklist.slice(0, MAX_APPLY);
}

// The Online Store publication id — resolved once. Every publish/unpublish in
// this script addresses ONLY this sales channel.
// Matched on the stable `online_store` CHANNEL HANDLE (collections.mjs owns the
// one lookup): the catalog title is auto-generated and localisable, so a title
// match could silently resolve nothing and publish to no channel.
//
// STRICT, like the sweep. I first reasoned that a wrong publication here would
// "just fail to publish" — it would not. This script publishes to that id and
// then writes confirmLiveState "on", so a wrong guess records a product as LIVE
// while it sits on no channel, and the intent is consumed so the worklist never
// revisits it. Refusing to guess is much cheaper than a durable false "live".
// ONLY when there is something to apply. This tick may exist purely to run the
// search-index sweep, and the sweep touches neither the publication nor the
// collection map. Resolving them anyway would spend a Shopify API call and an
// RTDB read on every idle tick — 720 a day on the mini's two-minute schedule —
// for values nothing reads. (Review finding, 2026-08-17.)
let online;
let collectionGids = {};
let managedGids = [];
if (worklist.length) {
  try {
    online = { id: await requireOnlineStorePublication(graphql, { strict: true }) };
  } catch (e) {
    console.error(String(e?.message || e));
    process.exit(1);
  }

  // The collection gids, read ONCE. An empty map is not fatal: publishing must
  // still work on a shop where ensure-collections.mjs has never run — the
  // products just land in no collection, and the warning below says so on every
  // single product rather than once, because a storefront with no navigation is
  // exactly the failure this work exists to fix.
  collectionGids = await collectionGidsByKey(db);
  managedGids = manualGidsFrom(collectionGids);
  if (!managedGids.length) {
    console.error("  ⚠ no storefront collections recorded at /shopify_sync/_collections — run `node scripts/shopify/ensure-collections.mjs --commit` first, or every product published here lands in no collection");
  }
}

// ── ONE search-index document builder, shared by the hook and the sweep ──────
// Both must write byte-identical documents: two builders would drift, and a
// drifted index is one where a product's searchability depends on which code
// path last touched it. Returns null when the product cannot be indexed (no
// mapping, gone from the shop) — the caller counts that, it is not a throw.
const buildSearchDocFor = async (pid) => {
  const map = (await db.ref(`shopify_sync/${pid}`).get()).val();
  const gid = map?.shopifyProductId;
  if (!gid) return null;
  const rec = (await db.ref(`products/${pid}`).get()).val();
  if (!rec) return null;
  // NOT MERCHANDISE. Structurally unreachable — the ON path refuses a price
  // record long before it could be confirmed live — but the SWEEP builds from
  // whatever /shopify_publish claims is live, and a node written before that
  // refusal shipped (or by hand in the console) would walk straight past it.
  // An index is a second publication; it gets the same gate.
  if (isPriceRecord(rec)) return null;
  const idx = await graphql(
    `query ($id: ID!) {
      product(id: $id) {
        id handle title
        featuredMedia { preview { image { url(transform: { maxWidth: 600, maxHeight: 800 }) } } }
        priceRangeV2 { minVariantPrice { amount currencyCode } }
        variants(first: 100) { nodes { title availableForSale } }
      }
    }`,
    { id: gid }
  );
  if (!idx.product) return null;
  const r = resolveCollection(rec);
  return {
    product: rec,
    shopifyProduct: idx.product,
    collection: r.status === "mapped" ? COLLECTION_BY_KEY.get(r.collectionKey)?.handle ?? null : null,
    // The identity is read from its OWN node, never from rec.name — that is the
    // whole reason the node exists (src/utils/searchIdentity.js).
    identity: (await db.ref(`${SEARCH_IDENTITY_PATH}/${pid}`).get()).val(),
  };
};

const results = [];
// Best-effort channel unpublish for fail-safe paths: a refusal or cancel on a
// product that has somehow drifted to publicly-visible must take it down
// BEFORE the intent is consumed. Idempotent — unpublishing an unpublished
// product is a no-op. userErrors are the normal Shopify failure channel, so
// they warn just like a thrown error would.
// RETURNS WHETHER IT ACTUALLY WORKED. It used to swallow both exceptions and
// userErrors and tell the caller nothing — which was survivable while nothing
// depended on the answer, and stopped being survivable the moment markBlocked
// started recording `liveState: "off"` on the strength of it. A throttled or
// denied unpublish would then have the app stating, durably, that a product
// nobody can take down is off the shop. False is the honest answer, and the
// caller leaves the field alone.
const failSafeUnpublish = async (gid) => {
  if (!gid) return false;
  try {
    const res = await graphql(
      `mutation ($id: ID!, $input: [PublicationInput!]!) {
        publishableUnpublish(id: $id, input: $input) { userErrors { field message } }
      }`,
      { id: gid, input: [{ publicationId: online.id }] },
      { mutation: true }
    );
    const errs = res.publishableUnpublish.userErrors;
    if (errs?.length) {
      console.error(`  ⚠ fail-safe unpublish userErrors: ${JSON.stringify(errs)} — check ${gid} in admin`);
      return false;
    }
    console.log("  fail-safe: unpublished from the Online Store channel");
    return true;
  } catch (e) {
    console.error(`  ⚠ fail-safe unpublish failed (${String(e?.message || e)}) — check ${gid} in admin`);
    return false;
  }
};
// `tookDown` — this refusal ran failSafeUnpublish first, so it has PROVED the
// product is off the sales channel and markBlocked can record liveState "off".
// A refusal that never published leaves the field alone: it has learned nothing
// new about the channel and guessing would be a second lie beside the first.
// The exact owner of a handle, or null. Direct lookup by identifier — exact by
// construction and NOT behind the search index, so an orphan from a run that
// crashed seconds ago still shows. The search fallback is weaker (index lag)
// and is still filtered to the exact handle.
const probeHandleOwner = async (handle) => {
  try {
    const byId = await graphql(
      `query ($h: String!) { productByIdentifier(identifier: { handle: $h }) { id title handle } }`,
      { h: handle }
    );
    return byId.productByIdentifier || null;
  } catch {
    console.error("  ⚠ productByIdentifier unavailable — falling back to search-index handle probe");
    const hit = await graphql(
      `query ($q: String!) { products(first: 25, query: $q) { nodes { id title handle } } }`,
      { q: `handle:'${handle}'` }
    );
    return hit.products.nodes.find((n) => n.handle === handle) || null;
  }
};

const refuse = async (pid, why, { tookDown = false, blockedHandle = null } = {}) => {
  console.error(`  🛑 ${pid} REFUSED: ${why}`);
  await markBlocked(db, pid, why, UPDATED_BY, { wasTakenDown: tookDown, blockedHandle });
  // A refusal is a take-down: every refusal path either never published or
  // called failSafeUnpublish first. Whatever the reason, this product is not on
  // the storefront, so it must not be answering searches with a link to it.
  // No-ops when it was never indexed, which is the common case.
  await unindexProduct(db, pid, "blocked");
  results.push({ pid, ok: false, why: `blocked: ${why}` });
};

// Which storefront collection this record belongs in — and it SAYS SO, loudly,
// when the answer is "none". A category with no mapping is a warning in the run
// log, never a silent skip and never a refusal: the product still goes live and
// is still reachable through the New In smart collection and its own URL. It
// just has no heading in the navigation until collectionMap.mjs gains a row.
const desiredCollectionFor = (pid, product) => {
  const r = resolveCollection(product);
  if (r.status !== "mapped") {
    console.error(`  ⚠⚠ ${pid}: ${r.status.toUpperCase()} CATEGORY — ${r.reason}`);
    console.error(`     going live in NO collection; reachable via New In and its direct URL only`);
    return null;
  }
  const gid = collectionGids[r.collectionKey] ?? null;
  if (!gid) {
    console.error(`  ⚠⚠ ${pid}: category "${r.key}" maps to collection "${r.collectionKey}", but no id is recorded at /shopify_sync/_collections — run ensure-collections.mjs --commit; going live in NO collection`);
    return null;
  }
  console.log(`  collection: "${COLLECTION_BY_KEY.get(r.collectionKey).title}" (from ${r.key})`);
  return gid;
};

for (const { pid, want } of capped) {
  assertSafeSegment(pid, "productId");
  console.log(`\n▶ ${pid} → ${want.toUpperCase()}`);
  // CONTAINMENT STATE FOR THE OUTER CATCH. `gid` is scoped inside the try, so
  // a throw AFTER publishablePublish succeeded — a network timeout on the
  // status update, an RTDB blip on the confirm — used to leave a product
  // publicly ACTIVE with nothing but a line in the report (Codex review,
  // 2026-08-28). These two carry the facts the catch needs.
  let publicGid = null;   // set only once the product is actually on the channel
  try {
    // Re-read at the last moment — the page may have flipped the switch back
    // (or a publish may have been cancelled) since the worklist was read.
    const fresh = (await db.ref(`shopify_publish/${pid}`).get()).val();
    if (fresh?.desiredState !== want || (want === "on") === confirmedOn(fresh)) {
      results.push({ pid, ok: true, note: "intent changed since the run started — skipped" });
      continue;
    }
    const mapNode = (await db.ref(`shopify_sync/${pid}`).get()).val();

    if (want === "off") {
      // Channel unpublish ONLY. Status, handle, media, ID map all survive.
      if (!mapNode?.shopifyProductId) {
        // Nothing of ours exists on Shopify — "off" is already the truth,
        // and any admin link from an earlier life points at nothing.
        console.log("  no /shopify_sync mapping — nothing on Shopify to unpublish");
        await confirmLiveState(db, pid, "off", UPDATED_BY, {
          clearAdminUrl: true,
          offReason: "no_shopify_product",
          offDetail: "confirmed off because there is no Shopify product mapped to this record",
        });
        await unindexProduct(db, pid, "off");
        results.push({ pid, ok: true, note: "confirmed off (no Shopify product)" });
        continue;
      }
      const res = await graphql(
        `mutation ($id: ID!, $input: [PublicationInput!]!) {
          publishableUnpublish(id: $id, input: $input) { userErrors { field message } }
        }`,
        { id: mapNode.shopifyProductId, input: [{ publicationId: online.id }] },
        { mutation: true }
      );
      const errs = res.publishableUnpublish.userErrors;
      if (errs?.length) {
        // ── THE PRODUCT MAY SIMPLY BE GONE ──────────────────────────────────
        // "Resource does not exist" against the product id means the listing
        // was deleted in the Shopify admin. Retrying that forever is what the
        // old code did: five records refused this way on 30 Aug 2026 and were
        // still being retried 1,367 ticks later — every two minutes, day and
        // night, five futile GraphQL mutations a tick, and every tick counted
        // as a working tick so nothing downstream could ever back off.
        //
        // "Off" is already the truth for a product that does not exist, so
        // confirm it — but only after ASKING SHOPIFY, never by pattern-matching
        // the error text alone. If the product really is absent the stale ID
        // map is removed too (with its claim), because a map pointing at a
        // deleted product makes the record impossible to publish again.
        const gone = await productIsAbsent(mapNode.shopifyProductId);
        if (!gone) {
          results.push({ pid, ok: false, why: `publishableUnpublish userErrors: ${JSON.stringify(errs)}` });
          continue;
        }
        console.log(`  ${mapNode.shopifyProductId} no longer exists on Shopify — clearing the stale ID map and confirming off`);
        // MAPPING FIRST, CLAIM SECOND, and the order is load-bearing.
        //
        // The claim index exists to guarantee one Shopify product is mapped by
        // at most one record. Freeing the claim before removing the mapping
        // opens a window — a `changed` verdict, a thrown error, a kill -9
        // between the two lines — in which the record still names the gid while
        // nothing protects it, so a second record can claim and map the same
        // product. That is the one invariant the index provides, given away for
        // nothing. The other order leaks at worst a claim with no mapping,
        // which blocks a gid that no longer exists and says so in the log.
        //
        // RE-READ BEFORE DELETING. `mapNode` was read earlier in this tick and
        // the Shopify round trip above takes time, so what is proved absent is
        // the product this record mapped THEN. If the record has since been
        // re-adopted onto a live product — round-trip.mjs and adopt.mjs both do
        // that by hand, outside this loop's single-flight lock — removing the
        // node here would delete a good, fresh mapping on the strength of a
        // deletion check performed against a different product.
        // ONE operation, whose verdict comes from the committed snapshot —
        // never from `committed` alone and never from a flag set inside a
        // callback RTDB may invoke more than once. See removeMappingIfUnchanged.
        const outcome = await removeMappingIfUnchanged(db, pid, mapNode.shopifyProductId);
        if (outcome !== "removed") {
          // Say which of the two it was. "contended" means the SERVER STILL
          // AGREES the record maps this gid and the write simply did not land —
          // reporting that as "it was re-mapped" would send someone looking for
          // a re-adoption that never happened.
          const why = outcome === "changed"
            ? `no longer maps ${mapNode.shopifyProductId} — it was re-mapped or cleared while Shopify was being asked about it; nothing removed`
            : `still maps ${mapNode.shopifyProductId} but the removal did not commit — nothing removed, retrying next tick`;
          console.log(`  ${pid} ${why}`);
          results.push({ pid, ok: false, why: `${why} (will re-evaluate next tick)` });
          continue;
        }
        // Only now is the gid unreferenced, so the claim can go. Releases only
        // if the index still names THIS record; a drifted entry naming someone
        // else is left alone rather than freed under them. A release that does
        // not land leaves a claim on a gid whose Shopify product is deleted —
        // harmless to the storefront, but it would block a future re-use of
        // that gid, so it is named in the log rather than swallowed.
        let released = "contended";
        try {
          released = await releaseClaim(db, pid, mapNode.shopifyProductId);
        } catch (e) {
          console.error(`  ⚠ could not release the claim on ${mapNode.shopifyProductId} for ${pid} (${String(e?.message || e)}) — clear it by hand if that gid is ever re-used`);
        }
        if (released === "contended") {
          console.error(`  ⚠ the claim on ${mapNode.shopifyProductId} for ${pid} did not release — clear it by hand if that gid is ever re-used`);
        }
        await confirmLiveState(db, pid, "off", UPDATED_BY, {
          clearAdminUrl: true,
          offReason: "no_shopify_product",
          offDetail: "the Shopify product this record mapped to no longer exists — confirmed off and the stale mapping removed",
        });
        await unindexProduct(db, pid, "off");
        results.push({ pid, ok: true, note: "confirmed off (the mapped Shopify product had been deleted)" });
        continue;
      }
      // Off the shelf means out of the aisles: the product LEAVES every managed
      // collection. It is not archived, not deleted, and its ID map survives —
      // switching it back on re-joins it from the map. A collection built by
      // hand in the admin is not ours and is left alone (planCollectionMembership).
      let leftNote = "";
      try {
        const { collections } = await readProductCollections(graphql, mapNode.shopifyProductId, online.id);
        const plan = planCollectionMembership(collections, null, managedGids);
        if (plan.leave.length) {
          await applyCollectionMembership(graphql, mapNode.shopifyProductId, plan);
          leftNote = `, left ${plan.leave.length} collection(s)`;
        }
      } catch (e) {
        // The unpublish already succeeded, so the product is invisible to
        // customers — a collection-membership failure must not turn a
        // successful take-down into a refusal. Warn and confirm off; the next
        // run re-plans from Shopify's current state.
        console.error(`  ⚠ ${pid}: unpublished, but leaving its collections failed (${String(e?.message || e)}) — re-run to clear the membership`);
        leftNote = ", collection membership NOT cleared (see the warning above)";
      }
      // The reason the PAGE recorded when the switch was flipped is already on
      // the node (lastOff, written by setDesiredState). This confirm must not
      // overwrite it with a duller one — an "off_to_rename" that becomes
      // "switched off" here is exactly the information loss this audit exists
      // to stop. So the page's record wins; only an intent with no record
      // (a script, a console edit) gets the generic one.
      await confirmLiveState(db, pid, "off", UPDATED_BY, {
        gid: mapNode.shopifyProductId,
        // KEEP the page's own record only while it is NEWER than the last time
        // this product went live. An August "off_to_rename" on a product that
        // has been republished since describes a DIFFERENT off; keeping it here
        // would date this week's take-down to August and hide whichever path
        // actually authored the intent (spec review, 2026-08-28).
        ...(fresh?.lastOff && Number(fresh.lastOff.at) >= (Number(fresh.liveAt) || 0)
          ? { offReason: KEEP_EXISTING_OFF_REASON }
          : { offReason: "switched_off",
              offDetail: "an off intent was applied — unpublished from the Online Store channel" }),
      });
      // Off the storefront means out of search. A result that leads to an
      // unpublished product is worse than no result, so the document is
      // REMOVED rather than flagged.
      await unindexProduct(db, pid, "off");
      results.push({ pid, ok: true, note: `unpublished from the Online Store channel${leftNote}` });
      continue;
    }

    // ── Turning ON ───────────────────────────────────────────────────────────
    const product = (await db.ref(`products/${pid}`).get()).val();
    if (!product) { await refuse(pid, "no /products record"); continue; }
    if (product.mergedInto) { await refuse(pid, `record merged into ${product.mergedInto} — publish the survivor`); continue; }
    // NOT MERCHANDISE. This is the enforcement point, not the UI: the page's
    // filter stops a price record being nominated, but an intent written
    // before that filter shipped — or by a script, or by hand in the console —
    // would otherwise sail straight through to the storefront. Deliberately
    // ahead of every other check so a price record can never reach a Shopify
    // call, and refuse() (not a silent skip) so it lands visibly in the run log
    // and on the node as blockedReason.
    //
    // NOTE THE POSITION: this sits inside the "turning ON" half, AFTER the
    // `want === "off"` branch has already `continue`d. That is on purpose and
    // is the recovery path — a price record somehow already live must still be
    // TAKE-DOWN-ABLE. Setting its intent to "off" runs the normal unpublish and
    // collection teardown; only going ON is refused. Refusing both would strand
    // a live one with no way down, which is the opposite of a safe gate.
    if (isPriceRecord(product)) {
      await refuse(pid, "internal price-carrier record, not merchandise — never publishable");
      continue;
    }
    if (!CONDITIONS.includes(fresh.condition)) { await refuse(pid, "condition unset — a product cannot go live without one"); continue; }

    // Title: the reviewed cleanName wins while still trigger-free; else lexicon.
    let title;
    if (fresh.cleanName && isTriggerFree(fresh.cleanName)) {
      title = String(fresh.cleanName).trim();
    } else if (fresh.cleanName) {
      await refuse(pid, `cleanName trips the lexicon now (${triggersInText(fresh.cleanName).join(", ")}) — re-name it`);
      continue;
    } else {
      const named = cleanTitleFor(product);
      if (named.needsAI) { await refuse(pid, `no cleanName and lexicon can't clean (${named.reason})`); continue; }
      title = named.title;
    }

    const problems = [];
    if (!(Number(product.retailPrice) > 0)) problems.push("no retailPrice > 0");
    const sizes = Array.isArray(product.sizes) && product.sizes.length ? sortSizes(product.sizes) : null;
    if (!sizes) problems.push("no sizes array");
    if (sizes) problems.push(...findSizeCollisions(sizes));
    // The ID map keys variants by encodeSizeKey; inventory totals key by
    // stockSizeKey. For every token the catalogue actually uses they agree —
    // but a literal "Free Size" (folds to "_" in stock, not in the map) would
    // silently inventory the variant at 0. Refuse the mismatch outright.
    for (const sTok of sizes || []) {
      if (encodeSizeKey(sTok) !== stockSizeKey(sTok)) {
        problems.push(`size token ${JSON.stringify(sTok)} keys differently in stock ("${stockSizeKey(sTok)}") and the ID map ("${encodeSizeKey(sTok)}") — normalise the record first`);
      }
    }
    if (problems.length) { await refuse(pid, problems.join("; ")); continue; }

    // The reviewed publishing photo set (ordered, first = primary) wins over
    // the record's photoUrl/gallery; buildMediaPlan re-applies the HTTPS +
    // Storage-host guards to it, and preflight still 404-fails loudly.
    let mediaPlan;
    try { mediaPlan = buildMediaPlan(product, title, normalizePhotoList(fresh.photos)); }
    catch (e) { await refuse(pid, String(e?.message || e)); continue; }

    const payload = {
      title,
      handle: buildHandle(title),
      vendor: VENDOR,
      productType: product.subcategory || product.category || "",
      tags: buildTags(product),
      descriptionHtml: buildDescriptionHtml(fresh.condition),
      seo: buildSeo(title, fresh.condition),
      media: mediaPlan,
      variants: product.sku ? sizes.map((s) => ({ sku: `${product.sku}-${encodeSizeKey(s)}` })) : [],
    };
    const preVerdict = validatePayload(payload);
    if (!preVerdict.ok) {
      await refuse(pid, preVerdict.violations.map((v) => `${v.field}: ${v.problem}`).join("; "));
      continue;
    }

    let gid = mapNode?.shopifyProductId ?? null;
    // ── SOMETHING ON SHOPIFY ALREADY OWNS THE HANDLE WE WANT ─────────────────
    // Handles are unique per shop and buildHandle is deterministic, so this is
    // the strong duplicate probe: a crashed earlier run (productSet applied,
    // claim never written), a legacy product, a twin. It runs BEFORE the create
    // so an adoption can fall through into the reconcile-in-place path below —
    // an adopted product is a mapped product, and mapped products are exactly
    // what that path is for.
    //
    // Until now this ALWAYS refused, and told the operator to run a script by
    // name. Refusing an orphan from our own crashed run is not caution, it is
    // a dead end: nothing else will ever clean it up, and the block outlives
    // the name that caused it. adoptionVerdict decides, and it fails CLOSED —
    // see adopt.mjs for what it will not touch and why.
    let adoptedNow = false;
    if (!gid) {
      const handleHit = await probeHandleOwner(payload.handle);
      if (handleHit) {
        const verdict = await adoptionVerdict(graphql, handleHit.id, online.id);
        if (verdict.ok) {
          try {
            // The atomic half: claimShopifyProduct scans /shopify_sync inside a
            // transaction and REFUSES if any other record already maps this
            // gid. That is the guarantee that matters — an adoption that
            // overwrote a real listing belonging to another product would be
            // the worst outcome this whole path can produce — and it is made
            // against the server's value, not the read above.
            await claimShopifyProduct(db, pid, handleHit.id);
            gid = handleHit.id;
            adoptedNow = true;
            console.log(`  adopted the orphan holding "${payload.handle}": ${handleHit.id} (${verdict.why})`);
          } catch (e) {
            await requestFreshName(db, pid, `the storefront address this name produces is taken by another listing`);
            await refuse(pid, `the web address this name would use ("${payload.handle}") is already taken by another listing on the shop ("${handleHit.title}"). A new name has been asked for automatically; it will appear under Suggested names when it is ready.`, { blockedHandle: payload.handle });
            continue;
          }
        } else {
          // Not ours to take. Say WHOSE it is — the operator's next question is
          // always "taken by what?" — and get a new name moving without anybody
          // having to ask for one.
          await requestFreshName(db, pid, verdict.why);
          await refuse(pid, `the web address this name would use ("${payload.handle}") already belongs to another listing on the shop: "${handleHit.title}" — ${verdict.why}. A new name has been asked for automatically; it will appear under Suggested names when it is ready.`, { blockedHandle: payload.handle });
          continue;
        }
      }
    }
    const createdNow = !gid;
    if (gid) {
      // RECONCILE the mapped product's pushed fields from the CURRENT record —
      // a rename or condition change made while the product sat OFF must land
      // before it becomes visible again.
      console.log(adoptedNow
        ? `  adopted ${gid} — updating it in place from the current record`
        : `  /shopify_sync maps to ${gid} — reconciling fields`);
      const upd = await graphql(
        `mutation ($input: ProductUpdateInput!) {
          productUpdate(product: $input) { product { id } userErrors { field message } }
        }`,
        { input: { id: gid, title: payload.title, handle: payload.handle, vendor: payload.vendor,
                   productType: payload.productType, tags: payload.tags,
                   descriptionHtml: payload.descriptionHtml, seo: payload.seo } },
        { mutation: true }
      );
      const uErrs = upd.productUpdate.userErrors;
      if (uErrs?.length) {
        // A MAPPED product can be publicly visible through drift — republished
        // by hand in the admin, or left up by a run that crashed between
        // publishablePublish and its confirm. Refusing consumes the intent, so
        // leaving it up strands non-compliant content on the storefront with
        // nothing left to take it down. Every sibling refusal already does
        // this; these were missed (architect + Codex review, 2026-08-28).
        const down = await failSafeUnpublish(gid);
        await refuse(pid, `reconcile productUpdate userErrors: ${JSON.stringify(uErrs)}`, { tookDown: down });
        continue;
      }
    } else {
      // CREATE — the old publish-run's draft pipeline, inline: photos answer
      // first, exact-title duplicate guard (a legacy or twin product must be
      // adopted deliberately, never claimed by accident), DRAFT create, atomic
      // gid claim, read-back → ID map, media attach.
      await preflightPhotoUrls(mediaPlan.map((m) => m.originalSource));
      // The handle probe already ran above (it can ADOPT, so it has to run
      // before the create branch is chosen). What is left here is the weaker
      // title guard.
      const dupe = await graphql(
        `query ($q: String!) { products(first: 25, query: $q) { nodes { id title } } }`,
        { q: `title:'${payload.title.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'` }
      );
      if (dupe.products.nodes.some((n) => n.title === payload.title)) {
        // NO SCRIPT NAME IN A MESSAGE A PERSON READS. The remedy is a new
        // name, and one is already on its way.
        await requestFreshName(db, pid, "another listing on the shop already carries this exact title");
        await refuse(pid, "another listing on the shop already carries this exact title. A new name has been asked for automatically; it will appear under Suggested names when it is ready.");
        continue;
      }
      const price = Number(product.retailPrice).toFixed(2);
      const created = await graphql(
        `mutation ($input: ProductSetInput!) {
          productSet(synchronous: true, input: $input) {
            product { id }
            userErrors { field message }
          }
        }`,
        {
          input: {
            title: payload.title,
            handle: payload.handle,
            vendor: payload.vendor,
            productType: payload.productType,
            tags: payload.tags,
            descriptionHtml: payload.descriptionHtml,
            seo: payload.seo,
            status: "DRAFT", // visible only after the canonical validation below passes
            productOptions: [{ name: "Size", position: 1, values: sizes.map((s) => ({ name: displaySizeName(s) })) }],
            variants: sizes.map((s) => ({
              optionValues: [{ optionName: "Size", name: displaySizeName(s) }],
              price,
              // Tracked + DENY at birth. Without this, productSet leaves
              // `tracked` at its FALSE default and Shopify ignores every
              // quantity setAvailable later writes — the storefront then shows
              // every size as available for ever. See inventory.mjs.
              ...TRACKED_VARIANT,
              ...(product.sku ? { sku: `${product.sku}-${encodeSizeKey(s)}` } : {}),
            })),
          },
        },
        { mutation: true }
      );
      const errs = created.productSet.userErrors;
      if (errs?.length) { await refuse(pid, `productSet userErrors: ${JSON.stringify(errs)}`); continue; }
      gid = created.productSet.product?.id;
      if (!gid) { await refuse(pid, "productSet returned no id"); continue; }
      console.log(`  created ${gid}`);
      await claimShopifyProduct(db, pid, gid); // durable pointer before anything else can fail
    }

    // Read back → verified ID map (merge semantics) + media idempotency.
    const back = await graphql(
      `query ($id: ID!) {
        product(id: $id) {
          id
          media(first: 50) { pageInfo { hasNextPage } nodes { id } }
          variants(first: 100) { pageInfo { hasNextPage } nodes {
            id title inventoryPolicy inventoryItem { id tracked }
          } }
        }
      }`,
      { id: gid }
    );
    const bp = back.product;
    // NO TAKE-DOWN HERE, and that is not an oversight: the read-back found no
    // product at all, so there is nothing on Shopify to unpublish and the
    // mutation would only fail. Its siblings below DO take down, because they
    // found a product and are refusing it.
    if (!bp) { await refuse(pid, "read-back returned no product — the ID map may point at a deleted product"); continue; }
    if (bp.variants.pageInfo.hasNextPage) { const down = await failSafeUnpublish(gid); await refuse(pid, ">100 variants unpaginated", { tookDown: down }); continue; }
    const sizeByDisplay = new Map(sizes.map((s) => [displaySizeName(s), s]));
    const rows = bp.variants.nodes
      .filter((v) => sizeByDisplay.has(v.title) && v.inventoryItem?.id)
      .map((v) => ({
        size: sizeByDisplay.get(v.title), variantId: v.id, inventoryItemId: v.inventoryItem.id,
        tracked: v.inventoryItem.tracked, inventoryPolicy: v.inventoryPolicy,
      }));
    if (!rows.length) { const down = await failSafeUnpublish(gid); await refuse(pid, "no read-back variant matches any catalogue size", { tookDown: down }); continue; }
    // Every catalogue size must have a Shopify variant — a size added while
    // the product sat OFF has none, and shipping without it would silently
    // sell an incomplete run. Structural change needs a human.
    const missingSizes = sizes.filter((sTok) => !rows.some((r) => r.size === sTok));
    if (missingSizes.length) {
      const down = await failSafeUnpublish(gid);
      await refuse(pid, `catalogue sizes with no Shopify variant: ${missingSizes.join(", ")} — the size set changed while off; fix the Shopify product (or the record) first`, { tookDown: down });
      continue;
    }
    await writeIdMap(db, pid, buildMapping(gid, rows));

    if (!createdNow) {
      // The create path prices every variant at creation; the mapped path must
      // push the CURRENT retailPrice too — a price correction made while the
      // product sat OFF would otherwise go live stale.
      const priceNow = Number(product.retailPrice).toFixed(2);
      const priced = await graphql(
        `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
        }`,
        { productId: gid, variants: rows.map((r) => ({ id: r.variantId, price: priceNow })) },
        { mutation: true }
      );
      const priceErrs = priced.productVariantsBulkUpdate.userErrors;
      if (priceErrs?.length) { const down = await failSafeUnpublish(gid); await refuse(pid, `variant price update userErrors: ${JSON.stringify(priceErrs)}`, { tookDown: down }); continue; }
      console.log(`  variant prices set to ${priceNow}`);
    }
    if (bp.media?.pageInfo?.hasNextPage) { const down = await failSafeUnpublish(gid); await refuse(pid, ">50 media unpaginated — cannot verify the photo set", { tookDown: down }); continue; }
    const mediaCount = bp.media?.nodes?.length ?? 0;
    // Shopify rehosts files, so what it holds can't be compared to the plan
    // by URL — the fingerprint recorded on /shopify_sync at attach time is
    // the only proof its media IS the reviewed set. Anything else (an edited
    // publishing set, a crashed half-attach, an admin upload, a legacy
    // pre-fingerprint push) is RE-SYNCED: delete what's there, re-attach the
    // reviewed plan. The page is the source of truth for publishing photos —
    // certifying an unverified count match would let a stale or wrong photo
    // ship "verified" forever (reviewer finding, 2026-08-14). This happens
    // while the product is off the sales channel, invisible to customers.
    const planFp = mediaFingerprint(mediaPlan);
    if (mediaCount > 0 && mapNode?.mediaFingerprint === planFp && mediaCount === mediaPlan.length) {
      // Verified: Shopify's media is exactly this plan, attached by us.
    } else {
      await preflightPhotoUrls(mediaPlan.map((m) => m.originalSource));
      if (mediaCount > 0) {
        // A drift-visible product (published in admin while confirmed off)
        // must not show a half-deleted photo set — take it off the channel
        // BEFORE touching media. Idempotent; the ON path re-publishes at the
        // end anyway.
        await failSafeUnpublish(gid);
        const del = await graphql(
          `mutation ($mediaIds: [ID!]!, $productId: ID!) {
            productDeleteMedia(mediaIds: $mediaIds, productId: $productId) { mediaUserErrors { field message } }
          }`,
          { mediaIds: bp.media.nodes.map((n) => n.id), productId: gid },
          { mutation: true }
        );
        const delErrs = del.productDeleteMedia.mediaUserErrors;
        if (delErrs?.length) { const down = await failSafeUnpublish(gid); await refuse(pid, `productDeleteMedia userErrors: ${JSON.stringify(delErrs)}`, { tookDown: down }); continue; }
        // Deletion is asynchronous on Shopify's side; attachMedia's READY
        // poll counts nodes, so lingering old media could satisfy it
        // spuriously. Wait for zero before attaching.
        let cleared = false;
        for (let i = 0; i < 10; i++) {
          const now = await graphql(
            `query ($id: ID!) { product(id: $id) { media(first: 50) { nodes { id } } } }`, { id: gid });
          if ((now.product?.media?.nodes?.length ?? 0) === 0) { cleared = true; break; }
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (!cleared) { const down = await failSafeUnpublish(gid); await refuse(pid, "old media did not clear after productDeleteMedia — re-run to resume the re-sync", { tookDown: down }); continue; }
      }
      // attachMedia throws on userErrors/FAILED/poll-timeout. Letting that
      // land in the outer catch would leave a media-less product with its
      // intent still on and NO block recorded — worse after a re-sync, which
      // just deleted the old set. Same treatment as the sibling media
      // refusals: off the channel, blocked with the reason, resumable (the
      // next run sees 0/partial media and re-attaches the reviewed set).
      try {
        const { count } = await attachMedia(graphql, gid, mediaPlan);
        await db.ref(`shopify_sync/${pid}`).update({ mediaFingerprint: planFp });
        console.log(mediaCount > 0 ? `  media re-synced to the reviewed set: ${count}` : `  media READY: ${count}`);
      } catch (e) {
        const down = await failSafeUnpublish(gid);
        await refuse(pid, `media attach failed: ${String(e?.message || e)} — re-run re-attaches the reviewed set`, { tookDown: down });
        continue;
      }
    }

    // ── FAIL-CLOSED GATE: the FULL validator against the CANONICAL object ────
    // The product may have been edited in the Shopify admin since any earlier
    // push — what actually goes public is what Shopify holds NOW, so that is
    // what gets validated. A trigger anywhere refuses and marks blocked.
    const canon = await graphql(
      `query ($id: ID!) {
        product(id: $id) {
          id title handle vendor productType tags descriptionHtml
          seo { title description }
          options { name optionValues { name } }
          media(first: 50) { pageInfo { hasNextPage } nodes { alt } }
          variants(first: 100) { nodes { sku } }
        }
      }`,
      { id: gid }
    );
    const cp = canon.product;
    if (!cp) { await refuse(pid, `${gid} not found on the shop — deleted in admin mid-run?`); continue; }  // nothing there to take down
    if (cp.media.pageInfo?.hasNextPage) { const down = await failSafeUnpublish(gid); await refuse(pid, ">50 media unpaginated — the FULL validator cannot see them all", { tookDown: down }); continue; }
    const verdict = validatePayload({
      title: cp.title, handle: cp.handle, vendor: cp.vendor, productType: cp.productType,
      tags: cp.tags, descriptionHtml: cp.descriptionHtml, seo: cp.seo,
      media: cp.media.nodes.map((m) => ({ alt: m.alt })),
      variants: cp.variants.nodes.map((v) => ({ sku: v.sku })),
    });
    for (const o of cp.options ?? []) {
      for (const ov of o.optionValues ?? []) {
        if (!isTriggerFree(`${o.name} ${ov.name}`)) {
          verdict.ok = false;
          verdict.violations.push({ field: `option ${o.name}`, problem: `trigger in value "${ov.name}"` });
        }
      }
    }
    if (!cp.descriptionHtml.includes(fresh.condition)) {
      verdict.ok = false;
      verdict.violations.push({ field: "descriptionHtml", problem: `does not carry the reviewed condition ("${fresh.condition}")` });
    }
    if (!verdict.ok) {
      // FAIL-SAFE: if the product is somehow already visible (a crash between
      // an earlier run's publish and its confirm, or a manual publish in the
      // Shopify admin), refusing while leaving it up would strand
      // non-compliant content on the storefront with no remaining intent to
      // take it down — markBlocked consumes desiredState. Unpublish first;
      // on an unpublished product this is a no-op.
      const down = await failSafeUnpublish(gid);
      await refuse(pid, "canonical Shopify object fails compliance: " +
        verdict.violations.map((v) => `${v.field}: ${v.problem}`).join("; "), { tookDown: down });
      continue;
    }

    // Inventory at the moment it starts mattering to customers — from a FRESH
    // read of this product's cells (a sale mid-run must not be re-listed).
    const finalMap = (await db.ref(`shopify_sync/${pid}`).get()).val();
    // Ten location keys, resolved ONCE per process from a SHALLOW read. This
    // line used to pull the whole of /stock — 6,204,009 measured bytes — for
    // every single product published.
    const locNames = await stockLocationKeys();
    const tree = {};
    for (const loc of locNames) {
      const cells = (await db.ref(`stock/${loc}/${pid}`).get()).val();
      if (cells) tree[loc] = { [pid]: cells };
    }
    const totals = networkTotals(tree, pid, sizes);

    // ── TRACKING, ENFORCED ON EVERY RUN ──────────────────────────────────────
    // Not just at creation. This is the SELF-HEALING half: it re-checks the
    // read-back on both the create and the reconcile path, so a product created
    // before the create path carried TRACKED_VARIANT — or one whose tracking
    // was switched off by hand in the admin — is repaired the next time its
    // intent is applied, without anyone remembering to.
    //
    // Cost is zero for a correct product: untrackedVariants() returns nothing
    // and no mutation is sent. FAIL CLOSED — an untracked variant is a variant
    // that can oversell, so a failure here refuses and takes the product off
    // the channel rather than publishing something that can sell stock the
    // shop does not hold.
    // EVERY variant on the product, not just `rows`. `rows` is filtered to
    // variants whose title matches a catalogue size, so a variant added by hand
    // in the admin — or left over from a size the record dropped — never
    // entered it, was never tracked, and would go live infinitely sellable
    // under a product we published. It is on OUR product and about to be
    // public, so it gets the same lock as the rest. Tracked with whatever
    // quantity it holds (usually 0) fails towards unbuyable, which is the safe
    // direction; the alternative is a size nobody can fulfil taking orders.
    // (Spec review, 2026-08-16.)
    const allVariantRows = bp.variants.nodes.map((v) => ({
      variantId: v.id, tracked: v.inventoryItem?.tracked, inventoryPolicy: v.inventoryPolicy,
    }));
    const untracked = untrackedVariants(allVariantRows);
    if (untracked.length) {
      try {
        await enforceTracking(graphql, gid, untracked.map((r) => r.variantId));
        console.log(`  inventory tracking enabled on ${untracked.length} variant(s) (DENY)`);
      } catch (e) {
        const down = await failSafeUnpublish(gid);
        await refuse(pid, `could not enable inventory tracking (${String(e?.message || e)}) — refusing to list a product that would oversell`, { tookDown: down });
        continue;
      }
    }

    const locId = await requireSingleLocation(graphql);
    await setAvailable(
      graphql,
      locId,
      Object.entries(finalMap.variants).map(([sizeKey, v]) => ({
        inventoryItemId: v.shopifyInventoryItemId,
        quantity: totals[sizeKey] ?? 0,
      }))
    );
    console.log(`  inventory set: ${JSON.stringify(totals)}`);

    // LAST-MOMENT INTENT CHECK, at the point of no return: the page's Cancel
    // button stays enabled the whole time this multi-step sequence runs, and a
    // cancel that lands mid-run must win. Everything above (create/reconcile,
    // ID map, media, inventory) is invisible to customers; publishablePublish
    // is what goes public — so the intent is re-read right before it. On a
    // cancel, the product stays created-but-unpublished, which IS the "off"
    // the operator asked for.
    const lastCheck = (await db.ref(`shopify_publish/${pid}`).get()).val();
    if (lastCheck?.desiredState !== "on") {
      // Fail-safe here too: if drift left this product visible, a cancel
      // confirming "off" without an unpublish would strand it up for good.
      await failSafeUnpublish(gid);
      await confirmLiveState(db, pid, "off", UPDATED_BY, {
        gid,
        offReason: "cancelled_mid_run",
        offDetail: "the publish was called back while the reconciler was applying it — created on Shopify but never published",
      });
      await unindexProduct(db, pid, "cancelled");
      results.push({ pid, ok: true, note: "cancelled mid-run — created/reconciled but NOT published, confirmed off" });
      continue;
    }
    // Photos are editable while a publish sits pending — a set saved after
    // this run built its media plan must not go live under the OLD plan.
    // Leave the intent unconsumed; the next run rebuilds the plan from the
    // new set (and re-syncs the media by fingerprint).
    let lastPlanFp = null;
    try { lastPlanFp = mediaFingerprint(buildMediaPlan(product, title, normalizePhotoList(lastCheck?.photos))); } catch { /* unbuildable ⇒ changed */ }
    if (lastPlanFp !== planFp) {
      results.push({ pid, ok: true, note: "photo set changed mid-run — left for the next run to apply the new set" });
      continue;
    }

    // ── STOREFRONT COLLECTIONS ───────────────────────────────────────────────
    // Applied on BOTH paths (create and reconcile) and planned from Shopify's
    // CURRENT membership, so it is idempotent and self-healing: a product whose
    // record was re-categorised while it sat off leaves the old collection and
    // joins the new one here. Smart collections are never touched — Shopify
    // owns those.
    //
    // ORDER MATTERS, and this is deliberately the LAST thing before the product
    // becomes visible — after the canonical compliance gate, after the
    // last-moment cancel check, after the photo-set check. Every one of those
    // can abandon the run, and an earlier join would leave the product
    // blocked-or-cancelled but still a member of a collection. That is not
    // self-correcting: markBlocked consumes desiredState, so the reconciler's
    // worklist skips a blocked node forever, and the UI's Off button is
    // disabled on a product it already believes is off. Nothing a customer
    // could see (a collection only renders PUBLISHED products), but it would
    // quietly inflate the admin's collection counts with products that were
    // refused. Here, the only thing that can still fail is the publish itself —
    // and sync-collections.mjs sweeps that.
    //
    // A membership failure REFUSES: a product reaching the storefront filed
    // under the wrong heading is a worse outcome than one that stays down and
    // says why.
    const desiredCollectionGid = desiredCollectionFor(pid, product);
    try {
      const { collections } = await readProductCollections(graphql, gid, online.id);
      const plan = planCollectionMembership(collections, desiredCollectionGid, managedGids);
      if (plan.join.length || plan.leave.length) {
        await applyCollectionMembership(graphql, gid, plan);
        console.log(`  collections: joined ${plan.join.length}, left ${plan.leave.length}`);
      }
    } catch (e) {
      const down = await failSafeUnpublish(gid);
      await refuse(pid, `collection membership failed: ${String(e?.message || e)}`, { tookDown: down });
      continue;
    }

    // Publish to the Online Store channel, then make the product ACTIVE.
    const pubRes = await graphql(
      `mutation ($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) { userErrors { field message } }
      }`,
      { id: gid, input: [{ publicationId: online.id }] },
      { mutation: true }
    );
    const pubErrs = pubRes.publishablePublish.userErrors;
    // From here the product IS on the sales channel. Anything that throws
    // between here and the end of this iteration must take it down again.
    if (!pubErrs?.length) publicGid = gid;
    // A partial publish can still have made the product visible, and refuse()
    // consumes the intent — so take it down before recording the refusal.
    if (pubErrs?.length) { const down = await failSafeUnpublish(gid); await refuse(pid, `publishablePublish userErrors: ${JSON.stringify(pubErrs)}`, { tookDown: down }); continue; }
    const act = await graphql(
      `mutation ($input: ProductUpdateInput!) {
        productUpdate(product: $input) { product { id status } userErrors { field message } }
      }`,
      { input: { id: gid, status: "ACTIVE" } },
      { mutation: true }
    );
    // PRE-EXISTING HOLE, found in review of this PR and fixed here because it
    // is one line and the alternative is knowingly leaving it: publishablePublish
    // has ALREADY SUCCEEDED at this point, and a product that was live before
    // (switched off via a channel unpublish, so still status ACTIVE) is
    // publicly visible again the moment it lands. Refusing here without taking
    // it down left the app saying "blocked/off" while the storefront sold it,
    // permanently — markBlocked consumes desiredState, so the worklist never
    // revisits it. Every sibling refusal already unpublishes first; these two
    // were the only ones that did not.
    const actErrs = act.productUpdate.userErrors;
    if (actErrs?.length) { const down = await failSafeUnpublish(gid); await refuse(pid, `productUpdate userErrors: ${JSON.stringify(actErrs)} — NOT confirmed on`, { tookDown: down }); continue; }
    if (act.productUpdate.product?.status !== "ACTIVE") {
      const down = await failSafeUnpublish(gid);
      await refuse(pid, `productUpdate returned status ${act.productUpdate.product?.status} — NOT confirmed on`, { tookDown: down });
      continue;
    }
    await confirmLiveState(db, pid, "on", UPDATED_BY, { gid });
    // Now that it IS live, put it in the storefront search index — through
    // the SAME builder the sweep uses, so the two can never write different
    // documents for the same product.
    try {
      const doc = await buildSearchDocFor(pid);
      console.log(`  search index: ${doc ? await indexProductLive(db, pid, doc) : "skipped: nothing to build from"}`);
    } catch (e) {
      // NEVER turns a successful publish into a refusal. The product is live;
      // the worst case is that it is missing from search until the sweep at the
      // end of this run — or the next one — picks it up.
      console.error(`  ⚠ ${pid}: search index write failed (${String(e?.message || e)}) — the product IS live; the sweep will catch it`);
    }
    const numericId = gid.split("/").pop();
    results.push({
      pid, ok: true,
      note: `LIVE on the Online Store — "${title}" · https://admin.shopify.com/store/nu3ei8-0p/products/${numericId}`,
    });
  } catch (e) {
    // DELIBERATELY NOT markBlocked. A throw here is usually transient (a
    // timeout, a throttle) and blocking would consume the intent, so the next
    // tick would never retry a publish that only needed retrying. But if the
    // product reached the channel before the throw, leaving it up is not an
    // option — take it down and let the intent stand for the next run.
    if (publicGid) {
      console.error(`  ⚠ ${pid}: threw AFTER going public — taking it back off the channel`);
      await failSafeUnpublish(publicGid);
    }
    results.push({ pid, ok: false, why: String(e?.message || e) });
  }
}

// ── SEARCH-INDEX SWEEP — the index cannot rot ────────────────────────────────
// The per-product hooks above only fire on a state CHANGE. That was not enough:
// on 2026-08-17 the index held 200 documents against 373 live products — 46% of
// the storefront unfindable, none of it for want of identity. Every commit run
// now reconciles the two sets. See searchIndexWrite.mjs for the cost argument.
// The sweep is DRIFT REPAIR, not the primary path: the per-product hooks above
// keep the index in step within one tick of any state change. Running it every
// two minutes bought nothing and cost a second whole-node read each time, so it
// now runs when this tick actually applied something, or on the same cadence
// the full scan uses (30 min by day, 3 h overnight).
// Its live set comes from `.indexOn: ["state"]`, which the live rules ALREADY
// carry — or, on a full-scan tick, from the map already in hand, for free.
const sweptRecently = Number(scanState?.lastSweepAt) || 0;
// APPLIED work, not merely results. The sweep repairs drift caused by a state
// CHANGE, and an apply that failed changed nothing — so `results.length > 0`
// made a persistently failing product re-trigger the 747 KB live-set read every
// two minutes, day and night, which is precisely the standing-failure shape
// this branch found already live (five records refused for 1,367 consecutive
// ticks). A failure keeps its place in the retry set; it does not earn a sweep.
const appliedSomething = results.some((r) => r.ok);
const sweepDue = scanMode === "full" ||
  appliedSomething ||
  runStartedAt - sweptRecently >= fullScanIntervalMs(runStartedAt);
let sweepRan = false;
// RAN BUT DID NOT FINISH — a different thing from "did not run". Leaving
// lastSweepAt at its previous value is NOT enough to make the next tick sweep,
// because the sweep does not only run when the cadence has elapsed: it also
// runs whenever the tick applied something. So a capped sweep triggered by an
// apply, with a recent lastSweepAt, would sit until the cadence caught up —
// 30 minutes, or 3 hours overnight — while its own log line promised the next
// tick. Unfinished CLEARS lastSweepAt instead, which makes the next tick due.
let sweepUnfinished = false;
// A plain conditional, not a sentinel exception. "Not due" is a schedule, not a
// failure, and routing it through throw meant the catch below had to tell the
// two apart by comparing an error MESSAGE — which leaves the catch describing
// every genuine sweep error as something it must first prove is not the
// sentinel.
if (sweepDue) {
  try {
    const liveNow = scanMode === "full"
      ? Object.entries(all).filter(([, n]) => n?.state === "live" && n?.liveState === "on").map(([p]) => p)
      : await readLivePids(db, { meter });
    const sweep = await sweepSearchIndex(db, admin.app(), {
      livePids: liveNow,
      buildDoc: (pid) => buildSearchDocFor(pid),
    });
    // Only a sweep that actually REPAIRED counts as having run. sweepSearchIndex
    // returns `skipped` without throwing on both its refusals — an empty live
    // set, and an index it could not list — and neither did any repair. Stamping
    // lastSweepAt on those would suppress the next attempt for 30 minutes, or 3
    // hours overnight, on the strength of a sweep that declined to do anything.
    // Before the cadence existed this retried every tick, so the refusal cost
    // two minutes; it must not now cost three hours.
    // A CAPPED sweep has not finished either. It says so in the line below —
    // "the next tick continues" — and before this branch added a cadence that
    // was simply true. Stamping lastSweepAt on a capped run makes the message a
    // lie: the remaining documents would wait 30 minutes, or 3 hours overnight,
    // rather than the next tick. Leave it unstamped and the promise holds.
    // `refused` is deliberately NOT in this list (reviewed and declined,
    // PR #551). A removal-ceiling refusal is not unfinished work that the next
    // tick would finish: the additions were all applied, and the removals will
    // refuse again on identical input. Re-sweeping every two minutes would buy
    // nothing and cost the 747 KB live-set read each time, to reprint the same
    // message. Its own text says what actually clears it — a human running
    // build-search-index.mjs — and the cadence is the right interval at which
    // to keep saying so. `capped` and `skipped` are different: those really do
    // get further on the next attempt.
    sweepRan = !sweep.skipped && !sweep.capped;
    sweepUnfinished = Boolean(sweep.skipped || sweep.capped);
    if (sweep.skipped) {
      // already warned
    } else if (sweep.missing || sweep.orphans) {
      console.log(
        `\nsearch index: ${liveNow.length} live · +${sweep.indexed} indexed, -${sweep.removed} removed` +
        (sweep.capped ? ` · ${sweep.missing - sweep.indexed} still missing (per-run cap; the next tick continues)` : "") +
        (sweep.failed ? ` · ${sweep.failed} failed` : "")
      );
    }
  } catch (e) {
    // A sweep that threw did not repair anything either, and before the cadence
    // it would have been retried in two minutes. Keep that.
    sweepUnfinished = true;
    console.error(`  ⚠ search-index sweep failed (${String(e?.message || e)}) — run build-search-index.mjs --commit`);
  }
}

// RTDB stores no empty object — writing `{}` deletes the key, which is exactly
// what an empty retry set should do, but the Admin SDK refuses `{}` in an
// update payload. Say `null` and mean it.
const emptyToNull = (o) => (o && Object.keys(o).length ? o : null);

// ── Persist the scan state ───────────────────────────────────────────────────
// Only a COMMIT run that scanned the whole shop (or scanned a window) may move
// the watermark, and it moves to the moment this run STARTED — never to "now",
// so an intent written while the run was in flight lands in the next window
// instead of being stepped over. `--pids` runs deliberately touch nothing: they
// are a surgical human command and must not tell the scheduler it is caught up.
if (COMMIT && !ONLY) {
  // Two kinds of unfinished work must survive to the next tick, and NEITHER
  // moved its node's `updatedAt`, so neither would reappear in the next window
  // on its own: a product whose apply FAILED, and a product the per-run CAP
  // never got to. They are carried by different mechanisms, on purpose.
  //
  //   · a failure rides the RETRY SET. Its `updatedAt` is stale by definition,
  //     so no window will ever find it again; it is read by id every tick.
  //   · cap-deferred work rides the WATERMARK, which simply does not advance
  //     past it. Putting it in the retry set instead — which this branch did at
  //     first — breaks twice over at scale: the retry set is capped, so a
  //     backlog bigger than the two caps together was dropped and left to the
  //     next full scan (3 hours, overnight); and since the trim keeps the
  //     newest and every deferred pid shares one timestamp, one bulk deferral
  //     evicted every standing failure at a stroke.
  const deferred = new Set(worklist.slice(capped.length).map((w) => w.pid));
  const carried = results.filter((r) => !r.ok).map((r) => r.pid);
  // Retry pids are excluded: their `updatedAt` is stale, so one of them would
  // drag the watermark back and widen every window for as long as it failed.
  const unapplied = worklist.slice(capped.length)
    .filter((w) => !retryPids.includes(w.pid))
    .map((w) => w.node);
  // A retry pid is EVALUATED even when it never reaches the worklist. Its node
  // is read individually every tick, and that read can find the node deleted,
  // or find it already in the state it wants — in which case it produces no
  // worklist entry, so `capped` never names it. Counting only `capped` as
  // attempted would leave such a pid in the retry set for good: read every
  // tick forever, holding one of the bounded slots against a real failure that
  // needs it. Evaluated counts as attempted; only a pid the per-run cap
  // genuinely deferred is held back, and it is carried instead.
  const attempted = [...new Set([
    ...capped.map((w) => w.pid),
    ...retryPids.filter((pid) => !deferred.has(pid) && !unreadable.has(pid)),
  ])];
  await writeReconcileState(db, {
    watermark: nextWatermark({ runStartedAt, unapplied, previousWatermark: scanState?.watermark ?? null }),
    retry: emptyToNull(nextRetrySet({ previous: scanState?.retry, attempted, failedPids: carried, nowMs: runStartedAt })),
    ...(scanMode === "full" ? { lastFullScanAt: runStartedAt } : {}),
    // Three states, not two: finished (stamp it), ran-unfinished (CLEAR it, so
    // the next tick is due regardless of cadence), and never ran because it was
    // not due (leave it alone — clearing there would sweep every tick forever).
    ...(sweepRan ? { lastSweepAt: runStartedAt } : sweepUnfinished ? { lastSweepAt: null } : {}),
    updatedAt: runStartedAt,
  });
}
console.log(`rtdb read this run: ~${rtdbBytes.toLocaleString()} B`);

// ── Report ───────────────────────────────────────────────────────────────────
console.log("\n══ RECONCILE REPORT ══");
for (const r of results) {
  console.log(r.ok ? `✓ ${r.pid}: ${r.note}` : `✗ ${r.pid}: ${r.why}`);
}
const failed = results.filter((r) => !r.ok).length;
process.exit(failed ? 1 : 0);

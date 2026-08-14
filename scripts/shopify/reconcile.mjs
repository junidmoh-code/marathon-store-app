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
import { sortSizes, displaySizeName, findSizeCollisions } from "./sizeOrder.mjs";
import { cleanTitleFor, isTriggerFree, triggersInText } from "../../src/utils/shopifyTriggers.js";
import {
  VENDOR, CONDITIONS, buildDescriptionHtml, buildHandle, buildSeo, buildTags,
  validatePayload,
} from "./compliance.mjs";
import { buildMediaPlan, preflightPhotoUrls, attachMedia, mediaFingerprint } from "./media.mjs";
import { networkTotals, requireSingleLocation, setAvailable } from "./inventory.mjs";
import { buildMapping, writeIdMap, claimShopifyProduct } from "./idMap.mjs";
import { readAllPublishNodes, confirmLiveState, markBlocked } from "./publishNode.mjs";
// Storefront collections. The map is repo data (collectionMap.mjs); the gids
// are read from /shopify_sync/_collections and NEVER guessed — a product joins
// a collection that already exists or joins none. Nothing here creates a
// collection mid-publish; that is ensure-collections.mjs's job.
import {
  collectionGidsByKey, manualGidsFrom, planCollectionMembership,
  readProductCollections, applyCollectionMembership, requireOnlineStorePublication,
} from "./collections.mjs";
import { resolveCollection, COLLECTION_BY_KEY } from "./collectionMap.mjs";
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

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

// Confirmed = what the reconciler last verified against Shopify. A node that
// never reached state "live" is confirmed off — nothing is on the storefront.
const confirmedOn = (node) => node?.state === "live" && node?.liveState === "on";

// ── Worklist: every node whose intent differs from its confirmed state ───────
const all = await readAllPublishNodes(db);
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
if (!worklist.length) { console.log("nothing to do."); process.exit(0); }

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
    let action;
    if (want === "off") action = "UNPUBLISH";
    else action = mapNode?.shopifyProductId ? "PUBLISH" : "CREATE+PUBLISH";
    const title = node.cleanName || "(lexicon at apply time)";
    // The collection is resolvable from RTDB alone, so the dry run shows it —
    // including the "none" answers, which are the ones worth seeing BEFORE a
    // publish rather than in the run log after it.
    // An UNPUBLISH also fires collection LEAVES on the commit run — the dry run
    // is meant to be a complete preview, so it says so instead of showing "—".
    let collection = want === "off" ? "leaves collections" : "—";
    if (want === "on") {
      const r = resolveCollection((await db.ref(`products/${pid}`).get()).val());
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

// ── Commit path ──────────────────────────────────────────────────────────────
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
let online;
try {
  online = { id: await requireOnlineStorePublication(graphql) };
} catch (e) {
  console.error(String(e?.message || e));
  process.exit(1);
}

// The collection gids, read ONCE. An empty map is not fatal: publishing must
// still work on a shop where ensure-collections.mjs has never run — the
// products just land in no collection, and the warning below says so on every
// single product rather than once, because a storefront with no navigation is
// exactly the failure this work exists to fix.
const collectionGids = await collectionGidsByKey(db);
const managedGids = manualGidsFrom(collectionGids);
if (!managedGids.length) {
  console.error("  ⚠ no storefront collections recorded at /shopify_sync/_collections — run `node scripts/shopify/ensure-collections.mjs --commit` first, or every product published here lands in no collection");
}

const results = [];
// Best-effort channel unpublish for fail-safe paths: a refusal or cancel on a
// product that has somehow drifted to publicly-visible must take it down
// BEFORE the intent is consumed. Idempotent — unpublishing an unpublished
// product is a no-op. userErrors are the normal Shopify failure channel, so
// they warn just like a thrown error would.
const failSafeUnpublish = async (gid) => {
  if (!gid) return;
  try {
    const res = await graphql(
      `mutation ($id: ID!, $input: [PublicationInput!]!) {
        publishableUnpublish(id: $id, input: $input) { userErrors { field message } }
      }`,
      { id: gid, input: [{ publicationId: online.id }] },
      { mutation: true }
    );
    const errs = res.publishableUnpublish.userErrors;
    if (errs?.length) console.error(`  ⚠ fail-safe unpublish userErrors: ${JSON.stringify(errs)} — check ${gid} in admin`);
    else console.log("  fail-safe: unpublished from the Online Store channel");
  } catch (e) {
    console.error(`  ⚠ fail-safe unpublish failed (${String(e?.message || e)}) — check ${gid} in admin`);
  }
};
const refuse = async (pid, why) => {
  console.error(`  🛑 ${pid} REFUSED: ${why}`);
  await markBlocked(db, pid, why, UPDATED_BY);
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
        await confirmLiveState(db, pid, "off", UPDATED_BY, { clearAdminUrl: true });
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
      if (errs?.length) { results.push({ pid, ok: false, why: `publishableUnpublish userErrors: ${JSON.stringify(errs)}` }); continue; }
      // Off the shelf means out of the aisles: the product LEAVES every managed
      // collection. It is not archived, not deleted, and its ID map survives —
      // switching it back on re-joins it from the map. A collection built by
      // hand in the admin is not ours and is left alone (planCollectionMembership).
      let leftNote = "";
      try {
        const { collections } = await readProductCollections(graphql, mapNode.shopifyProductId);
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
      await confirmLiveState(db, pid, "off", UPDATED_BY, { gid: mapNode.shopifyProductId });
      results.push({ pid, ok: true, note: `unpublished from the Online Store channel${leftNote}` });
      continue;
    }

    // ── Turning ON ───────────────────────────────────────────────────────────
    const product = (await db.ref(`products/${pid}`).get()).val();
    if (!product) { await refuse(pid, "no /products record"); continue; }
    if (product.mergedInto) { await refuse(pid, `record merged into ${product.mergedInto} — publish the survivor`); continue; }
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
    const createdNow = !gid;
    if (gid) {
      // RECONCILE the mapped product's pushed fields from the CURRENT record —
      // a rename or condition change made while the product sat OFF must land
      // before it becomes visible again.
      console.log(`  /shopify_sync maps to ${gid} — reconciling fields`);
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
      if (uErrs?.length) { await refuse(pid, `reconcile productUpdate userErrors: ${JSON.stringify(uErrs)}`); continue; }
    } else {
      // CREATE — the old publish-run's draft pipeline, inline: photos answer
      // first, exact-title duplicate guard (a legacy or twin product must be
      // adopted deliberately, never claimed by accident), DRAFT create, atomic
      // gid claim, read-back → ID map, media attach.
      await preflightPhotoUrls(mediaPlan.map((m) => m.originalSource));
      // TWO duplicate guards. The handle probe is the strong one: handles are
      // unique per shop and buildHandle is deterministic, so a crashed earlier
      // run (productSet applied, claim never written) or a twin-titled product
      // surfaces here even when the search index hasn't caught the title yet —
      // and the slug charset ([a-z0-9-]) has no quoting hazards. Refusing
      // (not auto-claiming) is deliberate: a product with no /shopify_sync
      // entry is not ours to adopt without a human.
      let handleHit = null;
      try {
        // Direct lookup — exact by construction and NOT behind the search
        // index, so an orphan from a run that crashed seconds ago still shows.
        const byId = await graphql(
          `query ($h: String!) { productByIdentifier(identifier: { handle: $h }) { id title handle } }`,
          { h: payload.handle }
        );
        handleHit = byId.productByIdentifier;
      } catch {
        // Field unavailable on this API version — fall back to the search
        // probe (weaker: index lag), still filtered to the exact handle.
        console.error("  ⚠ productByIdentifier unavailable — falling back to search-index handle probe");
        const dupeHandle = await graphql(
          `query ($q: String!) { products(first: 25, query: $q) { nodes { id title handle } } }`,
          { q: `handle:'${payload.handle}'` }
        );
        handleHit = dupeHandle.products.nodes.find((n) => n.handle === payload.handle) || null;
      }
      if (handleHit) {
        await refuse(pid, `Shopify product ${handleHit.id} already owns handle "${payload.handle}" (an orphan from a crashed run, or a legacy/twin product) — adopt it via round-trip.mjs or remove it, then re-publish`);
        continue;
      }
      const dupe = await graphql(
        `query ($q: String!) { products(first: 25, query: $q) { nodes { id title } } }`,
        { q: `title:'${payload.title.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'` }
      );
      if (dupe.products.nodes.some((n) => n.title === payload.title)) {
        await refuse(pid, "a product with this exact title already exists — adopt via round-trip.mjs first");
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
          variants(first: 100) { pageInfo { hasNextPage } nodes { id title inventoryItem { id } } }
        }
      }`,
      { id: gid }
    );
    const bp = back.product;
    if (!bp) { await refuse(pid, "read-back returned no product — the ID map may point at a deleted product"); continue; }
    if (bp.variants.pageInfo.hasNextPage) { await refuse(pid, ">100 variants unpaginated"); continue; }
    const sizeByDisplay = new Map(sizes.map((s) => [displaySizeName(s), s]));
    const rows = bp.variants.nodes
      .filter((v) => sizeByDisplay.has(v.title) && v.inventoryItem?.id)
      .map((v) => ({ size: sizeByDisplay.get(v.title), variantId: v.id, inventoryItemId: v.inventoryItem.id }));
    if (!rows.length) { await refuse(pid, "no read-back variant matches any catalogue size"); continue; }
    // Every catalogue size must have a Shopify variant — a size added while
    // the product sat OFF has none, and shipping without it would silently
    // sell an incomplete run. Structural change needs a human.
    const missingSizes = sizes.filter((sTok) => !rows.some((r) => r.size === sTok));
    if (missingSizes.length) {
      await failSafeUnpublish(gid);
      await refuse(pid, `catalogue sizes with no Shopify variant: ${missingSizes.join(", ")} — the size set changed while off; fix the Shopify product (or the record) first`);
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
      if (priceErrs?.length) { await failSafeUnpublish(gid); await refuse(pid, `variant price update userErrors: ${JSON.stringify(priceErrs)}`); continue; }
      console.log(`  variant prices set to ${priceNow}`);
    }
    if (bp.media?.pageInfo?.hasNextPage) { await refuse(pid, ">50 media unpaginated — cannot verify the photo set"); continue; }
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
        if (delErrs?.length) { await failSafeUnpublish(gid); await refuse(pid, `productDeleteMedia userErrors: ${JSON.stringify(delErrs)}`); continue; }
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
        if (!cleared) { await failSafeUnpublish(gid); await refuse(pid, "old media did not clear after productDeleteMedia — re-run to resume the re-sync"); continue; }
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
        await failSafeUnpublish(gid);
        await refuse(pid, `media attach failed: ${String(e?.message || e)} — re-run re-attaches the reviewed set`);
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
    if (!cp) { await refuse(pid, `${gid} not found on the shop — deleted in admin mid-run?`); continue; }
    if (cp.media.pageInfo?.hasNextPage) { await refuse(pid, ">50 media unpaginated — the FULL validator cannot see them all"); continue; }
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
      await failSafeUnpublish(gid);
      await refuse(pid, "canonical Shopify object fails compliance: " +
        verdict.violations.map((v) => `${v.field}: ${v.problem}`).join("; "));
      continue;
    }

    // Inventory at the moment it starts mattering to customers — from a FRESH
    // read of this product's cells (a sale mid-run must not be re-listed).
    const finalMap = (await db.ref(`shopify_sync/${pid}`).get()).val();
    const locNames = Object.keys((await db.ref("stock").get()).val() || {});
    const tree = {};
    for (const loc of locNames) {
      const cells = (await db.ref(`stock/${loc}/${pid}`).get()).val();
      if (cells) tree[loc] = { [pid]: cells };
    }
    const totals = networkTotals(tree, pid, sizes);
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
      await confirmLiveState(db, pid, "off", UPDATED_BY, { gid });
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
      const { collections } = await readProductCollections(graphql, gid);
      const plan = planCollectionMembership(collections, desiredCollectionGid, managedGids);
      if (plan.join.length || plan.leave.length) {
        await applyCollectionMembership(graphql, gid, plan);
        console.log(`  collections: joined ${plan.join.length}, left ${plan.leave.length}`);
      }
    } catch (e) {
      await failSafeUnpublish(gid);
      await refuse(pid, `collection membership failed: ${String(e?.message || e)}`);
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
    if (pubErrs?.length) { await refuse(pid, `publishablePublish userErrors: ${JSON.stringify(pubErrs)}`); continue; }
    const act = await graphql(
      `mutation ($input: ProductUpdateInput!) {
        productUpdate(product: $input) { product { id status } userErrors { field message } }
      }`,
      { input: { id: gid, status: "ACTIVE" } },
      { mutation: true }
    );
    const actErrs = act.productUpdate.userErrors;
    if (actErrs?.length) { await refuse(pid, `productUpdate userErrors: ${JSON.stringify(actErrs)} — NOT confirmed on`); continue; }
    if (act.productUpdate.product?.status !== "ACTIVE") {
      await refuse(pid, `productUpdate returned status ${act.productUpdate.product?.status} — NOT confirmed on`);
      continue;
    }
    await confirmLiveState(db, pid, "on", UPDATED_BY, { gid });
    const numericId = gid.split("/").pop();
    results.push({
      pid, ok: true,
      note: `LIVE on the Online Store — "${title}" · https://admin.shopify.com/store/nu3ei8-0p/products/${numericId}`,
    });
  } catch (e) {
    results.push({ pid, ok: false, why: String(e?.message || e) });
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log("\n══ RECONCILE REPORT ══");
for (const r of results) {
  console.log(r.ok ? `✓ ${r.pid}: ${r.note}` : `✗ ${r.pid}: ${r.why}`);
}
const failed = results.filter((r) => !r.ok).length;
process.exit(failed ? 1 : 0);

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
//                 record), then re-run the FULL compliance validator against
//                 the CANONICAL Shopify object at that moment, re-sync
//                 inventory, and publish to the Online Store sales channel.
//                 ANY failure refuses and marks the node blocked — the
//                 apply-time validator is the only thing between a mis-click
//                 and a public listing.
//   turning OFF — unpublish from the Online Store sales channel ONLY. Never
//                 archive, never delete, never touch the ID map: the product,
//                 its handle and its /shopify_sync entry all survive so the
//                 switch can go back on.
//
// Confirmed state is written back (confirmLiveState) so the page's pending
// marker clears. Idempotent: desired == confirmed is skipped, so a re-run
// after a partial failure resumes exactly where it stopped.
//
//   node scripts/shopify/reconcile.mjs                     dry run (default) — a table of what it WOULD do
//   node scripts/shopify/reconcile.mjs --commit            apply (hard cap 10 actions per run)
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
import { encodeSizeKey, assertSafeSegment } from "../../src/utils/sizeKey.js";
import { sortSizes, displaySizeName, findSizeCollisions } from "./sizeOrder.mjs";
import { cleanTitleFor, isTriggerFree, triggersInText } from "../../src/utils/shopifyTriggers.js";
import {
  VENDOR, CONDITIONS, buildDescriptionHtml, buildHandle, buildSeo, buildTags,
  validatePayload,
} from "./compliance.mjs";
import { buildMediaPlan, preflightPhotoUrls, attachMedia } from "./media.mjs";
import { networkTotals, requireSingleLocation, setAvailable } from "./inventory.mjs";
import { buildMapping, writeIdMap, claimShopifyProduct } from "./idMap.mjs";
import { readAllPublishNodes, confirmLiveState, markBlocked } from "./publishNode.mjs";

const MAX_APPLY = 10;
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
  console.log("\npid              action            title / note");
  for (const { pid, node, want } of worklist) {
    assertSafeSegment(pid, "productId");
    const mapNode = (await db.ref(`shopify_sync/${pid}`).get()).val();
    let action;
    if (want === "off") action = "UNPUBLISH";
    else action = mapNode?.shopifyProductId ? "PUBLISH" : "CREATE+PUBLISH";
    const title = node.cleanName || "(lexicon at apply time)";
    console.log(`${pid.padEnd(16)} ${action.padEnd(17)} "${title}"`);
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
const pubs = await graphql(`query { publications(first: 10) { nodes { id catalog { title } } } }`);
const online = pubs.publications.nodes.find((n) => /online store/i.test(n.catalog?.title ?? ""));
if (!online) { console.error("no Online Store publication found"); process.exit(1); }

const results = [];
const refuse = async (pid, why) => {
  console.error(`  🛑 ${pid} REFUSED: ${why}`);
  await markBlocked(db, pid, why, UPDATED_BY);
  results.push({ pid, ok: false, why: `blocked: ${why}` });
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
        // Nothing of ours exists on Shopify — "off" is already the truth.
        console.log("  no /shopify_sync mapping — nothing on Shopify to unpublish");
        await confirmLiveState(db, pid, "off", UPDATED_BY);
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
      await confirmLiveState(db, pid, "off", UPDATED_BY);
      results.push({ pid, ok: true, note: "unpublished from the Online Store channel" });
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
    if (problems.length) { await refuse(pid, problems.join("; ")); continue; }

    let mediaPlan;
    try { mediaPlan = buildMediaPlan(product, title); }
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
      if (uErrs?.length) { results.push({ pid, ok: false, why: `reconcile productUpdate userErrors: ${JSON.stringify(uErrs)}` }); continue; }
    } else {
      // CREATE — the old publish-run's draft pipeline, inline: photos answer
      // first, exact-title duplicate guard (a legacy or twin product must be
      // adopted deliberately, never claimed by accident), DRAFT create, atomic
      // gid claim, read-back → ID map, media attach.
      await preflightPhotoUrls(mediaPlan.map((m) => m.originalSource));
      const dupe = await graphql(
        `query ($q: String!) { products(first: 25, query: $q) { nodes { id title } } }`,
        { q: `title:'${payload.title.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'` }
      );
      if (dupe.products.nodes.some((n) => n.title === payload.title)) {
        results.push({ pid, ok: false, why: "a product with this exact title already exists — adopt via round-trip.mjs first" });
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
      if (errs?.length) { results.push({ pid, ok: false, why: `productSet userErrors: ${JSON.stringify(errs)}` }); continue; }
      gid = created.productSet.product?.id;
      if (!gid) { results.push({ pid, ok: false, why: "productSet returned no id" }); continue; }
      console.log(`  created ${gid}`);
      await claimShopifyProduct(db, pid, gid); // durable pointer before anything else can fail
    }

    // Read back → verified ID map (merge semantics) + media idempotency.
    const back = await graphql(
      `query ($id: ID!) {
        product(id: $id) {
          id
          media(first: 5) { nodes { id } }
          variants(first: 100) { pageInfo { hasNextPage } nodes { id title inventoryItem { id } } }
        }
      }`,
      { id: gid }
    );
    const bp = back.product;
    if (!bp) { results.push({ pid, ok: false, why: "read-back returned no product" }); continue; }
    if (bp.variants.pageInfo.hasNextPage) { results.push({ pid, ok: false, why: ">100 variants unpaginated" }); continue; }
    const sizeByDisplay = new Map(sizes.map((s) => [displaySizeName(s), s]));
    const rows = bp.variants.nodes
      .filter((v) => sizeByDisplay.has(v.title) && v.inventoryItem?.id)
      .map((v) => ({ size: sizeByDisplay.get(v.title), variantId: v.id, inventoryItemId: v.inventoryItem.id }));
    if (!rows.length) { results.push({ pid, ok: false, why: "no read-back variant matches any catalogue size" }); continue; }
    await writeIdMap(db, pid, buildMapping(gid, rows));
    if ((bp.media?.nodes?.length ?? 0) === 0) {
      await preflightPhotoUrls(mediaPlan.map((m) => m.originalSource));
      const { count } = await attachMedia(graphql, gid, mediaPlan);
      console.log(`  media READY: ${count}`);
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
          media(first: 50) { nodes { alt } }
          variants(first: 100) { nodes { sku } }
        }
      }`,
      { id: gid }
    );
    const cp = canon.product;
    if (!cp) { results.push({ pid, ok: false, why: `${gid} not found on the shop` }); continue; }
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

    // Publish to the Online Store channel, then make the product ACTIVE.
    const pubRes = await graphql(
      `mutation ($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) { userErrors { field message } }
      }`,
      { id: gid, input: [{ publicationId: online.id }] },
      { mutation: true }
    );
    const pubErrs = pubRes.publishablePublish.userErrors;
    if (pubErrs?.length) { results.push({ pid, ok: false, why: `publishablePublish userErrors: ${JSON.stringify(pubErrs)}` }); continue; }
    const act = await graphql(
      `mutation ($input: ProductUpdateInput!) {
        productUpdate(product: $input) { product { id status } userErrors { field message } }
      }`,
      { input: { id: gid, status: "ACTIVE" } },
      { mutation: true }
    );
    const actErrs = act.productUpdate.userErrors;
    if (actErrs?.length) { results.push({ pid, ok: false, why: `productUpdate userErrors: ${JSON.stringify(actErrs)} — NOT confirmed on` }); continue; }
    if (act.productUpdate.product?.status !== "ACTIVE") {
      results.push({ pid, ok: false, why: `productUpdate returned status ${act.productUpdate.product?.status} — NOT confirmed on` });
      continue;
    }
    await confirmLiveState(db, pid, "on", UPDATED_BY);
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

// ── The nominated-products push: RTDB → Shopify DRAFTs ───────────────────────
// Pushes products Junid nominated on the home-page Shopify card
// (/shopify_publish state "nominated") as DRAFT products with title,
// description, SEO, tags, photos and one-pool inventory — everything passing
// the full-field compliance validator first.
//
//   node scripts/shopify/publish-run.mjs                dry run — payloads printed, nothing written
//   node scripts/shopify/publish-run.mjs --commit       create DRAFTs (hard cap 10 per run)
//   node scripts/shopify/publish-run.mjs --commit --pids p1,p2   only these records
//   … --commit --publish <pid>                          make ONE draft storefront-visible.
//                                                       BUILT BUT NOT RUN in this slice —
//                                                       the owner runs it, deliberately.
//
// Safety rails (owner spec 2026-08-13):
//   • DRAFT only. NOTHING becomes storefront-visible without the explicit
//     --publish flag naming one product.
//   • Hard cap: 10 products per run.
//   • RTDB writes: /shopify_sync (ID map) and /shopify_publish (state) ONLY.
//   • Condition unset → state=blocked, never pushed, never defaulted.
//   • A validator rejection STOPS the run (exit 1) — nothing partial ships
//     after a compliance failure.
//   • A 404ing photo fails that product loudly BEFORE any Shopify write.
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
import { readAllPublishNodes, setPublishState } from "./publishNode.mjs";

const MAX_PUSH = 10;
const flags = process.argv.slice(2);
const COMMIT = flags.includes("--commit");
const pidIdx = flags.indexOf("--pids");
const pidArg = pidIdx !== -1 ? flags[pidIdx + 1] : null;
if (pidIdx !== -1 && (!pidArg || pidArg.startsWith("--"))) {
  console.error("--pids needs a comma-separated productId list");
  process.exit(2);
}
const ONLY = pidArg ? new Set(pidArg.split(",")) : null;
const pubIdx = flags.indexOf("--publish");
const PUBLISH_PID = pubIdx !== -1 ? flags[pubIdx + 1] : null;
if (pubIdx !== -1 && (!PUBLISH_PID || PUBLISH_PID.startsWith("--"))) {
  console.error("--publish needs a productId (one at a time, deliberately)");
  process.exit(2);
}

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

// ── Worklist: nominated products, capped ─────────────────────────────────────
// --publish is a STANDALONE owner action on one existing draft — it never
// piggybacks a batch of new drafts (a surprising side effect), and it needs
// no --commit (publishing is inherently a commit).
const publishNodes = PUBLISH_PID ? {} : await readAllPublishNodes(db);
let worklist = Object.entries(publishNodes)
  .filter(([pid, n]) => n?.state === "nominated" && (!ONLY || ONLY.has(pid)))
  .map(([pid, node]) => ({ pid, node }));
if (worklist.length > MAX_PUSH) {
  console.error(`⚠ ${worklist.length} nominated — pushing the first ${MAX_PUSH} only (hard cap)`);
  worklist = worklist.slice(0, MAX_PUSH);
}
console.log(`nominated products in this run: ${worklist.length}`);
if (!worklist.length && !PUBLISH_PID) process.exit(0);

// ── Build every payload FIRST; any validator rejection stops the run ─────────
const stockTree = COMMIT || worklist.length ? (await db.ref("stock").get()).val() || {} : {};
const jobs = [];
const blocked = [];
for (const { pid, node } of worklist) {
  const product = (await db.ref(`products/${assertSafeSegment(pid, "productId")}`).get()).val();
  if (!product) { blocked.push({ pid, why: "no /products record" }); continue; }
  // A record merged away after nomination is a dead identity — its stock,
  // barcodes and sales now belong to the survivor. Never push it.
  if (product.mergedInto) { blocked.push({ pid, why: `merged into ${product.mergedInto} — nominate the survivor` }); continue; }

  // Condition gate — NO default, unset means blocked (owner spec).
  if (!CONDITIONS.includes(node.condition)) {
    if (COMMIT) await setPublishState(db, pid, "blocked", "script:publish-run");
    blocked.push({ pid, why: `condition unset/invalid → state=blocked` });
    continue;
  }

  // Title: the card/AI cleanName wins when still trigger-free; else lexicon.
  let title = null;
  if (node.cleanName && isTriggerFree(node.cleanName)) {
    title = String(node.cleanName).trim();
  } else if (node.cleanName) {
    blocked.push({ pid, why: `cleanName trips the lexicon now (${triggersInText(node.cleanName).join(", ")}) — re-name it` });
    continue;
  } else {
    const named = cleanTitleFor(product);
    if (named.needsAI) { blocked.push({ pid, why: `no cleanName and lexicon can't clean (${named.reason})` }); continue; }
    title = named.title;
  }

  const problems = [];
  if (!(Number(product.retailPrice) > 0)) problems.push("no retailPrice > 0");
  const sizes = Array.isArray(product.sizes) && product.sizes.length ? sortSizes(product.sizes) : null;
  if (!sizes) problems.push("no sizes array");
  if (sizes) problems.push(...findSizeCollisions(sizes));
  if (problems.length) { blocked.push({ pid, why: problems.join("; ") }); continue; }

  const mediaPlan = (() => {
    try { return buildMediaPlan(product, title); }
    catch (e) { blocked.push({ pid, why: String(e?.message || e) }); return null; }
  })();
  if (!mediaPlan) continue;

  // Variant SKUs are pushed fields too — validated with everything else
  // (catalogue SKUs are 4-digit codes today, but the gate fails closed).
  const variantSkus = product.sku
    ? sizes.map((s) => ({ sku: `${product.sku}-${encodeSizeKey(s)}` }))
    : [];
  const payload = {
    title,
    handle: buildHandle(title),
    vendor: VENDOR,
    productType: product.subcategory || product.category || "",
    tags: buildTags(product),
    descriptionHtml: buildDescriptionHtml(node.condition),
    seo: buildSeo(title, node.condition),
    media: mediaPlan,
    variants: variantSkus,
  };
  const verdict = validatePayload(payload);
  if (!verdict.ok) {
    console.error(`🛑 VALIDATOR REJECTED ${pid} "${product.name}":`);
    for (const v of verdict.violations) console.error(`   ${v.field}: ${v.problem}`);
    console.error("Stopping the run — nothing partial ships after a compliance failure.");
    process.exit(1);
  }
  jobs.push({ pid, node, product, sizes, payload, mediaPlan });
}

for (const b of blocked) console.error(`  ✗ skipped ${b.pid}: ${b.why}`);
console.log(`payloads built and validated: ${jobs.length}`);

if (!COMMIT && !PUBLISH_PID) {
  for (const j of jobs) {
    console.log(`\n── ${j.pid}  "${j.product.name}"`);
    console.log(JSON.stringify({ ...j.payload, media: j.payload.media.map((m) => ({ ...m, originalSource: m.originalSource.slice(0, 60) + "…" })) }, null, 2));
    console.log(`   sizes: ${j.sizes.join(", ")} · price ${Number(j.product.retailPrice).toFixed(2)}`);
    console.log(`   inventory: ${JSON.stringify(networkTotals(stockTree, j.pid, j.sizes))}`);
  }
  console.log("\ndry run — nothing written. Re-run with --commit to create DRAFTs.");
  process.exit(0);
}

// ── Commit path ──────────────────────────────────────────────────────────────
const locationId = jobs.length ? await requireSingleLocation(graphql) : null;
const results = [];
for (const j of jobs) {
  const { pid, product, sizes, payload, mediaPlan } = j;
  console.log(`\n▶ ${pid}  "${payload.title}"`);
  try {
    // Re-check the nomination at the last moment — the card may have
    // withdrawn or re-conditioned it since the worklist was read.
    const fresh = (await db.ref(`shopify_publish/${pid}`).get()).val();
    if (fresh?.state !== "nominated" || fresh?.condition !== j.node.condition) {
      results.push({ pid, ok: false, why: `nomination changed since the run started (state=${fresh?.state}) — skipped` });
      continue;
    }

    // Photos must answer BEFORE anything is created.
    await preflightPhotoUrls(mediaPlan.map((m) => m.originalSource));

    // Map-first (same authority order as round-trip.mjs): existing map →
    // reconcile that product; else exact-title duplicate guard; else create.
    const mapNode = (await db.ref(`shopify_sync/${pid}`).get()).val();
    let gid = mapNode?.shopifyProductId ?? null;
    if (gid) {
      // RECONCILE means the validated payload fields too, not just media and
      // inventory — a card rename or condition change after the draft was
      // created must land on Shopify on the next run.
      console.log(`  /shopify_sync maps to ${gid} — reconciling fields, media, inventory`);
      const upd = await graphql(
        `mutation ($input: ProductUpdateInput!) {
          productUpdate(product: $input) { product { id } userErrors { field message } }
        }`,
        {
          input: {
            id: gid,
            title: payload.title,
            handle: payload.handle,
            vendor: payload.vendor,
            productType: payload.productType,
            tags: payload.tags,
            descriptionHtml: payload.descriptionHtml,
            seo: payload.seo,
          },
        },
        { mutation: true }
      );
      const uErrs = upd.productUpdate.userErrors;
      if (uErrs?.length) { results.push({ pid, ok: false, why: `reconcile productUpdate userErrors: ${JSON.stringify(uErrs)}` }); continue; }
    } else {
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
            status: "DRAFT", // never storefront-visible in this run
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
      console.log(`  created DRAFT ${gid}`);
      await claimShopifyProduct(db, pid, gid); // durable pointer before anything else can fail
    }

    // Read back variants → ID map (verified pairs only, merge semantics).
    const back = await graphql(
      `query ($id: ID!) {
        product(id: $id) {
          id title status handle
          media(first: 5) { nodes { id } }
          variants(first: 100) { pageInfo { hasNextPage } nodes { id title inventoryItem { id } } }
        }
      }`,
      { id: gid }
    );
    const p = back.product;
    if (!p) { results.push({ pid, ok: false, why: "read-back returned no product (pending pointer kept)" }); continue; }
    if (p.variants.pageInfo.hasNextPage) { results.push({ pid, ok: false, why: ">100 variants unpaginated" }); continue; }
    const sizeByDisplay = new Map(sizes.map((s) => [displaySizeName(s), s]));
    const rows = p.variants.nodes
      .filter((v) => sizeByDisplay.has(v.title) && v.inventoryItem?.id)
      .map((v) => ({ size: sizeByDisplay.get(v.title), variantId: v.id, inventoryItemId: v.inventoryItem.id }));
    if (!rows.length) { results.push({ pid, ok: false, why: "no read-back variant matches any catalogue size" }); continue; }
    await writeIdMap(db, pid, buildMapping(gid, rows));

    // Photos — idempotent: attach only when the product has none yet.
    if ((p.media?.nodes?.length ?? 0) === 0) {
      const { count } = await attachMedia(graphql, gid, mediaPlan);
      console.log(`  media READY: ${count}`);
    } else {
      console.log(`  media already present (${p.media.nodes.length}) — not re-attaching`);
    }

    // Inventory — absolute network totals at the single location, from a
    // FRESH read of this product's cells (the run-start snapshot only names
    // the locations): a sale mid-run must not be pushed back as sellable.
    const freshTree = {};
    for (const loc of Object.keys(stockTree)) {
      const cells = (await db.ref(`stock/${loc}/${pid}`).get()).val();
      if (cells) freshTree[loc] = { [pid]: cells };
    }
    const totals = networkTotals(freshTree, pid, sizes);
    await setAvailable(
      graphql,
      locationId,
      rows.map((r) => ({ inventoryItemId: r.inventoryItemId, quantity: totals[encodeSizeKey(r.size)] ?? 0 }))
    );
    console.log(`  inventory set: ${JSON.stringify(totals)}`);

    await setPublishState(db, pid, "draft", "script:publish-run");
    const numericId = gid.split("/").pop();
    results.push({
      pid, ok: true, gid,
      adminUrl: `https://admin.shopify.com/store/nu3ei8-0p/products/${numericId}`,
      title: payload.title, condition: j.node.condition,
      fields: Object.keys(payload).join(", "),
      variants: rows.length, media: mediaPlan.length, inventory: totals,
    });
  } catch (e) {
    results.push({ pid, ok: false, why: String(e?.message || e) });
  }
}

// ── Optional, owner-run only: make ONE draft storefront-visible ──────────────
if (PUBLISH_PID) {
  assertSafeSegment(PUBLISH_PID, "productId");
  const mapNode = (await db.ref(`shopify_sync/${PUBLISH_PID}`).get()).val();
  if (!mapNode?.shopifyProductId) {
    console.error(`--publish ${PUBLISH_PID}: no /shopify_sync mapping — push it as a draft first`);
    process.exit(1);
  }

  // FAIL-CLOSED GATE: the draft may have been edited in the Shopify admin (or
  // created by an older tool) since it was pushed — re-read the CANONICAL
  // object and run the full-field validator on what is actually there. A
  // trigger anywhere refuses; nothing becomes storefront-visible unvalidated.
  const liveNode = (await db.ref(`shopify_publish/${PUBLISH_PID}`).get()).val();
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
    { id: mapNode.shopifyProductId }
  );
  const cp = canon.product;
  if (!cp) { console.error(`--publish: ${mapNode.shopifyProductId} not found on the shop`); process.exit(1); }
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
  if (!verdict.ok) {
    console.error(`🛑 --publish REFUSED: the product on Shopify fails the compliance validator:`);
    for (const v of verdict.violations) console.error(`   ${v.field}: ${v.problem}`);
    process.exit(1);
  }
  if (liveNode?.condition && !cp.descriptionHtml.includes(liveNode.condition)) {
    console.error(
      `⚠ the card's condition ("${liveNode.condition}") is not the one in the live ` +
        `description — update the draft before publishing if that matters.`
    );
  }

  // Re-sync inventory at the moment it starts mattering to real customers —
  // draft-time quantities can be days stale by the time the owner publishes.
  const pubProduct = (await db.ref(`products/${PUBLISH_PID}`).get()).val();
  const pubSizes = Array.isArray(pubProduct?.sizes) ? sortSizes(pubProduct.sizes) : null;
  if (pubSizes && mapNode.variants) {
    const locNames = Object.keys((await db.ref("stock").get()).val() || {});
    const tree = {};
    for (const loc of locNames) {
      const cells = (await db.ref(`stock/${loc}/${PUBLISH_PID}`).get()).val();
      if (cells) tree[loc] = { [PUBLISH_PID]: cells };
    }
    const totals = networkTotals(tree, PUBLISH_PID, pubSizes);
    const locId = await requireSingleLocation(graphql);
    await setAvailable(
      graphql,
      locId,
      Object.entries(mapNode.variants).map(([sizeKey, v]) => ({
        inventoryItemId: v.shopifyInventoryItemId,
        quantity: totals[sizeKey] ?? 0,
      }))
    );
    console.log(`  pre-publish inventory re-sync: ${JSON.stringify(totals)}`);
  }

  const pubs = await graphql(
    `query { publications(first: 10) { nodes { id catalog { title } } } }`
  );
  const online = pubs.publications.nodes.find((n) => /online store/i.test(n.catalog?.title ?? ""));
  if (!online) { console.error("no Online Store publication found"); process.exit(1); }
  const res = await graphql(
    `mutation ($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) { userErrors { field message } }
    }`,
    { id: mapNode.shopifyProductId, input: [{ publicationId: online.id }] },
    { mutation: true }
  );
  const errs = res.publishablePublish.userErrors;
  if (errs?.length) { console.error(`publishablePublish userErrors: ${JSON.stringify(errs)}`); process.exit(1); }
  const upd = await graphql(
    `mutation ($input: ProductUpdateInput!) {
      productUpdate(product: $input) { product { id status } userErrors { field message } }
    }`,
    { input: { id: mapNode.shopifyProductId, status: "ACTIVE" } },
    { mutation: true }
  );
  const updErrs = upd.productUpdate.userErrors;
  if (updErrs?.length) { console.error(`productUpdate userErrors: ${JSON.stringify(updErrs)} — NOT marking live`); process.exit(1); }
  if (upd.productUpdate.product?.status !== "ACTIVE") {
    console.error(`productUpdate returned status ${upd.productUpdate.product?.status} — NOT marking live`);
    process.exit(1);
  }
  await setPublishState(db, PUBLISH_PID, "live", "script:publish-run");
  console.log(`published ${PUBLISH_PID} → live`);
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log("\n══ RUN REPORT ══");
for (const r of results) {
  if (r.ok) {
    console.log(`✓ ${r.pid}`);
    console.log(`    admin:     ${r.adminUrl}`);
    console.log(`    title:     "${r.title}"`);
    console.log(`    condition: ${r.condition}`);
    console.log(`    fields:    ${r.fields}`);
    console.log(`    variants ${r.variants} · media ${r.media} · inventory ${JSON.stringify(r.inventory)}`);
  } else {
    console.log(`✗ ${r.pid}: ${r.why}`);
  }
}
const failed = results.filter((r) => !r.ok).length;
process.exit(failed ? 1 : 0);

// ── PRICE: the app owns it, Shopify follows ──────────────────────────────────
//
// WHAT WAS BROKEN (6 Nov 2026). reconcile.mjs wrote a product's price to
// Shopify only inside the block that applies a publish INTENT — at creation, or
// when a mapped product is switched on. Once a product was live and on, that
// block never ran for it again, so any later app price edit (Edit price,
// bulk pricing, specials, New Arrivals, Missing prices) never reached the
// website. Junid caught it on Air Jordan 1 Low Travis Scott Brown Pink
// (p1778140291773): R700 in the app, R450 on marathonclub.co.za. Same shape as
// the inventory defect closed in September (shopify-inventory-dirty.cjs).
//
// THE FIX, two legs, same as inventory:
//   FAST — the shopifyPriceDirty trigger (functions/lib/shopify-price-dirty.cjs)
//     writes /shopify_price_dirty/{pid} when /products/{pid}/retailPrice
//     changes on a listed product. sweepPriceDirty drains it every commit
//     tick, so an app price edit reaches the website within one tick.
//   BACKSTOP — sweepPriceBackstop compares EVERY listed product with Shopify
//     on its own cadence (one bulk query, no throttle) and corrects whatever
//     disagrees, whatever caused it: a missed marker, a price typed in Shopify
//     admin, an import. The app owns price; Shopify's own value is never
//     copied back.
//
// The price pushed is ALWAYS retailPrice, never stockPrice (the trade price).
// shopifyPriceFor is the one place that decision is made; reconcile.mjs's
// create and switch-on paths use it too (priceSync.test.mjs pins both).
//
// Every correction is printed to the reconcile log and recorded at
// /shopify_sync/_priceLog/{pid} (last correction: when, from, to, source).
import { isPriceRecord } from "../../src/utils/productCategory.js";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import { clearMarker } from "./inventorySync.mjs";
import { runBulkQuery } from "./bulkSnapshot.mjs";

export const PRICE_DIRTY_PATH = "shopify_price_dirty";
export const PRICE_LOG_PATH = "shopify_sync/_priceLog";
// Markers drained per tick. Each costs one Shopify read and at most one write.
export const PRICE_MAX_PER_RUN = 40;
// The backstop's cadence. One bulk query plus two tiny RTDB reads per listed
// product (~2,300 today), so it is not run every two-minute tick.
export const PRICE_BACKSTOP_INTERVAL_MS = 3 * 60 * 60 * 1000;
// Corrections one backstop run may write. A run that finds more than this is
// not a drift, it is a systemic fault (wrong field, bad import) — it stops and
// says so instead of rewriting the whole catalogue unattended.
export const PRICE_BACKSTOP_MAX_FIXES = 150;

/**
 * The price Shopify must show for this record, as Shopify's decimal string —
 * or null when the record has no usable retail price (then nothing is pushed:
 * a blank or zero retail must never become a R0.00 listing).
 *
 * RETAIL ONLY. stockPrice is the trade price and is never read here.
 */
export function shopifyPriceFor(product) {
  if (!product || isPriceRecord(product)) return null;
  const n = Number(product.retailPrice);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n.toFixed(2);
}

const cents = (v) => Math.round(Number(v) * 100);

/**
 * PURE: which variants disagree with the app. variants = [{ id, price }].
 * Compared in whole cents, so "700" and "700.00" agree.
 */
export function planPriceFix(want, variants) {
  if (want == null) return [];
  return (variants || [])
    .filter((v) => v?.id && cents(v.price) !== cents(want))
    .map((v) => ({ id: v.id, from: String(v.price), to: want }));
}

/** Which of the three suspects a mismatch looks like (for reports). */
export function driftPattern({ retail, trade, shopify }) {
  if (shopify == null || retail == null) return "unknown";
  if (cents(shopify) === cents(retail)) return "in step";
  if (trade != null && Number(trade) > 0 && cents(shopify) === cents(trade)) return "1: trade price pushed";
  return "2/3: app price changed after publish, or edited in Shopify";
}

async function readVariants(graphql, gid) {
  const r = await graphql(
    `query ($id: ID!) { product(id: $id) { id variants(first: 100) { pageInfo { hasNextPage } nodes { id price } } } }`,
    { id: gid }
  );
  if (!r.product) return null;
  if (r.product.variants.pageInfo.hasNextPage) throw new Error(">100 variants — not priced");
  return r.product.variants.nodes;
}

async function writePrices(graphql, gid, fixes) {
  const r = await graphql(
    `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
    }`,
    { productId: gid, variants: fixes.map((f) => ({ id: f.id, price: f.to })) },
    { mutation: true }
  );
  const errs = r.productVariantsBulkUpdate.userErrors;
  if (errs?.length) throw new Error(`variant price update userErrors: ${JSON.stringify(errs)}`);
}

/**
 * Bring one product's Shopify price in line with the app. Always re-reads
 * Shopify before writing — a snapshot is never the baseline for a write.
 * → { pid, ok, changed, from?, to?, why? }
 */
export async function syncProductPrice(db, graphql, pid, { commit = false, source = "marker", now = () => Date.now(), log = () => {} } = {}) {
  assertSafeSegment(pid, "productId");
  const [product, gid] = await Promise.all([
    db.ref(`products/${pid}`).get().then((s) => s.val()),
    db.ref(`shopify_sync/${pid}/shopifyProductId`).get().then((s) => s.val()),
  ]);
  if (!gid) return { pid, ok: true, changed: false, why: "no Shopify mapping" };
  const want = shopifyPriceFor(product);
  if (want == null) return { pid, ok: false, changed: false, why: "no retailPrice > 0 on the record — Shopify left as it is" };
  const variants = await readVariants(graphql, gid);
  if (!variants) return { pid, ok: false, changed: false, productGone: true, why: `${gid} is not on Shopify` };
  const fixes = planPriceFix(want, variants);
  if (!fixes.length) return { pid, ok: true, changed: false };
  const from = [...new Set(fixes.map((f) => f.from))].join("/");
  if (!commit) return { pid, ok: true, changed: false, wouldChange: true, from, to: want, fixes };
  await writePrices(graphql, gid, fixes);
  await db.ref(`${PRICE_LOG_PATH}/${pid}`).set({
    at: now(), from, to: want, variants: fixes.length, source, gid,
  });
  log(`  price ${pid}: Shopify R${from} → R${want} (${fixes.length} variant(s), ${source})`);
  return { pid, ok: true, changed: true, from, to: want };
}

/**
 * FAST LEG: drain /shopify_price_dirty. A marker is cleared only when it still
 * holds the revision processed, so an edit landing mid-push is not lost.
 */
export async function sweepPriceDirty(db, graphql, { commit = false, isLive, max = PRICE_MAX_PER_RUN, now, log = () => {} } = {}) {
  const markers = (await db.ref(PRICE_DIRTY_PATH).get()).val() || {};
  const pids = Object.keys(markers).sort().slice(0, max);
  const out = { seen: Object.keys(markers).length, pushed: 0, cleared: 0, kept: 0, results: [] };
  for (const pid of pids) {
    const revision = markers[pid];
    try {
      if (!(await isLive(pid))) {
        if (commit && await clearMarker(db, pid, revision, PRICE_DIRTY_PATH)) out.cleared++;
        continue;
      }
      const r = await syncProductPrice(db, graphql, pid, { commit, source: "app edit", now, log });
      out.results.push(r);
      if (r.changed) out.pushed++;
      // A record with no retail, or a product gone from Shopify, will not
      // become pushable by retrying every tick; the backstop re-judges it.
      if (commit && await clearMarker(db, pid, revision, PRICE_DIRTY_PATH)) out.cleared++;
      else out.kept++;
    } catch (e) {
      out.kept++;
      out.results.push({ pid, ok: false, why: String(e?.message || e) });
    }
  }
  return out;
}

export function priceBulkQuery() {
  return `{
    products(query: "status:active") {
      edges { node { id variants { edges { node { id price } } } } }
    }
  }`;
}

/** PURE: bulk JSONL → Map(productGid → [{ id, price }]). */
export function parsePriceSnapshot(jsonl) {
  const products = new Map();
  const variants = [];
  for (const line of String(jsonl || "").split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o.__parentId) variants.push(o);
    else if (String(o.id).includes("/Product/")) products.set(o.id, []);
  }
  for (const v of variants) products.get(v.__parentId)?.push({ id: v.id, price: v.price });
  return products;
}

/** Run `fn` over `items`, `width` at a time. */
export async function inBatches(items, width, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += width) {
    out.push(...await Promise.all(items.slice(i, i + width).map(fn)));
  }
  return out;
}

/**
 * Every listed product: the app's prices beside Shopify's. Read-only.
 * → [{ pid, gid, retail, trade, want, variants, fixes }]
 */
export async function comparePrices(db, graphql, pids, { snapshot = null, log = () => {} } = {}) {
  const snap = snapshot ?? parsePriceSnapshot(await runBulkQuery(graphql, priceBulkQuery(), { log }));
  return inBatches(pids, 25, async (pid) => {
    const [retail, trade, gid] = await Promise.all([
      db.ref(`products/${pid}/retailPrice`).get().then((s) => s.val()),
      db.ref(`products/${pid}/stockPrice`).get().then((s) => s.val()),
      db.ref(`shopify_sync/${pid}/shopifyProductId`).get().then((s) => s.val()),
    ]);
    const variants = gid ? snap.get(gid) ?? null : null;
    const want = shopifyPriceFor({ retailPrice: retail });
    return { pid, gid, retail, trade, want, variants, fixes: variants ? planPriceFix(want, variants) : [] };
  });
}

/**
 * BACKSTOP: correct every listed product whose Shopify price disagrees with
 * the app. Refuses to write anything when more than maxFixes disagree.
 */
export async function sweepPriceBackstop(db, graphql, { livePids, commit = false, maxFixes = PRICE_BACKSTOP_MAX_FIXES, now, log = () => {} } = {}) {
  const rows = await comparePrices(db, graphql, livePids, { log });
  const drifted = rows.filter((r) => r.fixes.length);
  const out = { checked: rows.length, drifted: drifted.length, fixed: 0, failed: 0, refused: false, results: [] };
  if (drifted.length > maxFixes) {
    out.refused = true;
    log(`  ‼ price backstop: ${drifted.length} listings disagree with the app (cap ${maxFixes}) — NOT correcting; run scripts/shopify/price-drift.mjs and look`);
    return out;
  }
  for (const r of drifted) {
    try {
      const res = await syncProductPrice(db, graphql, r.pid, { commit, source: "backstop", now, log });
      out.results.push(res);
      if (res.changed) out.fixed++;
    } catch (e) {
      out.failed++;
      out.results.push({ pid: r.pid, ok: false, why: String(e?.message || e) });
    }
  }
  return out;
}

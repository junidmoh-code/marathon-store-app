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
//
// RRP (13 Nov 2026). Every push also carries the variant's compareAtPrice — the
// struck-through "RRP" the website shows above the price. It is DERIVED here,
// at push time, from the same app price (src/utils/shopifyRrp.js: rrpFor) and
// the per-product chip /shopify_publish/{pid}/rrpDiscountPct (65 or 70). It is
// never stored as a second price on /products and the till never sees it.
// compareAtPrice is part of the drift comparison, so a price edit moves the RRP
// with it on the next tick, a wrong RRP is corrected by the backstop, and a
// listing already showing the right pair is never re-pushed.
import { isPriceRecord } from "../../src/utils/productCategory.js";
import { rrpFor, rrpDiscountPctOf } from "../../src/utils/shopifyRrp.js";
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
 * The compareAtPrice ("RRP") Shopify must show, as a decimal string, or null
 * when there must be none (no usable retail price → no RRP; Shopify clears it).
 * `publishNode` is /shopify_publish/{pid} — only its rrpDiscountPct is read.
 */
export function shopifyCompareAtFor(product, publishNode) {
  const price = shopifyPriceFor(product);
  if (price == null) return null;
  const rrp = rrpFor(price, rrpDiscountPctOf(publishNode));
  return rrp == null ? null : rrp.toFixed(2);
}

const blank = (v) => v == null || v === "";
/** Same compare-at? Both absent agree; otherwise compared in whole cents. */
const sameCompareAt = (a, b) => (blank(a) || blank(b) ? blank(a) && blank(b) : cents(a) === cents(b));

/**
 * PURE: which variants disagree with the app. variants = [{ id, price,
 * compareAtPrice }]. Price compared in whole cents, so "700" and "700.00"
 * agree. `wantCompareAt` null means "no RRP": a variant still carrying one is
 * cleared. With no app price (`want` null) the price is never touched — only a
 * stale RRP is cleared, since an RRP above an unknown price means nothing.
 * Each fix: { id, from, to, fromCompareAt, toCompareAt } (`to` null = leave
 * the price alone).
 */
export function planPriceFix(want, variants, wantCompareAt = null) {
  const toCompareAt = want == null ? null : wantCompareAt;
  return (variants || [])
    .filter((v) => v?.id && ((want != null && cents(v.price) !== cents(want)) || !sameCompareAt(v.compareAtPrice, toCompareAt)))
    .map((v) => ({ id: v.id, from: String(v.price), to: want, fromCompareAt: blank(v.compareAtPrice) ? null : String(v.compareAtPrice), toCompareAt }));
}

/**
 * The RRP chip was tapped while a publish was in flight: the push used the
 * node read at the start (`usedNode`), the chip has since moved, and the
 * shopifyRrpDirty function skipped it because the product was not live yet.
 * Called right after a product is confirmed live — marks its price dirty so
 * the next tick pushes the right RRP instead of waiting for the backstop.
 */
export async function markPriceDirtyIfRrpMoved(db, pid, usedNode, increment) {
  const now = (await db.ref(`shopify_publish/${pid}/rrpDiscountPct`).get()).val();
  if (rrpDiscountPctOf({ rrpDiscountPct: now }) === rrpDiscountPctOf(usedNode)) return false;
  await db.ref(`${PRICE_DIRTY_PATH}/${pid}`).set(increment(1));
  return true;
}

/** The productVariantsBulkUpdate input for a fix list. */
export function variantInputsFor(fixes) {
  return fixes.map((f) => ({ id: f.id, ...(f.to != null ? { price: f.to } : {}), compareAtPrice: f.toCompareAt }));
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
    `query ($id: ID!) { product(id: $id) { id variants(first: 100) { pageInfo { hasNextPage } nodes { id price compareAtPrice } } } }`,
    { id: gid }
  );
  if (!r.product) return null;
  // >100 variants is permanent, not a blip: say so and stop, rather than throw
  // and have the marker retried every tick for ever.
  if (r.product.variants.pageInfo.hasNextPage) return { tooMany: true };
  return r.product.variants.nodes;
}

async function writePrices(graphql, gid, fixes) {
  const r = await graphql(
    `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
    }`,
    { productId: gid, variants: variantInputsFor(fixes) },
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
export async function syncProductPrice(db, graphql, pid, { commit = false, source = "marker", now = () => Date.now(), log = () => {}, beforeWrite = async () => {} } = {}) {
  assertSafeSegment(pid, "productId");
  const [product, gid, rrpDiscountPct] = await Promise.all([
    db.ref(`products/${pid}`).get().then((s) => s.val()),
    db.ref(`shopify_sync/${pid}/shopifyProductId`).get().then((s) => s.val()),
    db.ref(`shopify_publish/${pid}/rrpDiscountPct`).get().then((s) => s.val()),
  ]);
  if (!gid) return { pid, ok: true, changed: false, why: "no Shopify mapping" };
  // A merge loser's price is stale by definition — the survivor carries the
  // product now. Never price a loser's listing (the publish path refuses it too).
  if (product?.mergedInto) return { pid, ok: true, changed: false, why: `merged into ${product.mergedInto}` };
  const want = shopifyPriceFor(product);
  const wantCompareAt = shopifyCompareAtFor(product, { rrpDiscountPct });
  const noRetail = "no retailPrice > 0 on the record — Shopify price left as it is";
  const variants = await readVariants(graphql, gid);
  if (!variants) return { pid, ok: false, changed: false, productGone: true, why: `${gid} is not on Shopify` };
  if (variants.tooMany) return { pid, ok: false, changed: false, why: ">100 variants on Shopify — not priced automatically" };
  const fixes = planPriceFix(want, variants, wantCompareAt);
  // No app price: the price is left alone, but an RRP still showing above it is
  // cleared (the fixes then carry only compareAtPrice: null).
  if (!fixes.length) return want == null ? { pid, ok: false, changed: false, why: noRetail } : { pid, ok: true, changed: false };
  const from = [...new Set(fixes.map((f) => f.from))].join("/");
  const fromCompareAt = [...new Set(fixes.map((f) => f.fromCompareAt ?? "none"))].join("/");
  const toCompareAt = wantCompareAt ?? "none";
  if (!commit) return { pid, ok: true, changed: false, wouldChange: true, from, to: want, fromCompareAt, toCompareAt, fixes };
  // The exact product + variant values this write was planned from, handed to
  // the caller BEFORE the write so a rollback restores what was really changed.
  await beforeWrite({ pid, gid, before: variants.map((v) => ({ id: v.id, price: v.price, compareAtPrice: v.compareAtPrice ?? null })) });
  await writePrices(graphql, gid, fixes);
  await db.ref(`${PRICE_LOG_PATH}/${pid}`).set({
    at: await now(), from, to: want, fromCompareAt, toCompareAt, variants: fixes.length, source, gid,
  });
  log(`  price ${pid}: Shopify R${from} → ${want == null ? "(left as it is)" : `R${want}`} · RRP ${fromCompareAt} → ${toCompareAt} (${fixes.length} variant(s), ${source})`);
  return { pid, ok: true, changed: true, from, to: want, fromCompareAt, toCompareAt, ...(want == null ? { why: noRetail } : {}) };
}

/**
 * FAST LEG: drain /shopify_price_dirty. A marker is cleared only when it still
 * holds the revision processed, so an edit landing mid-push is not lost.
 */
export async function sweepPriceDirty(db, graphql, { commit = false, isLive, max = PRICE_MAX_PER_RUN, now, log = () => {} } = {}) {
  const markers = (await db.ref(PRICE_DIRTY_PATH).get()).val() || {};
  // Rotating start: a marker that keeps failing (Shopify down for it) is kept,
  // and a fixed sorted slice would let 40 of those starve everything after
  // them. Starting at a random point gives every marker its turn.
  const all = Object.keys(markers).sort();
  const start = all.length > max ? Math.floor(Math.random() * all.length) : 0;
  const pids = Array.from({ length: Math.min(max, all.length) }, (_, i) => all[(start + i) % all.length]);
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
      edges { node { id variants { edges { node { id price compareAtPrice } } } } }
    }
  }`;
}

/** PURE: bulk JSONL → Map(productGid → [{ id, price, compareAtPrice }]). */
export function parsePriceSnapshot(jsonl) {
  const products = new Map();
  const variants = [];
  for (const line of String(jsonl || "").split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o.__parentId) variants.push(o);
    else if (String(o.id).includes("/Product/")) products.set(o.id, []);
  }
  for (const v of variants) products.get(v.__parentId)?.push({ id: v.id, price: v.price, compareAtPrice: v.compareAtPrice ?? null });
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
 * → [{ pid, gid, retail, trade, want, wantCompareAt, rrpDiscountPct, variants, fixes }]
 */
export async function comparePrices(db, graphql, pids, { snapshot = null, log = () => {} } = {}) {
  const snap = snapshot ?? parsePriceSnapshot(await runBulkQuery(graphql, priceBulkQuery(), { log }));
  return inBatches(pids, 25, async (pid) => {
    const [retail, trade, gid, rrpDiscountPct] = await Promise.all([
      db.ref(`products/${pid}/retailPrice`).get().then((s) => s.val()),
      db.ref(`products/${pid}/stockPrice`).get().then((s) => s.val()),
      db.ref(`shopify_sync/${pid}/shopifyProductId`).get().then((s) => s.val()),
      db.ref(`shopify_publish/${pid}/rrpDiscountPct`).get().then((s) => s.val()),
    ]);
    const variants = gid ? snap.get(gid) ?? null : null;
    const want = shopifyPriceFor({ retailPrice: retail });
    const wantCompareAt = shopifyCompareAtFor({ retailPrice: retail }, { rrpDiscountPct });
    return { pid, gid, retail, trade, want, wantCompareAt, rrpDiscountPct: rrpDiscountPctOf({ rrpDiscountPct }),
             variants, fixes: variants ? planPriceFix(want, variants, wantCompareAt) : [] };
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

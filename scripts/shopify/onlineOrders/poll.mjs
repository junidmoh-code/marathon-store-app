// ── One tick of the website-order poller ─────────────────────────────────────
// Runs on the Mac mini inside the reconciler's own tick, strictly BEFORE
// reconcile.mjs, so every hold exists before stock is pushed to Shopify
// (reconcile-runner.mjs). Everything it touches is injected — the database,
// Shopify, the clock, the mail sender — so the whole tick is tested against a
// fake (poll.test.mjs).
//
// What a tick does, in order:
//   1. PULL   orders Shopify changed since the cursor (and created since
//             go-live): new paid unfulfilled ones are written, routed and held;
//             cancelled ones are released (or flagged, if already packed).
//   2. KEEP   every open order: re-route lines Junid sent back (Resolve),
//             create the feed entries a line is missing while the switch is on
//             (this is also the backfill when he turns it on), re-derive the
//             status, raise attention, and make the hold rows match the lines.
//   3. SHIP   packed orders waiting on Shopify: bookShipment, then fulfil.
//   4. TELL   email Junid once for each attention not yet mailed.
//
// NOTHING HERE MOVES STOCK. Holds are /online_reservations rows; feed entries
// are instructions to people. The only stock movement an online order ever
// makes is the POS pack sale.
//
// No whole-node reads: orders by exact id or by an indexed status query; stock
// and holds by exact cell path; the variant map by exact pid.
import {
  ONLINE_ORDERS_PATH, ONLINE_RESERVATIONS_PATH, ONLINE_PICKS_PATH, ONLINE_ORDERS_CONFIG_PATH,
  ORDER_STATUS, LINE_STATUS, ATTENTION_KIND, HOLDING_STATUSES, TERMINAL_STATUSES, deriveOrderStatus,
} from "../../../src/utils/onlineOrders.js";
import { stockSizeKey, encodeSizeKey, decodeSizeKey, assertSafeSegment } from "../../../src/utils/sizeKey.js";
import { productIsFootwear } from "../../../src/utils/footwearLine.js";
import { availableAt, routeLines, ROUTED_LOCATIONS } from "./routing.mjs";
import {
  isIngestible, buildLine, buildOrder, holdRowsFor, sameHold, numericId, linesOf,
  pickKey, displayKey, pickEntry, displayEntry, attentionFromLines, placeName,
} from "./orderModel.mjs";
import { fetchOrdersUpdatedSince, fetchOrderById, fulfilOnShopify } from "./shopifyOrders.mjs";
import { bookShipment } from "./shipping.mjs";

export const META_PATH = "online_orders_meta";
export const DIRTY_PATH = "shopify_inventory_dirty";
// Shopify's search index lags the write by seconds to a minute; re-reading a
// window behind the cursor costs a page and is harmless (ingest is idempotent
// on the order id).
export const CURSOR_OVERLAP_MS = 10 * 60 * 1000;
export const MAX_FULFIL_ATTEMPTS_SHOWN = 99;

const isTerminal = (s) => TERMINAL_STATUSES.includes(s);

// ── An indexed query that survives its index not being pasted yet ───────────
// The /online_orders indexes are part of the rules block Junid pastes by hand
// (docs/ONLINE-ORDERS.md). Until he does, the server refuses the query
// outright. That must not stop the tick: pulling orders in and holding their
// stock use exact reads only and are the part that protects the storefront.
// So a refused query skips its own phase, says so on every tick, and nothing
// else changes. Any OTHER error still throws.
async function queryEq(ctx, child, value) {
  try {
    return (await ctx.db.ref(ONLINE_ORDERS_PATH).orderByChild(child).equalTo(value).get()).val() || {};
  } catch (e) {
    if (!/index not defined/i.test(String(e?.message || e))) throw e;
    ctx.summary.missingIndex.add(child);
    return {};
  }
}

export async function runOrdersPoll(deps) {
  const { db, graphql, log = () => {} } = deps;
  const get = async (path) => (await db.ref(path).get()).val();
  const now = await deps.nowMs();
  const ctx = { ...deps, get, now, summary: { ingested: 0, cancelled: 0, flagged: 0, kept: 0, entries: 0, holds: 0, fulfilled: 0, fulfilFailed: 0, mailed: 0, errors: [], missingIndex: new Set() } };
  ctx.enabled = (await get(`${ONLINE_ORDERS_CONFIG_PATH}/enabled`)) === true;

  // ── 1. PULL ────────────────────────────────────────────────────────────────
  const meta = (await get(META_PATH)) || {};
  // `pretendGoLiveMs` is the dry run's lens only (orders-poll.mjs refuses it
  // with --commit): it shows what older orders WOULD route to without moving
  // the real line.
  let goLiveAtMs = Number(deps.pretendGoLiveMs ?? meta.goLiveAtMs);
  if (!Number.isFinite(goLiveAtMs) || goLiveAtMs <= 0) {
    // FIRST RUN. Orders older than this were rung through the POS by hand
    // (the practice until now); pulling them in would hold — and at pack,
    // deduct — them a second time. So the line is drawn here, once.
    goLiveAtMs = now;
    await db.ref(`${META_PATH}/goLiveAtMs`).set(goLiveAtMs);
    log(`first run: website orders created from ${new Date(goLiveAtMs).toISOString()} on are pulled in; older ones stay manual`);
  }
  const cursorMs = deps.pretendGoLiveMs != null ? goLiveAtMs : (Number(meta.cursorMs) || goLiveAtMs);
  if (graphql) {
    const nodes = await fetchOrdersUpdatedSince(graphql, {
      sinceMs: Math.max(goLiveAtMs, cursorMs - CURSOR_OVERLAP_MS),
      createdSinceMs: goLiveAtMs,
    });
    // ── ONE BAD ORDER MUST NOT STOP THE REST (reviewer finding, PR #775) ──
    // The cursor moves past every order seen. One that fails is parked in
    // online_orders_meta/retry/{id} and fetched again BY ID every tick until
    // it goes through — so a single order that keeps failing can never hold
    // the cursor back until newer orders fall out of the window.
    let advanceTo = cursorMs;
    const retry = deps.pretendGoLiveMs != null ? {} : ((await get(`${META_PATH}/retry`)) || {});
    const seen = new Set();
    const attempt = async (node) => {
      const id = String(node.legacyResourceId || numericId(node.id));
      seen.add(id);
      try {
        await handleShopifyOrder(ctx, node);
        if (retry[id]) await db.ref(`${META_PATH}/retry/${id}`).set(null);
      } catch (e) {
        const error = String(e?.message || e);
        ctx.summary.errors.push(`${node?.name ?? id}: ${error}`);
        log(`  ✗ ${node?.name ?? id}: ${error} — parked, retried by id next tick`);
        await db.ref(`${META_PATH}/retry/${id}`).set({ name: node?.name ?? null, attempts: (Number(retry[id]?.attempts) || 0) + 1, error: error.slice(0, 300), at: now });
      }
    };
    for (const node of nodes) {
      await attempt(node);
      advanceTo = Math.max(advanceTo, Date.parse(node.updatedAt) || 0);
    }
    for (const id of Object.keys(retry)) {
      if (seen.has(id)) continue;
      let node = null;
      try { node = await fetchOrderById(graphql, id); }
      catch (e) { log(`  ✗ parked order ${id}: could not be fetched (${String(e?.message || e)}) — retried next tick`); continue; }
      if (node) await attempt(node);
      else { log(`  ‼ parked order ${id} is gone from Shopify — dropped from the retry list`); await db.ref(`${META_PATH}/retry/${id}`).set(null); }
    }
    if (advanceTo > cursorMs) await db.ref(`${META_PATH}/cursorMs`).set(advanceTo);
  }

  // ── 2. KEEP ────────────────────────────────────────────────────────────────
  for (const status of HOLDING_STATUSES) {
    const found = await queryEq(ctx, "status", status);
    for (const [id, order] of Object.entries(found)) {
      try { await maintainOrder(ctx, id, order); ctx.summary.kept++; }
      catch (e) {
        ctx.summary.errors.push(`${order?.ref ?? id}: ${String(e?.message || e)}`);
        log(`  ✗ ${order?.ref ?? id}: ${String(e?.message || e)}`);
      }
    }
  }

  // Junid's "Rung by hand at a till" (Settings): close entries, release holds.
  for (const id of Object.keys(await queryEq(ctx, "status", ORDER_STATUS.RELEASE_REQUESTED))) {
    try { await releaseFulfilledElsewhere(ctx, id, null, { why: "marked rung by hand at a till (Settings)" }); }
    catch (e) { ctx.summary.errors.push(`${id}: ${String(e?.message || e)}`); log(`  ✗ ${id}: ${String(e?.message || e)}`); }
  }

  // ── 3. SHIP ────────────────────────────────────────────────────────────────
  if (graphql) {
    const pending = await queryEq(ctx, "fulfilState", "pending");
    for (const [id, order] of Object.entries(pending)) {
      try { await shipOrder(ctx, id, order); }
      catch (e) {
        ctx.summary.errors.push(`${order?.ref ?? id} fulfil: ${String(e?.message || e)}`);
        log(`  ✗ ${order?.ref ?? id} fulfil: ${String(e?.message || e)}`);
      }
    }
  }

  // ── 4. TELL ────────────────────────────────────────────────────────────────
  await mailAttention(ctx);

  if (ctx.summary.missingIndex.size) {
    log(`  ⚠ /online_orders has no index on ${[...ctx.summary.missingIndex].join(", ")} — the rules block in docs/ONLINE-ORDERS.md is not pasted yet; open orders are not swept, fulfilled or emailed until it is (new orders are still pulled in and held)`);
  }
  await db.ref(`${META_PATH}/lastRunAt`).set(now);
  return ctx.summary;
}

// ── 1. One order from Shopify ────────────────────────────────────────────────
async function handleShopifyOrder(ctx, node) {
  const { db, get, now, log } = ctx;
  const id = String(node.legacyResourceId || numericId(node.id));
  assertSafeSegment(id, "order id");
  const existing = await get(`${ONLINE_ORDERS_PATH}/${id}`);

  if (node.cancelledAt) {
    if (existing) await cancelOrder(ctx, id, node);
    return;
  }
  // ── THE OLD WAY, WHILE THE SWITCH IS OFF ───────────────────────────────────
  // Until Junid turns the feeds on, staff still ring each web sale at a till
  // by hand and fulfil it in the Shopify admin. That sale deducts the stock;
  // a hold left standing would then hide the same unit a SECOND time on every
  // push, for good. So an order Shopify shows fulfilled while the switch is
  // off is let go — exactly today's behaviour. With the switch ON the hold
  // stays until the pack (an admin fulfilment before the pack is the very gap
  // the hold closes), and the walk-in guard stops the hand-rung slip.
  if (existing && !ctx.enabled && node.displayFulfillmentStatus === "FULFILLED" && HOLDING_STATUSES.includes(existing.status)) {
    await releaseFulfilledElsewhere(ctx, id, node);
    return;
  }
  // Switch ON: the order still goes through the pick and the pack (that is the
  // only stock deduction), but Shopify no longer commits its units — the hold
  // rows say so (`released`), and the push subtracts them outright.
  if (existing && ctx.enabled && node.displayFulfillmentStatus === "FULFILLED" && HOLDING_STATUSES.includes(existing.status) && !existing.shopifyFulfilledAt) {
    const res = await db.ref(`${ONLINE_ORDERS_PATH}/${id}`).transaction((cur) => {
      if (cur == null) return null;
      if (!HOLDING_STATUSES.includes(cur.status) || cur.shopifyFulfilledAt) return undefined;
      return { ...cur, shopifyFulfilledAt: Date.parse(node.updatedAt) || ctx.now, updatedAt: ctx.now };
    });
    if (res.committed && res.snapshot.val()) {
      log(`  ~ ${res.snapshot.val().ref}: fulfilled in the Shopify admin before the pack — still held, released on Shopify's side`);
      await syncHolds(ctx, id, res.snapshot.val());
    }
    return;
  }
  if (existing || !isIngestible(node)) return;

  const order = await buildIngestedOrder(ctx, id, node);
  // Create-if-absent. The null first pass writes (cold cache), and the SDK
  // re-runs against the server's value — which aborts if another run won.
  const res = await db.ref(`${ONLINE_ORDERS_PATH}/${id}`).transaction((cur) => (cur == null ? order : undefined));
  if (!res.committed) return;
  ctx.summary.ingested++;
  log(`  + ${order.ref} ${order.customer?.name ?? ""}: ${linesOf(order).map((l) => `${l.title}${l.size && l.size !== "_" ? ` ${l.size}` : ""} ×${l.qty} → ${l.source?.locationId ? `${placeName(l.source.locationId)} (${l.source.status})` : l.source?.status}`).join(", ")}`);
  await maintainOrder(ctx, id, res.snapshot.val());
}

async function buildIngestedOrder(ctx, id, node) {
  const items = (node.lineItems?.nodes ?? []).filter((li) => (Number(li.currentQuantity ?? li.quantity) || 0) > 0);
  const resolved = [];
  for (const item of items) resolved.push(await resolveVariant(ctx, item.variant?.id, item.variant?.product?.id, item.variantTitle));
  const routable = items.map((item, i) => ({ item, r: resolved[i] })).filter((x) => x.r.pid);
  const available = await availabilityFor(ctx, id, routable.map((x) => x.r));
  const routed = routeLines(
    routable.map((x) => ({ key: `${x.r.pid}|${x.r.sizeKey}`, qty: Number(x.item.currentQuantity ?? x.item.quantity) || 1, isFootwear: x.r.isFootwear })),
    available,
  );
  const lines = [];
  let k = 0;
  items.forEach((item, i) => {
    const r = resolved[i];
    if (!r.pid) { lines.push(buildLine({ index: lines.length, item, resolved: r })); return; }
    for (const piece of routed[k]) lines.push(buildLine({ index: lines.length, item, resolved: r, piece }));
    k++;
  });
  return buildOrder({ node, lines, nowMs: ctx.now });
}

/**
 * Shopify variant → { pid, size, sizeKey, product, isFootwear, barcode }, or
 * { reason } when the app cannot say which product and size it is. Two exact
 * reads: the product claim (/shopify_sync/_claims/{numeric product id}, the
 * reverse index the reconciler keeps) and that pid's own variant map.
 */
async function resolveVariant(ctx, variantGid, productGid, variantTitle) {
  const { get } = ctx;
  if (!variantGid || !productGid) return { reason: "a custom or deleted Shopify item with no product behind it" };
  const pid = await get(`shopify_sync/_claims/${numericId(productGid)}`);
  if (typeof pid !== "string" || !pid) return { reason: `Shopify product ${numericId(productGid)} is not linked to a product in the app` };
  const variants = (await get(`shopify_sync/${pid}/variants`)) || {};
  const mapKey = Object.keys(variants).find((key) => variants[key]?.shopifyVariantId === variantGid);
  if (!mapKey) return { reason: `size "${variantTitle || "?"}" is not linked to a size of ${pid} in the app` };
  const product = await get(`products/${pid}`);
  if (!product) return { reason: `product ${pid} no longer exists in the app` };
  const sizes = Array.isArray(product.sizes) ? product.sizes : Object.values(product.sizes || {});
  const size = sizes.find((s) => encodeSizeKey(s) === mapKey || stockSizeKey(s) === mapKey) ?? decodeSizeKey(mapKey);
  const sizeKey = stockSizeKey(size);
  const barcode = product.barcodes?.[sizeKey] || product.barcodes?.[mapKey] || (sizes.length <= 1 ? product.barcode : null) || null;
  return { pid, size, sizeKey, product, isFootwear: productIsFootwear(product), barcode };
}

/** { "pid|sizeKey": { loc: free units } } for the given resolved lines. */
async function availabilityFor(ctx, orderId, resolvedList, ownOther = {}) {
  const out = {};
  for (const r of resolvedList) {
    const key = `${r.pid}|${r.sizeKey}`;
    if (out[key]) continue;
    const stockQty = {};
    for (const loc of ROUTED_LOCATIONS) stockQty[loc] = Number(await ctx.get(`stock/${loc}/${r.pid}/${r.sizeKey}/qty`)) || 0;
    const holdsCell = await ctx.get(`${ONLINE_RESERVATIONS_PATH}/${r.pid}/${r.sizeKey}`);
    const free = availableAt({ stockQty, holdsCell, orderId });
    // A shop whose Display Checks are switched off has no feed to show the
    // entry on and cannot close it (completeDisplayCheck refuses), so it is
    // not a place a line can come from (PR #775 spec review).
    for (const shop of ["marathon-pe", "trophy"]) if (!(await displayFeedOn(ctx, shop))) free[shop] = 0;
    // Units THIS order's other lines already hold there (a re-route excludes
    // the order's own rows, so its untouched lines are subtracted here).
    for (const [loc, q] of Object.entries(ownOther[key] || {})) free[loc] = Math.max(0, (free[loc] || 0) - q);
    out[key] = free;
  }
  return out;
}

// The shop's own Display Checks switch, as the feed and the callable judge it
// (functions/displayChecks lib.cjs isTriggerStoreEnabled), injected by the CLI.
// Asked once per tick per shop. No judge injected (tests) → on.
async function displayFeedOn(ctx, shop) {
  ctx.displayFeed ||= {};
  if (!(shop in ctx.displayFeed)) ctx.displayFeed[shop] = ctx.displayFeedEnabled ? await ctx.displayFeedEnabled(shop) !== false : true;
  return ctx.displayFeed[shop];
}

// ── Cancellation ─────────────────────────────────────────────────────────────
async function cancelOrder(ctx, id, node) {
  const { db, now, log } = ctx;
  const res = await db.ref(`${ONLINE_ORDERS_PATH}/${id}`).transaction((cur) => {
    if (cur == null) return null;
    if (cur.status === ORDER_STATUS.CANCELLED) return undefined;
    if (cur.status === ORDER_STATUS.PACKED) {
      // Already sold through the POS and on its way: left alone, flagged.
      if (cur.cancelledAfterPack) return undefined;
      return {
        ...cur, cancelledAfterPack: true, shopifyCancelledAt: Date.parse(node.cancelledAt) || now, updatedAt: now,
        attention: { kind: ATTENTION_KIND.CANCELLED_AFTER_PACK, reason: `Cancelled on Shopify after it was packed (sale ${cur.pack?.saleId ?? "?"}) — refund or return it by hand`, at: now },
        attentionOpen: true,
      };
    }
    return {
      ...cur,
      status: ORDER_STATUS.CANCELLED,
      shopifyCancelledAt: Date.parse(node.cancelledAt) || now,
      updatedAt: now,
      lines: linesOf(cur).map((l) => ({ ...l, source: { ...(l.source || {}), status: LINE_STATUS.CANCELLED } })),
    };
  });
  const order = res.snapshot.val();
  if (!res.committed || !order) return;
  if (order.status === ORDER_STATUS.PACKED) {
    ctx.summary.flagged++;
    log(`  ‼ ${order.ref}: cancelled on Shopify AFTER it was packed — flagged for Junid`);
    return;
  }
  ctx.summary.cancelled++;
  log(`  − ${order.ref}: cancelled on Shopify — hold released`);
  await cancelEntries(ctx, order);
  await syncHolds(ctx, id, order);
}

async function releaseFulfilledElsewhere(ctx, id, node, { why = "fulfilled in the Shopify admin with the switch off" } = {}) {
  const { db, now, log } = ctx;
  const res = await db.ref(`${ONLINE_ORDERS_PATH}/${id}`).transaction((cur) => {
    if (cur == null) return null;
    if (!HOLDING_STATUSES.includes(cur.status) && cur.status !== ORDER_STATUS.RELEASE_REQUESTED) return undefined;
    return { ...cur, status: ORDER_STATUS.FULFILLED_ELSEWHERE, fulfilledElsewhereAt: Date.parse(node?.updatedAt) || now, updatedAt: now, attention: null, attentionOpen: null };
  });
  const order = res.snapshot.val();
  if (!res.committed || !order) return;
  ctx.summary.handledElsewhere = (ctx.summary.handledElsewhere || 0) + 1;
  log(`  ~ ${order.ref}: ${why} — handled the old way, hold released`);
  await cancelEntries(ctx, order);
  await syncHolds(ctx, id, order);
}

async function cancelEntries(ctx, order) {
  for (const line of linesOf(order)) {
    const key = line?.source?.entryKey;
    if (key) await cancelEntry(ctx, key);
  }
}

async function cancelEntry(ctx, entryKey) {
  const { db, now } = ctx;
  if (entryKey.startsWith(`${ONLINE_PICKS_PATH}/`)) {
    const cur = await ctx.get(entryKey);
    if (cur && cur.status === "open") {
      await db.ref(entryKey).update({ status: "cancelled", locStatus: `${cur.locationId}|cancelled`, cancelledAt: now });
    }
    return;
  }
  if (entryKey.startsWith("displayChecks_active/")) {
    // A completed TOMBSTONE, never a delete — the display-check invariant
    // (completeCheck.js). The reaper clears it like any other.
    const saDate = ctx.saDate(now);
    await db.ref(entryKey).transaction((cur) => {
      if (cur == null) return null;
      if (cur.status !== "open") return undefined;
      return { ...cur, status: "completed", result: "cancelled", completedAt: now, completedSaDate: saDate, completedBy: { name: "Website order cancelled" } };
    });
  }
}

// ── 2. Keeping an open order true ────────────────────────────────────────────
async function maintainOrder(ctx, id, order) {
  const { db, now, enabled } = ctx;
  if (!order || isTerminal(order.status)) return;
  const before = linesOf(order);

  // (a) RE-ROUTE what Resolve sent back. The first piece keeps the line's
  // index (its basket tick and history stay put); extra pieces are appended.
  const changed = new Map();
  const appended = [];
  const reroute = before.map((l, i) => (l?.source?.status === LINE_STATUS.REROUTE ? i : -1)).filter((i) => i >= 0);
  if (reroute.length) {
    const resolvedList = [];
    for (const i of reroute) {
      const l = before[i];
      const r = await resolveVariant(ctx, l.variantId, l.productGid, l.title);
      resolvedList.push(r);
    }
    const ownOther = {};
    before.forEach((l, i) => {
      if (reroute.includes(i) || !l?.pid || !l.source?.locationId) return;
      const key = `${l.pid}|${l.sizeKey}`;
      (ownOther[key] ||= {})[l.source.locationId] = ((ownOther[key] || {})[l.source.locationId] || 0) + (Number(l.qty) || 0);
    });
    const available = await availabilityFor(ctx, id, resolvedList.filter((r) => r.pid), ownOther);
    const routable = reroute.map((i, j) => ({ i, r: resolvedList[j] })).filter((x) => x.r.pid);
    const routed = routeLines(routable.map((x) => ({ key: `${x.r.pid}|${x.r.sizeKey}`, qty: Number(before[x.i].qty) || 1, isFootwear: x.r.isFootwear })), available);
    let k = 0;
    reroute.forEach((i, j) => {
      const old = before[i];
      const r = resolvedList[j];
      const gen = (Number(old.routeGen) || 0) + 1;
      const item = { id: old.shopifyLineItemId, title: old.title, variant: { id: old.variantId, product: { id: old.productGid } }, quantity: old.qty, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: (Number(old.unitPriceCents) || 0) / 100 } } };
      if (!r.pid) { changed.set(i, { ...buildLine({ index: i, item, resolved: r }), lineId: old.lineId, routeGen: gen }); return; }
      const pieces = routed[k++];
      pieces.forEach((piece, n) => {
        const line = { ...buildLine({ index: n === 0 ? i : before.length + appended.length, item, resolved: r, piece }), routeGen: gen };
        if (n === 0) changed.set(i, { ...line, lineId: old.lineId });
        else appended.push(line);
      });
    });
    // The rerouted lines' old entries (a walk-in override leaves one open).
    for (const i of reroute) if (before[i]?.source?.entryKey) await cancelEntry(ctx, before[i].source.entryKey);
  }

  const lines = before.map((l, i) => changed.get(i) || l).concat(appended);

  // (b) FEED ENTRIES — only while the switch is on; this is also the backfill.
  const entryKeys = new Map();
  if (enabled) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const st = line?.source?.status;
      if ((st !== LINE_STATUS.PICK && st !== LINE_STATUS.DISPLAY) || line.source.entryKey) continue;
      const key = await createEntry(ctx, id, order, i, line);
      if (key) entryKeys.set(i, key);
    }
  }

  // (c) COMMIT — guarded: only onto the order as it was read. A line a person
  // moved meanwhile (handed, overridden, packed) makes this abort; the next
  // tick re-reads and decides again. Entries created above are idempotent.
  const expect = before.map((l) => `${l?.source?.status}|${l?.source?.entryKey ?? ""}`);
  let patchedAny = changed.size > 0 || appended.length > 0 || entryKeys.size > 0;
  const res = await db.ref(`${ONLINE_ORDERS_PATH}/${id}`).transaction((cur) => {
    if (cur == null) return null;
    if (isTerminal(cur.status)) return undefined;
    const curLines = linesOf(cur);
    if (curLines.length !== before.length) return undefined;
    if (patchedAny && curLines.some((l, i) => (changed.has(i) || entryKeys.has(i)) && `${l?.source?.status}|${l?.source?.entryKey ?? ""}` !== expect[i])) return undefined;
    const next = { ...cur };
    next.lines = curLines.map((l, i) => {
      let line = changed.get(i) || l;
      if (entryKeys.has(i)) line = { ...line, source: { ...line.source, entryKey: entryKeys.get(i) } };
      return line;
    }).concat(appended.map((l, n) => (entryKeys.has(before.length + n) ? { ...l, source: { ...l.source, entryKey: entryKeys.get(before.length + n) } } : l)));
    const status = deriveOrderStatus(next, { enabled });
    if (status === ORDER_STATUS.NEEDS_ATTENTION && !next.attention) {
      const attention = attentionFromLines(next, now);
      if (attention) { next.attention = attention; next.attentionOpen = true; }
    }
    if (status === next.status && !patchedAny && next.attention === cur.attention) return undefined; // nothing to say
    next.status = status;
    next.updatedAt = now;
    return next;
  });
  const committed = res.committed ? res.snapshot.val() : await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`);
  ctx.summary.entries += entryKeys.size;
  // (d) HOLDS follow the lines, whatever the commit did.
  await syncHolds(ctx, id, committed || order);
}

async function createEntry(ctx, orderId, order, index, line) {
  const { db, now } = ctx;
  if (line.source.status === LINE_STATUS.PICK) {
    const path = `${ONLINE_PICKS_PATH}/${pickKey(orderId, index, line.routeGen)}`;
    if (!(await ctx.get(path))) await db.ref(path).set(pickEntry({ orderId, order, index, line, nowMs: now }));
    return path;
  }
  const store = line.source.locationId;
  const path = `displayChecks_active/${store}/${displayKey(orderId, index, line.routeGen)}`;
  if (!(await ctx.get(path))) {
    const saDate = ctx.saDate(now);
    const [cover, roster] = await Promise.all([
      ctx.get(`displayChecks_settings/${store}/cover/${saDate}`),
      ctx.get(`displayChecks_settings/${store}/roster`),
    ]);
    const assignedTo = ctx.resolveAssignment ? ctx.resolveAssignment({ cover, roster, saDate }) : null;
    const checkId = db.ref(`displayChecks_active/${store}`).push().key;
    await db.ref(path).set(displayEntry({ orderId, order, index, line, checkId, nowMs: now, saDate, assignedTo }));
  }
  return path;
}

/**
 * Make /online_reservations match the order: one row per pid/size it holds,
 * none once it stops holding. Write-then-verify: if the order went terminal
 * while the rows were being written (a pack landing between the read and the
 * write), the rows just written are removed again — a packed order can never
 * be left holding stock.
 */
async function syncHolds(ctx, id, order) {
  const { db, now } = ctx;
  const want = holdRowsFor(order);
  const keys = new Set(Object.keys(want));
  for (const l of linesOf(order)) if (l?.pid && l.sizeKey) keys.add(`${l.pid}/${l.sizeKey}`);
  const touched = new Set();
  for (const key of keys) {
    const path = `${ONLINE_RESERVATIONS_PATH}/${key}/${id}`;
    const have = await ctx.get(path);
    const row = want[key] || null;
    if (sameHold(have, row)) continue;
    await db.ref(path).set(row ? { ...row, at: now } : null);
    touched.add(key);
  }
  if (touched.size && Object.keys(want).length) {
    const status = await ctx.get(`${ONLINE_ORDERS_PATH}/${id}/status`);
    if (!HOLDING_STATUSES.includes(status)) {
      for (const key of Object.keys(want)) await db.ref(`${ONLINE_RESERVATIONS_PATH}/${key}/${id}`).set(null);
    }
  }
  // The reconciler pushes a product when its dirty marker moves — so a hold
  // that appears or goes reaches Shopify on this same tick's reconcile.
  for (const pid of new Set([...touched].map((k) => k.split("/")[0]))) {
    await db.ref(`${DIRTY_PATH}/${pid}`).set(ctx.increment(1));
  }
  ctx.summary.holds += touched.size;
}

// ── 3. Shopify fulfilment after the pack ─────────────────────────────────────
async function shipOrder(ctx, id, order) {
  const { db, graphql, now, log } = ctx;
  if (order?.status !== ORDER_STATUS.PACKED || order.fulfilState !== "pending") return;
  const booking = await bookShipment(order);
  if (booking && !order.shipping?.booking) {
    await db.ref(`${ONLINE_ORDERS_PATH}/${id}/shipping/booking`).set({ ...booking, at: now });
  }
  const attempts = Math.min(MAX_FULFIL_ATTEMPTS_SHOWN, (Number(order.fulfil?.attempts) || 0) + 1);
  let out;
  try {
    out = await fulfilOnShopify(graphql, { orderGid: order.shopifyGid, trackingNumber: order.fulfil?.trackingNumber || null });
  } catch (e) {
    out = { ok: false, error: String(e?.message || e) };
  }
  if (out.ok) {
    await db.ref(`${ONLINE_ORDERS_PATH}/${id}`).update({
      fulfilState: "done",
      "fulfil/state": "done",
      "fulfil/attempts": attempts,
      "fulfil/at": now,
      "fulfil/error": null,
      ...(out.alreadyDone ? { "fulfil/alreadyDone": true } : {}),
      // A fulfilment that failed before and has now landed takes its
      // attention with it, or it would sit in Settings for ever.
      ...(order.attention?.kind === ATTENTION_KIND.FULFIL_FAILED ? { attention: null, attentionOpen: null } : {}),
      updatedAt: now,
    });
    ctx.summary.fulfilled++;
    log(`  ✓ ${order.ref}: fulfilled on Shopify${out.alreadyDone ? " (it already was)" : ", customer notified"}`);
    return;
  }
  // The sale stands. The order says "Packed, Shopify not updated" with a Retry,
  // and never a second sale — the Retry only sets this back to pending.
  await db.ref(`${ONLINE_ORDERS_PATH}/${id}`).update({
    fulfilState: "failed",
    "fulfil/state": "failed",
    "fulfil/attempts": attempts,
    "fulfil/error": String(out.error).slice(0, 500),
    "fulfil/at": now,
    attention: { kind: ATTENTION_KIND.FULFIL_FAILED, reason: `Packed, but Shopify was not updated: ${String(out.error).slice(0, 300)}`, at: now },
    attentionOpen: true,
    updatedAt: now,
  });
  ctx.summary.fulfilFailed++;
  log(`  ✗ ${order.ref}: Shopify fulfilment failed (${out.error}) — "Packed, Shopify not updated"`);
}

// ── 4. One email per attention ───────────────────────────────────────────────
async function mailAttention(ctx) {
  const { db, send, log } = ctx;
  const open = await queryEq(ctx, "attentionOpen", true);
  const unmailed = Object.entries(open).filter(([, o]) => o?.attention && !o.attention.mailedAt);
  if (!unmailed.length) return;
  if (!send) { log(`  ⚠ ${unmailed.length} attention email(s) not sent — no mail sender on this machine; retried next tick`); return; }
  for (const [id, order] of unmailed) {
    const at = order.attention.at;
    try {
      await send(attentionMail(order));
    } catch (e) {
      log(`  ✗ ${order.ref}: attention email not sent (${String(e?.message || e)}) — retried next tick`);
      continue;
    }
    // Stamp THIS attention only: one cleared or replaced meanwhile is left alone.
    await db.ref(`${ONLINE_ORDERS_PATH}/${id}/attention`).transaction((cur) => {
      if (cur == null) return null;
      if (cur.at !== at || cur.mailedAt) return undefined;
      return { ...cur, mailedAt: ctx.now };
    });
    ctx.summary.mailed++;
    log(`  ✉ ${order.ref}: Junid emailed (${order.attention.kind})`);
  }
}

export function attentionMail(order) {
  const a = order.attention || {};
  const who = order.customer?.name ? ` for ${order.customer.name}` : "";
  return {
    subject: `Website order ${order.ref} needs attention`,
    text: [
      `Website order ${order.ref}${who} needs attention.`,
      "",
      a.reason || "(no reason recorded)",
      "",
      `Resolve it in the app: Settings → Online orders.`,
      `Shopify order ${order.shopifyName ?? ""}`.trim(),
    ].join("\n"),
  };
}

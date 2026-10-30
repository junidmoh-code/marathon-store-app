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
//   2. KEEP   every open order: escalate lines whose place failed (switch on;
//             escalate.mjs), re-route lines Junid sent back (Resolve),
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
  ONLINE_ORDERS_PATH, ONLINE_RESERVATIONS_PATH, ONLINE_ORDERS_CONFIG_PATH, PACKING_STORE, orderLabel,
  ORDER_STATUS, LINE_STATUS, ATTENTION_KIND, COURIER_COMPANY, HOLDING_STATUSES, TERMINAL_STATUSES, deriveOrderStatus,
} from "../../../src/utils/onlineOrders.js";
import { stockSizeKey, encodeSizeKey, decodeSizeKey, assertSafeSegment } from "../../../src/utils/sizeKey.js";
import { productIsFootwear } from "../../../src/utils/footwearLine.js";
import { availableAt, routeLines, ROUTED_LOCATIONS } from "./routing.mjs";
import {
  isIngestible, buildLine, buildOrder, holdRowsFor, sameHold, numericId, linesOf,
  displayKey, displayEntry, hubOrderRecord, hubOutcome, attentionFromLines, placeName,
} from "./orderModel.mjs";
import { fetchOrdersUpdatedSince, fetchOrderById } from "./shopifyOrders.mjs";
import { bookShipment, readLive, estimateForOrder, estimateSig, isExchangeKey } from "./shipping.mjs";
import { mintHubCode } from "./orderRefs.mjs";
import { normalizeNetwork, locationOf, SEED_REGISTRY } from "../../../src/utils/networkRegistry.js";
import { escalateOrder, ESCALATIONS_PATH, withdrawRequest } from "./escalate.mjs";
import { fulfilParcel } from "./partialFulfil.mjs";
import { createCourierClient } from "../../shipping/courier-client.mjs";
import { applySwapRequests } from "./swapRequests.mjs";
import { applyOrderNowRequests } from "./orderNowRequests.mjs";

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
  // Escalation (escalate.mjs) raises requests staff see: only with the feeds
  // on, and never while Junid's kill switch says off.
  ctx.escalate = ctx.enabled && (await get(`${ONLINE_ORDERS_CONFIG_PATH}/escalationOff`)) !== true;

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
  const kept = new Set();
  for (const status of HOLDING_STATUSES) {
    const found = await queryEq(ctx, "status", status);
    for (const [id, order0] of Object.entries(found)) {
      kept.add(id);
      let order = order0;
      try {
        // The POS "Replace" (swapRequests.mjs) first: the rest of the pass
        // then raises the new line's hub order / strip entry and its hold.
        if (order?.swapRequests && await applySwapRequests(ctx, id, order)) {
          order = await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`);
        }
        // The POS "Order it now" (orderNowRequests.mjs): a grey line whose item
        // is back in stock goes to reroute, and maintainOrder below routes and
        // raises it exactly like a new order's line.
        if (order?.orderNowRequests && await applyOrderNowRequests(ctx, id, order, { availabilityFor, resolveVariant })) {
          order = await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`);
        }
        // Escalation raises requests staff see, so only with the switch on.
        if (ctx.escalate && await escalateOrder(ctx, id, order, escalationHelpers(ctx))) {
          order = await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`);
        }
        await maintainOrder(ctx, id, order);
        // The keep step itself may just have turned a line no_stock (a hub
        // marked its order Out of Stock): escalate it in THIS tick, before the
        // attention mailer below would email Junid about it.
        if (ctx.escalate) {
          const fresh = await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`);
          if (fresh && linesOf(fresh).some(needsEscalationStart) && await escalateOrder(ctx, id, fresh, escalationHelpers(ctx))) {
            await maintainOrder(ctx, id, await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`));
          }
        }
        ctx.summary.kept++;
      }
      catch (e) {
        ctx.summary.errors.push(`${orderLabel(order ?? {}) || id}: ${String(e?.message || e)}`);
        log(`  ✗ ${orderLabel(order ?? {}) || id}: ${String(e?.message || e)}`);
      }
    }
  }

  // Packed orders whose leftover lines are still climbing the chain: they are
  // not in the status queries above, so the registry names them.
  if (ctx.escalate) await keepPackedEscalations(ctx, kept);

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
        ctx.summary.errors.push(`${orderLabel(order ?? {}) || id} fulfil: ${String(e?.message || e)}`);
        log(`  ✗ ${orderLabel(order ?? {}) || id} fulfil: ${String(e?.message || e)}`);
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
      log(`  ~ ${orderLabel(res.snapshot.val())}: fulfilled in the Shopify admin before the pack — still held, released on Shopify's side`);
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
  log(`  + ${orderLabel(order)} ${order.customer?.name ?? ""}: ${linesOf(order).map((l) => `${l.title}${l.size && l.size !== "_" ? ` ${l.size}` : ""} ×${l.qty} → ${l.source?.locationId ? `${placeName(l.source.locationId)} (${l.source.status})` : l.source?.status}`).join(", ")}`);
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
        // The parcel stands (Junid refunds or takes it back), but nothing
        // LEFT on the order may ship or climb any more: lines still resolving
        // or with the customer agent are cancelled with the order.
        lines: linesOf(cur).map((l) => (PARKED_OPEN.has(l?.source?.status) ? { ...l, source: { status: LINE_STATUS.CANCELLED } } : l)),
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
    log(`  ‼ ${orderLabel(order)}: cancelled on Shopify AFTER it was packed — flagged for Junid`);
    // Follow-ups only exist for packed orders: they, the chain and the
    // agent stop here (Sonnet review, PR #778).
    await syncHolds(ctx, id, order);
    await dropEscalations(ctx, id, order);
    for (const fid of Object.keys(order.followUps || {})) await cancelOrder(ctx, fid, node);
    return;
  }
  ctx.summary.cancelled++;
  log(`  − ${orderLabel(order)}: cancelled on Shopify — hold released`);
  await cancelEntries(ctx, { ...order, key: id });
  await syncHolds(ctx, id, order);
  await dropEscalations(ctx, id, order);
  // A follow-up (a line that came good after the pack) is the same Shopify
  // order: cancelled with it.
  for (const fid of Object.keys(order.followUps || {})) {
    await cancelOrder(ctx, fid, node);
  }
}

async function dropEscalations(ctx, id, order) {
  const lines = linesOf(order);
  for (let i = 0; i < lines.length; i++) {
    const esc = lines[i]?.escalation;
    if (!esc) continue;
    // The request still open at Hub 2 / Central goes too (untouched only) —
    // nobody moves stock toward a cancelled or hand-rung order (CodeRabbit).
    if (esc.phase === "await" && esc.request) await withdrawRequest(ctx, id, i, esc);
    await ctx.db.ref(`${ESCALATIONS_PATH}/${id}_${i}`).set(null);
  }
}

// Lines a cancellation after the pack stops: nothing shipped, nothing settled.
const PARKED_OPEN = new Set([LINE_STATUS.RESOLVING, LINE_STATUS.UNAVAILABLE, LINE_STATUS.PICK, LINE_STATUS.DISPLAY]);

const needsEscalationStart = (l) => !l?.escalation && (l?.source?.status === LINE_STATUS.NO_STOCK || l?.source?.status === LINE_STATUS.NOT_FOUND);

// An override on a line still on a list closes what it had there (hub orders, a display entry).
const escalationHelpers = (ctx) => ({ cancelLine: (line) => cancelLineEntries(ctx, line) });
// Lines a packed order moves into a follow-up close what they had on a list
// first (the follow-up raises its own, under the follow-up's id).
const withFollowUpCancel = (ctx) => { ctx.cancelLineForFollowUp ??= (line) => cancelLineEntries(ctx, line); return ctx; };

async function keepPackedEscalations(ctx, kept) {
  const reg = (await ctx.get(ESCALATIONS_PATH)) || {};
  const ids = new Set(Object.values(reg).map((r) => r?.orderId).filter((oid) => typeof oid === "string" && !kept.has(oid)));
  for (const id of ids) {
    try {
      assertSafeSegment(id, "order id");
      const order = await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`);
      if (!order) { for (const [k, r] of Object.entries(reg)) if (r?.orderId === id) await ctx.db.ref(`${ESCALATIONS_PATH}/${k}`).set(null); continue; }
      if (order.status !== ORDER_STATUS.PACKED) continue;
      const changed = await escalateOrder(withFollowUpCancel(ctx), id, order, escalationHelpers(ctx));
      // Every tick, not only on a change: the POS pack nulls the order's hold
      // rows in its one atomic write, including the resolving lines' — this
      // puts those back before the reconcile that follows pushes stock.
      const after = changed ? await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`) : order;
      await syncHolds(ctx, id, after);
      // A follow-up made just now holds and gets its entry THIS tick — the
      // parent stopped holding that line a moment ago (no gap for a walk-in).
      for (const fid of Object.keys(after?.followUps || {})) {
        if (kept.has(fid)) continue;
        const fu = await ctx.get(`${ONLINE_ORDERS_PATH}/${fid}`);
        if (fu && !isTerminal(fu.status)) { kept.add(fid); await maintainOrder(ctx, fid, fu); }
      }
    } catch (e) {
      ctx.summary.errors.push(`${id} escalation: ${String(e?.message || e)}`);
      ctx.log(`  ✗ ${id}: escalation — ${String(e?.message || e)}`);
    }
  }
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
  log(`  ~ ${orderLabel(order)}: ${why} — handled the old way, hold released`);
  await cancelEntries(ctx, { ...order, key: id });
  await syncHolds(ctx, id, order);
  await dropEscalations(ctx, id, order);
}

async function cancelEntries(ctx, order) {
  const sent = [];
  for (const line of linesOf(order)) sent.push(...(await cancelLineEntries(ctx, line)));
  // A pair the hub already SENT is on its way to (or at) Marathon PE while the
  // hub still counts it: someone must return it. Junid is told.
  if (sent.length && order?.key) {
    await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${order.key}`).update({
      attention: { kind: ATTENTION_KIND.CANCELLED_AFTER_PACK, reason: `Cancelled on Shopify after the hub sent it (${sent.map((s) => `${s.key} from ${s.hub ?? "the hub"}`).join(", ")}) — return it to the hub`, at: ctx.now },
      attentionOpen: true,
    });
  }
}

async function cancelLineEntries(ctx, line) {
  const keys = Array.isArray(line?.source?.orderKeys) ? line.source.orderKeys : [];
  const sent = [];
  if (keys.length) {
    for (const k of keys) { const r = await cancelHubOrder(ctx, k); if (r) sent.push(r); }
    return sent;
  }
  if (line?.source?.entryKey) await cancelEntry(ctx, line.source.entryKey);
  return sent;
}

// A cancelled website order's hub order: gone from the Warehouse queue if the
// hub has not sent it yet; if it was already sent, it is left as it is (the
// unit is on its way to Marathon PE) and the order's attention says so.
async function cancelHubOrder(ctx, key) {
  const { db, log } = ctx;
  const path = `orders/${key}`;
  const res = await db.ref(path).transaction((cur) => {
    if (cur == null) return null;
    if (cur.channel !== "online") return undefined; // never touch a shop's own order
    return cur.status === "incoming" || cur.status === "coming_tomorrow" ? null : undefined;
  });
  const left = res.snapshot?.val();
  if (!res.committed && left && left.channel === "online" && (left.status === "ready" || left.status === "collected")) {
    log(`  ~ hub order ${key} was already sent — left for the shop to return`);
    return { sent: true, key, hub: left.hub ?? null };
  }
  return null;
}

async function cancelEntry(ctx, entryKey) {
  const { db, now } = ctx;
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
      // The POS "Order it now" record (who tapped, when) stays on the line, and
      // so does escalationGen: the line's next escalation must raise NEW
      // request keys, never adopt a request an earlier chain left behind.
      const keep = { ...(old.orderNow ? { orderNow: old.orderNow } : {}), ...(Number(old.escalationGen) > 0 ? { escalationGen: Number(old.escalationGen) } : {}) };
      if (!r.pid) { changed.set(i, { ...buildLine({ index: i, item, resolved: r }), lineId: old.lineId, routeGen: gen, ...keep }); return; }
      const pieces = routed[k++];
      pieces.forEach((piece, n) => {
        const line = { ...buildLine({ index: n === 0 ? i : before.length + appended.length, item, resolved: r, piece }), routeGen: gen };
        if (n === 0) changed.set(i, { ...line, lineId: old.lineId, ...keep });
        else appended.push(line);
      });
    });
    // The rerouted lines' old entries (a walk-in override leaves one open).
    for (const i of reroute) await cancelLineEntries(ctx, before[i]);
  }

  // (a2) WHAT THE HUB DID — a line on a hub order follows its /orders record(s):
  // sent → handed (from the hub that sent it: the Pack deducts THERE), out of
  // stock → no_stock, sent in another size → needs attention. Exact reads.
  for (let i = 0; i < before.length; i++) {
    const l = changed.get(i) || before[i];
    const keys = l?.source?.orderKeys;
    if (!Array.isArray(keys) || !keys.length || l.source.status !== LINE_STATUS.PICK) continue;
    const records = [];
    for (const k of keys) {
      const r = await ctx.get(`orders/${k}`);
      // Only THIS order's THIS line's record — never one a reused key points at.
      records.push(r && r.onlineOrderId === String(id) && Number(r.onlineLineIndex) === i ? r : null);
    }
    const out = hubOutcome(l, records);
    if (!out) continue;
    changed.set(i, {
      ...l,
      source: {
        ...l.source,
        status: out.status,
        ...(out.locationId ? { locationId: out.locationId } : {}),
        ...(out.reason ? { reason: out.reason } : {}),
        ...(out.status === LINE_STATUS.HANDED ? { handedAt: now, handedBy: "hub" } : {}),
      },
    });
  }

  const lines = before.map((l, i) => changed.get(i) || l).concat(appended);

  // (b) FEED ENTRIES — only while the switch is on; this is also the backfill.
  const entryKeys = new Map();
  if (enabled) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const st = line?.source?.status;
      if ((st !== LINE_STATUS.PICK && st !== LINE_STATUS.DISPLAY) || line.source.entryKey) continue;
      const entry = await createEntry(ctx, id, { ...order, lines }, i, line);
      if (entry) entryKeys.set(i, entry);
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
      if (entryKeys.has(i)) line = { ...line, source: { ...line.source, ...entryKeys.get(i) } };
      return line;
    }).concat(appended.map((l, n) => (entryKeys.has(before.length + n) ? { ...l, source: { ...l.source, ...entryKeys.get(before.length + n) } } : l)));
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
  // (e) THE PARCELS the POS shows before Pack — recomputed only when the lines
  // change. Best-effort: a parcel estimate never blocks the order.
  await refreshEstimate(ctx, id, committed || order);
}

// → { entryKey, orderKeys? } — what the line's source records about its entry.
async function createEntry(ctx, orderId, order, index, line) {
  const { db, now } = ctx;
  if (line.source.status === LINE_STATUS.PICK) {
    // The hub's own Warehouse queue: one /orders record per UNIT, keyed by
    // that unit's own three-letter code (owner decision 2026-10-21 — one code
    // per pair). Codes are deterministic per (order, line, unit, routeGen), so a
    // re-run lands on the same code and adopts its own record; a code whose
    // /orders key holds someone else's record is skipped (mintHubCode taken).
    const section = await packingSection(ctx);
    const nowIso = new Date(now).toISOString();
    const qty = Math.max(1, Number(line.qty) || 1);
    const gen = Number(line.routeGen) || 0;
    const keys = [];
    const ours = (rec, u) => rec && rec.onlineOrderId === String(orderId) && Number(rec.onlineLineIndex) === index && Number(rec.onlineUnit ?? 0) === u;
    for (let u = 0; u < qty; u++) {
      const owner = `${orderId}:${index}:${u}:${gen}`;
      const key = await mintHubCode(db, owner, now, { taken: async (code) => { const rec = await ctx.get(`orders/${code}`); return !!rec && !ours(rec, u); } });
      assertSafeSegment(key, "hub order key");
      const res = await db.ref(`orders/${key}`).transaction((cur) => {
        if (cur == null) return hubOrderRecord({ key, line, onlineOrderId: orderId, lineIndex: index, section, nowIso, orderNumber: order.orderNumber ?? null, unit: u });
        return undefined;
      });
      const rec = res.snapshot?.val?.();
      if (res.committed || ours(rec, u)) keys.push(key);
    }
    // ALL units or none: a line recorded with fewer hub orders than pairs would
    // read as handed one pair short. The next tick tries again (idempotent).
    if (keys.length !== qty) return null;
    return { entryKey: `orders/${keys[0]}`, orderKeys: keys };
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
  return { entryKey: path };
}

// Marathon PE's section from the LIVE network registry (as the Assistant
// stamps it on a new order); the seed registry when it cannot be read.
async function packingSection(ctx) {
  if (ctx.packingSection !== undefined) return ctx.packingSection;
  // ONE exact path: the store's own registry node, normalised the same way the
  // app normalises the whole registry (absent → the seed's values).
  let net = null;
  try { net = normalizeNetwork({ locations: { [PACKING_STORE]: await ctx.get(`network/locations/${PACKING_STORE}`) } }); } catch { net = null; }
  const loc = locationOf(net || SEED_REGISTRY, PACKING_STORE) || locationOf(SEED_REGISTRY, PACKING_STORE);
  ctx.packingSection = loc && loc.type === "store" ? loc.section ?? null : null;
  return ctx.packingSection;
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
    // Re-read: a pack landing meanwhile removes what the packed lines held
    // (a packed order still holds only its resolving lines).
    const fresh = await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`);
    const still = fresh && fresh.status !== order.status ? holdRowsFor(fresh) : want;
    for (const key of Object.keys(want)) {
      if (!still[key]) await db.ref(`${ONLINE_RESERVATIONS_PATH}/${key}/${id}`).set(null);
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
  const { db, now, log } = ctx;
  if (order?.status !== ORDER_STATUS.PACKED || order.fulfilState !== "pending") return;
  await closeHubOrders(ctx, { ...order, key: id });
  // The order goes to bookShipment WITH its key (the record carries
  // shopifyGid too, which bookShipment can derive the key from — the explicit
  // key removes any doubt). The poll's own db is passed so booking never opens
  // a second connection, and `deps.courier` (tests inject a fake) replaces the
  // real Courier Guy client.
  //
  // NOTHING COURIER-SIDE MAY BLOCK THE FULFILMENT BELOW: a booking error is
  // recorded, and a record that cannot be written is logged and skipped —
  // otherwise the order would stay pending and be re-quoted every tick.
  let booking;
  try {
    booking = await bookShipment({ ...order, key: id }, {
      db,
      // A BOUNDED client: the ship sweep is serial and fulfilment waits on
      // this, so reads get 2 attempts × 15 s (≈31 s worst case, door and
      // locker in parallel) instead of the default 4 × 20 s. Built once per
      // poll; a missing key throws here and is caught below.
      client: ctx.courier ?? (ctx.courierClient ??= createCourierClient({ maxAttempts: 2, timeoutMs: 15_000 })),
      ...(ctx.courierLog ? { log: ctx.courierLog } : {}), // default: logs/courier.log
    });
  } catch (e) {
    booking = { skipped: true, error: String(e?.message || e).slice(0, 300) };
    log(`  ! ${orderLabel(order)}: courier booking failed — ${booking.error}`);
  }
  const prior = order.shipping?.booking;
  // A real booking replaces a recorded dry run; nothing replaces a real one.
  if (booking && (!prior || (prior.skipped && !booking.skipped))) {
    // "already booked" returns the order's whole shipping node — never nest it.
    const { shipping: _whole, ...result } = booking;
    try {
      // JSON round trip: RTDB refuses undefined and NaN (NaN becomes null).
      await db.ref(`${ONLINE_ORDERS_PATH}/${id}/shipping/booking`).set(JSON.parse(JSON.stringify({ ...result, at: now })));
    } catch (e) {
      log(`  ! ${orderLabel(order)}: courier booking not recorded — ${String(e?.message || e).slice(0, 200)}`);
    }
  }
  // ── LIVE: no waybill, no fulfilment ────────────────────────────────────────
  // With /config/shipping/live on, the customer's Shopify notification must
  // carry the waybill, so a booking that did not happen (failed, refused,
  // unconfirmed) HOLDS the fulfilment: "Packed, courier not booked", Junid is
  // emailed through the attention path, and the POS Retry puts the order back
  // to pending — the next tick re-runs the booking only, never the sale.
  // Live off: unchanged — the dry run is recorded and Shopify is fulfilled.
  // An earlier tick's booking: on the order, or — if its record write failed
  // ("booked but not recorded") — on the claim, where bookShipment kept it.
  const booked = order.shipping?.waybill ?? (order.shipping?.courierBooking?.state === "booked" ? order.shipping.courierBooking.waybill ?? null : null);
  const waybill = booking && !booking.skipped
    ? booking.waybill
    : (booking?.reason === "already booked" || /booking already booked/.test(String(booking?.reason)) ? booked : null);
  let live = false;
  try { live = await readLive(db); } catch (e) { live = true; log(`  ! ${orderLabel(order)}: could not read the live switch — holding (${String(e?.message || e).slice(0, 120)})`); }
  if (live && !waybill) {
    const why = String(booking?.error || booking?.reason || "no waybill came back").slice(0, 300);
    await db.ref(`${ONLINE_ORDERS_PATH}/${id}`).update({
      fulfilState: "courier_failed",
      "fulfil/state": "courier_failed",
      courierError: why,
      attention: { kind: ATTENTION_KIND.COURIER_FAILED, reason: `Packed, but Courier Guy was not booked: ${why}`, at: now },
      attentionOpen: true,
      updatedAt: now,
    });
    ctx.summary.courierFailed = (ctx.summary.courierFailed ?? 0) + 1;
    log(`  ✗ ${orderLabel(order)}: courier not booked (${why}) — "Packed, courier not booked"; Shopify waits`);
    return;
  }
  const attempts = Math.min(MAX_FULFIL_ATTEMPTS_SHOWN, (Number(order.fulfil?.attempts) || 0) + 1);
  // NO SHOPIFY ORDER. An exchange's replacement (exchange-<n>-<ms>, minted by
  // Jimmy) has no shopifyGid: once the courier step above has passed, it is
  // finished exactly as a fulfilled order is, without any Shopify call. Any
  // other record without a shopifyGid is never sent to Shopify with a
  // missing id — it fails as "Shopify not updated" for a person to look at.
  const noShopify = !order.shopifyGid;
  const exchange = noShopify && isExchangeKey(id);
  let out;
  if (noShopify) {
    out = exchange ? { ok: true, noShopify: true } : { ok: false, error: "the order carries no shopifyGid" };
  } else {
    try {
      // The Courier Guy waybill is the tracking number Shopify sends the
      // customer, carrier "The Courier Guy" (the typed tracking field is gone;
      // an older order's typed number still counts when there is no waybill).
      const trackingNumber = waybill || order.fulfil?.trackingNumber || null;
      // Only the lines in this parcel (partialFulfil.mjs) when a pack left lines
      // resolving or this is a follow-up; the whole order otherwise, as before.
      out = await fulfilParcel(ctx, id, order, {
        trackingNumber,
        trackingCompany: waybill ? COURIER_COMPANY : null,
      });
    } catch (e) {
      out = { ok: false, error: String(e?.message || e) };
    }
  }
  if (out.ok) {
    await db.ref(`${ONLINE_ORDERS_PATH}/${id}`).update({
      fulfilState: "done",
      "fulfil/state": "done",
      "fulfil/attempts": attempts,
      "fulfil/at": now,
      "fulfil/error": null,
      ...(out.alreadyDone ? { "fulfil/alreadyDone": true } : {}),
      ...(out.noShopify ? { "fulfil/note": "No Shopify order (online exchange) — finished without Shopify" } : {}),
      // A fulfilment that failed before and has now landed takes its
      // attention with it, or it would sit in Settings for ever.
      ...([ATTENTION_KIND.FULFIL_FAILED, ATTENTION_KIND.COURIER_FAILED].includes(order.attention?.kind) ? { attention: null, attentionOpen: null } : {}),
      courierError: null,
      updatedAt: now,
    });
    ctx.summary.fulfilled++;
    // A swapped line: Shopify fulfilled the ORIGINAL line item, which the app
    // never deducted. Push both products again now, so the original is never
    // left sold out on the website (the reconciler sets on_hand from app stock).
    const swapped = linesOf(order).flatMap((l) => (l?.swappedFrom?.pid ? [l.originalPid, l.swappedFrom.pid, l.pid] : []));
    for (const pid of new Set(swapped.filter(Boolean))) await db.ref(`${DIRTY_PATH}/${pid}`).set(ctx.increment(1));
    log(out.noShopify
      ? `  ✓ ${orderLabel(order)}: exchange shipped${waybill ? ` (waybill ${waybill})` : ""} — no Shopify order, finished without Shopify`
      : `  ✓ ${orderLabel(order)}: fulfilled on Shopify${out.alreadyDone ? " (it already was)" : ", customer notified"}`);
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
  log(`  ✗ ${orderLabel(order)}: Shopify fulfilment failed (${out.error}) — "Packed, Shopify not updated"`);
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
      log(`  ✗ ${orderLabel(order)}: attention email not sent (${String(e?.message || e)}) — retried next tick`);
      continue;
    }
    // Stamp THIS attention only: one cleared or replaced meanwhile is left alone.
    await db.ref(`${ONLINE_ORDERS_PATH}/${id}/attention`).transaction((cur) => {
      if (cur == null) return null;
      if (cur.at !== at || cur.mailedAt) return undefined;
      return { ...cur, mailedAt: ctx.now };
    });
    ctx.summary.mailed++;
    log(`  ✉ ${orderLabel(order)}: Junid emailed (${order.attention.kind})`);
  }
}

export function attentionMail(order) {
  const a = order.attention || {};
  const who = order.customer?.name ? ` for ${order.customer.name}` : "";
  return {
    subject: `Website order ${orderLabel(order)} needs attention`,
    text: [
      `Website order ${orderLabel(order)}${who} needs attention.`,
      "",
      a.reason || "(no reason recorded)",
      "",
      `Resolve it in the app: Settings → Online orders.`,
      `Shopify order ${order.shopifyName ?? ""}`.trim(),
    ].join("\n"),
  };
}

const ownsHubOrder = (rec, orderId) => rec && String(rec.onlineOrderId) === String(orderId);

// After the Pack: the hub orders behind the order are done — "collected", the
// way a till marks a shop order collected — so they leave the Warehouse queue
// and the TV. Idempotent; never touches an out-of-stock or foreign record.
async function closeHubOrders(ctx, order) {
  const iso = new Date(ctx.now).toISOString();
  for (const line of linesOf(order)) {
    for (const key of Array.isArray(line?.source?.orderKeys) ? line.source.orderKeys : []) {
      await ctx.db.ref(`orders/${key}`).transaction((cur) => {
        // null on the cold pass (never undefined, which aborts without asking
        // the server); writing null over an absent record changes nothing.
        if (cur == null) return null;
        if (!ownsHubOrder(cur, order.key ?? cur.onlineOrderId) || cur.channel !== "online") return undefined;
        if (cur.status === "collected" || cur.status === "out_of_stock") return undefined;
        return { ...cur, status: "collected", collectedAt: iso, updatedAt: iso };
      });
    }
  }
}

async function refreshEstimate(ctx, id, order) {
  if (!order || isTerminal(order.status) || order.status === ORDER_STATUS.PACKED) return;
  // Nothing to ship (every line cancelled): no estimate, and no error each tick.
  if (!linesOf(order).some((l) => l?.pid && (Number(l.qty) || 0) > 0 && l.source?.status !== LINE_STATUS.CANCELLED)) return;
  try {
    // ONE config read per tick; the products are only read when the signature
    // (lines + config) has actually changed.
    if (ctx.shippingConfigRaw === undefined) ctx.shippingConfigRaw = (await ctx.db.ref("config/shipping").get()).val();
    const sig = estimateSig(order, ctx.shippingConfigRaw);
    if (order.shipping?.estimate?.sig === sig) return;
    const est = await estimateForOrder({ ...order, key: id }, { db: ctx.db, rawConfig: ctx.shippingConfigRaw, sig });
    await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${id}/shipping/estimate`).set(JSON.parse(JSON.stringify({ ...est, at: ctx.now })));
  } catch (e) {
    ctx.log(`  ! ${orderLabel(order)}: parcel estimate not written — ${String(e?.message || e).slice(0, 160)}`);
  }
}

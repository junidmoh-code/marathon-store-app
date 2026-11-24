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
//
// AND NO ORDER READ TWICE IN A TICK FOR NOTHING (cost watch, 11 Nov 2026). The
// profiler put this poller's share at ~150 MB a day for ~20 open orders: each
// open order was downloaded up to four times a pass (the status query, the
// maintain transaction, a re-read after that transaction declined to write,
// and a "fresh" re-read for escalation), and the attention mailer downloaded
// every order with an open attention (25 long-mailed ones, 183 KB) every two
// minutes to find nothing. What changed, and what did not:
//   · an order the maintain transaction just handed back is USED, not read
//     again (the transaction's snapshot is the server's value);
//   · the attention mailer looks, every tick, at the orders this tick handled
//     (one exact /attention read each) and runs the indexed attentionOpen
//     query on a 10-minute cadence (ATTENTION_SWEEP_MS) for everything else.
// What a tick detects, holds, raises, ships and mails is unchanged; the one
// timing difference is spelled out at ATTENTION_SWEEP_MS.
import { hostname } from "node:os";
import { PUBLISH_PATH, SYNC_PATH, storeNode, STORE, IS_MARATHON, STORES } from "../storeConfig.mjs";
import {
  ONLINE_ORDERS_PATH, ONLINE_RESERVATIONS_PATH, ONLINE_ORDERS_CONFIG_PATH, PACKING_STORE, orderLabel,
  ORDER_STATUS, LINE_STATUS, ATTENTION_KIND, COURIER_COMPANY, HOLDING_STATUSES, TERMINAL_STATUSES, deriveOrderStatus,
} from "../../../src/utils/onlineOrders.js";
import { stockSizeKey, encodeSizeKey, decodeSizeKey, assertSafeSegment } from "../../../src/utils/sizeKey.js";
import { productIsFootwear } from "../../../src/utils/footwearLine.js";
import { availableAt, routeLines, shelfRisk, routingRulesFrom, ROUTED_LOCATIONS, STRIP_SHOPS, ROUTING_CONFIG_PATH, CENTRAL } from "./routing.mjs";
import { raiseChainMoves, stampChainResults } from "./chainMove.mjs";
import { writeDownRejected, sweepWriteDowns } from "./writeDown.mjs";
import {
  isIngestible, buildLine, buildItemLines, unitPieces, buildOrder, holdRowsFor, sameHold, numericId, linesOf,
  displayKey, displayEntry, hubOrderRecord, hubOutcome, attentionFromLines, placeName, shippingOf,
} from "./orderModel.mjs";
import { fetchOrdersUpdatedSince, fetchOrderById, addTrackingToOrder, fetchShippingPoint } from "./shopifyOrders.mjs";
import { bookShipment, readLive, estimateForOrder, estimateSig, isExchangeKey } from "./shipping.mjs";
import { sweepUnknownBookings, RELEASED_PATH as UNKNOWN_RELEASED_PATH } from "../../shipping/unknownBooking.mjs";
// The held-courier text (scripts/shipping/exchangeReturn.mjs releases an order carrying exactly this when Junid says good).
export const HOLD_COURIER_TEXT = "Junid said the returned item is not in good condition: nothing ships until he tells Jimmy otherwise";
import { mintHubCode } from "./orderRefs.mjs";
import { normalizeNetwork, locationOf, SEED_REGISTRY } from "../../../src/utils/networkRegistry.js";
import { escalateOrder, ESCALATIONS_PATH, withdrawRequest } from "./escalate.mjs";
import { fulfilParcel, partShipBlockers, partShipReason } from "./partialFulfil.mjs";
import { createCourierClient } from "../../shipping/courier-client.mjs";
import { costAlertMail, costAlertThreshold } from "../../shipping/costAlert.mjs";
import { applySwapRequests, mailLineMoneyChanges } from "./swapRequests.mjs";
import { applyOrderNowRequests, clearAttentionIfSettled } from "./orderNowRequests.mjs";
import { applyWaitingReroutes } from "./waitingReroute.mjs";
import { applyAgentRepicks } from "./agentRepick.mjs";
import { CELL_HOLDS_PATH, cellHeld, cellQty, holdRow, readPickableRules } from "../pickableStock.mjs";

// Per store: Marathon keeps /online_orders_meta exactly as before; the
// Concrete process (SHOPIFY_STORE=concrete) keeps its own cursor and retry
// list at /online_orders_meta_concrete. Orders themselves share /online_orders
// (the POS reads one list); a Concrete order carries sourceStore: "concrete".
export const META_PATH = storeNode("online_orders_meta");
// Every store's inventory-dirty node. A hold that appears or goes changes what
// EVERY store may sell of that product (one stock pool), so each store's
// pusher is told — the Concrete pusher ignores products not live there.
export const ALL_DIRTY_PATHS = Object.values(STORES).map((st) => storeNode("shopify_inventory_dirty", st));
/** Does this process own the order? Absent sourceStore = Marathon (every order before 2026-11-15). */
export const ownsOrder = (order, storeKey = STORE.key) => (order?.sourceStore || "marathon") === storeKey;
export const DIRTY_PATH = storeNode("shopify_inventory_dirty");
// Shopify's search index lags the write by seconds to a minute; re-reading a
// window behind the cursor costs a page and is harmless (ingest is idempotent
// on the order id).
export const CURSOR_OVERLAP_MS = 10 * 60 * 1000;
export const MAX_FULFIL_ATTEMPTS_SHOWN = 99;
// How often the attention mailer runs the indexed attentionOpen query over ALL
// orders. Between sweeps it reads only the orders the tick handled — which is
// every open order (the KEEP pass), every order Shopify changed (PULL) and
// every order shipped (SHIP) — so an attention this poller raises, or one
// raised on any open order by anyone (the display-check Function sets the order
// needs_attention, an open status), is still emailed in the SAME tick.
//
// The one thing that waits: an attention some OTHER writer puts on an order
// that is already closed (packed / cancelled / handled elsewhere) and that this
// tick has no other reason to touch. No writer does that today (the Function
// skips closed orders; Jamie and the POS only clear attentions). If one ever
// does, Junid's email goes out within 10 minutes instead of 2. Nothing a
// customer or a till waits on reads this email.
export const ATTENTION_SWEEP_MS = 10 * 60 * 1000;

const isTerminal = (s) => TERMINAL_STATUSES.includes(s);

// ── An indexed query that survives its index not being pasted yet ───────────
// The /online_orders indexes are part of the rules block Junid pastes by hand
// (docs/ONLINE-ORDERS.md). Until he does, the server refuses the query
// outright. That must not stop the tick: pulling orders in and holding their
// stock use exact reads only and are the part that protects the storefront.
// So a refused query skips its own phase, says so on every tick, and nothing
// else changes. Any OTHER error still throws.
// A second parcel (<id>r1, made by hand) carries no tag of its own: it
// belongs to its parent's store (CodeRabbit, #911).
export async function ownsOrderAt(ctx, id, o) {
  let order = o;
  if (o && !o.sourceStore && /r\d+$/.test(id)) {
    const parentStore = await ctx.get(`${ONLINE_ORDERS_PATH}/${id.replace(/r\d+$/, "")}/sourceStore`).catch(() => null);
    if (parentStore) order = { ...o, sourceStore: parentStore };
  }
  return ownsOrder(order);
}

async function queryEq(ctx, child, value) {
  try {
    const all = (await ctx.db.ref(ONLINE_ORDERS_PATH).orderByChild(child).equalTo(value).get()).val() || {};
    // Each store's poller works only its own orders: Marathon's fulfils on
    // Marathon's Shopify, Concrete's on Concrete's. Before 2026-11-15 every
    // order is Marathon's, so this filter removes nothing from Marathon's run.
    // A second parcel (<id>r1, made by hand) carries no tag of its own: it
    // belongs to its parent's store (CodeRabbit, #911).
    const out = {};
    for (const [id, o] of Object.entries(all)) if (await ownsOrderAt(ctx, id, o)) out[id] = o;
    return out;
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
  const ctx = { ...deps, get, now, touched: new Set(), summary: { ingested: 0, cancelled: 0, flagged: 0, kept: 0, entries: 0, holds: 0, fulfilled: 0, fulfilFailed: 0, mailed: 0, errors: [], missingIndex: new Set() } };
  ctx.enabled = (await get(`${ONLINE_ORDERS_CONFIG_PATH}/enabled`)) === true;
  // Escalation (escalate.mjs) raises requests staff see: only with the feeds
  // on, and never while Junid's kill switch says off.
  ctx.escalate = ctx.enabled && (await get(`${ONLINE_ORDERS_CONFIG_PATH}/escalationOff`)) !== true;
  // NEVER for Concrete. Escalation can raise refill requests, and Junid's rule
  // is that only the scan raises a request (CLAUDE.md). Concrete orders are
  // pulled in, held, routed and packed like Marathon's; a short line is left
  // for staff to see, not escalated.
  if (!IS_MARATHON) ctx.escalate = false;

  // ── 1. PULL ────────────────────────────────────────────────────────────────
  const meta = (await get(META_PATH)) || {};
  ctx.meta = meta;
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
      ctx.touched.add(id);
      let order = order0;
      try {
        // The POS "Replace" (swapRequests.mjs) first: the rest of the pass
        // then raises the new line's hub order / strip entry and its hold.
        if (order?.swapRequests && await applySwapRequests(ctx, id, order)) {
          order = await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`);
        }
        // A cancelled money task / a credit now too big (any swap path): Junid by email, once. Never blocks.
        await mailLineMoneyChanges(ctx, id, order).catch((e) => log(`  ✗ ${id}: money email check failed (${String(e?.message || e)})`));
        // The POS "Order it now" (orderNowRequests.mjs): a grey line whose item
        // is back in stock goes to reroute, and maintainOrder below routes and
        // raises it exactly like a new order's line.
        if (order?.orderNowRequests && await applyOrderNowRequests(ctx, id, order, { availabilityFor: (c, i, list, own) => availabilityFor(c, i, list, own, { trustBefore: c.now }), resolveVariant })) {
          order = await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`);
        }
        // The order agent's re-pick (agentRepick.mjs, Junid 14 Nov 2026): a line a
        // place could not produce goes to the next place on its route with a free
        // unit, KEEPING its item (a swapped line too). Raises no request.
        if (order?.agentRepicks && await applyAgentRepicks(ctx, id, order, { availabilityFor, cancelLine: (line) => cancelLineEntries(ctx, line) })) {
          order = await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`);
        }
        // A line WAITING ON REFILL (nowhere on the route had it) routes itself
        // the tick its stock lands (waitingReroute.mjs, Junid 12 Nov 2026). It
        // raises nothing; the refill scan alone brings stock in.
        if (await applyWaitingReroutes(ctx, id, order, { availabilityFor, resolveVariant })) {
          await clearAttentionIfSettled(ctx, id);
          order = await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`);
        }
        // Escalation raises requests staff see, so only with the switch on.
        if (ctx.escalate && await escalateOrder(ctx, id, order, escalationHelpers(ctx))) {
          order = await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`);
        }
        let after = await maintainOrder(ctx, id, order);
        // A REJECTION MOVES THE LINE ON IN THIS TICK (chainMove.mjs, Junid 24 Nov
        // 2026): a hub's Out of Stock (turned into no_stock just above), a shop's
        // Not found or the packer's Not here goes to the next place on its chain
        // that shows the size — the agent re-pick's own machinery, raised here
        // instead of on the order agent's next round. Nowhere left → the line is
        // stamped `chain.exhausted` and Jamie offers alternatives.
        {
          let fresh = after ?? await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`);
          let again = false;
          if (fresh && await raiseChainMoves(ctx, id, fresh)) {
            if (await applyAgentRepicks(ctx, id, await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`), { availabilityFor, cancelLine: (line) => cancelLineEntries(ctx, line) })) await clearAttentionIfSettled(ctx, id);
            fresh = await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`);
            again = true;
          }
          // Stamped from the order as it stands, whichever tick answered the request (a move claimed on one tick and
          // answered on a later one must still tell Jamie). Reads nothing; writes once per route generation.
          if (fresh?.agentRepicks && await stampChainResults(ctx, id, fresh)) again = true;
          if (again) after = await maintainOrder(ctx, id, await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`));
        }
        // The keep step itself may just have turned a line no_stock (a hub
        // marked its order Out of Stock): escalate it in THIS tick, before the
        // attention mailer below would email Junid about it.
        if (ctx.escalate) {
          // The order as maintainOrder's own transaction left it (the server's
          // value, handed back by that transaction) — not a second download of
          // the same record a few milliseconds later. Read exactly only when
          // maintainOrder had nothing to hand back.
          const fresh = after ?? await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`);
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
    // A booking whose answer was lost ("unknown"): Courier Guy is asked by the order reference — a shipment found is
    // attached, none after 10 minutes is booked once more (scripts/shipping/unknownBooking.mjs). Before the pending
    // query, so an order handed back is shipped on this same tick.
    await recheckUnknownBookings(ctx);
    const pending = await queryEq(ctx, "fulfilState", "pending");
    for (const [id, order] of Object.entries(pending)) {
      // Under the ship lock, on a FRESH read (fast-ship.mjs may have shipped it since the query): never twice.
      try { await shipOrderLocked(ctx, id, order, { owner: "tick" }); }
      catch (e) {
        ctx.summary.errors.push(`${orderLabel(order ?? {}) || id} fulfil: ${String(e?.message || e)}`);
        log(`  ✗ ${orderLabel(order ?? {}) || id} fulfil: ${String(e?.message || e)}`);
      }
    }
  }

  // A written-down shelf whose piece was sold or picked after all puts itself back (writeDown.mjs).
  if (IS_MARATHON) await sweepWriteDowns(ctx, META_PATH);

  // ── 4. TELL ────────────────────────────────────────────────────────────────
  await mailAttention(ctx);
  await mailCostAlerts(ctx);

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
  log(`  + ${orderLabel(order)} ${order.customer?.name ?? ""}: ${linesOf(order).map((l) => `${l.title}${l.size && l.size !== "_" ? ` ${l.size}` : ""} ×${l.qty} → ${l.source?.locationId ? `${placeName(l.source.locationId)} (${l.source.status}${l.source.why ? `: ${l.source.why}` : ""})` : l.source?.status}`).join(", ")}`);
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
    available, ctx.shelfRisk,
  );
  // ONE LINE PER UNIT (Junid, 20 Nov 2026): an item of quantity N becomes N lines of qty 1.
  const lines = [];
  let k = 0;
  items.forEach((item, i) => {
    const r = resolved[i];
    lines.push(...buildItemLines({ startIndex: lines.length, item, resolved: r, pieces: r.pid ? routed[k++] : null }));
  });
  return buildOrder({ node, lines, nowMs: ctx.now, store: STORE.key });
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
  const pid = await get(`${SYNC_PATH}/_claims/${numericId(productGid)}`);
  if (typeof pid !== "string" || !pid) return { reason: `Shopify product ${numericId(productGid)} is not linked to a product in the app` };
  const variants = (await get(`${SYNC_PATH}/${pid}/variants`)) || {};
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
//
// SHELF HOLDS (pickableStock.mjs, Junid 24 Nov 2026): a cell that rejected a
// website pick and has not moved since counts as empty here, so no line is
// sent back to a shelf that already said "not here". `trustBefore` is for the
// POS "Order it now": a person who has the item in their hand is newer
// evidence than a rejection made BEFORE they said so, so holds stamped up to
// that moment are not applied. A rejection made after it still is.
async function availabilityFor(ctx, orderId, resolvedList, ownOther = {}, { trustBefore = null } = {}) {
  const out = {};
  const rules = await readPickableRules(ctx.get, ctx.now);
  const routing = await routingRules(ctx);
  ctx.shelfRisk ||= {};
  for (const r of resolvedList) {
    const key = `${r.pid}|${r.sizeKey}`;
    if (out[key]) continue;
    const stockQty = {};
    const stamps = {};
    for (const loc of ROUTED_LOCATIONS) {
      if (loc === CENTRAL && !routing.central) { stockQty[loc] = 0; continue; }
      stockQty[loc] = Number(await ctx.get(`stock/${loc}/${r.pid}/${r.sizeKey}/qty`)) || 0;
    }
    // When each shelf that shows a piece last moved: the hold test and the trust score both read it.
    const stampOf = async (loc) => {
      if (!(loc in stamps)) stamps[loc] = stockQty[loc] > 0 ? (await ctx.get(`stock/${loc}/${r.pid}/${r.sizeKey}/updatedAt`)) ?? null : null;
      return stamps[loc];
    };
    let holds = null;
    try { holds = await ctx.get(`${CELL_HOLDS_PATH}/${r.pid}/${r.sizeKey}`); } catch (e) { ctx.log?.(`  ⚠ shelf holds for ${key} unreadable (${String(e?.message || e)}) — routed without them`); }
    if (rules?.holds) {
      for (const loc of holds ? ROUTED_LOCATIONS : []) {
        if (!holds[loc] || stockQty[loc] <= 0) continue;
        if (trustBefore != null && Number(holds[loc].at) <= trustBefore) continue;
        if (cellHeld(holds, loc, { qty: stockQty[loc], updatedAt: await stampOf(loc) }, rules)) stockQty[loc] = 0;
      }
    }
    const holdsCell = await ctx.get(`${ONLINE_RESERVATIONS_PATH}/${r.pid}/${r.sizeKey}`);
    const free = availableAt({ stockQty, holdsCell, orderId });
    // A shop whose Display Checks are switched off has no feed to show the
    // entry on and cannot close it (completeDisplayCheck refuses), so it is
    // not a place a line can come from (PR #775 spec review).
    for (const shop of STRIP_SHOPS) if (!(await displayFeedOn(ctx, shop))) free[shop] = 0;
    // Units THIS order's other lines already hold there (a re-route excludes
    // the order's own rows, so its untouched lines are subtracted here).
    for (const [loc, q] of Object.entries(ownOther[key] || {})) free[loc] = Math.max(0, (free[loc] || 0) - q);
    out[key] = free;
    // HOW FAR EACH SHELF CAN BE TRUSTED (routing.mjs shelfRisk; Junid 24 Nov
    // 2026). A person who has the piece in their hand ("Order it now",
    // trustBefore) outranks every signal, so no score is kept for that read.
    const risk = {};
    if (routing.trust && trustBefore == null) {
      for (const loc of ROUTED_LOCATIONS) {
        if (!(free[loc] > 0)) continue;
        const stamp = Date.parse(await stampOf(loc));
        risk[loc] = shelfRisk({ free: free[loc], stampMs: Number.isFinite(stamp) ? stamp : null, rejectedAt: Number(holds?.[loc]?.at) || null, nowMs: ctx.now, rules: routing });
      }
    }
    ctx.shelfRisk[key] = risk;
  }
  return out;
}

/** /config/onlineOrders/routing, read once per tick. A failed read routes on the defaults (logged). */
async function routingRules(ctx) {
  if (ctx.routing) return ctx.routing;
  let config = null;
  try { config = await ctx.get(ROUTING_CONFIG_PATH); } catch (e) { ctx.log?.(`  ⚠ ${ROUTING_CONFIG_PATH} unreadable (${String(e?.message || e)}) — the default routing settings apply`); }
  ctx.routing = routingRulesFrom(config);
  return ctx.routing;
}

// Can this shop's website strip take a line? (functions/displayChecks lib.cjs
// isWebsiteStripEnabled — on unless the store's Display Checks are switched
// OFF explicitly; a not-live store like Pine still has its strip), injected by
// the CLI.
// Asked once per tick per shop. No judge injected (tests) → on.
async function displayFeedOn(ctx, shop) {
  ctx.displayFeed ||= {};
  if (!(shop in ctx.displayFeed)) ctx.displayFeed[shop] = ctx.displayFeedEnabled ? await ctx.displayFeedEnabled(shop) !== false : true;
  return ctx.displayFeed[shop];
}

// ── Cancellation ─────────────────────────────────────────────────────────────
async function cancelOrder(ctx, id, node) {
  const { db, now, log } = ctx;
  ctx.touched?.add(id);
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
  // Already flagged on an earlier tick: that tick's second-parcel clean-up may have failed part-way, so it runs again
  // (idempotent: a cancelled record is left as it is) — CodeRabbit on #901.
  if (!res.committed && order?.status === ORDER_STATUS.PACKED && order.cancelledAfterPack) { await cancelReships(ctx, id, node); return; }
  if (!res.committed || !order) return;
  if (order.status === ORDER_STATUS.PACKED) {
    ctx.summary.flagged++;
    log(`  ‼ ${orderLabel(order)}: cancelled on Shopify AFTER it was packed — flagged for Junid`);
    // Follow-ups only exist for packed orders: they, the chain and the
    // agent stop here (Sonnet review, PR #778).
    await syncHolds(ctx, id, order);
    await dropEscalations(ctx, id, order);
    for (const fid of Object.keys(order.followUps || {})) await cancelOrder(ctx, fid, node);
    await cancelReships(ctx, id, node);
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

// A second parcel not packed yet (docs/ONLINE-ORDERS.md "Second parcel"; architect review 6) stops with its order.
// Exact reads of its keys, never a query: the parent names none of them (it is never written for one).
async function cancelReships(ctx, id, node) {
  for (let n = 1; n <= RESHIP_KEYS_CHECKED; n++) {
    const rid = `${id}r${n}`;
    const st = await ctx.get(`${ONLINE_ORDERS_PATH}/${rid}/status`);
    if (st == null) break;
    if (HOLDING_STATUSES.includes(st)) await cancelOrder(ctx, rid, node);
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
      ctx.touched?.add(id);
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
    ctx.touched?.add(order.key);
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
  ctx.touched?.add(id);
  if (!order || isTerminal(order.status)) return null;
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
    // A line a person has JUST sent back with "Order it now" is routed on the
    // cells as they are, shelf holds or not: the person who found the item is
    // newer evidence than the rejection (orderNowRequests.mjs checked it the
    // same way a moment ago). The hold it lands on is lifted below.
    // Only for a size no other line of this batch is being re-routed for: one
    // availability picture serves a whole size, and a line sent back another
    // way (Resolve, the agent) must not ride past a hold on this one's word.
    const keyOf = (x) => `${x.r.pid}|${x.r.sizeKey}`;
    const found = routable.filter((x) => foundJustNow(before[x.i], now) && !routable.some((y) => keyOf(y) === keyOf(x) && !foundJustNow(before[y.i], now)));
    for (const x of found) Object.assign(available, await availabilityFor(ctx, id, [x.r], ownOther, { trustBefore: Number(before[x.i].orderNow.appliedAt) }));
    const foundLines = new Set(found.map((x) => x.i));
    const routed = routeLines(routable.map((x) => ({ key: `${x.r.pid}|${x.r.sizeKey}`, qty: Number(before[x.i].qty) || 1, isFootwear: x.r.isFootwear })), available, ctx.shelfRisk);
    const holdsToLift = [];
    let k = 0;
    reroute.forEach((i, j) => {
      const old = before[i];
      const r = resolvedList[j];
      const gen = (Number(old.routeGen) || 0) + 1;
      const item = { id: old.shopifyLineItemId, title: old.title, variant: { id: old.variantId, product: { id: old.productGid } }, quantity: old.qty, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: (Number(old.unitPriceCents) || 0) / 100 } } };
      // The POS "Order it now" record (who tapped, when) stays on the line, and
      // so does escalationGen: the line's next escalation must raise NEW
      // request keys, never adopt a request an earlier chain left behind.
      const keep = { ...(old.orderNow ? { orderNow: old.orderNow } : {}), ...(Number(old.escalationGen) > 0 ? { escalationGen: Number(old.escalationGen) } : {}),
        // Which unit of its Shopify item the line is, and the line it was split from, stay with it.
        ...(old.units > 1 ? { unit: old.unit, units: old.units } : {}), ...(old.splitFrom != null ? { splitFrom: old.splitFrom } : {}) };
      if (!r.pid) { changed.set(i, { ...buildLine({ index: i, item, resolved: r }), lineId: old.lineId, routeGen: gen, ...keep }); return; }
      // One line per unit: a line still carrying qty > 1 (an order from before
      // 20 Nov 2026) comes back as qty-1 lines, the extra units appended.
      const pieces = unitPieces(routed[k++]);
      const total = pieces.length;
      if (foundLines.has(i)) holdsToLift.push(...pieces.filter((p) => p.locationId).map((p) => ({ pid: r.pid, sizeKey: r.sizeKey, loc: p.locationId, before: Number(old.orderNow.appliedAt) })));
      pieces.forEach((piece, n) => {
        const unitOf = n === 0
          ? (old.units > 1 ? { unit: old.unit, units: old.units } : total > 1 ? { unit: 1, units: total } : {})
          : { unit: n + 1, units: total, splitFrom: i };
        const line = { ...buildLine({ index: n === 0 ? i : before.length + appended.length, item, resolved: r, piece, unitPriceCents: Number(old.unitPriceCents) || 0 }), ...unitOf, routeGen: gen };
        if (n === 0) changed.set(i, { ...line, lineId: old.lineId, ...keep });
        else appended.push(line);
      });
    });
    // The rerouted lines' old entries (a walk-in override leaves one open).
    for (const i of reroute) await cancelLineEntries(ctx, before[i]);
    for (const cell of holdsToLift) await liftCellHold(ctx, cell);
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
    // The hub said Out of Stock: its pieces of this size come off the website
    // and out of routing until that shelf moves again (pickableStock.mjs).
    const refused = out.status === LINE_STATUS.NO_STOCK ? records.find((r) => r && r.channel === "online" && r.status === "out_of_stock") : null;
    // A lone piece is written to zero in the app's own count as well (writeDown.mjs, Junid 24 Nov 2026).
    if (refused?.hub) {
      const at = rejectedAt(refused.outOfStockAt, now);
      await holdCell(ctx, { pid: l.pid, sizeKey: l.sizeKey, loc: refused.hub, kind: "hub_out_of_stock", orderId: id, line: i, by: refused.outOfStockByUid, at });
      await writeDownRejected(ctx, { pid: l.pid, size: l.size, sizeKey: l.sizeKey, loc: refused.hub, kind: "hub_out_of_stock", orderId: id, orderNumber: order.orderNumber ?? null, line: i, gen: Number(l.routeGen) || 0, by: refused.outOfStockByUid || null, at });
    }
    changed.set(i, {
      ...l,
      source: {
        ...l.source,
        status: out.status,
        ...(out.locationId ? { locationId: out.locationId } : {}),
        ...(out.reason ? { reason: out.reason } : {}),
        ...(out.status === LINE_STATUS.HANDED ? { handedAt: now, handedBy: "hub" } : {}),
        // When the hub said no: what the chain move (chainMove.mjs) picks the line up by.
        ...(refused?.hub ? { failedAt: now } : {}),
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
  // COMMITTED OR NOT, THE TRANSACTION HANDS BACK THE SERVER'S ORDER. A
  // transaction that declines (returns undefined — "nothing to say" on a quiet
  // order, which is nearly every order on nearly every tick) completes with
  // the value it was last run on, and that run was against the server's value:
  // the cold null pass returns null, never undefined, so an abort is
  // unreachable before the server has answered. Reading the order again here
  // downloaded the same record a second time per open order per tick. The
  // exact read stays as the fallback for a snapshot that carries nothing.
  const committed = res.committed
    ? res.snapshot.val()
    : (res.snapshot?.val?.() ?? await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`));
  ctx.summary.entries += entryKeys.size;
  // (d) HOLDS follow the lines, whatever the commit did.
  await syncHolds(ctx, id, committed || order);
  // (e) THE PARCELS the POS shows before Pack — recomputed only when the lines
  // change. Best-effort: a parcel estimate never blocks the order.
  await refreshEstimate(ctx, id, committed || order);
  // The order as this pass left it, for the caller's escalation check. null
  // when the order is gone (the caller then reads exactly, as it always did).
  return committed ?? null;
}

// A place rejected a website pick: note it beside the cell (never IN it — the
// count is not touched) and tell every store's pusher, so the website drops
// those pieces on this same tick's reconcile. Best-effort: a failure here is
// logged and never stops the order being kept; the nightly sweep re-checks.
//
// `at` is WHEN THE PLACE SAID NO, not when this tick noticed: a delivery or a
// count that reached the cell in between (the poller can be minutes or, after
// an outage, hours behind) must end the hold, and it can only do that if the
// hold is stamped before it. The same stamp on every retry, so a tick that
// repeats this never moves a hold forward over a movement.
const HOLD_STAMP_MAX_AGE_MS = 7 * 864e5;
export function rejectedAt(iso, now) {
  const t = Date.parse(iso);
  // A device clock ahead of the server, an unreadable stamp, or one from long ago: the tick's own time.
  return Number.isFinite(t) && t <= now && now - t <= HOLD_STAMP_MAX_AGE_MS ? t : now;
}

/** Did a person send this line back with "Order it now" in the last quarter of an hour? */
const ORDER_NOW_TRUST_MS = 15 * 60e3;
const foundJustNow = (line, now) => {
  const at = Number(line?.orderNow?.appliedAt);
  return Number.isFinite(at) && at > 0 && now - at >= 0 && now - at <= ORDER_NOW_TRUST_MS;
};

// "Order it now" routed a line to a held cell: the hold goes (a person found
// the piece there), and the website is told so it counts the piece again.
// Only a hold stamped up to the moment the person said so: a rejection made
// after that is newer evidence again and stays.
async function liftCellHold(ctx, { pid, sizeKey, loc, before }) {
  const { db } = ctx;
  try {
    const path = `${CELL_HOLDS_PATH}/${pid}/${sizeKey}/${loc}`;
    const res = await db.ref(path).transaction((cur) => (cur == null ? null : Number(cur.at) <= before ? null : undefined));
    if (!res.committed || res.snapshot.exists()) return false;
    for (const dirty of ALL_DIRTY_PATHS) await db.ref(`${dirty}/${pid}`).set(ctx.increment(1));
    ctx.log?.(`  ~ shelf hold lifted: ${pid} size ${sizeKey} at ${loc} (found: Order it now)`);
    return true;
  } catch (e) {
    ctx.log?.(`  ⚠ shelf hold for ${pid}/${sizeKey} at ${loc} not lifted (${String(e?.message || e)})`);
    return false;
  }
}

async function holdCell(ctx, { pid, sizeKey, loc, kind, orderId, line, by = null, at = null }) {
  const { db, now } = ctx;
  try {
    const qty = cellQty(await ctx.get(`stock/${loc}/${pid}/${sizeKey}`));
    if (qty <= 0) return false; // nothing on paper there: nothing to hide
    const row = holdRow({ pid, sizeKey, loc, at: at ?? now, kind, orderId, line, qty, by });
    if (!row) return false;
    // Never backwards: a late retry carrying an older rejection leaves a newer hold as it is.
    const res = await db.ref(row.path).transaction((cur) => (cur != null && Number(cur.at) > row.value.at ? undefined : row.value));
    if (!res.committed) return false;
    for (const dirty of ALL_DIRTY_PATHS) await db.ref(`${dirty}/${pid}`).set(ctx.increment(1));
    ctx.log?.(`  ~ shelf hold: ${pid} size ${sizeKey} at ${loc} (${kind}, ${qty} on paper) — off the website until that shelf moves`);
    return true;
  } catch (e) {
    ctx.log?.(`  ⚠ shelf hold for ${pid}/${sizeKey} at ${loc} not written (${String(e?.message || e)})`);
    return false;
  }
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
    await db.ref(path).set(row ? { ...row, ...(IS_MARATHON ? {} : { store: STORE.key }), at: now } : null);
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
    for (const dirty of ALL_DIRTY_PATHS) await db.ref(`${dirty}/${pid}`).set(ctx.increment(1));
  }
  ctx.summary.holds += touched.size;
}

// Second parcels looked for when a packed order is cancelled on Shopify (<id>r1, r2, …; they are made by hand, rarely).
const RESHIP_KEYS_CHECKED = 3;

// ── The ship lock (fast courier booking, 20 Nov 2026) ────────────────────────
// Two processes ship packed orders now: this tick (SHIP, the fallback) and
// fast-ship.mjs (a listener that ships an order the moment the POS Pack sets
// it pending, so the waybill is on the packer's screen in seconds instead of
// the 1–3 minutes a tick takes to come round and get through PULL and KEEP).
// bookShipment's courierBooking claim already stops a SECOND WAYBILL; this
// lock stops the second SHIP — without it, the process that lost the claim
// would read "booking already booking", find no waybill on its stale copy and
// write "Packed, courier not booked" over the winner's work.
//
// One node per order under online_orders_meta (never on the order record the
// POS writes). Taken by transaction; held while it is younger than the TTL
// AND, on this machine, its process is alive (a tick SIGKILLed by the runner's
// 3-minute timeout leaves a lock nobody holds — that must not block the next
// pack for ten minutes). Released only by the token that took it.
export const SHIP_LOCKS_PATH = `${META_PATH}/shipLocks`;
export const SHIP_LOCK_TTL_MS = 10 * 60 * 1000;
const HOST = (() => { try { return hostname(); } catch { return "unknown"; } })();
const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
};
/** Is this lock record still held? Pure apart from the injected liveness check. */
export function shipLockHeld(cur, { nowMs, ttlMs = SHIP_LOCK_TTL_MS, host = HOST, isAlive = pidAlive } = {}) {
  if (!cur || typeof cur !== "object") return false;
  const age = nowMs - (Number(cur.at) || 0);
  if (!(age >= -60_000 && age < ttlMs)) return false; // expired, or a stamp from the far future
  if (cur.host === host && Number.isInteger(cur.pid) && !isAlive(cur.pid)) return false; // its owner died
  return true;
}
/** → the token when this caller now holds the order's ship lock, null when someone else does. */
export async function takeShipLock(db, id, { owner, nowMs = Date.now(), ttlMs, host = HOST, pid = process.pid, isAlive } = {}) {
  const token = `${owner}-${pid}-${nowMs}-${Math.random().toString(36).slice(2, 8)}`;
  const mine = { owner, host, pid, token, at: nowMs };
  const res = await db.ref(`${SHIP_LOCKS_PATH}/${assertSafeSegment(id, "order key")}`).transaction((cur) =>
    (shipLockHeld(cur, { nowMs, ttlMs, host, isAlive }) ? undefined : mine));
  return res.committed && res.snapshot?.val()?.token === token ? token : null;
}
export async function releaseShipLock(db, id, token) {
  // null on the cold pass (never undefined, which aborts without asking the server).
  await db.ref(`${SHIP_LOCKS_PATH}/${assertSafeSegment(id, "order key")}`).transaction((cur) =>
    (cur == null ? null : cur.token === token ? null : undefined));
}

/**
 * ONE packed order, outside a tick (fast-ship.mjs): the same shipOrder, under
 * the same lock, with a context built the way runOrdersPoll builds its own.
 * An attention it raises ("Packed, courier not booked" / "Shopify not
 * updated") is emailed by the next tick: the attention sweep is made due now.
 * → { result, summary }
 */
export async function shipPendingOrder(deps, id, snapshot = null, { owner = "fast" } = {}) {
  const { db, log = () => {} } = deps;
  const get = async (path) => (await db.ref(path).get()).val();
  const now = await deps.nowMs();
  const ctx = { ...deps, log, get, now, touched: new Set(), summary: { ingested: 0, cancelled: 0, flagged: 0, kept: 0, entries: 0, holds: 0, fulfilled: 0, fulfilFailed: 0, mailed: 0, errors: [], missingIndex: new Set() } };
  const result = await shipOrderLocked(ctx, id, snapshot, { owner });
  if (ctx.summary.courierFailed || ctx.summary.fulfilFailed) {
    try { await db.ref(`${META_PATH}/attentionSweepAt`).set(0); }
    catch (e) { log(`  ⚠ attentionSweepAt not cleared (${String(e?.message || e).slice(0, 120)}) — the email waits for the 10-minute sweep`); }
  }
  return { result, summary: ctx.summary };
}

/**
 * Ship one order under its ship lock, from a fresh read of the record.
 * → "shipped" | "locked" (another process is on it) | "not_pending" (already
 * handled, or not packed). shipOrder's own errors propagate, as before.
 */
export async function shipOrderLocked(ctx, id, snapshot, { owner }) {
  const { db, log } = ctx;
  const token = await takeShipLock(db, id, { owner, nowMs: ctx.lockClock ? ctx.lockClock() : Date.now(), ...(ctx.lockOpts ?? {}) });
  if (!token) {
    log(`  · ${orderLabel(snapshot ?? {}) || id}: being shipped by the other shipper — left to it`);
    return "locked";
  }
  try {
    const order = (await db.ref(`${ONLINE_ORDERS_PATH}/${id}`).get()).val();
    if (order?.status !== ORDER_STATUS.PACKED || order.fulfilState !== "pending") return "not_pending";
    await shipOrder(ctx, id, order);
    return "shipped";
  } finally {
    try { await releaseShipLock(db, id, token); }
    catch (e) { log(`  ! ${id}: ship lock not released (${String(e?.message || e).slice(0, 120)}) — it lapses when this process ends or in ${SHIP_LOCK_TTL_MS / 60000} min`); }
  }
}

/** shipping/geo from Shopify for an order that has none (asked once: shipping/geoAsked). Never throws. → the order, with it when found. */
export async function backfillShippingGeo(ctx, id, order) {
  const { db, log, now } = ctx;
  try {
    const point = await fetchShippingPoint(ctx.graphql, order.shopifyGid);
    // Only for the address the order holds: shippingOf signs Shopify's point with Shopify's address, and the
    // booking uses it only while that matches the order's own (an address Jamie changed is not Shopify's).
    const geo = point ? shippingOf({ shippingAddress: { ...point } }).geo : null;
    await db.ref(`${ONLINE_ORDERS_PATH}/${id}/shipping`).update(geo ? { geo, geoAsked: now } : { geoAsked: now });
    return geo ? { ...order, shipping: { ...order.shipping, geo } } : order;
  } catch (e) {
    log(`  ! ${orderLabel(order)}: Shopify's map point not read (${String(e?.message || e).slice(0, 120)}) — placed by OpenStreetMap`);
    return order;
  }
}

/** The tick's unknown-booking check (unknownBooking.mjs). Never throws: a failure waits for the next tick. */
export async function recheckUnknownBookings(ctx) {
  const { db, log } = ctx;
  try {
    const failed = await queryEq(ctx, "fulfilState", "courier_failed");
    const orders = Object.fromEntries(Object.entries(failed).filter(([, o]) => o?.shipping?.courierBooking?.state === "unknown"));
    // Nothing unknown and no release waiting for its late look: no Courier Guy client, no call.
    if (!Object.keys(orders).length && !(await db.ref(UNKNOWN_RELEASED_PATH).get()).exists()) return [];
    const client = ctx.courier ?? (ctx.courierClient ??= createCourierClient({ maxAttempts: 2, timeoutMs: 15_000 }));
    const out = await sweepUnknownBookings({ db, client, orders, now: () => Date.now(), log: ctx.courierLog ?? ((l) => log(`  ${l}`)) });
    for (const r of out) if (r.action !== "wait" && r.action !== "none") log(`  ↻ ${r.ref}: unknown booking — ${r.action}${r.waybill ? ` ${r.waybill}` : ""}`);
    return out;
  } catch (e) {
    log(`  ! unknown-booking check failed — ${String(e?.message || e).slice(0, 200)}`);
    return [];
  }
}

// The Courier Guy's public tracking page for a waybill (the link the customer agent sends too).
export const courierTrackUrl = (waybill) => `https://portal.thecourierguy.co.za/track?ref=${encodeURIComponent(String(waybill))}`;

// ── 3. Shopify fulfilment after the pack ─────────────────────────────────────
async function shipOrder(ctx, id, order) {
  const { db, now, log } = ctx;
  ctx.touched?.add(id);
  if (order?.status !== ORDER_STATUS.PACKED || order.fulfilState !== "pending") return;
  // JUNID'S CONDITION HOLD (30 Oct 2026, scripts/shipping/exchangeReturn.mjs): he told Jimmy the exchange's returned
  // item is NOT in good condition ("nothing ships"). The replacement is not booked while the hold stands: the order
  // shows "Packed, courier not booked" with the reason, and the POS Retry re-checks it. His later "good" clears it.
  // Re-read at the exact path (not the pass's snapshot): a hold written a moment ago still stops a paid booking.
  const conditionHold = isExchangeKey(id) && (await db.ref(`${ONLINE_ORDERS_PATH}/${id}/incoming/conditionHold`).get()).val();
  if (conditionHold && typeof conditionHold === "object") {
    const why = HOLD_COURIER_TEXT;
    await db.ref(`${ONLINE_ORDERS_PATH}/${id}`).update({
      fulfilState: "courier_failed",
      "fulfil/state": "courier_failed",
      courierError: why,
      attention: { kind: ATTENTION_KIND.COURIER_FAILED, reason: `Packed, but held: ${why}`, at: now },
      attentionOpen: true,
      updatedAt: now,
    });
    log(`  ✗ ${orderLabel(order)}: condition hold — courier not booked`);
    return;
  }
  // AN IN-STORE EXCHANGE (Junid, 19 Nov 2026; marathon-dm-agent src/jimmy/inStoreExchange.js): a Durban customer swaps
  // at Marathon PE and takes the replacement over the counter. The Pack is the hand-over: the hub orders close, nothing
  // is booked with The Courier Guy and there is no Shopify order to fulfil.
  if (isExchangeKey(id) && !order.shopifyGid && order.exchange?.inStore && typeof order.exchange.inStore === "object") {
    await closeHubOrders(ctx, { ...order, key: id });
    await db.ref(`${ONLINE_ORDERS_PATH}/${id}`).update({
      fulfilState: "done",
      "fulfil/state": "done",
      "fulfil/attempts": Math.min(MAX_FULFIL_ATTEMPTS_SHOWN, (Number(order.fulfil?.attempts) || 0) + 1),
      "fulfil/at": now,
      "fulfil/error": null,
      "fulfil/note": "In-store exchange: handed over at the counter — no courier, no Shopify order",
      ...([ATTENTION_KIND.FULFIL_FAILED, ATTENTION_KIND.COURIER_FAILED].includes(order.attention?.kind) ? { attention: null, attentionOpen: null } : {}),
      courierError: null,
      updatedAt: now,
    });
    ctx.summary.fulfilled++;
    log(`  ✓ ${orderLabel(order)}: in-store exchange handed over — no courier, no Shopify order`);
    return;
  }
  // NO PART-SHIPPING (Junid, 20 Nov 2026; partialFulfil.mjs partShipBlockers): a pack that left a line behind with
  // nothing settled books no courier and fulfils nothing. Re-read at the exact paths, as the hold above: a decision
  // written a moment ago (Jamie's 24 h rule settling the line) must count, and so must a pack this pass did not see.
  const [freshLines, freshPacked] = await Promise.all([db.ref(`${ONLINE_ORDERS_PATH}/${id}/lines`).get(), db.ref(`${ONLINE_ORDERS_PATH}/${id}/packedLines`).get()]);
  const partBlockers = partShipBlockers(id, { ...order, lines: freshLines.val() ?? order.lines, packedLines: freshPacked.val() ?? order.packedLines });
  if (partBlockers.length) {
    const why = partShipReason(partBlockers);
    await db.ref(`${ONLINE_ORDERS_PATH}/${id}`).update({
      fulfilState: "courier_failed",
      "fulfil/state": "courier_failed",
      courierError: why,
      attention: { kind: ATTENTION_KIND.COURIER_FAILED, reason: `Packed, but not shipped: ${why}`, at: now },
      attentionOpen: true,
      updatedAt: now,
    });
    ctx.summary.courierFailed = (ctx.summary.courierFailed ?? 0) + 1;
    log(`  ✗ ${orderLabel(order)}: ${why} — courier not booked, Shopify waits`);
    return;
  }
  // The hub orders close WHILE the courier is booked (fast booking, 20 Nov 2026): neither needs the other, and the
  // waybill is what the packer waits for. Its failure still stops this ship before Shopify, exactly as before (it is
  // awaited below); the order stays pending, and the retry's booking finds the waybill already there.
  const closing = closeHubOrders(ctx, { ...order, key: id });
  closing.catch(() => {}); // observed here so it is never an unhandled rejection; awaited below
  // The order goes to bookShipment WITH its key (the record carries
  // shopifyGid too, which bookShipment can derive the key from — the explicit
  // key removes any doubt). The poll's own db is passed so booking never opens
  // a second connection, and `deps.courier` (tests inject a fake) replaces the
  // real Courier Guy client.
  //
  // NOTHING COURIER-SIDE MAY BLOCK THE FULFILMENT BELOW: a booking error is
  // recorded, and a record that cannot be written is logged and skipped —
  // otherwise the order would stay pending and be re-quoted every tick.
  // An order ingested before shipping/geo existed (21 Nov 2026): Shopify's point for its address, asked once, so the
  // door-to-locker booking places the customer by it rather than by an OpenStreetMap name match (#2181).
  if (!order.shipping?.geo && !order.shipping?.geoAsked && order.shopifyGid && ctx.graphql && order.shipping?.address) {
    order = await backfillShippingGeo(ctx, id, order);
  }
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
      ...(ctx.geocoder ? { geocoder: ctx.geocoder } : {}), // door-to-locker: the address → map point (tests inject)
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
  // OVER THE CEILING (Junid, 6 Nov 2026), or NO LOCKER NEAR THE ADDRESS (door-to-locker, 20 Nov 2026: never a
  // silent door-to-door): not booked; Junid gets ONE WhatsApp line with the cheaper option / the reason. Queued once per order (the first wins);
  // the courier-recon runner sends it through Jamie (scripts/shipping/courier-recon.mjs).
  if (booking?.junidLine) {
    try {
      // One line per order (a re-quote at another rate does not send a second).
      const lineRef = db.ref(`shipping_recon/junidLines/${id}`);
      if (!(await lineRef.get()).exists()) await lineRef.set({ orderId: id, text: booking.junidLine, at: now });
    } catch (e) {
      log(`  ! ${orderLabel(order)}: ceiling line not queued — ${String(e?.message || e).slice(0, 200)}`);
    }
  }
  // A real booking above R250 (or /config/shipping/costAlertRand): Junid is
  // emailed once, with the box and why (costAlert.mjs). Never blocks the ship.
  if (booking && !booking.skipped && booking.waybill) {
    // The reconciliation loop's open set (scripts/shipping/reconcile.mjs): read back after delivery.
    try { await db.ref(`shipping_recon/open/${id}`).set(now); } catch (e) { log(`  ! ${orderLabel(order)}: recon open-set not written — ${String(e?.message || e).slice(0, 120)}`); }
    await queueCostAlert(ctx, id, order, booking);
  }
  // A crash between the booking and the queue: the next tick's booking says
  // "already booked" with the recorded shipping — queue from that (deduped by waybill).
  else if (booking?.reason === "already booked" && booking.shipping?.waybill) await queueCostAlert(ctx, id, order, booking.shipping);
  // ── LIVE: no waybill, no fulfilment ────────────────────────────────────────
  // With /config/shipping/live on, the customer's Shopify notification must
  // carry the waybill, so a booking that did not happen (failed, refused,
  // unconfirmed) HOLDS the fulfilment: "Packed, courier not booked", Junid is
  // emailed through the attention path, and the POS Retry puts the order back
  // to pending — the next tick re-runs the booking only, never the sale.
  // Live off: unchanged — the dry run is recorded and Shopify is fulfilled.
  // An earlier tick's booking: on the order, or — if its record write failed
  // ("booked but not recorded") — on the claim, where bookShipment kept it.
  await closing;
  const booked = order.shipping?.waybill ?? (order.shipping?.courierBooking?.state === "booked" ? order.shipping.courierBooking.waybill ?? null : null);
  const waybill = booking && !booking.skipped
    ? booking.waybill
    : (booking?.reason === "already booked" || /booking already booked/.test(String(booking?.reason)) ? booked : null);
  let live = false;
  try { live = await readLive(db); } catch (e) { live = true; log(`  ! ${orderLabel(order)}: could not read the live switch — holding (${String(e?.message || e).slice(0, 120)})`); }
  // An exchange (no Shopify order) is finished only on a booking or a recorded dry run (CodeRabbit, #815): a plan that
  // failed with live off (no address, no usable rate) takes the courier-failure path instead of "done".
  const exchangeUnplanned = !order.shopifyGid && isExchangeKey(id) && !waybill && !booking?.dryRun;
  if ((live && !waybill) || exchangeUnplanned) {
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
  } else if (order.reship && typeof order.reship === "object") {
    // A SECOND PARCEL (docs/ONLINE-ORDERS.md "Second parcel"): its items are already fulfilled on Shopify with the
    // first parcel, so nothing is fulfilled — the new waybill is added to the order's tracking (no Shopify email;
    // the customer agent tells the customer). With live off there is no waybill: the dry run is recorded, as for any order.
    try {
      out = waybill
        ? await addTrackingToOrder(ctx.graphql, { orderGid: order.shopifyGid, number: waybill, url: courierTrackUrl(waybill), company: COURIER_COMPANY, fill: courierTrackUrl })
        : { ok: true, reshipNote: "no waybill (the live switch was off) — Shopify not changed" };
      if (out.ok) out = { ...out, reship: true };
    } catch (e) {
      out = { ok: false, error: String(e?.message || e) };
    }
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
      ...(out.reship ? { "fulfil/note": out.reshipNote || (out.alreadyDone ? `Second parcel: waybill ${waybill} was already on the Shopify order's tracking` : `Second parcel: waybill ${waybill} added to the Shopify order's tracking (no Shopify email)`) } : {}),
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
      : out.reship
      ? `  ✓ ${orderLabel(order)}: second parcel shipped${waybill ? ` (waybill ${waybill}, added to the Shopify order's tracking)` : " (no waybill: live off)"}`
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
// WHICH ORDERS ARE LOOKED AT (ATTENTION_SWEEP_MS has the reasoning). Every
// tick: the orders this tick handled, one exact /attention read each (a couple
// of hundred bytes, or nothing), and the whole order only for one that really
// has an unmailed attention. Every 10 minutes: the indexed attentionOpen query
// over all orders, as every tick used to run it. The sweep is stamped done only
// when it left nothing unsent, so "retried next tick" stays true: an email
// that could not be sent keeps the sweep due until it has gone.
async function attentionOnTouched(ctx) {
  const open = {};
  for (const id of ctx.touched ?? []) {
    const attention = await ctx.get(`${ONLINE_ORDERS_PATH}/${id}/attention`);
    if (!attention || attention.mailedAt) continue;
    const order = await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`);
    if (order?.attentionOpen === true) open[id] = order;
  }
  return open;
}

async function mailAttention(ctx) {
  const { db, send, log } = ctx;
  const sweptAt = Number(ctx.meta?.attentionSweepAt) || 0;
  // A stamp from the future (a restored node, a stepped clock) is not a reason
  // to stop sweeping: it counts as never swept.
  const sweepDue = !(sweptAt > 0 && sweptAt <= ctx.now && ctx.now - sweptAt < ATTENTION_SWEEP_MS);
  let open = null;
  if (sweepDue) {
    open = await queryEq(ctx, "attentionOpen", true);
    // No index pasted: the query answered nothing, which is not "no attention".
    if (ctx.summary.missingIndex.has("attentionOpen")) open = null;
  }
  const swept = open !== null;
  if (!swept) open = await attentionOnTouched(ctx);
  const unmailed = Object.entries(open).filter(([, o]) => o?.attention && !o.attention.mailedAt);
  // `clean` is set only when every mail that was due has gone. A throw part-way
  // through the sends (architect review, 11 Nov) used to leave `unsent` at 0
  // and stamp the sweep as done, hiding an unmailed closed order for ten
  // minutes; now anything but a normal, complete return leaves the sweep due.
  let clean = false;
  try {
    if (!unmailed.length) { clean = true; return; }
    if (!send) { log(`  ⚠ ${unmailed.length} attention email(s) not sent — no mail sender on this machine; retried next tick`); return; }
    clean = (await sendAttentionMails(ctx, unmailed)) === 0;
  } finally {
    // An email owed on an order this tick handled, on a tick that did not
    // sweep (CodeRabbit, PR #891): the next tick may not handle that order, so
    // the sweep is made due now and the retry comes next tick, not in ten
    // minutes. 0 = never swept.
    if (!swept && !clean && unmailed.length) {
      try { await db.ref(`${META_PATH}/attentionSweepAt`).set(0); }
      catch (err) { log(`  ⚠ attentionSweepAt not cleared (${err?.message || err})`); }
    }
    if (swept && clean) {
      // A lost stamp costs one extra sweep. It must never replace an error in
      // flight or stop the rest of the tick.
      try { await db.ref(`${META_PATH}/attentionSweepAt`).set(ctx.now); }
      catch (err) { log(`  ⚠ attentionSweepAt not written (${err?.message || err}); the sweep runs again next tick`); }
    }
  }
}

// → how many could NOT be sent (they are retried next tick).
async function sendAttentionMails(ctx, unmailed) {
  const { db, send, log } = ctx;
  let unsent = 0;
  for (const [id, order] of unmailed) {
    const at = order.attention.at;
    try {
      await send(attentionMail(order));
    } catch (e) {
      unsent++;
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
  return unsent;
}

// ── The expensive-waybill email (Junid, 30 Oct 2026) ─────────────────────────
// QUEUED, then sent at the end of the tick (never in the ship sweep, so a slow
// mail server never holds a fulfilment). The queue entry carries the finished
// email, so it survives a missing mail sender, a failed send or a crash, and
// is retried every tick until sent (dropped after a day, logged). One email
// per WAYBILL: the order's shipping/costAlert names the waybill it is for, so
// a re-booking (new waybill) is alerted again and the same one never twice.
export const COST_ALERT_QUEUE = `${META_PATH}/costAlertQueue`;
const COST_ALERT_GIVE_UP_MS = 24 * 60 * 60 * 1000;
// Keyed by order AND waybill: a re-booking never overwrites an alert still waiting.
export const costAlertKey = (id, waybill) => `${id}_${String(waybill).replace(/[^A-Za-z0-9_-]/g, "-")}`;
async function queueCostAlert(ctx, id, order, booking) {
  const { db, log } = ctx;
  try {
    const threshold = costAlertThreshold(await ctx.get("config/shipping/costAlertRand"));
    const mail = costAlertMail(order, { ...booking, address: order.shipping?.address }, threshold);
    if (!mail) return;
    // QUEUE FIRST, then mark the order: a failure between the two leaves the
    // email queued (sent) rather than marked-but-never-queued (lost). Ticks
    // never overlap (reconcile-runner's single-flight lock) and the fast path
    // ships an order only under its ship lock, so the read-then-write below
    // cannot race another shipper of the same order.
    const markRef = db.ref(`${ONLINE_ORDERS_PATH}/${id}/shipping/costAlert`);
    if ((await ctx.get(`${ONLINE_ORDERS_PATH}/${id}/shipping/costAlert/waybill`)) === booking.waybill) return;
    await db.ref(`${COST_ALERT_QUEUE}/${costAlertKey(id, booking.waybill)}`).set({ orderId: id, waybill: booking.waybill, subject: mail.subject, text: mail.text, at: ctx.now, attempts: 0 });
    await markRef.set({ state: "queued", at: ctx.now, waybill: booking.waybill });
  } catch (e) {
    log(`  ! ${orderLabel(order)}: expensive-waybill alert not queued — ${String(e?.message || e).slice(0, 200)}`);
  }
}

async function mailCostAlerts(ctx) {
  const { db, send, log } = ctx;
  let queue;
  try { queue = (await ctx.get(COST_ALERT_QUEUE)) || {}; }
  catch (e) { log(`  ! expensive-waybill queue not read — ${String(e?.message || e).slice(0, 200)}`); return; }
  const entries = Object.entries(queue).filter(([, q]) => q && q.subject && q.text);
  if (!entries.length) return;
  // Each entry's bookkeeping is guarded on its own: a database hiccup is logged
  // and the tick goes on (lastRunAt and the other entries are never skipped).
  // Send-then-delete is not exactly-once: a delete that fails after a send
  // means the same email again next tick — accepted over a lost one.
  for (const [key, q] of entries) {
    const id = q.orderId || key;
    const shippingRef = db.ref(`${ONLINE_ORDERS_PATH}/${id}/shipping/costAlert`);
    const stale = ctx.now - (Number(q.at) || ctx.now) > COST_ALERT_GIVE_UP_MS;
    try {
      if (!send) {
        if (stale) {
          await db.ref(`${COST_ALERT_QUEUE}/${key}`).set(null);
          await shippingRef.update({ state: "failed", error: "no mail sender for a day" });
          log(`  ✗ ${id}: expensive-waybill email for ${q.waybill} given up — no mail sender on this machine for a day`);
        } else {
          log(`  ⚠ ${id}: expensive-waybill email for ${q.waybill} waiting — no mail sender on this machine; retried next tick`);
        }
        continue;
      }
      try {
        await send({ subject: q.subject, text: q.text });
      } catch (e) {
        const why = String(e?.message || e).slice(0, 200);
        if (stale) {
          await db.ref(`${COST_ALERT_QUEUE}/${key}`).set(null);
          await shippingRef.update({ state: "failed", error: why });
          log(`  ✗ ${id}: expensive-waybill email for ${q.waybill} given up after a day (${why})`);
        } else {
          await db.ref(`${COST_ALERT_QUEUE}/${key}/attempts`).set((Number(q.attempts) || 0) + 1);
          log(`  ✗ ${id}: expensive-waybill email for ${q.waybill} not sent (${why}) — retried next tick`);
        }
        continue;
      }
      await db.ref(`${COST_ALERT_QUEUE}/${key}`).set(null);
      // Mark mailed only if the order's alert is still for THIS waybill (a plain
      // read is safe: ticks never overlap — a transaction's cold-cache null run
      // would abort here).
      if ((await ctx.get(`${ONLINE_ORDERS_PATH}/${id}/shipping/costAlert/waybill`)) === q.waybill) {
        await shippingRef.update({ state: "mailed", mailedAt: ctx.now });
      }
      log(`  ✉ ${id}: Junid emailed — expensive waybill ${q.waybill}`);
    } catch (e) {
      log(`  ! ${id}: expensive-waybill bookkeeping failed — ${String(e?.message || e).slice(0, 200)}`);
    }
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
  // Every hub order at once (separate records, one transaction each).
  const keys = linesOf(order).flatMap((line) => (Array.isArray(line?.source?.orderKeys) ? line.source.orderKeys : []));
  await Promise.all([...new Set(keys)].map((key) =>
      ctx.db.ref(`orders/${key}`).transaction((cur) => {
        // null on the cold pass (never undefined, which aborts without asking
        // the server); writing null over an absent record changes nothing.
        if (cur == null) return null;
        if (!ownsHubOrder(cur, order.key ?? cur.onlineOrderId) || cur.channel !== "online") return undefined;
        if (cur.status === "collected" || cur.status === "out_of_stock") return undefined;
        return { ...cur, status: "collected", collectedAt: iso, updatedAt: iso };
      })));
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

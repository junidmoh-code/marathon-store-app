// ── THE line swap: one website-order line becomes another product ────────────
// The ONE implementation every swap goes through (docs/ONLINE-ORDERS.md § Swap):
//   • Jimmy (marathon-dm-agent) — through scripts/swap-online-order-line.mjs
//   • the POS "Replace" button — the POS writes a swap request on the order and
//     the Mac mini's poller applies it here (scripts/shopify/onlineOrders/swapRequests.mjs)
//   • the customer agent's "pick N" builds its line with swappedLine() below,
//     so the record a customer's pick leaves is the record a manual swap leaves.
//
//   1. the line becomes the new product, routed by the app's own route against
//      FREE stock (live units minus other web orders' holds and this order's
//      other lines): footwear → hub1, hub2 (pick); anything else → Marathon PE,
//      Trophy (display), then Hub 2 (pick). The poller's next pass creates the
//      new hub order (a fresh three-letter code: routeGen + 1) or Display Checks
//      strip entry, exactly as for a fresh line, and the parcel estimate.
//   2. the old line's list state goes: hub order(s) still incoming are removed;
//      a display entry still open is closed (tombstone, "cancelled"); an open
//      escalation request is withdrawn (escalate.mjs withdrawRequest) and its
//      registry row dropped.
//   3. RETURN TO SHELF: an item already handed over (a hub order the hub sent,
//      a strip entry answered "Handed over", a line confirmed in hand) is with
//      the packer. Nothing was ever deducted for it, so no stock moves: it goes
//      back where it came from. /online_orders/{id}/returns/{i}_{gen} says so on
//      the card; the hub order is stamped `returnToShelf` (its queue card says
//      so); a Trophy item gets a "Put back" row on Trophy's Website orders strip.
//   4. holds: recomputed from the swapped order (holdRowsFor) for the old and
//      the new product, so the counts are right the moment the swap lands;
//      Shopify's inventory sync is nudged for both products.
//
// Nothing here moves stock and nothing here edits the Shopify order (no
// write_orders scope): the Pack deducts the replacement from its routed
// location and fulfils the original Shopify line item; the reconciler then
// pushes both variants from app stock (poll.mjs marks the original dirty after
// the fulfilment). Money is never moved here: the caller decides (the agent's
// money() path).
//
// Refused: a packed / cancelled / closed order (the agent's follow-up path owns
// a packed one), a line moved / resolved / cancelled, a size the product does
// not have, no free unit anywhere on the route, a dearer item without a price
// decision, a line that changed since the person looked at it (`expect`).
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { routeLine, availableAt, ROUTED_LOCATIONS } from "../shopify/onlineOrders/routing.mjs";
import { placeName, linesOf, holdRowsFor, displayKey } from "../shopify/onlineOrders/orderModel.mjs";
import { withdrawRequest, ESCALATIONS_PATH } from "../shopify/onlineOrders/escalate.mjs";
import { judgeSwap, paidCents, rands } from "../online/agent/core.mjs";
import { ONLINE_ORDERS_PATH, ONLINE_RESERVATIONS_PATH, PACKING_STORE, LINE_STATUS, ONLINE_RETURN_KIND } from "../../src/utils/onlineOrders.js";
import { stockSizeKey } from "../../src/utils/sizeKey.js";
import { productIsFootwear } from "../../src/utils/footwearLine.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIRTY_PATH = "shopify_inventory_dirty";
const clean = (v) => JSON.parse(JSON.stringify(v ?? null));

/** firebase-admin's database from the functions package and the reconciler key (callers may pass their own `db`). */
export function openDb({ keyFile = path.join(process.env.HOME || "", ".config", "marathon", "shopify-reconciler-sa.json"), databaseURL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" } = {}) {
  const require = createRequire(path.join(HERE, "..", "..", "functions", "package.json"));
  const admin = require("firebase-admin");
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(require(keyFile)), databaseURL });
  return { db: admin.database(), admin };
}

/** "Customer agreed to pay the difference" / "we absorb it" — the only ways a dearer item is allowed. */
export const PRICE_DECISIONS = Object.freeze(["customer_pays", "we_absorb"]);
/** A line in one of these states cannot be swapped. */
const NOT_SWAPPABLE = new Set([LINE_STATUS.MOVED, LINE_STATUS.RESOLVED, LINE_STATUS.CANCELLED]);
const CLOSED_ORDER = new Set(["packed", "cancelled", "fulfilled_elsewhere", "closed", "release_requested"]);

const lineLabel = (l) => `${l?.title || "?"}${l?.size && l.size !== "_" ? ` ${l.size}` : ""}`;
const whoName = (by) => (typeof by === "string" ? by : by?.name || null);
const saDate = (ms) => new Date(ms + 2 * 3600e3).toISOString().slice(0, 10);

/** What the line WAS, kept on the swapped line (the card strikes it through: "Replaced by …, who, when"). */
export function swapFromRecord(line, { at, by = null, via, hubOrders = [], requestId = null }) {
  return clean({
    pid: line.pid, size: line.size ?? null, sizeKey: line.sizeKey ?? null, title: line.title,
    photoUrl: line.photoUrl ?? null, unitPriceCents: line.unitPriceCents,
    locationId: line.source?.locationId ?? null, status: line.source?.status ?? null,
    ...(hubOrders.length ? { hubOrders } : {}),
    at, by, via,
    ...(requestId ? { requestId } : {}),
  });
}

/**
 * PURE: the swapped line. `item` = { pid, size, sizeKey, title, photoUrl, category,
 * isFootwear?, barcode?, priceCents, locationId, status }. The escalation goes (a
 * fresh line), routeGen moves on (a fresh hub code / strip key), what was paid
 * stays (originalUnitPriceCents), and `resolution` is the caller's (the agent
 * closes its conversation in it).
 */
export function swappedLine(cur, item, { swappedFrom, outcome, resolution }) {
  const { escalation: _e, escalationOverride: _o, ...rest } = cur;
  return clean({
    ...rest,
    pid: item.pid, size: item.size, sizeKey: item.sizeKey || stockSizeKey(item.size), title: item.title,
    photoUrl: item.photoUrl ?? null, category: item.category ?? cur.category ?? null,
    ...(item.isFootwear != null ? { isFootwear: item.isFootwear } : {}),
    ...(item.barcode !== undefined ? { barcode: item.barcode ?? null } : {}),
    unitPriceCents: item.priceCents,
    originalUnitPriceCents: Number.isInteger(cur.originalUnitPriceCents) ? cur.originalUnitPriceCents : cur.unitPriceCents,
    swappedFrom, routeGen: (Number(cur.routeGen) || 0) + 1,
    escalationGen: (Number(cur.escalationGen) || 0) + 1,
    source: { locationId: item.locationId, status: item.status },
    resolution: resolution ?? { ...(cur.resolution || {}), outcome },
  });
}

// Free units per routed location for pid/sizeKey: live cells minus every other
// order's holds (availableAt) minus what THIS order's other lines hold there.
async function defaultAvailable({ get, orderKey, order, i, pid, sizeKey, displayFeedOn }) {
  const stockQty = {};
  for (const loc of ROUTED_LOCATIONS) stockQty[loc] = Number(await get(`stock/${loc}/${pid}/${sizeKey}/qty`)) || 0;
  const holdsCell = await get(`${ONLINE_RESERVATIONS_PATH}/${pid}/${sizeKey}`);
  const free = availableAt({ stockQty, holdsCell, orderId: String(orderKey) });
  linesOf(order).forEach((l, k) => {
    if (k === i || l?.pid !== pid || String(l.sizeKey) !== sizeKey) return;
    const loc = l.source?.locationId;
    if (loc && free[loc] != null) free[loc] = Math.max(0, free[loc] - (Number(l.qty) || 0));
  });
  // A shop whose Display Checks are off can neither see nor close an entry.
  if (displayFeedOn) for (const shop of ["marathon-pe", "trophy"]) if ((await displayFeedOn(shop)) === false) free[shop] = 0;
  return { stockQty, free };
}

/**
 * swapOnlineOrderLine({ orderKey, lineIndex, newPid, size, dry, allowHigher, priceDecision,
 *   by, via, expect, db, admin, increment, now, log, displayFeedOn })
 * → { ok, summary, plan, notes, refused?, creditCents, extraCents, returns }.
 * `summary` is the one line Jimmy relays ("#1776 updated: …" / "#1776 NOT changed: …").
 */
export async function swapOnlineOrderLine({
  orderKey, lineIndex, newPid, size, dry = false, allowHigher = false, priceDecision = null,
  by = null, via = "cli", requestId = null, expect = null, db = null, admin = null, increment = null, now = Date.now(), log = () => {}, displayFeedOn = null,
}) {
  if (!db) ({ db, admin } = openDb());
  const get = async (p) => (await db.ref(p).get()).val();
  const inc = increment || (admin?.database?.ServerValue?.increment ? (n) => admin.database.ServerValue.increment(n) : null);
  const i = Number(lineIndex);
  const sizeKey = stockSizeKey(size == null || size === "" ? "_" : size);
  let ref = orderKey;
  const refuse = (why, extra = {}) => ({ ok: false, refused: why, summary: `#${ref} NOT changed: ${why}`, ...extra });

  if (!Number.isInteger(i) || i < 0) return refuse(`no line ${lineIndex}`);
  const order = await get(`${ONLINE_ORDERS_PATH}/${orderKey}`);
  if (!order) return refuse("no such order");
  ref = order.orderNumber || String(order.shopifyName || "").replace(/\D/g, "") || orderKey;
  const line = linesOf(order)[i];
  if (!line) return refuse(`no line ${i}`);
  if (order.status === "packed") return refuse("the order is packed: a swap now ships as a follow-up (the store customer agent's path)");
  if (CLOSED_ORDER.has(order.status)) return refuse(`the order is ${order.status}`);
  if (NOT_SWAPPABLE.has(line.source?.status)) return refuse(`line ${i} is ${line.source.status}`);
  if (expect && (expect.pid !== line.pid || String(expect.sizeKey ?? "") !== String(line.sizeKey ?? ""))) return refuse("the line changed since it was looked at (someone swapped or rerouted it)");
  const product = await get(`products/${newPid}`);
  if (!product) return refuse(`no product ${newPid}`);
  const sizes = (Array.isArray(product.sizes) ? product.sizes : Object.values(product.sizes || {})).map((s) => stockSizeKey(s));
  if (sizes.length && !sizes.includes(sizeKey)) return refuse(`${product.name} has no size ${sizeKey} (sizes: ${sizes.join(", ")})`);
  if (line.pid === newPid && String(line.sizeKey ?? "_") === sizeKey) return refuse("the line already is that product and size");
  if (priceDecision != null && !PRICE_DECISIONS.includes(priceDecision)) return refuse(`unknown price decision ${priceDecision}`);

  const priceCents = Math.round(Number(product.retailPrice ?? product.price) * 100) || 0;
  const judged = judgeSwap(line, { priceCents });
  const paid = paidCents(line);
  if (!judged.ok && !priceDecision && !allowHigher) {
    return refuse(`${product.name} costs ${rands(judged.extraCents)} more than the ${rands(paid)} paid — the customer must agree to pay it, or we absorb it`, { extraCents: judged.extraCents });
  }

  const { stockQty, free } = await defaultAvailable({ get, orderKey, order, i, pid: newPid, sizeKey, displayFeedOn });
  const isFootwear = productIsFootwear(product);
  const qty = Math.max(1, Number(line.qty) || 1);
  const pieces = routeLine({ qty, isFootwear, available: free });
  const piece = pieces[0];
  if (!piece || !piece.locationId || pieces.length > 1) {
    return refuse(`no free unit of ${product.name}${sizeKey === "_" ? "" : ` size ${sizeKey}`} on the route (free: ${ROUTED_LOCATIONS.map((l) => `${placeName(l)} ${free[l] ?? 0}`).join(", ")})`);
  }

  const oldKeys = Array.isArray(line.source?.orderKeys) ? line.source.orderKeys : [];
  const oldEntry = !oldKeys.length && line.source?.entryKey ? line.source.entryKey : null;
  const esc = line.escalation;
  const plan = {
    order: `#${ref}`, line: i, from: lineLabel(line), to: `${product.name}${sizeKey !== "_" ? ` ${sizeKey}` : ""}`,
    oldSource: line.source || null, oldEscalation: esc ? { phase: esc.phase, request: esc.request || null } : null,
    stock: Object.fromEntries(ROUTED_LOCATIONS.map((l) => [l, { onHand: stockQty[l], free: free[l] ?? 0 }])),
    route: { locationId: piece.locationId, status: piece.status, place: placeName(piece.locationId) },
    price: { paidCents: paid, newCents: priceCents * qty, creditCents: judged.ok ? judged.creditCents : 0, extraCents: judged.ok ? 0 : judged.extraCents, decision: judged.ok ? null : (priceDecision || "allow_higher") },
    willRemoveHubOrders: oldKeys, willTombstoneEntry: oldEntry,
    willWithdrawRequest: esc?.phase === "await" && esc.request ? esc.request : null,
  };
  const summary = `#${ref} updated: ${plan.from} → ${plan.to}, ${piece.status === "display" ? "display pick" : "pick"} raised at ${placeName(piece.locationId)}`;
  if (dry) return { ok: true, dry: true, summary: `DRY RUN — ${summary}`, plan, creditCents: plan.price.creditCents, extraCents: plan.price.extraCents };

  // ── 1. The line (first, guarded: a line someone moved meanwhile is left alone).
  const swappedFrom = swapFromRecord(line, { at: now, by, via, hubOrders: oldKeys, requestId });
  const item = {
    pid: newPid, size: size == null || size === "" ? "_" : String(size), sizeKey, title: product.name,
    photoUrl: product.photoUrl || product.photo || null, category: product.category ?? null, isFootwear,
    barcode: product.barcodes?.[sizeKey] ?? (sizes.length <= 1 ? product.barcode ?? null : null),
    priceCents, locationId: piece.locationId, status: piece.status,
  };
  const outcome = clean({ kind: "swap", pid: newPid, size: item.size, creditCents: plan.price.creditCents, extraCents: plan.price.extraCents || null, priceDecision: plan.price.decision, at: now, by: whoName(by), via });
  const expectKey = `${line.pid}|${line.sizeKey ?? ""}|${line.source?.status ?? ""}|${Number(line.routeGen) || 0}`;
  const res = await db.ref(`${ONLINE_ORDERS_PATH}/${orderKey}/lines/${i}`).transaction((cur) => {
    if (cur == null) return null; // the cold pass; the server value decides
    if (`${cur.pid}|${cur.sizeKey ?? ""}|${cur.source?.status ?? ""}|${Number(cur.routeGen) || 0}` !== expectKey) return undefined;
    // An open customer-agent conversation is closed: the line is settled by this swap.
    const conv = cur.resolution?.conversation;
    const resolution = { ...(cur.resolution || {}), outcome, ...(conv && conv.state !== "closed" ? { conversation: { ...conv, state: "closed", closedAt: now, closedBy: via } } : {}) };
    return swappedLine(cur, item, { swappedFrom, outcome, resolution });
  });
  if (!res.committed || !res.snapshot.val()) return refuse("the line changed meanwhile; nothing written to it", { plan });
  const gen = Number(res.snapshot.val().routeGen) || 0;
  // The basket tick and pair codes confirmed for the OLD item say nothing about
  // the new one: the replacement must be scanned / confirmed in hand afresh.
  await db.ref(`${ONLINE_ORDERS_PATH}/${orderKey}/basket/${i}`).set(null);
  for (const k of oldKeys) await db.ref(`${ONLINE_ORDERS_PATH}/${orderKey}/codesIn/${k}`).set(null);

  // ── 2. The old line's list state, and 3. what goes back to the shelf.
  const notes = [];
  const back = { hubOrders: [], at: null };
  for (const k of oldKeys) {
    const r = await db.ref(`orders/${k}`).transaction((cur) => {
      if (cur == null) return null;
      if (cur.channel !== "online" || String(cur.onlineOrderId) !== String(orderKey) || Number(cur.onlineLineIndex) !== i) return undefined;
      if (cur.status === "incoming" || cur.status === "coming_tomorrow") return null;
      if (cur.status === "ready" || cur.status === "collected") {
        if (cur.returnToShelf) return undefined;
        return { ...cur, returnToShelf: clean({ at: now, by: whoName(by), orderNumber: order.orderNumber ?? null, swappedTo: plan.to, note: `Website order #${ref} swapped this for ${plan.to} — put it back on the shelf` }), updatedAt: new Date(now).toISOString() };
      }
      return undefined;
    });
    const left = r.snapshot?.val();
    if (left && left.returnToShelf && (left.status === "ready" || left.status === "collected")) {
      back.hubOrders.push(k);
      back.at = left.hub || line.source?.locationId || null;
      notes.push(`hub order ${k} was already sent by ${placeName(left.hub)}: marked RETURN TO SHELF`);
    } else if (!left) notes.push(`hub order ${k} cancelled (removed from ${placeName(line.source?.locationId)}'s queue)`);
    else notes.push(`hub order ${k} left as it is (${left.status})`);
  }
  let handedEntry = false;
  if (oldEntry && oldEntry.startsWith("displayChecks_active/")) {
    const r = await db.ref(oldEntry).transaction((cur) => {
      if (cur == null) return null;
      if (cur.status !== "open") return undefined;
      return { ...cur, status: "completed", result: "cancelled", completedAt: now, completedSaDate: saDate(now), completedBy: { name: "Website order line swapped" } };
    });
    const left = r.snapshot?.val();
    handedEntry = !!left && left.status === "completed" && left.result === LINE_STATUS.HANDED;
    notes.push(handedEntry ? "display entry was already handed over" : "display entry closed");
  }
  if (plan.willWithdrawRequest) {
    await withdrawRequest({ db, now }, String(orderKey), i, esc);
    notes.push(`escalation request ${esc.request.key} withdrawn (only if untouched)`);
  }
  if (esc) await db.ref(`${ESCALATIONS_PATH}/${orderKey}_${i}`).set(null);

  const handed = line.source?.status === LINE_STATUS.HANDED || handedEntry || back.hubOrders.length > 0;
  let returnRec = null;
  if (handed) {
    const loc = back.at || line.source?.locationId || null;
    const rid = `${i}_${gen}`;
    returnRec = clean({
      lineIndex: i, pid: line.pid, size: line.size ?? null, sizeKey: line.sizeKey ?? null, title: line.title, photoUrl: line.photoUrl ?? null,
      qty: Number(line.qty) || 1, locationId: loc, hubOrders: back.hubOrders.length ? back.hubOrders : null,
      swappedTo: plan.to, at: now, by: whoName(by), via, state: "open",
    });
    // A shop other than the packing store sees it on its own Website orders strip.
    if (loc && loc !== PACKING_STORE && !back.hubOrders.length && ["trophy", "marathon-pe"].includes(loc)) {
      const key = `${displayKey(orderKey, i, gen)}__return`;
      returnRec.entryKey = `displayChecks_active/${loc}/${key}`;
      await db.ref(returnRec.entryKey).transaction((cur) => (cur == null ? clean({
        kind: ONLINE_RETURN_KIND, checkId: db.ref(`displayChecks_active/${loc}`).push().key,
        productId: line.pid, productName: line.title, size: line.size == null || line.size === "" ? "_" : String(line.size), sizeKey: line.sizeKey,
        dedupeKey: key, photoUrl: line.photoUrl, qty: Number(line.qty) || 1, saleCount: Number(line.qty) || 1,
        status: "open", createdAt: now, activatedAt: now, activatedSaDate: saDate(now),
        orderId: String(orderKey), lineIndex: i, returnId: rid, ref: `#${ref}`, orderNumber: order.orderNumber ?? null,
        instruction: "Put back on the floor — the website customer swapped it",
      }) : undefined));
    }
    await db.ref(`${ONLINE_ORDERS_PATH}/${orderKey}/returns/${rid}`).transaction((cur) => (cur == null ? returnRec : undefined));
    notes.push(`RETURN TO SHELF: ${plan.from} goes back to ${placeName(loc)} (nothing was deducted for it)`);
  }

  // ── 4. The record, the holds, Shopify's nudge.
  await db.ref(`${ONLINE_ORDERS_PATH}/${orderKey}/lines/${i}/resolution/log`).push().set(clean({ at: now, action: "swapped", note: `${plan.from} → ${plan.to} at ${placeName(piece.locationId)}${handed ? " (old item: return to shelf)" : ""}`, by: whoName(by), via }));
  const after = await get(`${ONLINE_ORDERS_PATH}/${orderKey}`);
  const want = holdRowsFor(after || {});
  for (const key of new Set([line.pid && line.sizeKey ? `${line.pid}/${line.sizeKey}` : null, `${newPid}/${sizeKey}`].filter(Boolean))) {
    await db.ref(`${ONLINE_RESERVATIONS_PATH}/${key}/${orderKey}`).set(want[key] ? { ...want[key], at: now } : null);
  }
  if (inc) for (const pid of new Set([line.pid, newPid].filter(Boolean))) await db.ref(`${DIRTY_PATH}/${pid}`).set(inc(1));
  log(summary);
  for (const n of notes) log(`  ${n}`);
  return { ok: true, summary, plan, notes, creditCents: plan.price.creditCents, extraCents: plan.price.extraCents, returns: returnRec ? [returnRec] : [], swappedFrom };
}

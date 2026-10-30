// ── confirmExchangeReturn(key) — an online exchange's returned item back into stock, on Junid's word ─────────────────
//
// Junid, 29 Oct 2026: "when I confirm a return is in good condition, the returned items go back into stock at Marathon PE
// and the outbound is booked", with a stock movement marked "exchange return #<order>", "not a manual adjustment with no
// reason", and the new items deducted exactly once. 30 Oct 2026 (the exchange flow): "wait for my condition OK, then
// ship; returned items added back to stock at Marathon PE automatically."
//
// He says it to Jimmy on his WhatsApp line ("#1785 return is in, good condition"); Jimmy (marathon-dm-agent
// src/jimmy/returnCondition.js) runs scripts/shipping/exchange-return.mjs from this checkout, which calls this.
//
// WHERE THE STOCK IS. The app's ledger is the stock of record: /stock_movements is the append-only source of truth and
// /stock/{loc}/{pid}/{sizeKey} its cache (SCHEMA.md "STOCK / INVENTORY"); Shopify's quantities are pushed FROM it
// (docs/SHOPIFY-STOCK-TRUTH.md: "the app's inventory is the only source of Shopify quantities"; movementSync.mjs reads
// the ledger from its cursor, the dirty markers and the backstop push on every /stock write). So the return is ONE
// ledger movement per returned unit, written by the server-side writer (functions/lib/admin-movement.cjs
// applyMovementAdmin, the client writer's contract), and Shopify follows by itself — nothing here calls Shopify:
//   type "return" (the ledger's own type: `return +to`), qty 1, reason "exchange return #<n>",
//   link { orderId: <exchange key>, saleId: <the original order's pack sale, when it has one> },
//   actor "system:jimmy-exchange-return",
//   movementId exret_<exchange key>_<pid>_<sizeKey>_<n>: the idempotency key, fixed per exchange and returned unit (not
//   per place), so a second "good condition", a retry or a crash re-run never adds the unit twice.
// Then the Shopify dirty marker for each product is nudged, and a DEACTIVATED product is reactivated in the same pass, as
// the client writer does on every arrival (applyMovement.js isArrival, owner spec 2026-08-25).
//
// WHICH CELL AT MARATHON PE (architect review, PR #820). Marathon PE is section 2 of the network: the Marathon PE shop,
// Trophy, Hub 1 and Hub 2, one building (src/utils/networkRegistry.js). Junid's own sections rule of 2 Oct 2026
// (marathon-pos-app src/stock/returnRouting.js) is that "shops hold NO sneaker stock … a sneaker return goes back to the
// exact cell the sale deducted", and the store app routes online footwear from hub1 / hub2 only (routing.mjs
// FOOTWEAR_ROUTE). A pair booked onto the shop's own cell could never be sold again online or at the till. So:
//   footwear (isFootwearLine: catalogue footwear AND a shoe size, the sale side's own test) → the cell the original
//            pack sale deducted (its ledger row sold:<saleId>:<loc>:<pid>:<sizeKey>, the till's "ledger hit"), when that is
//            Hub 1 or Hub 2; else the hub the original order's line came from (its source.locationId); else the one of
//            the two holding most of the product; else Hub 1 (the footwear route's first). A re-run after a crash reuses
//            the place its own claim recorded, so a unit never lands on two cells;
// THE CREDIT IS CAPPED at what the original sale deducted (Junid's no-negative-cells rule of 11 Sep 2026, the till's
// capReturn): a sale whose ledger row records a `shortfall` deducted fewer units than it rang, so that part is not
// credited back (reported to Junid as withheld), less what earlier refunds already credited (the sale lines'
// refundedQty).
//   anything else → the Marathon PE shop ("marathon-pe"), where the till's return path also leaves clothing.
// Never outside section 2. Junid's answer names the place ("Hub 2, Marathon PE").
//
// THE ARRIVAL. The POS's "Incoming exchanges" (marathon-pos-app src/onlineOrders/incomingExchanges.js) has its own
// Confirm arrival, which puts the item back through the till's return path and writes
// online_orders/<key>/incoming/arrival; the replacement is packable only once that is { state: "done" }
// (orderView.packBlockers). Junid's word on WhatsApp is the same confirmation, so it takes the SAME record, the same way:
//   1. claim: a transaction on incoming/arrival → { state "returning", via "jimmy", attemptId, by, at, items }. A "done"
//      (the POS confirmed it, or an earlier "good condition") → nothing is added again: the answer reports what is there
//      (Jimmy's own units from the record; a till return's units from its ledger rows). A till's claim ("returning" /
//      "failed" carrying the till's plan) → refused: the till's own retry decides whether its return landed.
//   2. the movements (idempotent, above).
//   3. done: { state "done", via "jimmy", at, by, stockReturned [{ movementId, pid, size, title, to, before, after }],
//      returnSaleId null, note }. The POS then lists it under History and its Confirm arrival answers "Already
//      confirmed"; Jimmy's incoming.js moves the stage to "arrived"; Till 2 can pack.
// A crash between 2 and 3 leaves Jimmy's own "returning" claim: the next run takes it over with the same movement ids.
// The claim also carries plan [{ saleId: "jimmy-exchange-return", … }], a sale no till can read: a POS Confirm arrival
// that takes over a stale Jimmy claim inherits that plan, cannot read its sale and stops ("could not be read") instead
// of writing a till return on top of Jimmy's units (spec review, round 2). A clearer POS message is a follow-up there.
// Jimmy re-runs an unfinished one within minutes (returnCondition.js "confirming" rows), well inside the POS's 10-minute
// claim window: the POS takes over only a claim older than that (a POS-side guard for via "jimmy" is a follow-up there).
//   A POS "by hand" arrival (an original sold before the app: "put the item back into stock by hand") is that by-hand
//   step: done here once, UNLESS the ledger already shows the unit put back since the arrival (a return, a received or a
//   positive adjustment of that product and size anywhere in section 2, not this exchange's) → refused, Junid told.
//
// NOT GOOD (condition "not_good"): nothing goes back. incoming/conditionHold = { at, by, words } is written, so this
// command refuses to put anything back while it stands... unless Junid later says good (that clears it), and the poller
// books no courier for the exchange while it stands (poll.mjs shipOrder): nothing ships. Already back in stock → refused
// with what happened, nothing written.
//
// THE REPLACEMENT IS DEDUCTED ONCE, BY THE PACK, NEVER HERE. Jimmy's reservation (src/jimmy/reserve.js) only HOLDS it
// (online_reservations/<pid>/<sizeKey>/<key>, the poller's holds): nothing is deducted at reservation. The Till 2 pack
// (marathon-pos-app packOnlineOrder.js) is the one writer of the online sale: its packClaim mints the sale id once,
// /pos/sales/<id> is create-only, and a packed order is refused a second pack. So this code writes no "sold" movement
// for the replacement, and reports what it checked: each replacement line's place, its stock there now, its hold, and
// whether the pack's sale exists yet (status packed / pack.saleId / packClaim.saleId → /pos/sales/<id>).
//
// THE OUTBOUND is not booked here either: once packed, the poller's SHIP pass (poll.mjs shipOrder, fulfilState
// "pending") books it through bookShipment, under /config/shipping/live and the maxChargeRand ceiling, like every
// website parcel; its waybill lands on online_orders/<key>/shipping/booking.
//
// NEVER MONEY: no refund, no credit, no sale line, no payment, and the original sale is not touched (its refundedQty is
// money's; the movement's link.saleId names it instead). Only the ledger rows, the cells they move, the dirty markers,
// the product's deactivated flag and the arrival / hold records.
//
// dry: everything read and the plan returned (before / after per unit), nothing written.
import { createRequire } from "node:module";
import { isExchangeKey } from "./bookShipment.mjs";
import { assertSafeSegment, stockSizeKey } from "../../src/utils/sizeKey.js";
import { isFootwearLine } from "../../src/utils/footwearLine.js";
import { reactivateUpdates } from "../../src/utils/deactivation.js";

const require = createRequire(import.meta.url);
const { applyMovementAdmin, cellPath } = require("../../functions/lib/admin-movement.cjs");

export const RETURN_TO = "marathon-pe"; // Junid: "back into stock at Marathon PE" (the shop, for everything but sneakers)
export const SECTION_HUBS = Object.freeze(["hub1", "hub2"]); // Marathon PE's hubs (section 2), the footwear route
export const SECTION = Object.freeze(["marathon-pe", "trophy", "hub1", "hub2"]);
export const PLACE = Object.freeze({ "marathon-pe": "Marathon PE", trophy: "Trophy", hub1: "Hub 1", hub2: "Hub 2" });
export const ACTOR = "system:jimmy-exchange-return";
export const VIA = "jimmy";
export const SENTINEL_PLAN = Object.freeze([{ saleId: "jimmy-exchange-return", lineId: "jimmy", qty: 0, refundedBefore: 0, note: "Jimmy is putting this return back: ask Junid, never tap again" }]);
// The POS's ARRIVAL_CLAIM_STALE_MS: a claim younger than this belongs to a writer that is working on it right now.
export const CLAIM_STALE_MS = 10 * 60 * 1000;
// What "already put back by hand" looks like in the ledger: a return, or a positive count correction (Set Qty). A
// delivery (received) or a transfer is ordinary stock flow and does not count (round-2 review 6).
const ARRIVALS = new Set(["return", "adjustment"]);
export const LOOKBACK_MAX_MS = 30 * 86400e3; // the ledger is read back at most this far (round-2 review 5)
// The poller's held-courier text: a later "good" that clears the hold puts a courier_failed order with this text back to pending.
export const HOLD_COURIER_TEXT = "Junid said the returned item is not in good condition: nothing ships until he tells Jimmy otherwise";
const FINISHED = new Set(["cancelled", "closed", "fulfilled_elsewhere", "release_requested"]);
const UNSAFE = /[.#$/[\]\s]/g;

const list = (v) => (Array.isArray(v) ? v : Object.values(v || {})).filter((x) => x && typeof x === "object");
const str = (v) => (v == null ? "" : String(v).trim());
const digits = (v) => str(v).replace(/\D/g, "");

/** The ledger reason Junid asked for. Pure. */
export const reasonFor = (orderNumber) => `exchange return #${digits(orderNumber)}`;

/** The movement id for the n-th unit of one product/size coming back on one exchange. Pure. */
export const movementIdFor = (key, pid, sizeKey, n) => `exret_${key}_${pid}_${sizeKey}_${n}`.replace(UNSAFE, "_");

/**
 * Where one returned unit goes back (header: WHICH CELL). Pure.
 *   product  /products/<pid>     size  the unit's size     origLine  the original order's line (its source)
 *   hubQty   { hub1, hub2 }      the product's units at each Marathon PE hub now (all sizes)
 */
export function destinationFor({ product, size, origLine = null, hubQty = {}, soldLoc = null }) {
  if (!isFootwearLine(product, size)) return RETURN_TO;
  // The cell the original sale actually deducted (its ledger row), as the till's return routing does, wins.
  if (SECTION_HUBS.includes(str(soldLoc))) return str(soldLoc);
  const from = str(origLine?.source?.locationId);
  if (SECTION_HUBS.includes(from)) return from;
  const [a, b] = SECTION_HUBS;
  return (Number(hubQty[b]) || 0) > (Number(hubQty[a]) || 0) ? b : a;
}

/**
 * What is coming back, one entry per unit: incoming.returning (the item(s) Jimmy matched on the ORIGINAL order when the
 * return was booked), else `fallback` (Jimmy's own list, matched on the original order's lines, for a return booked by
 * hand or handed in at a shop). → { ok, fromFallback, items: [{ pid, size, sizeKey, title, origOrderKey, origLineIndex,
 * movementId }] } | { ok: false, why }. Pure.
 */
export function returnPlan(record, key, fallback = null) {
  const own = list(record?.incoming?.returning);
  const from = own.length ? own : list(fallback);
  if (!from.length) return { ok: false, why: "the exchange does not say which item is coming back" };
  const seen = new Map();
  const items = [];
  for (const it of from) {
    const pid = str(it.pid);
    if (!pid) return { ok: false, why: `which product "${str(it.title) || "the returned item"}" is in the app is not recorded` };
    try {
      assertSafeSegment(pid, "productId");
    } catch {
      return { ok: false, why: `"${pid}" is not an app product id` };
    }
    const size = it.size == null || it.size === "" ? "_" : String(it.size);
    const sizeKey = str(it.sizeKey) || stockSizeKey(size);
    const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
    for (let u = 0; u < qty; u++) {
      const id = `${pid}|${sizeKey}`;
      const n = seen.get(id) || 0;
      seen.set(id, n + 1);
      items.push({ pid, size, sizeKey, title: str(it.title) || pid, origOrderKey: str(it.origOrderKey) || null, origLineIndex: Number.isInteger(it.origLineIndex) ? it.origLineIndex : null, movementId: movementIdFor(key, pid, sizeKey, n) });
    }
  }
  return { ok: true, fromFallback: !own.length, items };
}

/** Is this exchange ready for its return to be confirmed? → null (ready) or the reason it is not. Pure. */
export function notReadyWhy(record, { orderNumber = null } = {}) {
  if (!record || typeof record !== "object") return "there is no exchange record in the app for it";
  const n = digits(orderNumber);
  if (n && digits(record.orderNumber) !== n) return `the exchange record is for #${record.orderNumber}, not #${n}`;
  if (!record.exchange || typeof record.exchange !== "object") return "the record is not an exchange";
  if (!(Number(record.exchange.paidAt) > 0)) return "the exchange is not paid yet";
  if (FINISHED.has(str(record.status))) return `the exchange record is ${record.status}`;
  if (!list(record.lines).some((l) => l.pid)) return "no replacement is reserved on it";
  return null;
}

/** The arrival as it stands → "free" | "ours" (Jimmy's own unfinished claim) | "done" | "till" (a till's claim). Pure. */
export function arrivalState(arrival) {
  if (!arrival || typeof arrival !== "object") return "free";
  if (arrival.state === "done" || (arrival.state == null && arrival.returnSaleId)) return "done";
  if (arrival.via === VIA && (arrival.state === "returning" || arrival.state === "failed")) return "ours";
  return "till";
}

/** A ledger row that already put this unit back (a by-hand arrival's step done by someone). Pure. */
export function priorArrivalRow(rows, { pid, sizeKey, key }) {
  for (const [id, m] of Object.entries(rows || {})) {
    if (!m || m.productId !== pid || stockSizeKey(m.size ?? "_") !== sizeKey || !ARRIVALS.has(m.type)) continue;
    if (!SECTION.includes(str(m.to))) continue;
    if (m.link?.orderId === key || String(id).startsWith("exret_")) continue;
    return { id, type: m.type, to: m.to, ts: m.ts || null, reason: m.reason || null };
  }
  return null;
}

/**
 * The replacement's deduction, as checked (Junid: "the new items deducted exactly once"). Pure.
 *   lines   the exchange record's lines        cells  { "<loc>/<pid>/<sizeKey>": qty }   holds { "<pid>/<sizeKey>": row }
 *   saleId  the pack's sale id, if any         saleExists  /pos/sales/<saleId> is there
 */
export function replacementCheck({ record, cells = {}, holds = {}, saleId = null, saleExists = false }) {
  const packed = str(record?.status) === "packed";
  const lines = list(record?.lines).filter((l) => l.pid).map((l) => {
    const sizeKey = str(l.sizeKey) || stockSizeKey(l.size ?? "_");
    const loc = str(l.source?.locationId) || null;
    const hold = holds[`${l.pid}/${sizeKey}`] || null;
    return {
      pid: String(l.pid), size: l.size ?? null, sizeKey, title: str(l.title) || String(l.pid), qty: Number(l.qty) || 1,
      location: loc, stockNow: loc ? Number(cells[`${loc}/${l.pid}/${sizeKey}`]) || 0 : null,
      held: hold ? Number(hold.qty) || 0 : 0,
    };
  });
  const deducted = saleId && saleExists ? "once" : packed ? "packed, sale not found" : "not yet";
  const text = deducted === "once"
    ? `deducted once, by the Till 2 pack (sale ${saleId}); nothing else deducts it`
    : deducted === "not yet"
      ? "not deducted yet: held for the exchange, deducted once when Till 2 packs it (the pack's one sale); nothing else deducts it"
      : "the record says packed but its pack sale was not found: check Till 2 before anything is done by hand";
  return { lines, packed, saleId: saleId || null, deducted, text };
}

const read = async (db, p) => (await db.ref(p).once("value")).val();
const iso = (ms) => new Date(Number(ms) || 0).toISOString();
/** Ledger rows since `sinceMs` (the ts index; a few days of rows at most). */
const rowsSince = async (db, sinceMs) => (await db.ref("stock_movements").orderByChild("ts").startAt(iso(sinceMs)).once("value")).val() || {};
/** Since when the ledger is checked for a unit already put back: the exchange's payment (the return can't be earlier), capped. */
const checkSince = (record, now) => {
  const paid = Number(record?.exchange?.paidAt) || 0;
  return paid > 0 ? Math.max(paid - 3600e3, now - LOOKBACK_MAX_MS) : null;
};

async function checkReplacement(db, key, record) {
  const cells = {}, holds = {};
  for (const l of list(record?.lines).filter((x) => x.pid)) {
    const sizeKey = str(l.sizeKey) || stockSizeKey(l.size ?? "_");
    const loc = str(l.source?.locationId);
    if (loc) cells[`${loc}/${l.pid}/${sizeKey}`] = (await read(db, `${cellPath(loc, l.pid, l.size, sizeKey)}/qty`)) ?? 0;
    holds[`${l.pid}/${sizeKey}`] = await read(db, `online_reservations/${l.pid}/${sizeKey}/${key}`);
  }
  const saleId = str(record?.pack?.saleId) || str(record?.packClaim?.saleId) || null;
  const saleExists = saleId ? (await read(db, `pos/sales/${assertSafeSegment(saleId, "saleId")}`)) != null : false;
  return replacementCheck({ record, cells, holds, saleId, saleExists });
}

/** A ledger row → the unit's before/after where it landed (for a unit that went back on an earlier run). */
async function ledgerUnit(db, it) {
  const mv = await read(db, `stock_movements/${it.movementId}`);
  if (!mv) return null;
  const to = mv.to || it.to || RETURN_TO;
  return { ...it, to, place: PLACE[to] || to, before: mv.before?.[to] ?? null, after: mv.after?.[to] ?? null, ...(mv.negativeCleared?.[to] != null ? { negativeCleared: mv.negativeCleared[to] } : {}), already: true };
}

/**
 * Each unit's facts: its product (must exist), its original line (must be on one of the exchange's original orders when
 * the list is Jimmy's fallback), where it goes back. → { ok, units } | { ok: false, why }.
 */
/** The original sale's ledger row for one product/size (the till's soldCellLookup, section 2 only). → { loc, soldQty, shortfall } | null */
async function soldCellOf(db, saleId, pid, sizeKey) {
  if (!saleId) return null;
  for (const loc of SECTION) {
    const row = await read(db, `stock_movements/sold:${saleId}:${loc}:${pid}:${sizeKey}`).catch(() => null);
    if (row) return { loc, soldQty: Number(row.qty) || 0, shortfall: Number(row.shortfall) || 0 };
  }
  return null;
}

async function resolveUnits(db, key, record, plan, { priorTo = {} } = {}) {
  const related = [...new Set([...list(record?.incoming?.returning).map((x) => str(x.origOrderKey)), ...(Array.isArray(record?.exchange?.relatedOrders) ? record.exchange.relatedOrders.map(str) : [])].filter(Boolean))];
  const origLines = {};
  const linesOf = async (k) => {
    if (!(k in origLines)) {
      try {
        origLines[k] = list(await read(db, `online_orders/${assertSafeSegment(k, "order key")}/lines`));
      } catch {
        origLines[k] = [];
      }
    }
    return origLines[k];
  };
  const products = {}, hubQty = {}, sales = {}, cells = {};
  const saleOfOrig = async (k) => {
    if (!k) return null;
    if (!(k in sales)) {
      try {
        const id = str(await read(db, `online_orders/${assertSafeSegment(k, "order key")}/pack/saleId`)) || null;
        sales[k] = id ? { id, lines: list((await read(db, `pos/sales/${assertSafeSegment(id, "saleId")}/lineItems`)) || {}) } : null;
      } catch {
        sales[k] = null;
      }
    }
    return sales[k];
  };
  const units = [];
  for (const it of plan.items) {
    if (!(it.pid in products)) products[it.pid] = await read(db, `products/${it.pid}`);
    const product = products[it.pid];
    if (!product) return { ok: false, why: `${it.title} (${it.pid}) is not a product in the app: nothing was put back` };
    let origLine = null;
    if (it.origOrderKey) {
      const ls = await linesOf(it.origOrderKey);
      origLine = (it.origLineIndex != null ? ls[it.origLineIndex] : null) || ls.find((l) => String(l.pid) === it.pid || String(l.swappedFrom?.pid || "") === it.pid) || null;
    }
    if (!origLine && plan.fromFallback) {
      for (const k of related) {
        origLine = (await linesOf(k)).find((l) => (String(l.pid) === it.pid || String(l.swappedFrom?.pid || "") === it.pid) && stockSizeKey(l.size ?? "_") === it.sizeKey) || null;
        if (origLine) break;
      }
      if (!origLine) return { ok: false, why: `${it.title} size ${it.size} is not on the exchange's original order: nothing was put back` };
    }
    if (!(it.pid in hubQty)) {
      hubQty[it.pid] = {};
      for (const h of SECTION_HUBS) hubQty[it.pid][h] = Object.values((await read(db, `stock/${h}/${it.pid}`)) || {}).reduce((a, c) => a + Math.max(0, Number(c?.qty) || 0), 0);
    }
    const sale = await saleOfOrig(it.origOrderKey || (related.length === 1 ? related[0] : null));
    const cellKey = `${sale?.id || "-"}|${it.pid}|${it.sizeKey}`;
    if (!(cellKey in cells)) {
      const sold = sale ? await soldCellOf(db, sale.id, it.pid, it.sizeKey) : null;
      const refunded = sale ? sale.lines.filter((l) => String(l.productId) === it.pid && stockSizeKey(l.size ?? "_") === it.sizeKey).reduce((a, l) => a + (Number(l.refundedQty) || 0), 0) : 0;
      // Whenever the sale's row is found: what it deducted, less its shortfall and what refunds already credited back
      // (CodeRabbit, #820: a fully refunded line must not be credited a second time).
      cells[cellKey] = { sold, left: sold ? Math.max(0, sold.soldQty - sold.shortfall - refunded) : Infinity };
    }
    const c = cells[cellKey];
    const to = SECTION.includes(str(priorTo[it.movementId])) ? priorTo[it.movementId] : destinationFor({ product, size: it.size, origLine, hubQty: hubQty[it.pid], soldLoc: c.sold?.loc || null });
    // Capped at what the sale deducted (no negative cells, 11 Sep 2026): the part it never covered is withheld.
    const withheld = c.left <= 0;
    if (!withheld) c.left -= 1;
    units.push({ ...it, to, place: PLACE[to] || to, deactivated: product.deactivated != null, ...(withheld ? { withheld: true } : {}) });
  }
  return { ok: true, units };
}

/** The original order's pack sale (for the movement's link), when the return names one original. */
async function origSaleOf(db, units) {
  const keys = [...new Set(units.map((u) => u.origOrderKey).filter(Boolean))];
  if (keys.length !== 1) return null;
  try {
    return str(await read(db, `online_orders/${assertSafeSegment(keys[0], "order key")}/pack/saleId`)) || null;
  } catch {
    return null;
  }
}

/** A till's return, reported from its own ledger rows (link.saleId = the return sale). */
async function tillUnits(db, arrival) {
  if (!arrival?.returnSaleId) return [];
  const since = (Number(arrival.claimedAt) || Number(arrival.at) || 0) - 3600e3;
  const rows = await rowsSince(db, since).catch(() => ({}));
  return Object.entries(rows).filter(([, m]) => m?.link?.saleId === arrival.returnSaleId && m.type === "return").map(([id, m]) => ({
    movementId: id, pid: m.productId, size: m.size, title: list(arrival.lines).find((l) => l.pid === m.productId)?.title || m.productId,
    to: m.to, place: PLACE[m.to] || m.to, before: m.before?.[m.to] ?? null, after: m.after?.[m.to] ?? null, already: true,
  }));
}

/**
 * → { ok: true, done | already | dryRun | held, key, orderNumber, items: [{ pid, size, title, to, place, before, after,
 *     movementId }], replacement: replacementCheck(), arrival } | { ok: false, notReady | busy | alreadyBack, reason }
 *   condition  "good" (default) | "not_good"
 * Throws only on a read/write error (the CLI prints it; a re-run is safe).
 */
export async function confirmExchangeReturn(key, { db, dry = false, orderNumber = null, returning = null, condition = "good", words = null, force = false, now = () => Date.now(), attemptId = null } = {}) {
  if (!isExchangeKey(key)) return { ok: false, notReady: true, reason: `"${key}" is not an exchange key (exchange-<n>-<paidAtMs>)` };
  assertSafeSegment(key, "order key");
  const record = await read(db, `online_orders/${key}`);
  const why = notReadyWhy(record, { orderNumber });
  if (why) return { ok: false, notReady: true, key, reason: why };
  const n = digits(record.orderNumber) || digits(orderNumber);
  const arrivalPath = `online_orders/${key}/incoming/arrival`;
  const holdPath = `online_orders/${key}/incoming/conditionHold`;
  const arrival = record.incoming?.arrival ?? null;
  const hold = record.incoming?.conditionHold ?? null;
  const st = arrivalState(arrival);
  const by = { uid: ACTOR, name: "Jimmy (Junid's word on WhatsApp)" };

  // NOT GOOD: nothing goes back; the hold stops this command and the courier until he says otherwise.
  if (condition === "not_good") {
    if (st === "done" || st === "till" || st === "ours") {
      return { ok: false, alreadyBack: true, key, orderNumber: n, by: list(arrival.stockReturned).length || arrival.via === VIA ? "jimmy" : "till", status: record.status || null, reason: st === "done" ? `the return was already confirmed${arrival.by?.name ? ` by ${arrival.by.name}` : ""} and its stock is back${record.status === "packed" ? "; the replacement is packed" : ""}` : st === "ours" ? "an earlier \"good condition\" for it is still being finished, so its stock may already be back" : "a till is confirming its arrival right now" };
    }
    if (dry) return { ok: true, dryRun: true, held: true, key, orderNumber: n };
    await db.ref(holdPath).set({ at: now(), by, ...(words ? { words: String(words).slice(0, 200) } : {}) });
    return { ok: true, held: true, key, orderNumber: n };
  }

  // Confirmed on a till "by hand" (the POS's path for an original sold before the app: "put the item back into stock by
  // hand"): that by-hand step is this one, once. Any other "done": nothing goes back twice.
  const byHandOpen = st === "done" && arrival.via !== VIA && !arrival.returnSaleId && arrival.byHand != null && !list(arrival.stockReturned).length;
  if (st === "done" && !byHandOpen) {
    // His "good" lifts a hold even when the till confirmed the arrival first (round-2 review 1).
    const released = hold && !dry ? await releaseHold(db, key, record) : false;
    const mine = list(arrival.stockReturned).length > 0 || arrival.via === VIA;
    const items = mine ? list(arrival.stockReturned).map((it) => ({ ...it, place: PLACE[it.to] || it.to, already: true })) : await tillUnits(db, arrival);
    return { ok: true, already: true, key, orderNumber: n, by: mine ? "jimmy" : "till", ...(hold ? { heldBefore: true, released } : {}), arrival: { at: arrival.at || null, by: arrival.by?.name || null, returnSaleId: arrival.returnSaleId || null, receiptNumber: arrival.receiptNumber || null }, items, replacement: await checkReplacement(db, key, record) };
  }
  if (st === "till") {
    const fresh = arrival.state === "returning" && now() - (Number(arrival.at) || 0) < CLAIM_STALE_MS;
    return { ok: false, busy: true, key, reason: fresh ? `a till is confirming this arrival right now (${arrival.by?.name || "someone"}): nothing was added` : `a till started Confirm arrival and did not finish (${arrival.state || "?"}${arrival.error ? `: ${String(arrival.error).slice(0, 120)}` : ""}): tap Confirm arrival on that till again; nothing was added here` };
  }
  const plan = returnPlan(record, key, returning);
  if (!plan.ok) return { ok: false, notReady: true, key, reason: plan.why };
  const priorTo = st === "ours" ? Object.fromEntries(list(arrival.items).filter((x) => x.movementId && x.to).map((x) => [x.movementId, x.to])) : {};
  const resolved = await resolveUnits(db, key, record, plan, { priorTo });
  if (!resolved.ok) return { ok: false, notReady: true, key, reason: resolved.why };

  // A unit someone may already have put back (a by-hand arrival, or a return handed in with no record): the ledger since
  // the exchange was paid is read first, never twice. Junid's "add it anyway" (force) is the way past a false match.
  if ((byHandOpen || plan.fromFallback) && !force) {
    const since = checkSince(record, now());
    if (since == null) return { ok: false, notReady: true, key, reason: "the exchange has no payment time, so I can't check whether it was already put back by hand: nothing was added" };
    const rows = await rowsSince(db, since);
    for (const u of resolved.units) {
      const prior = priorArrivalRow(rows, { pid: u.pid, sizeKey: u.sizeKey, key });
      if (prior) return { ok: false, notReady: true, key, prior, reason: `the ledger already shows ${u.title} size ${u.size} put back since the exchange was paid (${prior.type} at ${PLACE[prior.to] || prior.to}${prior.reason ? `, "${prior.reason}"` : ""}), so I added nothing. If that wasn't this pair, say "#${n} good condition, add it anyway"` };
    }
  }

  // The plan: each unit's cell now (or its ledger row, if an earlier run of ours already put it back).
  const units = [];
  for (const it of resolved.units) {
    if (it.withheld) { units.push({ ...it, before: null, after: null }); continue; }
    const done = await ledgerUnit(db, it);
    if (done) { units.push(done); continue; }
    const raw = Number(await read(db, `${cellPath(it.to, it.pid, it.size, it.sizeKey)}/qty`)) || 0;
    const sameEarlier = units.filter((u) => !u.already && u.pid === it.pid && u.sizeKey === it.sizeKey && u.to === it.to).length;
    const before = sameEarlier ? Math.max(0, raw) + sameEarlier : raw;
    units.push({ ...it, before, after: Math.max(0, before) + 1, ...(before < 0 ? { negativeCleared: before } : {}) });
  }
  const replacement = await checkReplacement(db, key, record);
  if (dry) return { ok: true, dryRun: true, key, orderNumber: n, items: units, replacement, reason: reasonFor(n), ...(hold ? { heldBefore: true } : {}), ...(byHandOpen ? { byHand: true } : {}) };

  // 1. the claim (cold-null safe: the first callback sees the value read above, RTDB re-runs it on the server's).
  const id = attemptId || `j${now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const claimAt = now();
  let refused = null;
  const claim = byHandOpen ? null : await db.ref(arrivalPath).transaction((raw) => {
    const cur = raw === null ? arrival : raw;
    refused = null;
    const s = arrivalState(cur);
    if (s === "done" || s === "till") { refused = s; return undefined; }
    return { state: "returning", via: VIA, attemptId: id, by, at: claimAt, tries: (Number(cur?.tries) || 0) + 1, plan: SENTINEL_PLAN, items: resolved.units.map(({ pid, size, title, movementId, to }) => ({ pid, size, title, movementId, to })) };
  });
  const mine = byHandOpen || (claim?.committed && claim.snapshot?.val?.()?.attemptId === id);
  if (!mine) {
    // Taken meanwhile (the POS confirmed it a moment ago): answered as it now stands, nothing added.
    return refused === "done" || arrivalState(await read(db, arrivalPath)) === "done"
      ? confirmExchangeReturn(key, { db, orderNumber, returning, now })
      : { ok: false, busy: true, key, reason: "a till is confirming this arrival right now: nothing was added" };
  }

  // 2. the movements: one per unit, idempotent by id.
  const nowIso = iso(now());
  const origSale = await origSaleOf(db, resolved.units);
  const out = [];
  const withheld = resolved.units.filter((u) => u.withheld).map(({ pid, size, title, movementId }) => ({ pid, size, title, movementId }));
  for (const it of resolved.units.filter((u) => !u.withheld)) {
    const r = await applyMovementAdmin(db, {
      type: "return", productId: it.pid, size: it.size, sizeKey: it.sizeKey, qty: 1, from: null, to: it.to,
      reason: reasonFor(n), link: { orderId: key, ...(origSale ? { saleId: origSale } : {}) }, movementId: it.movementId, actor: ACTOR, actorRole: "admin",
    }, { nowIso });
    if (!r.ok) throw new Error(`${it.title} (${it.size}) not put back: ${r.reason}`);
    const row = await ledgerUnit(db, it);
    out.push({ ...(row || { ...it, before: r.newQty != null ? r.newQty - 1 : null, after: r.newQty ?? null }), already: !!r.idempotent });
  }
  // Our claim stays fresh while we finish (the POS takes over only a claim older than its 10 minutes).
  if (!byHandOpen) await db.ref(arrivalPath).transaction((raw) => (raw && raw.via === VIA && raw.attemptId === id && raw.state === "returning" ? { ...raw, at: now() } : undefined)).catch(() => {});
  const reactivated = [];
  const wasDeactivated = new Set(resolved.units.filter((u) => u.deactivated).map((u) => u.pid));
  for (const pid of new Set(resolved.units.map((x) => x.pid))) {
    try {
      await db.ref(`shopify_inventory_dirty/${pid}`).transaction((v) => (Number(v) || 0) + 1);
    } catch { /* the movement feed and the backstop still push it */ }
    // A deactivated line that gets stock back is reactivated, as every arrival on the client does.
    try {
      // A separate write after the stock (not one atomic update as on the client): a failure is logged by omission
      // and the next arrival, or a tap, reactivates it.
      if (wasDeactivated.has(pid)) {
        await db.ref().update(reactivateUpdates(pid, { uid: ACTOR, byName: "Jimmy", nowMs: now(), reason: "stock_received" }));
        reactivated.push(pid);
      }
    } catch { /* a flag write never undoes the stock: the next arrival or a tap reactivates it */ }
  }

  // 3. done (ours, or a claim nobody finished; never over a "done" or a till's claim). For a by-hand arrival the record
  // stays the till's: only stockReturned (and when, and by whom) is added, once. The condition hold goes (he said good).
  const stockReturned = out.map(({ movementId, pid, size, title, to, before, after }) => ({ movementId, pid, size, title, to, before, after }));
  const note = `Junid confirmed the condition on WhatsApp; the item(s) went back into stock at ${[...new Set(out.map((u) => PLACE[u.to] || u.to))].join(" and ")}, Marathon PE (${reasonFor(n)}).`;
  const rec = byHandOpen ? null : { state: "done", via: VIA, at: now(), by, attemptId: id, claimedAt: claimAt, stockReturned, ...(withheld.length ? { withheld } : {}), note, replacementCheck: replacement.text };
  let lost = null;
  const fin = await db.ref(arrivalPath).transaction((raw) => {
    const cur = raw === null ? (byHandOpen ? arrival : { state: "returning", via: VIA, attemptId: id }) : raw;
    lost = null;
    const s2 = arrivalState(cur);
    if (byHandOpen) {
      if (s2 !== "done" || list(cur.stockReturned).length) { lost = s2; return undefined; }
      return { ...cur, stockReturned, stockReturnedAt: now(), stockReturnedBy: by, stockNote: note };
    }
    if (s2 === "done" || s2 === "till") { lost = s2; return undefined; }
    return rec;
  });
  if (!fin?.committed && lost === "till") {
    throw new Error(`a till took over #${n}'s arrival while the stock went back (${stockReturned.map((u) => u.movementId).join(", ")}): check it on the POS before anything else is put back`);
  }
  const released = hold ? await releaseHold(db, key, record) : false;
  return { ok: true, done: true, key, orderNumber: n, items: out, replacement, reason: reasonFor(n), ...(reactivated.length ? { reactivated } : {}), ...(hold ? { heldBefore: true, released } : {}), ...(byHandOpen ? { byHand: true } : {}), ...(withheld.length ? { withheld } : {}) };
}

/**
 * His "good" lifts the condition hold: the hold goes, and an order the poller held for it (courier_failed with the hold's
 * own text) goes back to pending, so the next poll books it with no Retry tap. → true when the order was released.
 */
async function releaseHold(db, key, record) {
  await db.ref(`online_orders/${key}/incoming/conditionHold`).set(null);
  if (record?.fulfilState !== "courier_failed" || record?.courierError !== HOLD_COURIER_TEXT) return false;
  await db.ref(`online_orders/${key}`).update({ fulfilState: "pending", "fulfil/state": "pending", courierError: null, attention: null, attentionOpen: null, updatedAt: Date.now() });
  return true;
}

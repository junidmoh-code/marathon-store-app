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
//   type "return" (the ledger's own type: `return +to`), to "marathon-pe", qty 1, reason "exchange return #<n>",
//   link { orderId: <exchange key> }, actor "system:jimmy-exchange-return",
//   movementId exret_<exchange key>_<pid>_<sizeKey>_<n>: the idempotency key, fixed per exchange and returned unit, so a
//   second "good condition", a retry or a crash re-run never adds the unit twice.
// Then the Shopify dirty marker for each product is nudged (the push lands on the next reconcile tick, not the sweep).
//
// THE ARRIVAL. The POS's "Incoming exchanges" (marathon-pos-app src/onlineOrders/incomingExchanges.js) has its own
// Confirm arrival, which puts the item back through the till's return path and writes
// online_orders/<key>/incoming/arrival; the replacement is packable only once that is { state: "done" }
// (orderView.packBlockers). Junid's word on WhatsApp is the same confirmation, so it takes the SAME record, the same way:
//   1. claim: a transaction on incoming/arrival → { state "returning", via "jimmy", attemptId, by, at, items }. A "done"
//      (the POS confirmed it, or an earlier "good condition") → nothing is added again: the answer reports what is there.
//      A till's claim ("returning" / "failed" carrying the till's plan) → refused: the till's own retry decides whether
//      its return landed (planLanded), and only it can.
//   2. the movements (idempotent, above).
//   3. done: { state "done", via "jimmy", at, by, stockReturned [{ movementId, pid, size, title, to, before, after }],
//      returnSaleId null, note }. The POS then lists it under History and its Confirm arrival answers "Already
//      confirmed"; Jimmy's incoming.js moves the stage to "arrived" and tells the customer; Till 2 can pack.
// A crash between 2 and 3 leaves Jimmy's own "returning" claim: the next run takes it over with the same movement ids.
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
// NEVER MONEY: no refund, no credit, no sale line, no payment. Only the ledger rows, the cells they move, the dirty
// markers and the arrival record.
//
// dry: everything read and the plan returned (before / after per unit), nothing written.
import { createRequire } from "node:module";
import { isExchangeKey } from "./bookShipment.mjs";
import { assertSafeSegment, stockSizeKey } from "../../src/utils/sizeKey.js";

const require = createRequire(import.meta.url);
const { applyMovementAdmin, cellPath } = require("../../functions/lib/admin-movement.cjs");

export const RETURN_TO = "marathon-pe"; // Junid: "back into stock at Marathon PE"
export const ACTOR = "system:jimmy-exchange-return";
export const VIA = "jimmy";
// The POS's ARRIVAL_CLAIM_STALE_MS: a claim younger than this belongs to a writer that is working on it right now.
export const CLAIM_STALE_MS = 10 * 60 * 1000;
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
 * What is coming back, one entry per unit: incoming.returning (the item(s) Jimmy matched on the ORIGINAL order when the
 * return was booked), else `fallback` (Jimmy's own list, for a return booked by hand or handed in at a shop).
 * → { ok, items: [{ pid, size, sizeKey, title, movementId }] } | { ok: false, why }. Pure.
 */
export function returnPlan(record, key, fallback = null) {
  const from = list(record?.incoming?.returning).length ? list(record.incoming.returning) : list(fallback);
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
      items.push({ pid, size, sizeKey, title: str(it.title) || pid, movementId: movementIdFor(key, pid, sizeKey, n) });
    }
  }
  return { ok: true, items };
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

/** A ledger row → the unit's before/after at Marathon PE (for a unit that went back on an earlier run). */
async function ledgerUnit(db, it) {
  const mv = await read(db, `stock_movements/${it.movementId}`);
  return mv ? { ...it, to: mv.to || RETURN_TO, before: mv.before?.[mv.to || RETURN_TO] ?? null, after: mv.after?.[mv.to || RETURN_TO] ?? null, at: mv.appliedAt || null, already: true } : null;
}

/**
 * → { ok: true, done | already | dryRun, key, orderNumber, items: [{ pid, size, title, to, before, after, movementId }],
 *     replacement: replacementCheck(), arrival } | { ok: false, notReady: true, reason } | { ok: false, busy: true, reason }
 * Throws only on a read/write error (the CLI prints it; a re-run is safe).
 */
export async function confirmExchangeReturn(key, { db, dry = false, orderNumber = null, returning = null, now = () => Date.now(), attemptId = null } = {}) {
  if (!isExchangeKey(key)) return { ok: false, notReady: true, reason: `"${key}" is not an exchange key (exchange-<n>-<paidAtMs>)` };
  assertSafeSegment(key, "order key");
  const record = await read(db, `online_orders/${key}`);
  const why = notReadyWhy(record, { orderNumber });
  if (why) return { ok: false, notReady: true, key, reason: why };
  const n = digits(record.orderNumber) || digits(orderNumber);
  const arrivalPath = `online_orders/${key}/incoming/arrival`;
  const arrival = record.incoming?.arrival ?? null;
  const st = arrivalState(arrival);
  const plan = returnPlan(record, key, returning);

  // Confirmed on a till "by hand" (the POS's path for an original sold before the app or never packed through the POS:
  // "put the item back into stock by hand", no till return): that by-hand step is exactly this one, so Junid's OK puts it
  // back here, once (the same movement ids), and adds stockReturned to the arrival. Any other "done": nothing goes back
  // twice; Jimmy's own units are reported from the record.
  const byHandOpen = st === "done" && arrival.via !== VIA && !arrival.returnSaleId && arrival.byHand != null && !list(arrival.stockReturned).length;
  if (st === "done" && !byHandOpen) {
    const items = list(arrival.stockReturned).map((it) => ({ ...it, already: true }));
    return { ok: true, already: true, key, orderNumber: n, by: arrival.via === VIA ? "jimmy" : "till", arrival: { at: arrival.at || null, by: arrival.by?.name || null, returnSaleId: arrival.returnSaleId || null, receiptNumber: arrival.receiptNumber || null }, items, replacement: await checkReplacement(db, key, record) };
  }
  if (st === "till") {
    const fresh = arrival.state === "returning" && now() - (Number(arrival.at) || 0) < CLAIM_STALE_MS;
    return { ok: false, busy: true, key, reason: fresh ? `a till is confirming this arrival right now (${arrival.by?.name || "someone"}): nothing was added` : `a till started Confirm arrival and did not finish (${arrival.state || "?"}${arrival.error ? `: ${String(arrival.error).slice(0, 120)}` : ""}): tap Confirm arrival on that till again; nothing was added here` };
  }
  if (!plan.ok) return { ok: false, notReady: true, key, reason: plan.why };

  // The plan: each unit's cell at Marathon PE now (or its ledger row, if an earlier run of ours already put it back).
  const units = [];
  for (const it of plan.items) {
    const done = await ledgerUnit(db, it);
    if (done) { units.push(done); continue; }
    const before = Number(await read(db, `${cellPath(RETURN_TO, it.pid, it.size, it.sizeKey)}/qty`)) || 0;
    const sameEarlier = units.filter((u) => !u.already && u.pid === it.pid && u.sizeKey === it.sizeKey).length;
    units.push({ ...it, to: RETURN_TO, before: Math.max(0, before) + sameEarlier, after: Math.max(0, before) + sameEarlier + 1 });
  }
  const replacement = await checkReplacement(db, key, record);
  if (dry) return { ok: true, dryRun: true, key, orderNumber: n, items: units, replacement, reason: reasonFor(n) };

  // 1. the claim (cold-null safe: the first callback sees the value read above, RTDB re-runs it on the server's).
  const id = attemptId || `j${now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const by = { uid: ACTOR, name: "Jimmy (Junid's OK on WhatsApp)" };
  const claimAt = now();
  let refused = null;
  const claim = byHandOpen ? null : await db.ref(arrivalPath).transaction((raw) => {
    const cur = raw === null ? arrival : raw;
    refused = null;
    const s = arrivalState(cur);
    if (s === "done" || s === "till") { refused = s; return undefined; }
    return { state: "returning", via: VIA, attemptId: id, by, at: claimAt, tries: (Number(cur?.tries) || 0) + 1, items: plan.items.map(({ pid, size, title, movementId }) => ({ pid, size, title, movementId })) };
  });
  const mine = byHandOpen || (claim?.committed && claim.snapshot?.val?.()?.attemptId === id);
  if (!mine) {
    // Taken meanwhile (the POS confirmed it a moment ago): answered as it now stands, nothing added.
    return refused === "done" || arrivalState(await read(db, arrivalPath)) === "done"
      ? confirmExchangeReturn(key, { db, orderNumber, returning, now })
      : { ok: false, busy: true, key, reason: "a till is confirming this arrival right now: nothing was added" };
  }

  // 2. the movements: one per unit, idempotent by id.
  const nowIso = new Date(now()).toISOString();
  const out = [];
  for (const it of plan.items) {
    const r = await applyMovementAdmin(db, {
      type: "return", productId: it.pid, size: it.size, sizeKey: it.sizeKey, qty: 1, from: null, to: RETURN_TO,
      reason: reasonFor(n), link: { orderId: key }, movementId: it.movementId, actor: ACTOR, actorRole: "admin",
    }, { nowIso });
    if (!r.ok) throw new Error(`${it.title} (${it.size}) not put back: ${r.reason}`);
    const row = await ledgerUnit(db, it);
    out.push({ ...(row || { ...it, to: RETURN_TO, before: null, after: r.newQty ?? null }), already: !!r.idempotent });
  }
  for (const pid of new Set(plan.items.map((x) => x.pid))) {
    try {
      await db.ref(`shopify_inventory_dirty/${pid}`).transaction((v) => (Number(v) || 0) + 1);
    } catch { /* the movement feed and the backstop still push it */ }
  }

  // 3. done (ours, or a claim nobody finished; never over a "done" or a till's claim). For a by-hand arrival the record
  // stays the till's: only stockReturned (and when, and by whom) is added, once.
  const stockReturned = out.map(({ movementId, pid, size, title, to, before, after }) => ({ movementId, pid, size, title, to, before, after }));
  const note = `Junid confirmed the condition on WhatsApp; the item(s) went back into stock at Marathon PE (${reasonFor(n)}).`;
  const rec = byHandOpen
    ? null
    : { state: "done", via: VIA, at: now(), by, attemptId: id, claimedAt: claimAt, stockReturned, note, replacementCheck: replacement.text };
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
  return { ok: true, done: true, key, orderNumber: n, items: out, replacement, reason: reasonFor(n) };
}

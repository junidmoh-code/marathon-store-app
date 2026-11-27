// ── bookShipment(order) / cancelShipment(order) — DORMANT until Junid flips live
//
// bookShipment: estimateParcel → TCG rates (door + locker) → the cheapest
// service that matches the drop-box rule (src/shipping/chooseService.js) →
// the POST /shipments payload: the order's shipping address, the customer's
// phone and email, the order ref as customer_reference.
//
//   /config/shipping/live !== true  →  logs the exact payload it WOULD send,
//                                      returns { skipped: true, dryRun: payload }
//                                      and makes NO shipment call.
//   /config/shipping/live === true  →  creates the shipment, writes
//                                      { provider: "courier_guy", shipmentId, waybill,
//                                        service, parcel, cost, bookedAt }
//                                      to /online_orders/{key}/shipping, returns it.
//
// `live` is re-read on EVERY call, straight from the database, and only the
// boolean `true` books — "true", 1, or an absent node are all dry runs. Rates
// are allowed in both modes (they book nothing). The guard is pinned by
// bookShipment.test.mjs and by a mutation proof (mutation-proof-shipping.mjs):
// with live false, no code path may reach client.createShipment or
// client.cancelShipment.
//
// ONE BOOKING PER ORDER. Live booking first claims
// /online_orders/{key}/shipping/courierBooking in a transaction; a second
// packer (or a retry) finds the claim and books nothing. A failed create
// releases the claim with the error recorded; a create whose response was lost
// (timeout/5xx) leaves the claim as "unknown", because TCG may have booked it
// (the client never retries a create). unknownBooking.mjs then asks Courier Guy
// itself (GET /shipments by the order reference): a shipment found is attached,
// none after 10 minutes releases the claim for ONE automatic re-book.
// A 500 that is Courier Guy failing to place the address on the map is a
// definite refusal (isGeocodeRefusal), never "unknown": a door-to-locker
// parcel is sent once more with the locker's own address.
//
// DOOR-TO-LOCKER (Junid, 20 Nov 2026). Unless /config/shipping/deliveryMode is
// "door", every booking is collected from our door and delivered to the
// Courier Guy locker nearest the customer (lockerDelivery.mjs): one shoe-sized
// parcel per shipment, N shipments to the same locker when the order needs N.
// The locker is written to shipping/deliveryLocker, every waybill to
// shipping/waybills (the first stays shipping/waybill), the door-to-door price
// to shipping/doorQuote.
//
// NO LOCKER → DOOR-TO-DOOR (Junid, 24 Nov 2026, STANDING RULE, reversing "No
// locker near the address → refused, never door" of 20 Nov): "if no Courier Guy
// locker is near the customer (like #2411 Alistair, Jansenville: 'no locker
// within 30 km'), book DOOR-TO-DOOR delivery to their address automatically
// instead of failing. Never leave an order unbooked because there's no locker."
// planShipment books the door-to-door plan (the one /config/shipping/deliveryMode
// "door" books: the estimated parcel, the customer's address, the cheapest door
// service) when the locker plan fails for one of doorFallbackFor's reasons, and
// ONLY those: no locker within the limit, a parcel no locker box takes, or no
// door-to-locker service quoted to any near locker. The same ceiling
// (maxChargeRand), cost alert, claim and live switch apply. Written on the
// order: shipping/deliveryMode "door" and shipping/doorFallback { reason, kind,
// at } (no deliveryLocker, no waybills[]); Junid's one line says "booked
// door-to-door: no Courier Guy locker within N km …". Still refused as before:
// an address that cannot be placed on the map, a locker a person named
// (lockerChoice / lockerAvoid / a split), an API error, anything transient, a
// quote over the ceiling. A half-booked split is never finished as door.
// /config/shipping/locker/doorFallback false switches it off. Orders already
// "Packed, courier not booked" for this reason are handed back ONCE
// (doorRetryDue; poll.mjs retryNoLockerOrders, retry-no-locker.mjs).
//
// THE ADDRESS SAFETY GATE (Junid, 24 Nov 2026, STANDING RULE: "No Courier Guy booking unless the waybill's suburb,
// town and postal code match the customer's address. On a mismatch, hold and confirm on WhatsApp."; #2316's Umlazi
// order typed Vosloorus's 1475 and went to a Vosloorus locker). planShipment asks addressHold.mjs addressGate before
// anything is priced, and lockerGate once the locker is chosen (it must be in the customer's AREA, not merely near
// the postal code's point). A failing order books nothing: bookShipment writes shipping/addressHold (live only) and
// refuses with "address check: …"; the fast-ship sweep asks the customer once on WhatsApp.
//
// OWN COURIER (Junid, 24 Nov 2026: WhatsApp orders through Jamie, tag "own-courier"): the customer books their own
// courier and sends the waybill. Such an order (shipping/ownCourier, set at ingestion) is NEVER booked here.
//
// No waybill printing: waybills stay handwritten. `waybill` is returned for
// that, and a later label-print step can open TCG's label PDF
// (GET /shipments/label?id=) with window.print — never WebUSB.
import { estimateParcel, chooseLocker } from "../../src/shipping/estimateParcel.js";
import { mergeShippingConfig } from "../../src/shipping/shippingConfig.js";
import { chooseRate } from "../../src/shipping/chooseService.js";
import { orderLines, deliveryAddress, deliveryContact, orderRef, orderKey as keyOf } from "../../src/shipping/orderShipment.js";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import { isReturnOnlyOrder, isReturnOnlyLine } from "../../src/utils/onlineOrders.js";
// A record mixing outgoing lines with a returning (returnOnly) line is not supported for shipping: the returning item
// would be counted into the outbound parcel. Refused like a return-only record, never booked half-right.
const hasReturnOnlyLine = (order) => (Array.isArray(order?.lines) ? order.lines : Object.values(order?.lines || {})).some(isReturnOnlyLine);
import { quoteParcel, tcgParcels, lockerCollection } from "./quote.mjs";
import { fileLogger } from "./courier-client.mjs";
import { planLockerDelivery, lockerAddressPayload } from "./lockerDelivery.mjs";
import { addressGate, lockerGate, raiseHold } from "./addressHold.mjs";

export const LIVE_PATH = "config/shipping/live";

// RTDB refuses undefined and NaN anywhere in a write; a booking that is
// already paid for must never fail on its own record.
const finiteOrNull = (n) => (Number.isFinite(Number(n)) ? Number(n) : null);
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));

/** The one place `live` is decided. Only the boolean true books. */
export async function readLive(db) {
  const snap = await db.ref(LIVE_PATH).get();
  return snap.exists() && snap.val() === true;
}

async function defaultDeps(deps) {
  const out = { ...deps };
  if (!out.db) out.db = (await import("./adminDb.mjs")).adminDb();
  if (!out.client) out.client = (await import("./courier-client.mjs")).createCourierClient();
  if (!out.log) out.log = fileLogger();
  if (!out.now) out.now = () => Date.now();
  return out;
}

// An online EXCHANGE's replacement order, minted by Jimmy (marathon-dm-agent
// src/jimmy/reserve.js) at /online_orders/exchange-<orderNumber>-<paidAtMs>.
// It has no Shopify order (no shopifyGid): it is packed and shipped through
// this same flow, and finished without Shopify (poll.mjs shipOrder).
export const EXCHANGE_KEY = /^exchange-\d+-\d+$/;
export const isExchangeKey = (key) => EXCHANGE_KEY.test(String(key ?? ""));
// A SECOND PARCEL of items an earlier parcel was short (docs/ONLINE-ORDERS.md "Second parcel"):
// /online_orders/<shopify order id>r<n>, same Shopify order, its own Courier Guy waybill.
export const RESHIP_KEY = /^\d+r\d+$/;
export const isReshipKey = (key) => RESHIP_KEY.test(String(key ?? ""));

// The /online_orders key (the Shopify order id, digits — or an exchange key),
// never the order's code.
function orderKey(order) {
  const key = keyOf(order);
  if (!key) throw new Error("bookShipment: the order carries no /online_orders key (key, id or shopifyGid)");
  // A ref (KQZ) passed as id/key would put the claim on a junk node the real
  // order never sees — and the one-booking guard with it. Keys are digits,
  // or exchange-<n>-<ms>; anything else is refused.
  if (!/^\d+$/.test(key) && !isExchangeKey(key) && !isReshipKey(key)) throw new Error(`bookShipment: "${key}" is not an /online_orders key (the Shopify order id)`);
  return assertSafeSegment(key, "order key");
}

// An exchange record's own recipient fields: its label is shopifyName
// ("#1789-EX") and its phone is the one the customer is talking to Jimmy on
// (exchange.contactPhone) — the copied address may carry the original order's
// phone. Everything else is read exactly as for a website order.
function exchangeOverrides(order, ref, contact) {
  if (!isExchangeKey(keyOf(order))) return { ref, contact };
  const phone = String(order?.exchange?.contactPhone ?? "").trim();
  const name = String(order?.shopifyName ?? "").trim();
  return {
    ref: name || ref,
    contact: phone ? { ...contact, mobile_number: phone } : contact,
  };
}

// Each line's /products record, by exact path, for its subcategory — the
// order lines carry pid + category only. One small read per distinct product.
async function productsFor(db, order) {
  const raw = Array.isArray(order?.lines) ? order.lines : Object.values(order?.lines ?? {});
  const pids = [...new Set(raw.map((l) => l?.pid ?? l?.productId).filter(Boolean))];
  const out = {};
  // All at once (fast booking, 20 Nov 2026): one round trip, not one per product.
  await Promise.all(pids.map(async (pid) => {
    try {
      const snap = await db.ref(`products/${assertSafeSegment(pid, "productId")}`).get();
      if (snap.exists()) out[pid] = snap.val();
    } catch { /* an unreadable product classifies by its line alone */ }
  }));
  return out;
}

/** The customer_reference a booking of this order carries ("#2181"; an exchange: its shopifyName "#1789-EX"). Pure. */
export function bookingRef(order) {
  return exchangeOverrides(order, orderRef(order), {}).ref;
}

/**
 * Courier Guy refusing a create because IT could not place the delivery address on the map (#2181, 21 Nov 2026:
 * HTTP 500 "cannot find a latitude/longitude for the address. Try to add more detail…"). Despite the 500 this is a
 * validation answer, not a lost response: no shipment was made. It is a definite failure (never "unknown"), and a
 * door-to-locker booking is sent once more with the locker's own address (lockerAddressPayload). Pure.
 */
export function isGeocodeRefusal(err) {
  const status = Number(err?.status);
  if (!(status >= 400 && status < 600) || status === 408) return false;
  return /latitude\s*\/\s*longitude|lat\s*\/\s*lng|could ?n[o']t (?:find|geocode)|cannot geocode|unable to geocode/i.test(String(err?.body ?? err?.message ?? ""));
}

/** Everything up to (not including) the shipment call. Pure apart from rates. */
export async function planShipment(order, { db, client, products = null, geocoder }) {
  // The config and the products are read together (fast booking, 20 Nov 2026).
  const [rawCfg, productMap] = await Promise.all([db.ref("config/shipping").get(), products ?? productsFor(db, order)]);
  const cfg = mergeShippingConfig(rawCfg.val());
  const lines = orderLines(order, productMap);
  const parcel = estimateParcel(lines, cfg);
  const { address, missing: addrMissing } = deliveryAddress(order);
  const { contact: baseContact, missing: baseContactMissing } = deliveryContact(order);
  const { ref, contact } = exchangeOverrides(order, orderRef(order), baseContact);
  const contactMissing = contact.mobile_number || contact.email ? [] : baseContactMissing;
  const collectionContact = cfg.collectionContact ?? {};
  // The customer's side must be complete before anything is even priced.
  const missing = [...addrMissing, ...contactMissing, ...(!ref ? ["order_ref"] : [])];
  if (missing.length) return { ok: false, reason: `missing: ${missing.join(", ")}`, missing, parcel };
  // THE ADDRESS SAFETY GATE: postal code, suburb/town must describe the same place, before anything is priced.
  const gate = addressGate(order, cfg);
  if (gate) return { ok: false, reason: gate.reason, addressHold: gate.hold, parcel };
  // Our own side only has to be complete to BOOK: a dry run still shows the
  // whole payload, with the gap named, so the card/log is useful before
  // Junid has filled the collection contact in.
  // Door-to-locker declares one shoe whatever the goods are: size never stops that booking.
  const toLocker = cfg.deliveryMode !== "door";
  const liveBlockers = [
    ...(!collectionContact.mobile_number && !collectionContact.email ? ["collection_contact"] : []),
    ...(!toLocker && !parcel.fits ? ["no standard box fits"] : []),
  ];
  if (toLocker) {
    const lockerPlan = await planLockerDelivery({ order, key: keyOf(order), cfg, client, estimate: parcel, address, contact, ref, liveBlockers, ...(geocoder ? { geocoder } : {}) });
    // NO LOCKER → DOOR-TO-DOOR (Junid, 24 Nov 2026): only for a no-locker reason, never for any other failure.
    const fallback = doorFallbackFor(order, lockerPlan, cfg);
    // The locker must be in the customer's area, not merely near whatever point the postal code gave (#2316).
    const far = lockerPlan.ok ? lockerGate(order, lockerPlan.locker, cfg) : null;
    if (far) return { ok: false, reason: far.reason, addressHold: far.hold, parcel: lockerPlan.parcel ?? parcel };
    if (!fallback) return lockerPlan;
    // The door plan's own blockers: the box list matters again (a locker booking never asked it).
    const door = await planDoor([...liveBlockers, ...(!parcel.fits ? ["no standard box fits"] : [])], { noDropBox: true });
    if (door.ok) return { ...door, doorFallback: fallback };
    // No locker AND no door price: refused with the door plan's own reason (what the POS reads), the locker's kept beside it.
    return {
      ...door, attention: true, doorFallback: fallback, doorTried: true,
      junidLine: `${ref}: ${fallback.reason}, and door-to-door could not be booked either (${door.reason}). Not booked. Book it in the portal, or fix the address and press Retry on the POS.`,
    };
  }
  return planDoor(liveBlockers);

  // The door-to-door plan: /config/shipping/deliveryMode "door", and the fallback when there is no locker.
  async function planDoor(liveBlockers, { noDropBox = false } = {}) {
    // The locker is only asked when the drop box is ON (door-to-door otherwise). The no-locker fallback is ALWAYS
    // collected at our door (architect review, #984): it is recorded as deliveryMode "door", so it never books a
    // drop-box (collection_pickup_point_id) rate.
    const dropBox = !noDropBox && cfg.dropBox?.enabled
      ? { pickupPointId: cfg.dropBox.pickupPointId, pickupPointProvider: cfg.dropBox.pickupPointProvider }
      : null;
    const quoted = await quoteParcel(client, { collectionAddress: cfg.collectionAddress, deliveryAddress: address, parcels: parcel.parcels, dropBox });
    const chosen = chooseRate({ door: quoted.door.rates, locker: quoted.locker.rates }, parcel, cfg);
    if (!chosen) {
      return { ok: false, reason: `no usable rate (door: ${quoted.door.error ?? "none"}; locker: ${quoted.locker.error ?? "none"})`, parcel, quoted };
    }
    // THE SPEND CEILING (Junid, 6 Nov 2026: "the R300-per-booking ceiling
    // stays; a booking above it goes to Junid as one line with the cheaper
    // option"). The account is prepaid; an order that quotes above this is
    // booked by a person in the portal, not by this code. The cheaper option is
    // a locker drop-off when the parcel fits one (asked here even while the
    // drop box is off — rates book nothing), else the next service quoted.
    const ceiling = Number(cfg.maxChargeRand);
    let overCeiling = null;
    if (Number.isFinite(ceiling) && ceiling > 0 && chosen.rate.rate > ceiling) {
      liveBlockers.push(`quote R${chosen.rate.rate.toFixed(2)} is over the R${ceiling} ceiling`);
      let lockerRates = quoted.locker.rates;
      const p0 = parcel.parcels[0];
      const fitsLocker = chooseLocker([p0.lengthCm, p0.widthCm, p0.heightCm], p0.actualKg, { ...(cfg.dropBox ?? {}), enabled: true });
      if (!lockerRates.length && fitsLocker && cfg.dropBox?.pickupPointId) {
        const lk = await quoteParcel(client, { collectionAddress: cfg.collectionAddress, deliveryAddress: quoted.deliveryAddress ?? address, parcels: parcel.parcels, dropBox: { pickupPointId: cfg.dropBox.pickupPointId, pickupPointProvider: cfg.dropBox.pickupPointProvider } });
        lockerRates = lk.locker.rates;
      }
      overCeiling = { ceiling, chosen: { mode: chosen.mode, code: chosen.rate.code, rate: chosen.rate.rate }, cheaper: cheaperOption(chosen.rate, quoted.door.rates, lockerRates, cfg) };
    }

    const payload = {
      collection_address: cfg.collectionAddress,
      ...(chosen.mode === "locker" ? lockerCollection(dropBox) : {}),
      collection_contact: { name: collectionContact.name ?? "", mobile_number: collectionContact.mobile_number ?? "", email: collectionContact.email ?? "" },
      // The address TCG priced (the town as suburb when the typed suburb gave no rates).
      delivery_address: quoted.deliveryAddress ?? address,
      delivery_contact: contact,
      // ONE shipment, every parcel of the parcel rule (N shoeboxes + any flat box).
      parcels: tcgParcels(parcel.parcels),
      service_level_code: chosen.rate.code,
      customer_reference: ref,
      customer_reference_name: "Order no.",
      mute_notifications: false,
    };
    return { ok: true, payload, parcel, chosen, quoted, ref, liveBlockers, overCeiling, quotes: quoteList(quoted) };
  }
}

// ── OWN COURIER (Junid, 24 Nov 2026) ─────────────────────────────────────────
export const OWN_COURIER_TAG = "own-courier";
export const RETURN_ONLY_REASON = "return-only record (store credit / refund instead of a replacement): nothing ships for it — the return collection is booked by book-return.mjs";
export const OWN_COURIER_REASON = "own courier: the customer books their own courier and sends the waybill — never booked with Courier Guy";
/** Does the customer bring their own courier (shipping/ownCourier, written at ingestion from the Shopify tag)? Pure. */
export function isOwnCourier(order) {
  const oc = order?.shipping?.ownCourier;
  return (!!oc && typeof oc === "object") || (Array.isArray(order?.tags) && order.tags.some((t) => String(t).trim().toLowerCase() === OWN_COURIER_TAG));
}

// ── NO LOCKER → DOOR-TO-DOOR (Junid, 24 Nov 2026) ────────────────────────────
// The locker plan's refusals that mean "there is no locker for this parcel" (lockerDelivery.mjs noLockerKind).
export const DOOR_FALLBACK_KINDS = Object.freeze(["none_near", "too_big", "none_priced"]);
// The same three, as the reason an order ALREADY refused carries (courierError; written before noLockerKind existed).
export const NO_LOCKER_REASON = /^(?:no Courier Guy locker within \d|the parcel is bigger or heavier than the largest Courier Guy locker box|Courier Guy quoted no door-to-locker service to the lockers? near )/;

/** A person steered this booking to a locker (named one, ruled one out, split it) or it is half booked: never door instead. Pure. */
export function lockerSteered(order) {
  const s = order?.shipping ?? {};
  const avoid = s.lockerAvoid && typeof s.lockerAvoid === "object" ? Object.values(s.lockerAvoid) : [];
  return !!String(s.lockerChoice?.id ?? "").trim() || avoid.length > 0 || Number(s.lockerParcels) > 1 || !!partialOf(order);
}

/**
 * Does this failed locker plan go door-to-door instead? → { reason, kind } | null. Pure.
 * Only a no-locker refusal (DOOR_FALLBACK_KINDS), only when no person steered the locker and no split is half booked,
 * and only while /config/shipping/locker/doorFallback is not false. Everything else is refused exactly as before.
 */
export function doorFallbackFor(order, lockerPlan, cfg = {}) {
  if (!lockerPlan || lockerPlan.ok || !DOOR_FALLBACK_KINDS.includes(lockerPlan.noLockerKind)) return null;
  if (cfg?.locker?.doorFallback === false || lockerSteered(order)) return null;
  return { reason: String(lockerPlan.reason), kind: lockerPlan.noLockerKind };
}

/**
 * An order ALREADY sitting at "Packed, courier not booked" because there was no locker (refused under the 20 Nov rule):
 * due for its ONE hand-back to the ship step, which now books it door-to-door? Pure. → the reason | null.
 *   packed + courier_failed, its current courierError one of the no-locker reasons (NO_LOCKER_REASON), nothing booked
 *   or half booked, no claim held, door-to-door not already tried for it (booking.doorTried, shipping/doorRetry),
 *   and no person steering the locker (that order would be refused again: lockerSteered).
 * shipping/doorRetry is the once: the caller sets it in a transaction before handing the order back.
 */
export function doorRetryDue(order) {
  const s = order?.shipping ?? {};
  if (order?.status !== "packed" || order?.fulfilState !== "courier_failed") return null;
  const why = String(order.courierError ?? "");
  if (!NO_LOCKER_REASON.test(why)) return null;
  if (s.shipmentId != null || s.waybill || s.doorRetry || s.booking?.doorTried) return null;
  const claim = s.courierBooking?.state;
  if (claim && claim !== "failed") return null;
  if (lockerSteered(order)) return null;
  // Junid's "not good" hold on an exchange stops its replacement being booked (poll.mjs shipOrder): never handed back
  // under it (CodeRabbit, #984). It is due again once the hold is lifted.
  if (conditionHeld(order)) return null;
  return why;
}

const conditionHeld = (order) => !!order?.incoming?.conditionHold && typeof order.incoming.conditionHold === "object";

/**
 * An order that WAS handed back for its door-to-door try and is booked (the order or the claim carries the waybill),
 * but still says "courier not booked": the hand-back to the ship step after the booking did not land (retry-no-locker.mjs
 * books first, then hands back; CodeRabbit, #984). Due for that hand-back only: the ship step finds the waybill
 * ("already booked") and fulfils with it, it never books again. Pure. → true | false
 */
export function doorHandBackDue(order) {
  const s = order?.shipping ?? {};
  if (order?.status !== "packed" || order?.fulfilState !== "courier_failed" || !s.doorRetry) return false;
  if (conditionHeld(order)) return false;
  return !!(s.waybill || (s.courierBooking?.state === "booked" && s.courierBooking.waybill));
}

/** What the POS "Retry courier" writes (unknownBooking.mjs backToPending), on a whole order node. Pure. */
function handedBack(cur, at) {
  const next = { ...cur, fulfilState: "pending", fulfil: { ...(cur.fulfil ?? {}), state: "pending" }, updatedAt: at };
  delete next.courierError;
  if (!cur.attention || cur.attention.kind === "courier_failed") { delete next.attention; delete next.attentionOpen; }
  return next;
}

/**
 * THE ONCE, checked and taken in ONE transaction on the order (CodeRabbit, #984): the order is read as it is NOW, and
 * only while doorRetryDue still holds is shipping/doorRetry written — with, for the tick (`handBack`), the hand-back
 * to the ship step in the same write, so a marker never lands without its hand-back, and an order a person retried,
 * fast-shipped or re-failed for another reason meanwhile is left exactly as it is.
 * → the order as committed | null (not due any more, or another caller took it).
 */
export async function claimDoorRetry(db, key, { by, at, handBack = false }) {
  assertSafeSegment(key, "order key");
  const tx = await db.ref(`online_orders/${key}`).transaction((cur) => {
    // The Admin SDK's first pass sees null (a cold cache): answered with null so the server's value comes back.
    if (cur == null) return null;
    const why = doorRetryDue(cur);
    if (!why) return undefined;
    const marked = { ...cur, shipping: { ...(cur.shipping ?? {}), doorRetry: { at, by, reason: why.slice(0, 300) } } };
    return handBack ? handedBack(marked, at) : marked;
  });
  const v = tx?.snapshot?.val?.();
  return tx?.committed && v?.shipping?.doorRetry?.at === at && v.shipping.doorRetry.by === by ? v : null;
}

/**
 * The hand-back after a door-to-door booking was made (doorHandBackDue), in one transaction on the order: applied only
 * while the order still says "courier not booked" with that booking, so a fulfilment that moved on is never undone.
 * → true when handed back.
 */
export async function handBackBooked(db, key, { at }) {
  assertSafeSegment(key, "order key");
  const tx = await db.ref(`online_orders/${key}`).transaction((cur) => (cur == null ? null : doorHandBackDue(cur) ? handedBack(cur, at) : undefined));
  const v = tx?.snapshot?.val?.();
  return !!(tx?.committed && v && v.fulfilState === "pending" && v.updatedAt === at);
}

/** Junid's one line for a parcel that went door-to-door because there was no locker. Pure. */
export function doorFallbackLine(ref, shipping) {
  const f = shipping?.doorFallback;
  if (!f?.reason) return null;
  const cost = Number.isFinite(Number(shipping.cost)) ? ` R${Number(shipping.cost).toFixed(2)}` : "";
  return `${ref}: booked door-to-door: ${f.reason}. ${shipping.service ?? "Courier Guy"}${cost}, waybill ${shipping.waybill ?? "?"}.`;
}

// Every service TCG quoted for the parcel, door and locker, cheapest first —
// recorded on the order with the booking (Junid, 6 Nov 2026: "record the
// quote list on the order").
export function quoteList(quoted) {
  const rows = [
    ...(quoted?.door?.rates ?? []).map((r) => ({ mode: "door", ...r })),
    ...(quoted?.locker?.rates ?? []).map((r) => ({ mode: "locker", ...r })),
  ];
  return rows
    .map((r) => ({ mode: r.mode, code: r.code, name: r.name ?? "", rate: finiteOrNull(r.rate), chargedKg: finiteOrNull(r.chargedKg) }))
    .filter((r) => r.rate !== null)
    .sort((a, b) => a.rate - b.rate);
}

/** The cheapest option below the chosen one: a locker drop-off, else another door service (SDX excluded). Pure. */
export function cheaperOption(chosen, doorRates, lockerRates, cfg = {}) {
  const exclude = new Set(cfg.excludeServiceCodes ?? []);
  const options = [
    ...(lockerRates ?? []).map((r) => ({ mode: "locker", code: r.code, rate: r.rate })),
    ...(doorRates ?? []).map((r) => ({ mode: "door", code: r.code, rate: r.rate })),
  ].filter((r) => !exclude.has(r.code) && Number.isFinite(Number(r.rate)) && r.rate < chosen.rate);
  return options.sort((a, b) => a.rate - b.rate)[0] ?? null;
}

const rand = (n) => `R${Number(n).toFixed(2)}`;
/** The one line Junid gets for a booking over the ceiling. Pure. */
export function ceilingLine(ref, plan) {
  const oc = plan?.overCeiling;
  if (!oc) return null;
  const p = plan.parcel?.parcels?.[0] ?? {};
  const dims = [p.lengthCm, p.widthCm, p.heightCm].every((v) => Number.isFinite(Number(v))) ? `${p.lengthCm}×${p.widthCm}×${p.heightCm} cm, ` : "";
  const kg = Number.isFinite(Number(p.chargeableKg)) ? `${Math.ceil(Number(p.chargeableKg) - 1e-9)} kg` : "";
  const cheaper = oc.cheaper
    ? `Cheaper: ${oc.cheaper.mode === "locker" ? "locker drop-off " : ""}${oc.cheaper.code} ${rand(oc.cheaper.rate)}.`
    : "No cheaper service quoted.";
  // No locker, so door-to-door was priced (Junid, 24 Nov 2026) — and that is over the ceiling: the line says both.
  const noLocker = plan.doorFallback?.reason ? `${plan.doorFallback.reason}, so door-to-door was priced. ` : "";
  return `${ref}: ${noLocker}Courier Guy quotes ${rand(oc.chosen.rate)} (${oc.chosen.code}, ${dims}${kg}), over the R${oc.ceiling} ceiling, not booked. ${cheaper} Book it in the portal.`;
}

/**
 * @param {object} order   an /online_orders record (its key as order.key or order.ref)
 * @param {object} [deps]  { db, client, products, log, now } — injected by tests
 */
export async function bookShipment(order, deps = {}) {
  const { db, client, products, log, now, geocoder } = await defaultDeps(deps);
  const key = orderKey(order);

  // An order that already carries a booking is never booked again.
  if (order?.shipping?.shipmentId) {
    return { skipped: true, reason: "already booked", shipping: order.shipping };
  }
  // A RETURN-ONLY collection record (store credit / refund instead of a replacement, Junid 26 Nov 2026): its line is
  // the item coming BACK. Nothing ever goes out for it; its collection is bookReturn.mjs's, never this.
  if (isReturnOnlyOrder(order) || hasReturnOnlyLine(order)) {
    log(`bookShipment ${key} REFUSED return-only record (nothing ships)`);
    return { skipped: true, returnOnly: true, reason: RETURN_ONLY_REASON };
  }
  // OWN COURIER: the customer books their own courier; nothing is ever booked with Courier Guy for it.
  if (isOwnCourier(order)) {
    log(`bookShipment ${key} REFUSED own courier (the customer books their own)`);
    return { skipped: true, ownCourier: true, reason: OWN_COURIER_REASON };
  }

  // A split whose later parcel failed: the parcels already booked are kept on
  // shipping/partial, and the retry books only the rest, to the SAME locker.
  const partial = partialOf(order);
  const planOrder = partial?.locker?.id
    ? { ...order, shipping: { ...order.shipping, lockerChoice: { id: partial.locker.id, by: "partial" }, lockerParcels: partial.count } }
    : order;
  const plan = await planShipment(planOrder, { db, client, products, geocoder });
  if (!plan.ok) {
    log(`bookShipment ${key} REFUSED ${plan.reason}`);
    // THE ADDRESS GATE: the hold goes on the order (live only: a dry run asks nobody), once per address.
    if (plan.addressHold) {
      let held = null;
      if (await readLive(db).catch(() => false)) {
        try { held = (await raiseHold(db, key, plan.addressHold, { now: now() })).hold; }
        catch (e) { log(`bookShipment ${key} address hold NOT RECORDED: ${e?.message || e}`); }
      }
      return { skipped: true, reason: plan.reason, addressHold: plain(held ?? plan.addressHold), parcel: plan.parcel ?? null };
    }
    // No locker for this address: the reason goes on the order, and (live only) one line to Junid.
    const line = plan.attention && plan.junidLine && (await readLive(db).catch(() => false)) ? plan.junidLine : null;
    return {
      skipped: true, reason: plan.reason, parcel: plan.parcel ?? null, ...(plan.attention ? { noLocker: true } : {}), ...(line ? { junidLine: line } : {}),
      // No locker and door-to-door could not be priced either: said on the record, and never handed back for another try.
      ...(plan.doorTried ? { doorTried: true, doorFallback: plain(plan.doorFallback) } : {}),
    };
  }
  const payloads = plan.payloads ?? [plan.payload];
  // A half-booked split is only ever finished as what it was: the same locker, at least as many parcels. A plan
  // that no longer matches (the mode switched to "door", the locker gone) books nothing and keeps the checkpoint.
  if (partial && (plan.locker?.id !== partial.locker.id || payloads.length < partial.shipments.length)) {
    const reason = `a split is half booked (${partial.shipments.map((m) => m.waybill).join(", ")} to locker ${partial.locker.id}) and can no longer be finished as planned — book the rest in the portal`;
    log(`bookShipment ${key} REFUSED ${reason}`);
    return { skipped: true, reason };
  }

  // The live switch and the order's existence are asked together (fast booking,
  // 20 Nov 2026); the existence answer is only used on the live path below.
  const existsField = isExchangeKey(key) ? "exchange/paidAt" : isReshipKey(key) ? "reship/of" : "shopifyGid";
  const [live, orderExists] = await Promise.all([
    readLive(db),
    // A failed read here is not an answer: asked again, alone, on the live path (the dry run never needs it).
    db.ref(`online_orders/${key}/${existsField}`).get().then((s) => s.exists(), () => null),
  ]);
  if (!live) {
    log(`bookShipment ${key} DRY RUN (live is off) would POST /shipments ${JSON.stringify(plan.payload)}` +
      (plan.liveBlockers.length ? ` — live would refuse: ${plan.liveBlockers.join(", ")}` : ""));
    return {
      skipped: true, dryRun: plan.payload, parcel: plan.parcel, liveBlockers: plan.liveBlockers,
      quote: { mode: plan.chosen.mode, code: plan.chosen.rate.code, rate: plan.chosen.rate.rate },
      quotes: plan.quotes,
      ...(plan.locker ? { deliveryLocker: plain(plan.locker), doorQuote: plan.doorQuote ?? null, shipments: payloads.length, ...(payloads.length > 1 ? { dryRuns: payloads } : {}) } : {}),
      // No locker: this is the door-to-door booking it would be (Junid, 24 Nov 2026).
      ...(plan.doorFallback ? { deliveryMode: "door", doorFallback: plain(plan.doorFallback) } : {}),
    };
  }

  // ── LIVE ──────────────────────────────────────────────────────────────────
  if (plan.liveBlockers.length) {
    log(`bookShipment ${key} REFUSED ${plan.liveBlockers.join(", ")}`);
    // No locker AND the door-to-door booking is stopped (over the ceiling, no box fits): the same refusal as any door
    // booking (the reason unchanged, as the POS reads it), with the locker's reason beside it and in Junid's line.
    const fb = plan.doorFallback ?? null;
    const junidLine = ceilingLine(plan.ref, plan)
      ?? (fb ? `${plan.ref}: ${fb.reason}, and door-to-door was not booked either (${plan.liveBlockers.join(", ")}). Book it in the portal.` : null);
    return {
      skipped: true, reason: plan.liveBlockers.join(", "), quotes: plan.quotes,
      ...(junidLine ? { junidLine } : {}), ...(plan.overCeiling ? { overCeiling: plan.overCeiling } : {}),
      ...(fb ? { noLocker: true, doorTried: true, doorFallback: plain(fb) } : {}),
    };
  }
  // The order must exist at that key — never mint a node by booking.
  // shopifyGid is on every ingested order (ref is not, since 2026-10-21 —
  // gating on ref refused every live booking of a new order). An exchange
  // record has no shopifyGid; Jimmy writes it only once paid (exchange.paidAt).
  if (!(orderExists ?? (await db.ref(`online_orders/${key}/${existsField}`).get()).exists())) {
    log(`bookShipment ${key} REFUSED no order at /online_orders/${key}`);
    return { skipped: true, reason: `no order at /online_orders/${key}` };
  }
  const claimRef = db.ref(`online_orders/${key}/shipping/courierBooking`);
  // A claim the unknown-booking check released (unknownBooking.mjs: no shipment at Courier Guy) is re-booked here: its
  // `released` and `rebooks` are carried, and the re-book is COUNTED only once a create is attempted (below).
  let prior = null;
  const claim = await claimRef.transaction((cur) => {
    if (cur && cur.state !== "failed") return undefined;
    prior = cur?.released ? { released: cur.released, rebooks: Number(cur.rebooks) || 0 } : null;
    return { state: "booking", at: now(), ...(prior ?? {}) };
  });
  if (!claim.committed) {
    return { skipped: true, reason: `booking already ${claim.snapshot?.val()?.state ?? "claimed"}` };
  }

  // Re-read live AFTER winning the claim: the quotes took seconds, and a
  // switch turned off in that window must still stop this booking.
  if (!(await readLive(db))) {
    await claimRef.set({ state: "failed", at: now(), error: "live switched off before booking", ...(prior ?? {}) });
    log(`bookShipment ${key} DRY RUN (live switched off mid-booking)`);
    return { skipped: true, dryRun: plan.payload, parcel: plan.parcel };
  }

  // ONE create per parcel (door-to-door: always one; door-to-locker: one per one-shoe parcel, same locker).
  const made = partial ? [...partial.shipments] : [];
  let addressFallback = false;
  // → false when parcels were booked and their record could NOT be kept: the claim must then stay held
  // ("unknown"), or a retry would find no checkpoint and book parcel 1 a second time.
  const keepPartial = async () => {
    if (!made.length) return true;
    try { await db.ref(`online_orders/${key}/shipping/partial`).set(plain({ count: payloads.length, locker: plan.locker ?? null, shipments: made, at: now() })); return true; }
    catch (e) { log(`bookShipment ${key} PARTIAL NOT RECORDED (${made.map((m) => m.waybill).join(", ")}): ${e?.message || e}`); return false; }
  };
  for (let i = made.length; i < payloads.length; i++) {
    const nth = payloads.length > 1 ? ` (parcel ${i + 1} of ${payloads.length})` : "";
    let res;
    try {
      // The address fallback is decided once per order: a split's later parcels go straight to the locker's address.
      if (addressFallback && plan.locker) payloads[i] = lockerAddressPayload(payloads[i], plan.locker) ?? payloads[i];
      try {
        res = await client.createShipment(payloads[i]);
      } catch (first) {
        // Courier Guy could not place the customer's street (a definite refusal, nothing was made): a door-to-locker
        // parcel goes to the locker anyway, so it is sent ONCE more with the locker's own address and point.
        const retry = isGeocodeRefusal(first) && plan.locker && !addressFallback ? lockerAddressPayload(payloads[i], plan.locker) : null;
        if (!retry) throw first;
        log(`bookShipment ${key} CREATE REFUSED${nth} (Courier Guy could not place the address: ${String(first?.message || first).slice(0, 160)}) — once more with the locker's own address`);
        payloads[i] = retry;
        res = await client.createShipment(retry);
        addressFallback = true;
      }
    } catch (err) {
      // 408 means the request may still have run — as ambiguous as a 5xx. A geocode refusal is not: nothing was made.
      const lost = !(err?.status >= 400 && err?.status < 500) || err?.status === 408;
      const ambiguous = lost && !isGeocodeRefusal(err);
      const kept = await keepPartial();
      await claimRef.set({
        state: ambiguous || !kept ? "unknown" : "failed", at: now(), error: `${String(err?.message || err).slice(0, 300)}${nth}`,
        ...(made.length ? { booked: made.map((m) => m.waybill) } : {}),
        // What the attempt was, for the unknown-booking check (unknownBooking.mjs): the reference it carried and,
        // door-to-locker, the locker — so a shipment Courier Guy did make is attached with its locker.
        ...(ambiguous || !kept ? { ref: plan.ref ?? null, shipments: payloads.length, ...(plan.locker ? { locker: plain(plan.locker) } : {}), ...(plan.doorFallback ? { doorFallback: plain(plan.doorFallback) } : {}) } : {}),
        // A re-book after a release: counted now that it reached a create (MAX_AUTO_REBOOKS stops the next one).
        ...(prior ? { released: prior.released, rebooks: (ambiguous || !kept) ? prior.rebooks + 1 : prior.rebooks } : {}),
      });
      log(`bookShipment ${key} CREATE ${ambiguous ? "UNKNOWN" : "FAILED"}${nth} ${err?.message || err}`);
      throw err;
    }
    // A 2xx that names no shipment is not a confirmed booking: hold the claim
    // as "unknown" (nothing re-books it) and let a person check the portal.
    if (!res || typeof res !== "object" || (res.id == null && !res.short_tracking_reference && !res.custom_tracking_reference)) {
      await keepPartial();
      await claimRef.set({ state: "unknown", at: now(), error: `create returned no shipment id or tracking reference${nth}`, ...(made.length ? { booked: made.map((m) => m.waybill) } : {}), ref: plan.ref ?? null, shipments: payloads.length, ...(plan.locker ? { locker: plain(plan.locker) } : {}), ...(plan.doorFallback ? { doorFallback: plain(plan.doorFallback) } : {}), ...(prior ? { released: prior.released, rebooks: prior.rebooks + 1 } : {}) });
      log(`bookShipment ${key} CREATE UNCONFIRMED${nth} — response named no shipment: ${JSON.stringify(res)?.slice(0, 300)}`);
      throw new Error("bookShipment: Courier Guy's create response named no shipment — check the portal before retrying");
    }
    made.push({
      shipmentId: finiteOrNull(res?.id),
      waybill: res?.custom_tracking_reference || res?.short_tracking_reference || null,
      trackingReference: res?.short_tracking_reference ?? null,
      service: res?.service_level_code ?? plan.chosen.rate.code,
      cost: finiteOrNull(res?.charged_amount ?? res?.rate ?? plan.chosen.rate.rate),
      quoted: finiteOrNull(plan.chosen.rate.rate),
    });
  }
  const first = made[0];
  const costs = made.map((m) => m.cost);
  const shipping = {
    provider: "courier_guy",
    shipmentId: first.shipmentId,
    waybill: first.waybill,
    trackingReference: first.trackingReference,
    service: first.service,
    // The rule the parcel was declared under: the reconciliation loop learns
    // only from parcels declared by the current rule (reconcile.mjs). A
    // door-to-locker parcel is a FIXED declaration (one shoe), not an
    // estimate: it carries no rule version, so it never teaches the table.
    parcel: plain(plan.locker ? plan.parcel : { ...plan.parcel, ruleVersion: ESTIMATE_RULE_VERSION }),
    // Every shipment's charge added up (one shipment: its own charge).
    cost: made.length > 1 && costs.every((c) => c !== null) ? Math.round(costs.reduce((t, c) => t + c, 0) * 100) / 100 : first.cost,
    // The quote's make-up (base, surcharges, weights) — what the >R250 email explains.
    priced: plain({ quoted: made.length > 1 ? Math.round(plan.chosen.rate.rate * made.length * 100) / 100 : plan.chosen.rate.rate, mode: plan.chosen.mode, ...(plan.chosen.rate.breakdown || {}) }),
    // Every service quoted for this parcel, cheapest first (the one booked is the cheapest usable).
    quotes: plain(plan.quotes),
    ...(plan.locker ? {
      // Where the customer collects it — what Jamie tells them. No code yet: see collectionCodeNote.
      deliveryLocker: plain(plan.locker),
      deliveryMode: "locker",
      // Courier Guy could not place the customer's street: the shipment carries the locker's address (#2181).
      ...(addressFallback ? { deliveryAddressFallback: "locker" } : {}),
      // EVERY waybill (a split has several); shipping.waybill above is the first.
      waybills: made.map((m) => m.waybill).filter(Boolean),
      shipments: plain(made),
      // What door-to-door would have cost for the parcel the old rule declared.
      doorQuote: plain(plan.doorQuote ?? null),
    } : {}),
    // NO LOCKER → DOOR-TO-DOOR (Junid, 24 Nov 2026): delivered to the customer's own address, and why — so the packing
    // screen, the reports and Jamie can say so. No deliveryLocker: there is no locker to collect from and no PIN.
    ...(plan.doorFallback && !plan.locker ? { deliveryMode: "door", doorFallback: plain({ ...plan.doorFallback, at: now() }) } : {}),
    bookedAt: now(),
  };
  log(`bookShipment ${key} BOOKED ${plan.locker ? (shipping.waybills.join("+") || shipping.waybill) : shipping.waybill} ${shipping.service} R${shipping.cost}${plan.locker ? ` to locker ${plan.locker.id} (${plan.locker.name}, ${plan.locker.km} km)` : ""}${shipping.doorFallback ? ` DOOR-TO-DOOR (${shipping.doorFallback.reason})` : ""}`);
  try {
    await db.ref(`online_orders/${key}/shipping`).update({ ...shipping, ...(partial || made.length > 1 ? { partial: null } : {}), courierBooking: { state: "booked", at: shipping.bookedAt } });
  } catch (err) {
    // The waybill exists and is paid for. Keep at least the claim's record of
    // it, so nothing books it again and a person can find it.
    log(`bookShipment ${key} BOOKED BUT NOT RECORDED ${shipping.waybill}: ${err?.message || err}`);
    await claimRef.set({ state: "booked", at: shipping.bookedAt, shipmentId: shipping.shipmentId, waybill: shipping.waybill, ...(made.length > 1 ? { waybills: made.map((m) => m.waybill) } : {}) }).catch(() => {});
  }
  // Junid's one line ("booked door-to-door: no Courier Guy locker within N km …"): returned, never part of the shipping node.
  const doorLine = doorFallbackLine(plan.ref, shipping);
  return doorLine ? { ...shipping, junidLine: doorLine } : shipping;
}

// The parcels of a split already booked by an earlier, interrupted attempt. → { count, locker, shipments[] } | null
function partialOf(order) {
  const p = order?.shipping?.partial;
  const shipments = (Array.isArray(p?.shipments) ? p.shipments : Object.values(p?.shipments ?? {})).filter((m) => m && (m.waybill || m.shipmentId != null));
  if (!shipments.length || !p?.locker?.id) return null;
  return { count: Math.max(Number(p.count) || 0, shipments.length), locker: p.locker, shipments };
}

/** Mirrors bookShipment: dry run unless live; cancels by tracking reference. */
export async function cancelShipment(order, deps = {}) {
  const { db, client, log, now } = await defaultDeps(deps);
  const key = orderKey(order);
  const s = order?.shipping ?? {};
  const trackingReference = s.trackingReference || s.waybill;
  if (s.provider !== "courier_guy" || !trackingReference) {
    return { skipped: true, reason: "no Courier Guy booking on this order" };
  }
  if (s.cancelledAt) return { skipped: true, reason: "already cancelled", shipping: s };

  // A split has several shipments: every one is cancelled (the first is shipping.waybill).
  const all = (Array.isArray(s.shipments) ? s.shipments : Object.values(s.shipments ?? {})).map((m) => m?.trackingReference || m?.waybill).filter(Boolean);
  const refs = all.length > 1 ? [...new Set(all)] : [trackingReference];
  const payload = refs.length > 1 ? { tracking_references: refs } : { tracking_reference: trackingReference };
  const live = await readLive(db);
  if (!live) {
    log(`cancelShipment ${key} DRY RUN (live is off) would POST /shipments/cancel ${JSON.stringify(payload)}`);
    return { skipped: true, dryRun: payload };
  }

  const cancelled = [];
  try {
    for (const r of refs) { await client.cancelShipment(r); cancelled.push(r); }
  } catch (err) {
    // A 4xx means TCG refused (e.g. already collected); anything else may have
    // cancelled it. Either way the order says so; a retry re-sends the cancel,
    // which TCG treats idempotently.
    const refused = err?.status >= 400 && err?.status < 500 && err?.status !== 408;
    await db.ref(`online_orders/${key}/shipping/cancel`).set({ state: refused ? "refused" : "unknown", at: now(), error: String(err?.message || err).slice(0, 300), ...(refs.length > 1 ? { cancelled } : {}) });
    log(`cancelShipment ${key} ${refused ? "REFUSED" : "UNKNOWN"} ${err?.message || err}`);
    throw err;
  }
  // A 2xx is TCG's documented success for /shipments/cancel (the client
  // throws on anything else); the doc gives no body to check further.
  const patch = { cancelledAt: now(), cancel: { state: "cancelled", at: now() }, courierBooking: { state: "cancelled", at: now() } };
  await db.ref(`online_orders/${key}/shipping`).update(patch);
  log(`cancelShipment ${key} CANCELLED ${refs.join("+")}`);
  return { ...s, ...patch };
}

/**
 * The parcels an order will ship as — the parcel rule over its lines, with
 * the live /config/shipping — in the small shape the POS order card shows
 * before Pack. No rates, no network. `sig` changes when the lines do.
 */
// Bump when the RULE changes: every open order's estimate is then rewritten on
// the poller's next tick (2 = one parcel, never split — 2026-10-23;
// 3 = boxes also packed in flat layers, so a box of caps fits — 2026-10-29;
// 4 = no padding: clothing in the flat bag, no empty stack slot, overflow at
// its own thickness — 2026-11-06, docs/courier-rate-audit.md).
export const ESTIMATE_RULE_VERSION = 4;

/** The estimate's signature: the order's lines, the config they are packed with, AND the rule version. */
export function estimateSig(order, rawConfig) {
  const raw = Array.isArray(order?.lines) ? order.lines : Object.values(order?.lines ?? {});
  const lines = raw.map((l) => `${l?.pid ?? l?.productId}|${l?.size}|${l?.qty}`).join(";");
  let h = 0;
  for (const c of JSON.stringify(rawConfig ?? null)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `${lines}#${(h >>> 0).toString(36)}#v${ESTIMATE_RULE_VERSION}`;
}

export async function estimateForOrder(order, { db, products = null, rawConfig, sig }) {
  const raw = rawConfig !== undefined ? rawConfig : (await db.ref("config/shipping").get()).val();
  const cfg = mergeShippingConfig(raw);
  const lines = orderLines(order, products ?? (await productsFor(db, order)));
  const est = estimateParcel(lines, cfg);
  sig = sig ?? estimateSig(order, raw);
  return {
    sig,
    parcelCount: est.parcelCount,
    chargeableKg: est.chargeableKg,
    parcels: est.parcels.map((p) => ({
      kind: p.kind, boxCode: p.boxCode, lengthCm: p.lengthCm, widthCm: p.widthCm, heightCm: p.heightCm, calibrationClass: p.calibrationClass ?? null,
      actualKg: p.actualKg, chargeableKg: p.chargeableKg, items: p.contents.length,
      pairs: p.pairs ?? 0, overflowBundles: p.overflowBundles ?? 0, ...(p.layout ? { layout: p.layout } : {}),
      ...(p.contents.length ? { contents: p.contents.map((c) => c.kind) } : {}),
    })),
  };
}

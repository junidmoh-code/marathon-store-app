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
// (timeout/5xx) leaves the claim as "unknown" — check the portal before
// retrying, because TCG may have booked it (the client never retries a create).
//
// No waybill printing: waybills stay handwritten. `waybill` is returned for
// that, and a later label-print step can open TCG's label PDF
// (GET /shipments/label?id=) with window.print — never WebUSB.
import { estimateParcel } from "../../src/shipping/estimateParcel.js";
import { mergeShippingConfig } from "../../src/shipping/shippingConfig.js";
import { chooseRate } from "../../src/shipping/chooseService.js";
import { orderLines, deliveryAddress, deliveryContact, orderRef } from "../../src/shipping/orderShipment.js";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import { quoteParcel, tcgParcel, lockerCollection } from "./quote.mjs";
import { fileLogger } from "./courier-client.mjs";

export const LIVE_PATH = "config/shipping/live";

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

function orderKey(order) {
  return assertSafeSegment(String(order?.key ?? order?.ref ?? orderRef(order)).replace(/^#/, ""), "order key");
}

/** Everything up to (not including) the shipment call. Pure apart from rates. */
export async function planShipment(order, { db, client, products = null }) {
  const cfg = mergeShippingConfig((await db.ref("config/shipping").get()).val());
  const ref = orderRef(order) || order?.key || "";
  const lines = orderLines(order, products);
  const parcel = estimateParcel(lines, cfg);
  const { address, missing: addrMissing } = deliveryAddress(order);
  const { contact, missing: contactMissing } = deliveryContact(order);
  const collectionContact = cfg.collectionContact ?? {};
  // The customer's side must be complete before anything is even priced.
  const missing = [...addrMissing, ...contactMissing, ...(!ref ? ["order_ref"] : [])];
  if (missing.length) return { ok: false, reason: `missing: ${missing.join(", ")}`, missing, parcel };
  // Our own side only has to be complete to BOOK: a dry run still shows the
  // whole payload, with the gap named, so the card/log is useful before
  // Junid has filled the collection contact in.
  const liveBlockers = [
    ...(!collectionContact.mobile_number && !collectionContact.email ? ["collection_contact"] : []),
    ...(!parcel.fits ? ["no standard box fits"] : []),
  ];

  const dropBox = { pickupPointId: cfg.dropBox.pickupPointId, pickupPointProvider: cfg.dropBox.pickupPointProvider };
  const quoted = await quoteParcel(client, { collectionAddress: cfg.collectionAddress, deliveryAddress: address, parcel, dropBox });
  const chosen = chooseRate({ door: quoted.door.rates, locker: quoted.locker.rates }, parcel, cfg);
  if (!chosen) {
    return { ok: false, reason: `no usable rate (door: ${quoted.door.error ?? "none"}; locker: ${quoted.locker.error ?? "none"})`, parcel, quoted };
  }

  const payload = {
    collection_address: cfg.collectionAddress,
    ...(chosen.mode === "locker" ? lockerCollection(dropBox) : {}),
    collection_contact: { name: collectionContact.name ?? "", mobile_number: collectionContact.mobile_number ?? "", email: collectionContact.email ?? "" },
    delivery_address: address,
    delivery_contact: contact,
    parcels: [tcgParcel(parcel)],
    service_level_code: chosen.rate.code,
    customer_reference: ref,
    customer_reference_name: "Order no.",
    mute_notifications: false,
  };
  return { ok: true, payload, parcel, chosen, quoted, ref, liveBlockers };
}

/**
 * @param {object} order   an /online_orders record (its key as order.key or order.ref)
 * @param {object} [deps]  { db, client, products, log, now } — injected by tests
 */
export async function bookShipment(order, deps = {}) {
  const { db, client, products, log, now } = await defaultDeps(deps);
  const key = orderKey(order);

  // An order that already carries a booking is never booked again.
  if (order?.shipping?.shipmentId) {
    return { skipped: true, reason: "already booked", shipping: order.shipping };
  }

  const plan = await planShipment(order, { db, client, products });
  if (!plan.ok) {
    log(`bookShipment ${key} REFUSED ${plan.reason}`);
    return { skipped: true, reason: plan.reason, parcel: plan.parcel ?? null };
  }

  const live = await readLive(db);
  if (!live) {
    log(`bookShipment ${key} DRY RUN (live is off) would POST /shipments ${JSON.stringify(plan.payload)}` +
      (plan.liveBlockers.length ? ` — live would refuse: ${plan.liveBlockers.join(", ")}` : ""));
    return {
      skipped: true, dryRun: plan.payload, parcel: plan.parcel, liveBlockers: plan.liveBlockers,
      quote: { mode: plan.chosen.mode, code: plan.chosen.rate.code, rate: plan.chosen.rate.rate },
    };
  }

  // ── LIVE ──────────────────────────────────────────────────────────────────
  if (plan.liveBlockers.length) {
    log(`bookShipment ${key} REFUSED ${plan.liveBlockers.join(", ")}`);
    return { skipped: true, reason: plan.liveBlockers.join(", ") };
  }
  const claimRef = db.ref(`online_orders/${key}/shipping/courierBooking`);
  const claim = await claimRef.transaction((cur) => (cur && cur.state !== "failed" ? undefined : { state: "booking", at: now() }));
  if (!claim.committed) {
    return { skipped: true, reason: `booking already ${claim.snapshot?.val()?.state ?? "claimed"}` };
  }

  let res;
  try {
    res = await client.createShipment(plan.payload);
  } catch (err) {
    const ambiguous = !(err?.status >= 400 && err?.status < 500);
    await claimRef.set({ state: ambiguous ? "unknown" : "failed", at: now(), error: String(err?.message || err).slice(0, 300) });
    log(`bookShipment ${key} CREATE ${ambiguous ? "UNKNOWN" : "FAILED"} ${err?.message || err}`);
    throw err;
  }
  const shipping = {
    provider: "courier_guy",
    shipmentId: res?.id ?? null,
    waybill: res?.custom_tracking_reference || res?.short_tracking_reference || null,
    trackingReference: res?.short_tracking_reference ?? null,
    service: res?.service_level_code ?? plan.chosen.rate.code,
    parcel: plan.parcel,
    cost: Number(res?.charged_amount ?? res?.rate ?? plan.chosen.rate.rate),
    bookedAt: now(),
  };
  await db.ref(`online_orders/${key}/shipping`).update({ ...shipping, courierBooking: { state: "booked", at: shipping.bookedAt } });
  log(`bookShipment ${key} BOOKED ${shipping.waybill} ${shipping.service} R${shipping.cost}`);
  return shipping;
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

  const payload = { tracking_reference: trackingReference };
  const live = await readLive(db);
  if (!live) {
    log(`cancelShipment ${key} DRY RUN (live is off) would POST /shipments/cancel ${JSON.stringify(payload)}`);
    return { skipped: true, dryRun: payload };
  }

  await client.cancelShipment(trackingReference);
  const patch = { cancelledAt: now(), courierBooking: { state: "cancelled", at: now() } };
  await db.ref(`online_orders/${key}/shipping`).update(patch);
  log(`cancelShipment ${key} CANCELLED ${trackingReference}`);
  return { ...s, ...patch };
}

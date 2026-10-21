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
import { orderLines, deliveryAddress, deliveryContact, orderRef, orderKey as keyOf } from "../../src/shipping/orderShipment.js";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import { quoteParcel, tcgParcels, lockerCollection } from "./quote.mjs";
import { fileLogger } from "./courier-client.mjs";

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

// The /online_orders key (the Shopify order id, digits), never the order's code.
function orderKey(order) {
  const key = keyOf(order);
  if (!key) throw new Error("bookShipment: the order carries no /online_orders key (key, id or shopifyGid)");
  // A ref (KQZ) passed as id/key would put the claim on a junk node the real
  // order never sees — and the one-booking guard with it. Keys are digits.
  if (!/^\d+$/.test(key)) throw new Error(`bookShipment: "${key}" is not an /online_orders key (the Shopify order id)`);
  return assertSafeSegment(key, "order key");
}

// Each line's /products record, by exact path, for its subcategory — the
// order lines carry pid + category only. One small read per distinct product.
async function productsFor(db, order) {
  const raw = Array.isArray(order?.lines) ? order.lines : Object.values(order?.lines ?? {});
  const pids = [...new Set(raw.map((l) => l?.pid ?? l?.productId).filter(Boolean))];
  const out = {};
  for (const pid of pids) {
    try {
      const snap = await db.ref(`products/${assertSafeSegment(pid, "productId")}`).get();
      if (snap.exists()) out[pid] = snap.val();
    } catch { /* an unreadable product classifies by its line alone */ }
  }
  return out;
}

/** Everything up to (not including) the shipment call. Pure apart from rates. */
export async function planShipment(order, { db, client, products = null }) {
  const cfg = mergeShippingConfig((await db.ref("config/shipping").get()).val());
  const ref = orderRef(order);
  const lines = orderLines(order, products ?? (await productsFor(db, order)));
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

  // The locker is only asked when the drop box is ON (door-to-door otherwise).
  const dropBox = cfg.dropBox?.enabled
    ? { pickupPointId: cfg.dropBox.pickupPointId, pickupPointProvider: cfg.dropBox.pickupPointProvider }
    : null;
  const quoted = await quoteParcel(client, { collectionAddress: cfg.collectionAddress, deliveryAddress: address, parcels: parcel.parcels, dropBox });
  const chosen = chooseRate({ door: quoted.door.rates, locker: quoted.locker.rates }, parcel, cfg);
  if (!chosen) {
    return { ok: false, reason: `no usable rate (door: ${quoted.door.error ?? "none"}; locker: ${quoted.locker.error ?? "none"})`, parcel, quoted };
  }
  // THE SPEND CEILING. The account is prepaid; an order that quotes above
  // this is booked by a person in the portal, not by this code.
  const ceiling = Number(cfg.maxChargeRand);
  if (Number.isFinite(ceiling) && ceiling > 0 && chosen.rate.rate > ceiling) {
    liveBlockers.push(`quote R${chosen.rate.rate.toFixed(2)} is over the R${ceiling} ceiling`);
  }

  const payload = {
    collection_address: cfg.collectionAddress,
    ...(chosen.mode === "locker" ? lockerCollection(dropBox) : {}),
    collection_contact: { name: collectionContact.name ?? "", mobile_number: collectionContact.mobile_number ?? "", email: collectionContact.email ?? "" },
    delivery_address: address,
    delivery_contact: contact,
    // ONE shipment, every parcel of the parcel rule (N shoeboxes + any flat box).
    parcels: tcgParcels(parcel.parcels),
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
  // The order must exist at that key — never mint a node by booking.
  // shopifyGid is on every ingested order (ref is not, since 2026-10-21 —
  // gating on ref refused every live booking of a new order).
  if (!(await db.ref(`online_orders/${key}/shopifyGid`).get()).exists()) {
    log(`bookShipment ${key} REFUSED no order at /online_orders/${key}`);
    return { skipped: true, reason: `no order at /online_orders/${key}` };
  }
  const claimRef = db.ref(`online_orders/${key}/shipping/courierBooking`);
  const claim = await claimRef.transaction((cur) => (cur && cur.state !== "failed" ? undefined : { state: "booking", at: now() }));
  if (!claim.committed) {
    return { skipped: true, reason: `booking already ${claim.snapshot?.val()?.state ?? "claimed"}` };
  }

  // Re-read live AFTER winning the claim: the quotes took seconds, and a
  // switch turned off in that window must still stop this booking.
  if (!(await readLive(db))) {
    await claimRef.set({ state: "failed", at: now(), error: "live switched off before booking" });
    log(`bookShipment ${key} DRY RUN (live switched off mid-booking)`);
    return { skipped: true, dryRun: plan.payload, parcel: plan.parcel };
  }

  let res;
  try {
    res = await client.createShipment(plan.payload);
  } catch (err) {
    // 408 means the request may still have run — as ambiguous as a 5xx.
    const ambiguous = !(err?.status >= 400 && err?.status < 500) || err?.status === 408;
    await claimRef.set({ state: ambiguous ? "unknown" : "failed", at: now(), error: String(err?.message || err).slice(0, 300) });
    log(`bookShipment ${key} CREATE ${ambiguous ? "UNKNOWN" : "FAILED"} ${err?.message || err}`);
    throw err;
  }
  // A 2xx that names no shipment is not a confirmed booking: hold the claim
  // as "unknown" (nothing re-books it) and let a person check the portal.
  if (!res || typeof res !== "object" || (res.id == null && !res.short_tracking_reference && !res.custom_tracking_reference)) {
    await claimRef.set({ state: "unknown", at: now(), error: "create returned no shipment id or tracking reference" });
    log(`bookShipment ${key} CREATE UNCONFIRMED — response named no shipment: ${JSON.stringify(res)?.slice(0, 300)}`);
    throw new Error("bookShipment: Courier Guy's create response named no shipment — check the portal before retrying");
  }
  const shipping = {
    provider: "courier_guy",
    shipmentId: finiteOrNull(res?.id),
    waybill: res?.custom_tracking_reference || res?.short_tracking_reference || null,
    trackingReference: res?.short_tracking_reference ?? null,
    service: res?.service_level_code ?? plan.chosen.rate.code,
    parcel: plain(plan.parcel),
    cost: finiteOrNull(res?.charged_amount ?? res?.rate ?? plan.chosen.rate.rate),
    bookedAt: now(),
  };
  log(`bookShipment ${key} BOOKED ${shipping.waybill} ${shipping.service} R${shipping.cost}`);
  try {
    await db.ref(`online_orders/${key}/shipping`).update({ ...shipping, courierBooking: { state: "booked", at: shipping.bookedAt } });
  } catch (err) {
    // The waybill exists and is paid for. Keep at least the claim's record of
    // it, so nothing books it again and a person can find it.
    log(`bookShipment ${key} BOOKED BUT NOT RECORDED ${shipping.waybill}: ${err?.message || err}`);
    await claimRef.set({ state: "booked", at: shipping.bookedAt, shipmentId: shipping.shipmentId, waybill: shipping.waybill }).catch(() => {});
  }
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

  try {
    await client.cancelShipment(trackingReference);
  } catch (err) {
    // A 4xx means TCG refused (e.g. already collected); anything else may have
    // cancelled it. Either way the order says so; a retry re-sends the cancel,
    // which TCG treats idempotently.
    const refused = err?.status >= 400 && err?.status < 500 && err?.status !== 408;
    await db.ref(`online_orders/${key}/shipping/cancel`).set({ state: refused ? "refused" : "unknown", at: now(), error: String(err?.message || err).slice(0, 300) });
    log(`cancelShipment ${key} ${refused ? "REFUSED" : "UNKNOWN"} ${err?.message || err}`);
    throw err;
  }
  // A 2xx is TCG's documented success for /shipments/cancel (the client
  // throws on anything else); the doc gives no body to check further.
  const patch = { cancelledAt: now(), cancel: { state: "cancelled", at: now() }, courierBooking: { state: "cancelled", at: now() } };
  await db.ref(`online_orders/${key}/shipping`).update(patch);
  log(`cancelShipment ${key} CANCELLED ${trackingReference}`);
  return { ...s, ...patch };
}

/**
 * The parcels an order will ship as — the parcel rule over its lines, with
 * the live /config/shipping — in the small shape the POS order card shows
 * before Pack. No rates, no network. `sig` changes when the lines do.
 */
/** The estimate's signature: the order's lines AND the config they are packed with. */
export function estimateSig(order, rawConfig) {
  const raw = Array.isArray(order?.lines) ? order.lines : Object.values(order?.lines ?? {});
  const lines = raw.map((l) => `${l?.pid ?? l?.productId}|${l?.size}|${l?.qty}`).join(";");
  let h = 0;
  for (const c of JSON.stringify(rawConfig ?? null)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `${lines}#${(h >>> 0).toString(36)}`;
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
      kind: p.kind, boxCode: p.boxCode, lengthCm: p.lengthCm, widthCm: p.widthCm, heightCm: p.heightCm,
      actualKg: p.actualKg, chargeableKg: p.chargeableKg, items: p.contents.length,
      ...(p.contents.length ? { contents: p.contents.map((c) => c.kind) } : {}),
    })),
  };
}

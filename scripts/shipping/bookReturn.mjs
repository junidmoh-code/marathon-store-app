// ── bookReturn(key) — the RETURN leg of an online exchange, booked by code (Junid, 30 Oct 2026: "make Jimmy book the
// Courier Guy returns automatically")
//
// An online exchange (/online_orders/exchange-<n>-<paidAtMs>, minted by Jimmy once the R218 is paid; marathon-dm-agent
// src/jimmy/reserve.js) needs the customer's item back. Until now the operator booked that leg in the portal (#1789:
// L2DL - ECO, the customer drops it in a locker, The Courier Guy delivers it to the shop). This books the same shipment
// through the API, the reverse of bookShipment:
//
//   collection   the customer: the exchange record's shipping address, the phone they talk to Jimmy on
//                (exchange.contactPhone) and their email (passed in: the exchange record carries none) — The Courier Guy
//                SMSes them the locker drop-off details
//                + collection_pickup_point_id: the Courier Guy locker NEAREST the customer (Junid, 30 Oct 2026: "strictly
//                they have to drop them at a Courier Guy locker, you book the nearest one and give it to them"): their
//                address geocoded (OpenStreetMap Nominatim, one call, the full address first, then the town), then
//                GET /pickup-points?type=locker&order_closest=true; the closest one online, not hidden, with a
//                compartment the parcel fits. Never a door collection.
//   delivery     the shop: /config/shipping collectionAddress and collectionContact (where outgoing parcels leave from)
//   parcels      the parcel rule over the exchange's lines (the replacement is the same kind of item as the one coming back)
//   service      the cheapest LOCKER rate quoted (L2D* - ECO). No locker rate (too big, unplaceable) → refused: a person
//                books it (the customer was promised a locker drop-off, never a door collection).
//   reference    "<n>-EX return" (as the hand-booked #1789: "1789-EX return")
//
// The same guards as bookShipment, pinned by bookReturn.test.mjs:
//   /config/shipping/live !== true   → a dry run: the payload logged, NO create call.
//   the spend ceiling (maxChargeRand) → refused above it.
//   ONE booking per exchange          → a transaction claims /online_orders/<key>/returnShipping/courierBooking; a
//                                       second caller books nothing. A failed create releases it ("failed", the error
//                                       kept); a lost response (timeout, 5xx, 408) holds it as "unknown": check the
//                                       portal, the client never retries a create.
//   a return already recorded (incoming/waybill: booked by hand) or the item already back (incoming/arrival) → nothing.
// The result is written to /online_orders/<key>/returnShipping = { provider, shipmentId, waybill (the short tracking
// reference, what tracking reads), dropOffRef (the locker reference, e.g. LD-RFR518), locker { id, name, address, hours,
// km }, service, cost, parcel, bookedAt }.
import { estimateParcel } from "../../src/shipping/estimateParcel.js";
import { mergeShippingConfig } from "../../src/shipping/shippingConfig.js";
import { normalizeRates } from "../../src/shipping/chooseService.js";
import { orderLines, deliveryAddress, deliveryContact } from "../../src/shipping/orderShipment.js";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import { tcgParcels, lockerCollection } from "./quote.mjs";
import { readLive, isExchangeKey } from "./bookShipment.mjs";
import { fileLogger } from "./courier-client.mjs";

// The parcel's locker size → the compartment names TCG lists on a locker (available_compartment_sizes "V4-M").
const SIZES = ["XS", "S", "M", "L", "XL"];
const fitsCompartment = (point, size) => {
  const have = (point?.available_compartment_sizes || []).map((c) => String(c).split("-").pop().toUpperCase());
  if (!have.length) return true; // unlisted: TCG's rate call is the check
  return have.some((c) => SIZES.indexOf(c) >= SIZES.indexOf(size));
};
const km = (a, b) => {
  const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

export const MAX_LOCKER_KM = 30;
const tryLabels = (address) => [...new Set([
  [address.street_address, address.local_area, address.city, address.code],
  [address.local_area, address.city, address.code],
  [address.city, address.code],
].map((parts) => [...new Set(parts.map(str).filter(Boolean))].join(", ")).filter(Boolean))];

/** The customer's address → { lat, lng, from } (OpenStreetMap Nominatim; the full address, then the suburb/town). */
export async function geocode(address, { fetchImpl = globalThis.fetch } = {}) {
  if (Number.isFinite(Number(address?.lat)) && Number.isFinite(Number(address?.lng))) return { lat: Number(address.lat), lng: Number(address.lng), from: "address" };
  for (const q of tryLabels(address)) {
    try {
      const res = await fetchImpl(`https://nominatim.openstreetmap.org/search?format=json&countrycodes=za&limit=1&q=${encodeURIComponent(q)}`, {
        headers: { "User-Agent": "marathon-club-returns/1.0 (gunidmoh@gmail.com)", Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      const hit = res.ok ? (await res.json())?.[0] : null;
      if (hit && Number.isFinite(Number(hit.lat)) && Number.isFinite(Number(hit.lon))) return { lat: Number(hit.lat), lng: Number(hit.lon), from: q };
    } catch { /* the next, wider try */ }
    await new Promise((r) => setTimeout(r, 1100)); // Nominatim's policy: at most one request a second
  }
  return null;
}

/** The nearest Courier Guy locker the parcel fits, online and listed. → { id, provider, name, address, hours, description, km } | null */
export async function nearestLocker(client, at, size) {
  const res = await client.getPickupPoints({ lat: at.lat, lng: at.lng, order_closest: "true", type: "locker" });
  const list = (Array.isArray(res) ? res : res?.pickup_points) || [];
  const ok = list
    .filter((p) => p?.pickup_point_id && p.type === "locker" && !p.is_hidden && (p.status == null || p.status === "online") && fitsCompartment(p, size))
    .map((p) => ({ p, d: Number.isFinite(Number(p.lat)) ? km(at, { lat: Number(p.lat), lng: Number(p.lng) }) : Infinity }))
    .sort((a, b) => a.d - b.d);
  const best = ok[0];
  if (!best) return null;
  const a = best.p.address || {};
  return {
    id: best.p.pickup_point_id, provider: best.p.pickup_point_provider || "tcg-locker", name: str(best.p.name),
    address: (str(a.street_address) && str(a.street_address).toLowerCase().includes(str(a.city).toLowerCase()) ? str(a.street_address) : [a.street_address, a.city].map(str).filter(Boolean).join(", ")) || str(a.entered_address),
    hours: str(best.p.trading_hours), description: str(best.p.description), km: Number.isFinite(best.d) ? Math.round(best.d * 10) / 10 : null,
  };
}

const finiteOrNull = (n) => (Number.isFinite(Number(n)) ? Number(n) : null);
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));
const str = (v) => String(v ?? "").trim();

async function defaultDeps(deps) {
  const out = { ...deps };
  if (!out.db) out.db = (await import("./adminDb.mjs")).adminDb();
  if (!out.client) out.client = (await import("./courier-client.mjs")).createCourierClient();
  if (!out.log) out.log = fileLogger();
  if (!out.now) out.now = () => Date.now();
  return out;
}

/** The exchange's number ("1793" from "#1793-EX" / "1793-EX" / the key). Pure. */
export function exchangeNumber(order, key) {
  const n = str(order?.orderNumber || order?.shopifyName).replace(/^#/, "").replace(/-EX$/i, "");
  return n || String(key).split("-")[1] || "";
}

/** The customer as the SENDER: name, the phone they talk to Jimmy on, their email. Pure. */
export function returnContact(order, email = null) {
  const { contact } = deliveryContact(order);
  const mobile = str(order?.exchange?.contactPhone) || contact.mobile_number;
  return { name: contact.name || str(order?.customer?.name), mobile_number: mobile, email: str(email) || contact.email };
}

async function rates(client, body) {
  try { return { rates: normalizeRates(await client.getRates(body)) }; }
  catch (err) { return { error: String(err?.message || err).slice(0, 300), rates: [] }; }
}

/** Everything up to (not including) the create call. Rates only (they book nothing). */
export async function planReturn(order, { db, client, products = null, email = null, key, geocoder = geocode }) {
  const raw = (await db.ref("config/shipping").get()).val();
  const cfg = mergeShippingConfig(raw);
  // A return is ALWAYS a locker drop-off, whatever the outgoing drop-box switch says.
  const lockerCfg = { ...cfg, dropBox: { ...cfg.dropBox, enabled: true } };
  const lines = orderLines(order, products ?? (await productsFor(db, order)));
  const parcel = estimateParcel(lines, lockerCfg);
  const { address: from, missing: addrMissing } = deliveryAddress(order);
  const contact = returnContact(order, email);
  const shop = cfg.collectionAddress;
  const shopContact = cfg.collectionContact ?? {};
  const n = exchangeNumber(order, key);
  const missing = [
    ...addrMissing.map((m) => `customer ${m}`),
    ...(!contact.mobile_number && !contact.email ? ["customer phone or email"] : []),
    ...(!lines.length ? ["the exchange's lines"] : []),
    ...(!shopContact.mobile_number && !shopContact.email ? ["collection_contact"] : []),
    ...(!n ? ["order number"] : []),
  ];
  if (missing.length) return { ok: false, reason: `missing: ${missing.join(", ")}`, parcel };
  if (!parcel.fits || !parcel.dropBoxEligible) return { ok: false, reason: "the parcel fits no Courier Guy locker", parcel };

  const at = await geocoder(from);
  if (!at) return { ok: false, transient: true, reason: "the customer's address could not be placed on a map (no nearest locker)", parcel };
  let locker;
  try { locker = await nearestLocker(client, at, parcel.lockerSize); }
  catch (err) { return { ok: false, transient: true, reason: `the locker list could not be read (${String(err?.message || err).slice(0, 200)})`, parcel }; }
  if (!locker) return { ok: false, reason: `no Courier Guy locker near the customer fits a ${parcel.lockerSize} parcel`, parcel };
  // "The nearest one" must be near (architect review 5): further than MAX_LOCKER_KM, a person picks it with the customer.
  if (locker.km != null && locker.km > MAX_LOCKER_KM) return { ok: false, reason: `the nearest locker (${locker.name}) is ${locker.km} km from the customer's address`, parcel };
  locker.placedBy = at.from === "address" || at.from === tryLabels(from)[0] ? "street" : "town";
  const dropBox = { pickupPointId: locker.id, pickupPointProvider: locker.provider };
  const body = (collection) => ({ collection_address: collection, ...lockerCollection(dropBox), delivery_address: shop, parcels: tcgParcels(parcel.parcels) });
  let used = from;
  let quoted = await rates(client, body(from));
  // TCG answers rates: null when it can't place the suburb (as bookShipment): once more with the town as the suburb.
  const town = str(from.city);
  if (!quoted.error && !quoted.rates.length && town && str(from.local_area) !== town) {
    const retry = { ...from, local_area: town };
    const again = await rates(client, body(retry));
    if (again.rates.length) [quoted, used] = [again, retry];
  }
  const exclude = new Set(cfg.excludeServiceCodes ?? []);
  // STRICTLY locker to door (architect review 4): only an L2D service, whatever else TCG quotes.
  const lockers = quoted.rates.filter((r) => !exclude.has(r.code) && (/^L2D/i.test(r.code) || r.group === "L2D"));
  if (!lockers.length) return { ok: false, ...(quoted.error ? { transient: true } : {}), reason: `no locker rate (${quoted.error ?? "none quoted"})`, parcel };
  const rate = lockers.reduce((best, r) => (!best || r.rate < best.rate ? r : best), null);

  const blockers = [];
  const ceiling = Number(cfg.maxChargeRand);
  if (Number.isFinite(ceiling) && ceiling > 0 && rate.rate > ceiling) blockers.push(`quote R${rate.rate.toFixed(2)} is over the R${ceiling} ceiling`);

  const payload = {
    collection_address: used,
    ...lockerCollection(dropBox),
    collection_contact: contact,
    delivery_address: shop,
    delivery_contact: { name: shopContact.name ?? "", mobile_number: shopContact.mobile_number ?? "", email: shopContact.email ?? "" },
    parcels: tcgParcels(parcel.parcels),
    service_level_code: rate.code,
    customer_reference: `${n}-EX return`,
    customer_reference_name: "Order no.",
    mute_notifications: false,
  };
  return { ok: true, payload, parcel, rate, blockers, locker };
}

async function productsFor(db, order) {
  const raw = Array.isArray(order?.lines) ? order.lines : Object.values(order?.lines ?? {});
  const out = {};
  for (const pid of [...new Set(raw.map((l) => l?.pid ?? l?.productId).filter(Boolean))]) {
    try {
      const snap = await db.ref(`products/${assertSafeSegment(pid, "productId")}`).get();
      if (snap.exists()) out[pid] = snap.val();
    } catch { /* an unreadable product classifies by its line alone */ }
  }
  return out;
}

/**
 * @param {string} key      the exchange's /online_orders key (exchange-<n>-<paidAtMs>)
 * @param {object} [deps]   { db, client, products, log, now, email } — email: the customer's, for The Courier Guy's notice
 * → { booked: true, ...returnShipping } | { skipped: true, reason, dryRun? }. Throws on a create that failed or may have run.
 */
export async function bookReturn(key, deps = {}) {
  const { db, client, products, log, now, email = null, geocoder } = await defaultDeps(deps);
  if (!isExchangeKey(key)) throw new Error(`bookReturn: "${key}" is not an exchange key (exchange-<n>-<paidAtMs>)`);
  assertSafeSegment(key, "order key");
  const at = (p) => db.ref(`online_orders/${key}/${p}`);

  // Exact paths, never the whole order list. The exchange must exist and be paid (Jimmy writes it only once paid).
  if (!(await at("exchange/paidAt").get()).exists()) return { skipped: true, reason: `no paid exchange at /online_orders/${key}` };
  const done = (await at("returnShipping").get()).val();
  if (done?.shipmentId || done?.waybill) return { skipped: true, reason: "return already booked", returnShipping: done };
  if ((await at("incoming/waybill").get()).exists()) return { skipped: true, reason: "return already recorded (booked by hand)" };
  if ((await at("incoming/arrival").get()).exists()) return { skipped: true, reason: "the item is already back" };
  const order = { ...((await db.ref(`online_orders/${key}`).get()).val() || {}), key };
  if (["cancelled", "closed"].includes(str(order.status))) return { skipped: true, reason: `the exchange is ${order.status}` };

  const plan = await planReturn(order, { db, client, products, email, key, ...(geocoder ? { geocoder } : {}) });
  if (!plan.ok) {
    log(`bookReturn ${key} REFUSED ${plan.reason}`);
    return { skipped: true, refused: !plan.transient, transient: !!plan.transient, reason: plan.reason };
  }
  if (!(await readLive(db))) {
    log(`bookReturn ${key} DRY RUN (live is off) would POST /shipments ${JSON.stringify(plan.payload)}` + (plan.blockers.length ? ` — live would refuse: ${plan.blockers.join(", ")}` : ""));
    return { skipped: true, dryRun: plan.payload, locker: plan.locker, quote: { code: plan.rate.code, rate: plan.rate.rate }, blockers: plan.blockers };
  }
  if (plan.blockers.length) {
    log(`bookReturn ${key} REFUSED ${plan.blockers.join(", ")}`);
    return { skipped: true, refused: true, reason: plan.blockers.join(", ") };
  }

  const claimRef = at("returnShipping/courierBooking");
  const claim = await claimRef.transaction((cur) => (cur && cur.state !== "failed" ? undefined : { state: "booking", at: now() }));
  if (!claim.committed) return { skipped: true, reason: `return booking already ${claim.snapshot?.val()?.state ?? "claimed"}` };
  // The switch re-read after winning the claim (the quotes took seconds), as bookShipment.
  if (!(await readLive(db))) {
    await claimRef.set({ state: "failed", at: now(), error: "live switched off before booking" });
    return { skipped: true, dryRun: plan.payload };
  }

  let res;
  try {
    res = await client.createShipment(plan.payload);
  } catch (err) {
    const ambiguous = !(err?.status >= 400 && err?.status < 500) || err?.status === 408;
    await claimRef.set({ state: ambiguous ? "unknown" : "failed", at: now(), error: String(err?.message || err).slice(0, 300) });
    log(`bookReturn ${key} CREATE ${ambiguous ? "UNKNOWN" : "FAILED"} ${err?.message || err}`);
    err.ambiguous = ambiguous;
    throw err;
  }
  if (!res || typeof res !== "object" || (res.id == null && !res.short_tracking_reference)) {
    await claimRef.set({ state: "unknown", at: now(), error: "create returned no shipment id or tracking reference" });
    log(`bookReturn ${key} CREATE UNCONFIRMED — response named no shipment: ${JSON.stringify(res)?.slice(0, 300)}`);
    const err = new Error("bookReturn: Courier Guy's create response named no shipment — check the portal before retrying");
    err.ambiguous = true;
    throw err;
  }
  const ship = {
    provider: "courier_guy",
    shipmentId: finiteOrNull(res.id),
    // Tracking reads the short reference (CQMT67); the locker takes the custom one (LD-RFR518).
    waybill: res.short_tracking_reference || res.custom_tracking_reference || null,
    dropOffRef: res.custom_tracking_reference || null,
    service: res.service_level_code ?? plan.rate.code,
    cost: finiteOrNull(res.charged_amount ?? res.rate ?? plan.rate.rate),
    parcel: plain(plan.parcel.parcels?.[0] ?? null),
    locker: plain(plan.locker),
    bookedAt: now(),
  };
  log(`bookReturn ${key} BOOKED ${ship.waybill} (${ship.dropOffRef}) ${ship.service} R${ship.cost}`);
  try {
    await at("returnShipping").update({ ...ship, courierBooking: { state: "booked", at: ship.bookedAt } });
  } catch (err) {
    log(`bookReturn ${key} BOOKED BUT NOT RECORDED ${ship.waybill}: ${err?.message || err}`);
    await claimRef.set({ state: "booked", at: ship.bookedAt, shipmentId: ship.shipmentId, waybill: ship.waybill }).catch(() => {});
  }
  return { booked: true, ...ship };
}

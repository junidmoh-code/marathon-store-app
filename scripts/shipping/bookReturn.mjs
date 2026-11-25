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
//                compartment the parcel fits. No locker for it → a door collection, ONLY when switched on (below).
//   delivery     the shop: /config/shipping collectionAddress (where outgoing parcels leave from) and returnContact (Junid,
//                20 Nov 2026: Yusuf takes every incoming exchange, so The Courier Guy's OTPs and calls go to him; never
//                collectionContact, which stays on outbound parcels only)
//   parcels      the parcel rule over the exchange's lines (the replacement is the same kind of item as the one coming back)
//   service      the cheapest LOCKER rate quoted (L2D* - ECO). No locker rate (too big, unplaceable) → refused: a person
//                books it — unless the door collection below is switched on.
//
// NO LOCKER → A COURIER COLLECTS FROM THE CUSTOMER'S DOOR (Junid, 24 Nov 2026, STANDING RULE: "if no Courier Guy locker is
// near the customer … book DOOR-TO-DOOR delivery to their address automatically instead of failing. Never leave an order
// unbooked because there's no locker", and "Apply it to exchange returns too (e.g. #1934's refused return)"). For a
// return the door-to-door equivalent is a normal Courier Guy shipment collected at the customer's own address and
// delivered to our door: the same /rates and /shipments bodies WITHOUT collection_pickup_point_id, the cheapest door
// service (excludeServiceCodes left out, never an L2D / D2L locker service), under the same ceiling, the same live
// switch and the same one-booking claim. It replaces the refusal only when there is NO LOCKER for the parcel:
//   "none_near"    no fitting locker near, the nearest further than MAX_LOCKER_KM, or (street not on the map) the one
//                  nearest their town further than MAX_TOWN_LOCKER_KM
//   "too_big"      the parcel fits no locker (it must still fit a standard box)
//   "none_priced"  Courier Guy quotes no locker rate for that locker (an answer, not a failed lookup)
// Everything else is refused or retried exactly as before: an address that cannot be placed on the map, a lookup that
// failed, missing details, the return contact not set, a quote over the ceiling. The courier's driver has to reach the
// customer, so a door collection needs their SA mobile number (an email alone is refused).
// THE SWITCH: /config/shipping/returnDoorCollection === true (or the caller's `doorCollection: true`). It is OFF by
// default ON PURPOSE: Jimmy (marathon-dm-agent returnBooking.js DROP_OFF_TEXT, courierTools.js RETURN_DROP_OFF_TEXT,
// boss.js) tells the customer "please drop it at The Courier Guy locker at …" for EVERY booked return. Until he reads
// `mode: "door_collection"` and says "a courier will collect it from your address", booking a door collection would
// make him tell the customer something false. Switch it on in the database once that is live there; no deploy here.
// The record then says so truthfully: returnShipping = { mode: "door_collection", waybill, dropOffRef: null (there is
// no drop-off), no locker, collection { from: "door", address, contactMobile }, doorFallback { reason, kind, at }, … }.
// A locker booking now carries mode: "locker_dropoff".
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
// km }, service, cost, parcel, bookedAt, mode: "locker_dropoff" } (a door collection: see above).
import { estimateParcel } from "../../src/shipping/estimateParcel.js";
import { mergeShippingConfig } from "../../src/shipping/shippingConfig.js";
import { normalizeRates, chooseRate } from "../../src/shipping/chooseService.js";
import { orderLines, deliveryAddress, deliveryContact } from "../../src/shipping/orderShipment.js";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import { tcgParcels, lockerCollection } from "./quote.mjs";
import { readLive, isExchangeKey } from "./bookShipment.mjs";
import { fileLogger } from "./courier-client.mjs";
import { addressGate } from "./addressHold.mjs";

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

/** The last word of a town field that carries more (a number or a street before it), else "". Pure. */
const townWord = (city) => {
  const words = str(city).split(/[\s,]+/).filter(Boolean);
  return words.length > 1 && (/\d/.test(str(city)) || words.length > 2) ? words[words.length - 1] : "";
};

export const MAX_LOCKER_KM = 30;
export const MAX_TOWN_LOCKER_KM = 15;
const tryLabels = (address) => [...new Set([
  [address.street_address, address.local_area, address.city, address.code],
  [address.local_area, address.city, address.code],
  [address.city, address.code],
  // The town with its PROVINCE (#2181, 21 Nov 2026): "Khomanani, 0933" alone matched a Khomanani in Khayelitsha.
  // Every province the order may be in: the one typed AND the postal code's (customers pick the wrong one).
  ...allowedProvinces(address).map((zone) => [address.city, provinceName(zone)]),
  // A street typed into the town field ("27 Blankblaar Rooiberg", #2330): its last word is the town.
  ...(townWord(address.city) ? allowedProvinces(address).map((zone) => [townWord(address.city), provinceName(zone)]) : []),
].map((parts) => [...new Set(parts.map(str).filter(Boolean))].join(", ")).filter(Boolean))];

// TCG zone → the province name OpenStreetMap gives as address.state.
const PROVINCES = {
  KZN: "KwaZulu-Natal", GP: "Gauteng", WC: "Western Cape", EC: "Eastern Cape", FS: "Free State",
  LP: "Limpopo", MP: "Mpumalanga", NW: "North West", NC: "Northern Cape",
};
const squash = (s) => str(s).toLowerCase().replace(/[^a-z]/g, "");
export const provinceName = (zone) => PROVINCES[str(zone).toUpperCase()] ?? "";
/**
 * The province(s) a South African postal code is in — coarse ranges, two where a range straddles a border (2026
 * codes; checked against this account's own shipments; 0480 Bela-Bela is Limpopo and 8160 Vredendal is Western Cape, CodeRabbit on #958). [] for a code not covered. Pure.
 */
const POSTAL_RANGES = [
  [1, 199, ["GP"]], [200, 299, ["NW", "GP"]], [300, 499, ["NW", "LP"]], [500, 999, ["LP"]],
  [1000, 1099, ["MP", "GP"]], [1100, 1399, ["MP"]], [1400, 2199, ["GP"]], [2200, 2499, ["MP"]],
  [2500, 2899, ["NW"]], [2900, 2999, ["KZN", "MP"]], [3000, 4699, ["KZN"]], [4700, 4799, ["KZN", "EC"]],
  [4800, 6499, ["EC"]], [6500, 8099, ["WC"]], [8100, 8999, ["NC", "WC"]], [9000, 9299, ["FS", "NC"]], [9300, 9999, ["FS"]],
];
export function postalProvinces(code) {
  const c = str(code);
  if (!/^\d{4}$/.test(c)) return [];
  const n = Number(c);
  return POSTAL_RANGES.find(([a, b]) => n >= a && n <= b)?.[2] ?? [];
}
/**
 * Every province the order may be in: the one the customer typed AND the one(s) its postal code is in. Pure.
 * 21 Nov 2026: customers pick the wrong province — #2330 Rooiberg 0500 typed Gauteng (Limpopo), #2338 Botshabelo
 * 9781 typed Western Cape (Free State), #2340 Tumahole, Parys 9585 typed Gauteng (Free State). Judging by the typed
 * province alone threw away Shopify's correct point and every OpenStreetMap hit for all three.
 */
export function allowedProvinces(address) {
  const typed = str(address?.zone).toUpperCase();
  return [...new Set([...(PROVINCES[typed] ? [typed] : []), ...postalProvinces(address?.code)])];
}

/**
 * Is a map hit in a province the order may be in (allowedProvinces)? Pure. #2181 (21 Nov 2026): a Limpopo customer
 * in "Khomanani" 0933 was placed in Khayelitsha, Cape Town (a building called Khomanani) — neither the typed province
 * nor the postal code's. An address with no province and no known postal code, or a hit without a state, is not judged.
 */
export function inProvince(hit, address) {
  const allowed = allowedProvinces(address).map((z) => squash(provinceName(z)));
  if (!allowed.length) {
    const raw = squash(address?.zone);
    if (!raw) return true;
    allowed.push(raw);
  }
  const state = squash(hit?.address?.state);
  if (state) return allowed.includes(state);
  const shown = squash(hit?.display_name);
  return !shown || allowed.some((a) => shown.includes(a));
}
/**
 * Is a hit a PLACE (a town, suburb, village — or an area boundary), not a road or a building? Pure. The suburb/town
 * tries stand for the customer's area: #2181's "Khomanani, Limpopo" matched "Khomanani Street" in Nkowankowa, 80 km
 * from the customer. A hit without a class is not judged.
 */
// A residential area counts (OpenStreetMap maps small towns such as Rooiberg, #2330, only as landuse=residential).
export const isPlace = (hit) => !hit?.class || hit.class === "place" || hit.class === "boundary" || (hit.class === "landuse" && hit.type === "residential");
const pickHit = (list, address, { placeOnly = false } = {}) => (Array.isArray(list) ? list : [])
  .find((h) => h && Number.isFinite(Number(h.lat)) && Number.isFinite(Number(h.lon)) && inProvince(h, address) && (!placeOnly || isPlace(h))) ?? null;
export const nominatimHit = pickHit;

/** The customer's address → { lat, lng, from } (OpenStreetMap Nominatim; the full address, then the suburb/town), in its own province. */
export async function geocode(address, { fetchImpl = globalThis.fetch } = {}) {
  if (Number.isFinite(Number(address?.lat)) && Number.isFinite(Number(address?.lng))) return { lat: Number(address.lat), lng: Number(address.lng), from: "address" };
  const labels = tryLabels(address);
  for (const q of labels) {
    try {
      const res = await fetchImpl(`https://nominatim.openstreetmap.org/search?format=json&countrycodes=za&limit=5&addressdetails=1&q=${encodeURIComponent(q)}`, {
        headers: { "User-Agent": "marathon-club-returns/1.0 (gunidmoh@gmail.com)", Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      // The street try takes any hit; the wider tries only a place in the province.
      const hit = res.ok ? pickHit(await res.json(), address, { placeOnly: q !== labels[0] }) : null;
      if (hit) return { lat: Number(hit.lat), lng: Number(hit.lon), from: q };
    } catch { /* the next, wider try */ }
    await new Promise((r) => setTimeout(r, 1100)); // Nominatim's policy: at most one request a second
  }
  return null;
}

const lockerShape = ({ p, d }) => {
  const a = p.address || {};
  return {
    id: p.pickup_point_id, provider: p.pickup_point_provider || "tcg-locker", name: str(p.name),
    address: (str(a.street_address) && str(a.street_address).toLowerCase().includes(str(a.city).toLowerCase()) ? str(a.street_address) : [a.street_address, a.city].map(str).filter(Boolean).join(", ")) || str(a.entered_address),
    hours: str(p.trading_hours), description: str(p.description), km: Number.isFinite(d) ? Math.round(d * 10) / 10 : null,
    // The locker's own point and address: the delivery address of a door-to-locker shipment when Courier Guy
    // cannot place the customer's street (#2181).
    ...(Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) ? { lat: Number(p.lat), lng: Number(p.lng) } : {}),
    ...(a.street_address || a.city ? { tcgAddress: plain({ street_address: str(a.street_address), local_area: str(a.local_area), city: str(a.city), zone: str(a.zone), code: str(a.code) }) } : {}),
  };
};

/**
 * Every Courier Guy locker the parcel fits near `at`, online and listed, nearest first. → [{ id, provider, name, address, hours, description, km }]
 * `maxKm`: Courier Guy's own search radius is ~25 km and answers `pickup_points: null` beyond it (#2181: the nearest
 * lockers were 27–30 km away). With nothing found, the search is asked once more out to maxKm (`max_distance`, km).
 */
export async function nearestLockers(client, at, size, { maxKm = null } = {}) {
  const ask = (extra) => client.getPickupPoints({ lat: at.lat, lng: at.lng, order_closest: "true", type: "locker", ...extra });
  // A reply with no pickup_points list at all is a broken answer, not "no locker here" (CodeRabbit, #984): since
  // 24 Nov 2026 "no locker" books door-to-door, so it throws (the callers' failed-lookup path, tried again later).
  // `pickup_points: null` stays an empty answer: it is what Courier Guy says beyond its own search radius.
  const listOf = (res) => {
    const list = Array.isArray(res) ? res : res?.pickup_points;
    if (list === undefined) throw new Error("the pickup-points reply has no pickup_points list");
    return list || [];
  };
  let list = listOf(await ask({}));
  if (!list.length && Number.isFinite(Number(maxKm)) && Number(maxKm) > 0) list = listOf(await ask({ max_distance: Math.ceil(Number(maxKm)) }));
  return list
    .filter((p) => p?.pickup_point_id && p.type === "locker" && !p.is_hidden && (p.status == null || p.status === "online") && fitsCompartment(p, size))
    .map((p) => ({ p, d: Number.isFinite(Number(p.lat)) ? km(at, { lat: Number(p.lat), lng: Number(p.lng) }) : Infinity }))
    .sort((a, b) => a.d - b.d)
    .map(lockerShape);
}

/** The nearest Courier Guy locker the parcel fits, online and listed. → { id, provider, name, address, hours, description, km } | null */
export async function nearestLocker(client, at, size) {
  return (await nearestLockers(client, at, size))[0] ?? null;
}

/** Was the address placed by its street (true) or only by its suburb/town (false)? */
export const placedByStreet = (address, at) => at?.from === "address" || at?.from === tryLabels(address)[0];

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

const SA_MOBILE = /^(?:\+27|27|0)[6-8]\d{8}$/;

/** Our side of an incoming parcel: /config/shipping returnContact (Yusuf), never collectionContact. Pure. */
export function shopReturnContact(cfg) {
  const c = cfg?.returnContact ?? {};
  return { name: str(c.name), mobile_number: str(c.mobile_number), email: str(c.email) };
}

async function rates(client, body) {
  try { return { rates: normalizeRates(await client.getRates(body)) }; }
  catch (err) { return { error: String(err?.message || err).slice(0, 300), rates: [] }; }
}

export const MODE_LOCKER = "locker_dropoff";
export const MODE_DOOR = "door_collection";
/** The customer's address on one line, as the record and Jimmy's message carry it. Pure. */
export const addressLine = (a) => [a?.street_address, a?.local_area, a?.city, a?.code].map(str).filter((p, i, all) => p && all.indexOf(p) === i).join(", ");

/**
 * Everything up to (not including) the create call. Rates only (they book nothing).
 * → { ok: true, payload, parcel, rate, blockers, locker, mode: "locker_dropoff" }
 *   | { ok: true, payload, parcel, rate, blockers, locker: null, mode: "door_collection", doorFallback: { reason, kind }, collection }
 *   | { ok: false, reason, transient?, noLockerKind?, parcel }
 * doorCollection: true / false forces the no-locker door collection on / off; left out, /config/shipping/returnDoorCollection decides (default off).
 * collection: "locker" (default, everything above) | "door" — THE CUSTOMER'S CHOICE on the exchange page (Junid, 25 Nov
 *   2026: "auto-book the Courier Guy collection (locker or door per customer choice)"): no locker is looked for at all, a
 *   courier collects from their door (mode "door_collection", doorFallback { kind: "customer_choice" }). Every other guard
 *   is the same: the address gate, the return contact, the address placed on the map first, the ceiling (a blocker).
 */
export const COLLECTIONS = Object.freeze(["locker", "door"]);
export const CUSTOMER_CHOICE = Object.freeze({ reason: "customer chose door collection", kind: "customer_choice" });
export async function planReturn(order, { db, client, products = null, email = null, key, geocoder = geocode, doorCollection = null, collection = "locker" }) {
  if (!COLLECTIONS.includes(collection)) throw new Error(`planReturn: collection must be locker or door, not "${collection}"`);
  const raw = (await db.ref("config/shipping").get()).val();
  const cfg = mergeShippingConfig(raw);
  // A return is ALWAYS a locker drop-off, whatever the outgoing drop-box switch says.
  const lockerCfg = { ...cfg, dropBox: { ...cfg.dropBox, enabled: true } };
  const lines = orderLines(order, products ?? (await productsFor(db, order)));
  const parcel = estimateParcel(lines, lockerCfg);
  const { address: from, missing: addrMissing } = deliveryAddress(order);
  const contact = returnContact(order, email);
  const shop = cfg.collectionAddress;
  const shopContact = shopReturnContact(cfg);
  const n = exchangeNumber(order, key);
  const missing = [
    ...addrMissing.map((m) => `customer ${m}`),
    ...(!contact.mobile_number && !contact.email ? ["customer phone or email"] : []),
    ...(!lines.length ? ["the exchange's lines"] : []),
    ...(!n ? ["order number"] : []),
  ];
  if (missing.length) return { ok: false, reason: `missing: ${missing.join(", ")}`, parcel };
  // THE ADDRESS SAFETY GATE (Junid, 24 Nov 2026; addressHold.mjs): the collection address's postal code and
  // suburb/town must describe the same place, or nothing is booked (Jamie's return tool reads the refusal).
  const gate = addressGate(order, cfg);
  if (gate) return { ok: false, reason: gate.reason, addressHold: gate.hold, parcel };
  // The mobile is what The Courier Guy calls and sends the OTP to: an email alone is not enough on a return. A config
  // gap, not the exchange's: transient, so the booking retries once /config/shipping/returnContact is fixed.
  if (!shopContact.name || !SA_MOBILE.test(shopContact.mobile_number.replace(/[\s-]/g, ""))) {
    return { ok: false, transient: true, reason: "the return contact's name and SA mobile are not set (/config/shipping/returnContact)", parcel };
  }
  // NO LOCKER for this parcel (Junid, 24 Nov 2026): a door collection instead when it is switched on, else the refusal as before.
  const doorOn = doorCollection === true || (doorCollection == null && cfg.returnDoorCollection === true);
  const noLocker = (reason, kind) => (doorOn ? planDoorCollection(reason, kind) : { ok: false, reason, noLockerKind: kind, parcel });
  // The address is placed FIRST (architect review, #984): an address that cannot be placed stays refused (retried
  // later), even for a parcel no locker takes, so it never gets a door collection.
  const at = await geocoder(from);
  if (!at) return { ok: false, transient: true, reason: "the customer's address could not be placed on a map (no nearest locker)", parcel };
  // The customer chose a door collection: no locker search, straight to the door plan (it keeps its own checks).
  if (collection === "door") return planDoorCollection(CUSTOMER_CHOICE.reason, CUSTOMER_CHOICE.kind);
  if (!parcel.fits || !parcel.dropBoxEligible) return noLocker("the parcel fits no Courier Guy locker", "too_big");
  let locker;
  try { locker = await nearestLocker(client, at, parcel.lockerSize); }
  catch (err) { return { ok: false, transient: true, reason: `the locker list could not be read (${String(err?.message || err).slice(0, 200)})`, parcel }; }
  if (!locker) return noLocker(`no Courier Guy locker near the customer fits a ${parcel.lockerSize} parcel`, "none_near");
  // "The nearest one" must be near (architect review 5): further than MAX_LOCKER_KM, a person picks it with the customer.
  if (locker.km != null && locker.km > MAX_LOCKER_KM) return noLocker(`the nearest locker (${locker.name}) is ${locker.km} km from the customer's address`, "none_near");
  locker.placedBy = at.from === "address" || at.from === tryLabels(from)[0] ? "street" : "town";
  // Placed only by the town (spec review 4): "nearest" is a guess, so only a close locker is booked.
  if (locker.placedBy === "town" && locker.km != null && locker.km > MAX_TOWN_LOCKER_KM) return noLocker(`their street isn't on the map and the locker nearest their town (${locker.name}) is ${locker.km} km away`, "none_near");
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
    // A retry that FAILED is a failed lookup (tried again later), never "no locker service here" (CodeRabbit, #984:
    // that answer now books a door collection, so a lost lookup must not reach it).
    else if (again.error) quoted = again;
  }
  const exclude = new Set(cfg.excludeServiceCodes ?? []);
  // STRICTLY locker to door (architect review 4): only an L2D service, whatever else TCG quotes.
  const lockers = quoted.rates.filter((r) => !exclude.has(r.code) && (/^L2D/i.test(r.code) || r.group === "L2D"));
  // A lookup that FAILED is tried again later, as before; "none quoted" is Courier Guy's answer: no locker service here.
  if (!lockers.length) return quoted.error ? { ok: false, transient: true, reason: `no locker rate (${quoted.error})`, parcel } : noLocker("no locker rate (none quoted)", "none_priced");
  const rate = lockers.reduce((best, r) => (!best || r.rate < best.rate ? r : best), null);

  const blockers = [];
  const ceiling = Number(cfg.maxChargeRand);
  if (Number.isFinite(ceiling) && ceiling > 0 && rate.rate > ceiling) blockers.push(`quote R${rate.rate.toFixed(2)} is over the R${ceiling} ceiling`);

  const payload = {
    collection_address: used,
    ...lockerCollection(dropBox),
    collection_contact: contact,
    delivery_address: shop,
    delivery_contact: shopContact,
    parcels: tcgParcels(parcel.parcels),
    service_level_code: rate.code,
    customer_reference: `${n}-EX return`,
    customer_reference_name: "Order no.",
    mute_notifications: false,
  };
  return { ok: true, payload, parcel, rate, blockers, locker, mode: MODE_LOCKER };

  // ── The door collection (header: NO LOCKER → A COURIER COLLECTS FROM THE CUSTOMER'S DOOR). Rates only. ──
  async function planDoorCollection(why, kind) {
    const doorFallback = { reason: why, kind };
    const refuse = (reason, extra = {}) => ({ ok: false, reason: `${why}; a door collection was not booked either: ${reason}`, doorFallback, doorTried: true, parcel, ...extra });
    if (!parcel.fits) return refuse("no standard box fits the parcel");
    // The driver phones the customer to collect: an email alone is not enough (a locker drop-off never needed the call).
    if (!SA_MOBILE.test(str(contact.mobile_number).replace(/[\s-]/g, ""))) return refuse("the customer's SA mobile number is missing (the courier's driver calls them to collect)");
    const doorBody = (collection) => ({ collection_address: collection, delivery_address: shop, parcels: tcgParcels(parcel.parcels) });
    let usedDoor = from;
    let q = await rates(client, doorBody(from));
    const townName = str(from.city);
    if (!q.error && !q.rates.length && townName && str(from.local_area) !== townName) {
      const retry = { ...from, local_area: townName };
      const again = await rates(client, doorBody(retry));
      if (again.rates.length) [q, usedDoor] = [again, retry];
      else if (again.error) q = again;
    }
    // A door service only: never a locker service Courier Guy may list beside it (L2D / D2L / L2L).
    const door = q.rates.filter((r) => !/^(?:L2D|D2L|L2L)/i.test(str(r.code)) && r.group !== "L2D");
    const chosen = chooseRate({ door, locker: [] }, parcel, cfg);
    if (!chosen) return refuse(`no door rate (${q.error ?? "none quoted"})`, q.error ? { transient: true } : {});
    const doorRate = chosen.rate;
    // THE SAME CEILING (maxChargeRand) as a locker return and as every outbound booking.
    const doorBlockers = [];
    const max = Number(cfg.maxChargeRand);
    if (Number.isFinite(max) && max > 0 && doorRate.rate > max) doorBlockers.push(`quote R${doorRate.rate.toFixed(2)} is over the R${max} ceiling`);
    const doorPayload = {
      collection_address: usedDoor,
      collection_contact: contact,
      delivery_address: shop,
      delivery_contact: shopContact,
      parcels: tcgParcels(parcel.parcels),
      service_level_code: doorRate.code,
      customer_reference: `${n}-EX return`,
      customer_reference_name: "Order no.",
      mute_notifications: false,
    };
    return {
      ok: true, payload: doorPayload, parcel, rate: doorRate, blockers: doorBlockers, locker: null, mode: MODE_DOOR, doorFallback,
      collection: { from: "door", address: addressLine(usedDoor), contactMobile: str(contact.mobile_number) },
    };
  }
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
 * @param {object} [deps]   { db, client, products, log, now, email, doorCollection, collection } — email: the customer's, for
 *                          The Courier Guy's notice; doorCollection: true / false forces the no-locker door collection
 *                          (planReturn); collection: "locker" (default) | "door" — the customer's own choice (planReturn)
 * → { booked: true, mode, ...returnShipping } | { skipped: true, reason, dryRun?, mode? }. Throws on a create that failed or may have run.
 */
export async function bookReturn(key, deps = {}) {
  const { db, client, products, log, now, email = null, geocoder, doorCollection = null, collection = "locker" } = await defaultDeps(deps);
  if (!COLLECTIONS.includes(collection)) throw new Error(`bookReturn: collection must be locker or door, not "${collection}"`);
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

  const plan = await planReturn(order, { db, client, products, email, key, doorCollection, collection, ...(geocoder ? { geocoder } : {}) });
  if (!plan.ok) {
    log(`bookReturn ${key} REFUSED ${plan.reason}`);
    return {
      skipped: true, refused: !plan.transient, transient: !!plan.transient, reason: plan.reason,
      // No locker for it (and the door collection is off, or was not possible either): said, so a caller can tell this refusal from the others.
      ...(plan.noLockerKind ? { noLocker: true, noLockerKind: plan.noLockerKind } : {}),
      ...(plan.doorTried ? { noLocker: true, doorTried: true, doorFallback: plain(plan.doorFallback) } : {}),
    };
  }
  const door = plan.mode === MODE_DOOR;
  if (!(await readLive(db))) {
    log(`bookReturn ${key} DRY RUN (live is off) would POST /shipments ${JSON.stringify(plan.payload)}` + (plan.blockers.length ? ` — live would refuse: ${plan.blockers.join(", ")}` : ""));
    return {
      skipped: true, dryRun: plan.payload, locker: plan.locker, quote: { code: plan.rate.code, rate: plan.rate.rate }, blockers: plan.blockers, mode: plan.mode,
      ...(door ? { doorFallback: plain(plan.doorFallback), collection: plain(plan.collection) } : {}),
    };
  }
  if (plan.blockers.length) {
    log(`bookReturn ${key} REFUSED ${plan.blockers.join(", ")}${door ? ` (door collection: ${plan.doorFallback.reason})` : ""}`);
    return { skipped: true, refused: true, reason: plan.blockers.join(", "), ...(door ? { noLocker: true, doorTried: true, doorFallback: plain(plan.doorFallback) } : {}) };
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
    // A DOOR COLLECTION HAS NO DROP-OFF: no locker reference is written (whatever custom reference Courier Guy gives the
    // shipment), so nothing downstream can hand the customer a "drop-off code" for a parcel a driver fetches.
    dropOffRef: door ? null : (res.custom_tracking_reference || null),
    service: res.service_level_code ?? plan.rate.code,
    cost: finiteOrNull(res.charged_amount ?? res.rate ?? plan.rate.rate),
    parcel: plain(plan.parcel.parcels?.[0] ?? null),
    locker: plain(plan.locker),
    // How the item comes back: "locker_dropoff" (the customer drops it at `locker`) or "door_collection" (a courier
    // collects it from the customer's address: `collection`, and `doorFallback` says why there was no locker).
    mode: plan.mode,
    ...(door ? { collection: plain(plan.collection), doorFallback: plain({ ...plan.doorFallback, at: now() }) } : {}),
    bookedAt: now(),
  };
  log(`bookReturn ${key} BOOKED ${ship.waybill} ${door ? `DOOR COLLECTION from ${plan.collection.address} (${plan.doorFallback.reason})` : `(${ship.dropOffRef})`} ${ship.service} R${ship.cost}`);
  try {
    await at("returnShipping").update({ ...ship, courierBooking: { state: "booked", at: ship.bookedAt } });
  } catch (err) {
    log(`bookReturn ${key} BOOKED BUT NOT RECORDED ${ship.waybill}: ${err?.message || err}`);
    await claimRef.set({ state: "booked", at: ship.bookedAt, shipmentId: ship.shipmentId, waybill: ship.waybill }).catch(() => {});
  }
  return { booked: true, ...ship };
}

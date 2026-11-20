// ── DOOR-TO-LOCKER: the plan for one order (Junid, 20 Nov 2026) ──────────────
// "Every Courier Guy booking is door-to-locker": collected from our shop door,
// delivered to the Courier Guy locker nearest the customer's address. This is
// planShipment's other half (bookShipment.mjs), used whenever
// /config/shipping/deliveryMode is not "door". Rates and pickup-point lookups
// only: nothing here books, cancels or writes.
//
//   how many      ONE ORDER IS ONE PARCEL ON ONE WAYBILL (Junid, 20 Nov 2026
//                 evening: "one order ships as one parcel, all items
//                 together"). The first version of this file booked one
//                 shipment per pair of shoes: #2256 (2 pairs) cost R260.62 on
//                 two waybills and #2309 (5 pairs) R651.55 on five, where one
//                 parcel to the same locker is R192.72. Only a person splits
//                 an order: shipping/lockerParcels on the order
//                 (rebook-locker.mjs --parcels) is N one-shoe shipments to the
//                 SAME locker (a pickup-point shipment carries one parcel).
//   the parcel    an order of at most one pair of shoes is declared as one
//                 shoe: /config/shipping/locker/parcel, 34 × 23 × 13 cm,
//                 1.5 kg, never estimated from its lines. An order of two or
//                 more pairs is declared as the ONE parcel the parcel rule
//                 packs it in (estimateParcel), so Courier Guy quotes the
//                 locker size it really fits (measured 20 Nov: 2 to 6 pairs →
//                 D2LL - ECO R192.72 flat). Courier Guy measures at collection
//                 and re-rates; reconcile.mjs keeps the difference on the
//                 order (shipping/adjustment). A parcel no locker takes is
//                 refused like "no locker" below: a person books it.
//   the locker    the customer's address placed on the map (placeAddress:
//                 OpenStreetMap, the street first; a street it does not know —
//                 most of ours — is placed by its POSTAL CODE, which in a city
//                 is far nearer the customer than the town's centre; failing
//                 that the suburb/town), then
//                 GET /pickup-points nearest first: online, listed, with a
//                 compartment the parcel fits. The nearest that PRICES wins
//                 (locker.tryLockers are tried). shipping/lockerChoice/id on
//                 the order names one instead (rebook-locker.mjs --locker).
//   the service   the cheapest service TCG quotes for that locker (D2LM - ECO
//                 for a shoe), excludeServiceCodes left out.
//   the request   the normal /rates and /shipments body, the customer's address
//                 kept as delivery_address, plus delivery_pickup_point_id and
//                 delivery_pickup_point_provider (booked by hand for #2257 on
//                 20 Nov 2026: D2LM - ECO R130.31 against ECOR R519.62 to the door).
//
// NO LOCKER, NO BOOKING. An address that cannot be placed on the map, or no
// fitting locker within locker.maxKm of it (locker.maxTownKm when only the
// town was placed), is NOT quietly sent door-to-door: the plan is refused with
// `attention` set, the order shows "Packed, courier not booked" with the
// reason, and Junid gets the one line (junidLine), as for a booking over the
// ceiling.
//
// NO COLLECTION CODE EXISTS AT BOOKING. Courier Guy SMSes the PIN to the
// customer's phone when the parcel lands in the locker; the create response
// carries none (checked on #2257). The locker record says so; nothing here
// invents one.
import { chooseLocker } from "../../src/shipping/estimateParcel.js";
import { normalizeRates, chooseRate } from "../../src/shipping/chooseService.js";
import { quoteParcel, tcgParcel } from "./quote.mjs";
import { geocode, nearestLockers, placedByStreet } from "./bookReturn.mjs";

export const NO_CODE_NOTE = "No collection code exists at booking: Courier Guy SMSes the PIN to the customer's phone when the parcel lands in the locker.";
export const D2L_MODE = "door_to_locker";

const str = (v) => String(v ?? "").trim();
const pos = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
const finiteOrNull = (n) => (Number.isFinite(Number(n)) ? Number(n) : null);

/**
 * The customer's address → { lat, lng, from, by: "street" | "postcode" | "town" } | null.
 * bookReturn's geocode finds the street, or falls back to the suburb/town. Most
 * of our streets are not on OpenStreetMap, and "the centre of Soweto" is a poor
 * stand-in for a customer's home: the postal code's own point is asked for
 * first when the street is unknown (1804 lands 5 km from Soweto's centre).
 */
export async function placeAddress(address, { fetchImpl = globalThis.fetch, base = geocode, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const at = await base(address, { fetchImpl });
  if (at && placedByStreet(address, at)) return { ...at, by: "street" };
  const code = str(address?.code);
  if (/^\d{4}$/.test(code)) {
    try {
      await wait(1100); // Nominatim's policy: at most one request a second
      const res = await fetchImpl(`https://nominatim.openstreetmap.org/search?format=json&countrycodes=za&limit=1&postalcode=${code}`, {
        headers: { "User-Agent": "marathon-club-shipping/1.0", Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      const hit = res.ok ? (await res.json())?.[0] : null;
      if (hit && Number.isFinite(Number(hit.lat)) && Number.isFinite(Number(hit.lon))) return { lat: Number(hit.lat), lng: Number(hit.lon), from: `postal code ${code}`, by: "postcode" };
    } catch { /* the town's point, below */ }
  }
  return at ? { ...at, by: "town" } : null;
}

/** The one parcel every booking declares. Pure. */
export function oneShoe(cfg) {
  const p = cfg?.locker?.parcel ?? {};
  return { kind: "oneShoe", lengthCm: pos(p.lengthCm, 34), widthCm: pos(p.widthCm, 23), heightCm: pos(p.heightCm, 13), actualKg: pos(p.kg, 1.5) };
}

/**
 * How many shipments the order is booked as. Pure. ALWAYS ONE (Junid, 20 Nov 2026: "one order ships as one parcel"),
 * unless a person set shipping/lockerParcels on the order (rebook-locker.mjs --parcels). Never derived from the lines.
 */
export function lockerParcelCount(order) {
  const set = Number(order?.shipping?.lockerParcels);
  return Number.isInteger(set) && set >= 1 ? set : 1;
}

/** The pairs of shoes in the order (the parcel rule's count). Pure. */
export const pairsIn = (estimate) => (estimate?.parcels ?? []).reduce((t, p) => t + (Number(p?.pairs) || 0), 0);

/**
 * The parcel each shipment declares. Pure. One shoe, except a single-parcel order of two or more pairs: that is the
 * whole order in the one parcel the parcel rule packs (a one-shoe declaration would book a locker it cannot fit in).
 */
export function declaredParcel(cfg, estimate, count = 1) {
  const whole = estimate?.parcels?.length === 1 ? estimate.parcels[0] : null;
  const dims = whole ? [whole.lengthCm, whole.widthCm, whole.heightCm, whole.actualKg].map(Number) : [];
  if (count === 1 && pairsIn(estimate) > 1 && dims.length === 4 && dims.every((n) => Number.isFinite(n) && n > 0)) {
    return { kind: "wholeOrder", lengthCm: dims[0], widthCm: dims[1], heightCm: dims[2], actualKg: dims[3] };
  }
  return oneShoe(cfg);
}

const townOf = (address) => str(address?.city) || str(address?.local_area) || "the customer's address";

async function rates(client, body) {
  try { return { rates: normalizeRates(await client.getRates(body)) }; }
  catch (err) { return { error: str(err?.message || err).slice(0, 300), rates: [] }; }
}

/**
 * Everything up to (not including) the shipment calls.
 * → { ok: true, payload, payloads, parcel, chosen, quoted, ref, liveBlockers, overCeiling: null, quotes, locker, doorQuote }
 *   | { ok: false, reason, attention?, junidLine?, transient?, parcel }
 */
export async function planLockerDelivery({ order, key = "<orderKey>", cfg, client, estimate, address, contact, ref, liveBlockers, geocoder = placeAddress }) {
  const lk = cfg.locker ?? {};
  const count = lockerParcelCount(order);
  // `shoe` is the parcel EVERY shipment of this order declares (one shoe, or the whole order in one parcel).
  const shoe = declaredParcel(cfg, estimate, count);
  const parcel = {
    declaredAs: shoe.kind === "wholeOrder" ? "whole_order" : "one_shoe",
    parcels: Array.from({ length: count }, () => ({ ...shoe })),
    parcelCount: count,
    actualKg: shoe.actualKg * count,
    // What the old rule would have declared, kept beside it for the comparison only.
    estimated: (estimate?.parcels ?? []).map((p) => ({ kind: p.kind ?? null, lengthCm: finiteOrNull(p.lengthCm), widthCm: finiteOrNull(p.widthCm), heightCm: finiteOrNull(p.heightCm), actualKg: finiteOrNull(p.actualKg), pairs: Number(p.pairs) || 0 })),
  };
  const town = townOf(address);
  const refuse = (reason, extra = {}) => ({
    ok: false, reason, attention: true, parcel,
    // The order is not booked yet, so rebook-locker.mjs (which moves a BOOKED order) is not the way: a locker is named on the order itself.
    junidLine: `${ref}: ${reason}. Not booked (door-to-locker only). Book it in the portal, or name a locker on the order (online_orders/${key}/shipping/lockerChoice/id) and press Retry on the POS.`,
    ...extra,
  });

  const maxParcels = pos(lk.maxParcels, 10);
  if (count > maxParcels) return refuse(`the order needs ${count} locker parcels, more than the ${maxParcels} booked automatically`);

  // The door-to-door price of the parcel the OLD rule would have declared — asked beside the map lookup (rates book nothing).
  const doorAsk = lk.doorQuote !== false && estimate?.parcels?.length
    ? quoteParcel(client, { collectionAddress: cfg.collectionAddress, deliveryAddress: address, parcels: estimate.parcels, dropBox: null })
        .then((q) => chooseRate({ door: q.door.rates, locker: [] }, estimate, cfg), () => null)
    : Promise.resolve(null);
  doorAsk.catch(() => {});

  const at = await geocoder(address);
  // No line to Junid for this one: the map service being down looks the same, and the order's own attention says it.
  if (!at) return refuse(`no Courier Guy locker could be chosen for ${town}: the address could not be placed on the map`, { transient: true, junidLine: null });
  const size = chooseLocker([shoe.lengthCm, shoe.widthCm, shoe.heightCm], shoe.actualKg, { ...(cfg.dropBox ?? {}), enabled: true })?.size ?? (shoe.kind === "wholeOrder" ? "L" : "M");
  let lockers;
  try { lockers = await nearestLockers(client, at, size); }
  catch (err) { return { ok: false, transient: true, parcel, reason: `the locker list could not be read (${str(err?.message || err).slice(0, 200)})` }; }

  const placedBy = at.by ?? (placedByStreet(address, at) ? "street" : "town");
  const byStreet = placedBy === "street";
  const limit = byStreet ? pos(lk.maxKm, 30) : pos(lk.maxTownKm, 20);
  const chosenId = str(order?.shipping?.lockerChoice?.id);
  let candidates;
  if (chosenId) {
    // A person named the locker: the distance rule is theirs to break, but it must be a real, online locker near the address.
    candidates = lockers.filter((l) => l.id === chosenId);
    if (!candidates.length) return refuse(`locker ${chosenId} is not among the online Courier Guy lockers near ${town}`);
  } else {
    // shipping/lockerAvoid: lockers a person ruled out (rebook-locker.mjs with no --locker: "another one").
    const avoid = new Set((Array.isArray(order?.shipping?.lockerAvoid) ? order.shipping.lockerAvoid : []).map(str));
    candidates = lockers.filter((l) => l.km != null && l.km <= limit && !avoid.has(l.id)).slice(0, pos(lk.tryLockers, 3));
    if (!candidates.length) {
      const nearest = lockers[0];
      return refuse(`no Courier Guy locker within ${limit} km of ${town}` +
        (nearest ? ` (the nearest, ${nearest.name}, is ${nearest.km ?? "?"} km away)` : "") +
        (byStreet ? "" : `; only the ${placedBy === "postcode" ? "postal code" : "town"} could be placed on the map`));
    }
  }

  const exclude = new Set(cfg.excludeServiceCodes ?? []);
  const body = (locker, deliveryAddress) => ({
    collection_address: cfg.collectionAddress,
    delivery_address: deliveryAddress,
    delivery_pickup_point_id: locker.id,
    delivery_pickup_point_provider: locker.provider,
    parcels: [tcgParcel(shoe)],
  });
  let found = null;
  let lastError = null;
  for (const locker of candidates) {
    let used = address;
    let q = await rates(client, body(locker, address));
    // TCG answers rates: null when it can't place the suburb (#1862): once more with the town as the suburb.
    const city = str(address.city);
    if (!q.error && !q.rates.length && city && str(address.local_area) !== city) {
      const retry = { ...address, local_area: city };
      const again = await rates(client, body(locker, retry));
      if (again.rates.length) [q, used] = [again, retry];
      // A retry that FAILED is a failed lookup (try again later), not "Courier Guy quotes nothing here".
      else if (again.error) q = again;
    }
    const usable = q.rates.filter((r) => !exclude.has(r.code));
    if (usable.length) { found = { locker, rates: usable, used }; break; }
    lastError = q.error ?? lastError;
  }
  if (!found) {
    const tried = candidates.map((l) => l.name).join(", ");
    if (lastError) return { ok: false, transient: true, parcel, reason: `no door-to-locker rate (${lastError})` };
    return refuse(`Courier Guy quoted no door-to-locker service to the locker${candidates.length > 1 ? "s" : ""} near ${town} (${tried})`);
  }

  const rate = found.rates.reduce((best, r) => (!best || r.rate < best.rate ? r : best), null);
  const door = await doorAsk;
  const doorQuote = door?.rate ? { code: door.rate.code, rate: finiteOrNull(door.rate.rate) } : null;

  // THE SPEND CEILING, per shipment (one per order; a person's split is several at the same rate).
  const blockers = [...liveBlockers];
  // The locker PIN goes by SMS: without a mobile number the customer could never open it (#1671).
  if (!str(contact?.mobile_number)) blockers.push("no customer mobile number (the locker PIN is sent by SMS)");
  const ceiling = Number(cfg.maxChargeRand);
  let overCeiling = null;
  if (Number.isFinite(ceiling) && ceiling > 0 && rate.rate > ceiling) {
    blockers.push(`quote R${rate.rate.toFixed(2)} is over the R${ceiling} ceiling`);
    overCeiling = { ceiling, chosen: { mode: D2L_MODE, code: rate.code, rate: rate.rate }, cheaper: null };
  }

  const collectionContact = cfg.collectionContact ?? {};
  const locker = {
    ...found.locker,
    placedBy,
    ...(chosenId ? { chosenBy: str(order?.shipping?.lockerChoice?.by) || "hand" } : {}),
    // The PIN goes by SMS to this number when the parcel lands (a wrong number means no PIN: #1671).
    smsTo: str(contact?.mobile_number) || null,
    // false, not null: the database drops nulls, and the FACT must be on the record (Jamie reads it).
    hasCollectionCode: false,
    collectionCodeNote: NO_CODE_NOTE,
  };
  const payloads = Array.from({ length: count }, (_, i) => ({
    collection_address: cfg.collectionAddress,
    collection_contact: { name: collectionContact.name ?? "", mobile_number: collectionContact.mobile_number ?? "", email: collectionContact.email ?? "" },
    // The customer's own address stays on the shipment; the pickup point is where it is delivered.
    delivery_address: found.used,
    delivery_pickup_point_id: found.locker.id,
    delivery_pickup_point_provider: found.locker.provider,
    delivery_contact: contact,
    // ONE parcel per shipment (a pickup-point shipment carries one), and one shipment per order unless a person split it.
    parcels: [tcgParcel(shoe)],
    service_level_code: rate.code,
    customer_reference: count > 1 ? `${ref} (${i + 1}/${count})` : ref,
    customer_reference_name: "Order no.",
    mute_notifications: false,
  }));
  const quotes = [
    ...found.rates.map((r) => ({ mode: D2L_MODE, code: r.code, name: r.name ?? "", rate: finiteOrNull(r.rate), chargedKg: finiteOrNull(r.chargedKg) })),
    ...(doorQuote ? [{ mode: "door", code: doorQuote.code, name: "", rate: doorQuote.rate, chargedKg: null }] : []),
  ].filter((r) => r.rate !== null).sort((a, b) => a.rate - b.rate);

  return {
    ok: true, payload: payloads[0], payloads, parcel, chosen: { mode: D2L_MODE, rate },
    quoted: { door: { rates: [] }, locker: { rates: found.rates }, deliveryAddress: found.used },
    ref, liveBlockers: blockers, overCeiling, quotes, locker, doorQuote,
  };
}

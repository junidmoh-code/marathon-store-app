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
//   the parcel    the smallest Courier Guy locker box the parcel really
//                 fits (Junid, 21 Nov 2026, replacing "every parcel is one
//                 shoe"): lockerSizeFor, from what Courier Guy measured 406
//                 of our parcels at. 1 pair → M (declared as one shoe); 1 pair
//                 with goods on top, or 2+ pairs → L (the order's own parcel);
//                 no footwear → M; heavier than the box → one up. The service
//                 booked is the cheapest for a box at least that size, so the
//                 price is right at booking. Past the L box: refused like "no
//                 locker", a person books it.
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
// NO LOCKER → DOOR-TO-DOOR (Junid, 24 Nov 2026, STANDING RULE: "if no Courier
// Guy locker is near the customer (like #2411 Alistair, Jansenville: 'no locker
// within 30 km'), book DOOR-TO-DOOR delivery to their address automatically
// instead of failing. Never leave an order unbooked because there's no
// locker."). This REVERSES the 20 Nov rule ("no locker, no booking"). This
// file still only says WHY there is no locker: the refusal carries
// `noLockerKind`, and planShipment (bookShipment.mjs doorFallbackFor) books the
// door-to-door plan instead for
//   "none_near"    no fitting locker within locker.maxKm of the address
//                  (locker.maxTownKm when only the postal code / town was placed)
//   "too_big"      the parcel is bigger or heavier than the largest locker box
//   "none_priced"  Courier Guy quotes no door-to-locker service to any of the
//                  near lockers (an answer, not a failed lookup)
// Every other refusal carries no kind and is refused exactly as before, with
// `attention` set and the one line for Junid: an address that cannot be placed
// on the map (the map service being down looks the same), a locker a PERSON
// named that is not there, more parcels than locker.maxParcels, a lookup that
// failed (transient). /config/shipping/locker/doorFallback false switches the
// fallback off (the old refusal, no deploy).
//
// NO COLLECTION CODE EXISTS AT BOOKING. Courier Guy SMSes the PIN to the
// customer's phone when the parcel lands in the locker; the create response
// carries none (checked on #2257). The locker record says so; nothing here
// invents one.
import { normalizeRates, chooseRate } from "../../src/shipping/chooseService.js";
import { DEFAULT_SHIPPING_CONFIG } from "../../src/shipping/shippingConfig.js";
import { quoteParcel, tcgParcel } from "./quote.mjs";
import { addressSig, tcgZone } from "../../src/shipping/orderShipment.js";
import { geocode, nearestLockers, placedByStreet, nominatimHit, inProvince, allowedProvinces } from "./bookReturn.mjs";

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
export async function placeAddress(address, { fetchImpl = globalThis.fetch, base = geocode, wait = (ms) => new Promise((r) => setTimeout(r, ms)), geo = null } = {}) {
  // Shopify's own point for this very address (shipping/geo, written at ingest): Shopify places rural addresses
  // OpenStreetMap does not know (#2181: "291 Madobi villge, Khomanani 0933" — OSM had only a Khomanani in Cape Town).
  // Checked against the order's province like an OpenStreetMap hit: a point Shopify put in another province is not used.
  if (geo && Number.isFinite(Number(geo.lat)) && Number.isFinite(Number(geo.lng)) && (await pointInProvince(geo, address, { fetchImpl })) !== false) {
    return { lat: Number(geo.lat), lng: Number(geo.lng), from: "Shopify", by: "shopify" };
  }
  const at = await base(address, { fetchImpl });
  if (at && placedByStreet(address, at)) return { ...at, by: "street" };
  const code = str(address?.code);
  if (/^\d{4}$/.test(code)) {
    try {
      await wait(1100); // Nominatim's policy: at most one request a second
      const res = await fetchImpl(`https://nominatim.openstreetmap.org/search?format=json&countrycodes=za&limit=5&addressdetails=1&postalcode=${code}`, {
        headers: { "User-Agent": "marathon-club-shipping/1.0", Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      // Only a point in the order's own province (bookReturn inProvince).
      const hit = res.ok ? nominatimHit(await res.json(), address) : null;
      if (hit) return { lat: Number(hit.lat), lng: Number(hit.lon), from: `postal code ${code}`, by: "postcode" };
    } catch { /* the town's point, below */ }
  }
  return at ? { ...at, by: "town" } : null;
}

/** Shopify's point for the order's CURRENT address (shipping/geo), or null. Pure. */
export function shopifyGeo(order) {
  const g = order?.shipping?.geo;
  if (!g || !Number.isFinite(Number(g.lat)) || !Number.isFinite(Number(g.lng))) return null;
  return g.sig === addressSig(order?.shipping?.address) ? { lat: Number(g.lat), lng: Number(g.lng) } : null;
}

/**
 * The same shipment, delivered to the locker's OWN address and point instead of the customer's street (#2181,
 * 21 Nov 2026: Courier Guy refused the create with "cannot find a latitude/longitude for the address" for a rural
 * street it had just quoted). The parcel goes to the locker either way (Courier Guy files a locker shipment under
 * the locker's address); the customer stays the delivery contact, so the PIN SMS is unchanged. null when the
 * locker record carries no address. Pure.
 */
export function lockerAddressPayload(payload, locker) {
  const a = locker?.tcgAddress ?? {};
  const street = str(a.street_address) || str(locker?.address);
  const city = str(a.city) || str(payload?.delivery_address?.city);
  if (!payload || !street || !city) return null;
  const hasPoint = Number.isFinite(Number(locker?.lat)) && Number.isFinite(Number(locker?.lng));
  return {
    ...payload,
    delivery_address: {
      type: "business", company: str(locker?.name), street_address: street, local_area: str(a.local_area) || city, city,
      zone: tcgZone(str(a.zone)) || str(payload?.delivery_address?.zone), country: "ZA", code: str(a.code) || str(payload?.delivery_address?.code),
      ...(hasPoint ? { lat: Number(locker.lat), lng: Number(locker.lng) } : {}),
    },
  };
}

/**
 * Is a map point in the address's province? → true | false | null (could not tell: no province on the address, or the
 * reverse lookup failed — the point is then used, as it was validated by Shopify). OpenStreetMap reverse, province level.
 */
export async function pointInProvince(at, address, { fetchImpl = globalThis.fetch } = {}) {
  if (!str(address?.zone) && !allowedProvinces(address).length) return null;
  try {
    const res = await fetchImpl(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=5&addressdetails=1&lat=${Number(at.lat)}&lon=${Number(at.lng)}`, {
      headers: { "User-Agent": "marathon-club-shipping/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const hit = await res.json();
    if (!hit?.address?.state && !hit?.display_name) return null;
    return inProvince(hit, address);
  } catch { return null; }
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

// ── THE LOCKER BOX SIZE (Junid, 21 Nov 2026: "stop declaring every parcel as one shoe; book the smallest real Courier
// Guy locker box each parcel fits, so the price is right up front with no adjustment later") ─────────────────────────
// Courier Guy's door-to-locker price is flat per box: XS R86.51, S R97.46, M R130.31, L R192.72 (quoted 21 Nov 2026,
// the same to every locker). Its hub measures the parcel and re-rates it to the box it really needs, so the box is
// chosen from what Courier Guy MEASURED our parcels at (406 door parcels it dimensioned, Sep–Nov 2026), not from the
// estimate's centimetres:
//   one pair, nothing on top      → M   (198 of 205 measured M; 6 L, 1 S)
//   one pair with goods on top    → L   (every one measured L: #1773, #1822, #1876 …; #2257 booked M, re-rated L)
//   two or more pairs             → L   (74 two-pair parcels: 60 L, 13 M, 1 bigger; every 3–6 pairs L)
//   no footwear (clothes, caps, bags) → M (S only half the time: 41 of 82 the estimate called S measured 8–14 cm high,
//                                   too tall for the 8 cm S box, so S would be re-rated about every second order)
// A parcel heavier than the box takes (M 10 kg, L 15 kg) goes one box up; past L, or bigger than L, no locker takes it
// and a person books it (refused like "no locker").
export const LOCKER_SIZES = ["XS", "S", "M", "L"];
const BOX_RANK = Object.fromEntries(LOCKER_SIZES.map((s, i) => [s, i]));

/** The locker box (from dropBox.lockers: TCG's own compartment sizes and weight limits) of a size, or null. Pure. */
export function lockerBox(cfg, size) {
  const list = cfg?.dropBox?.lockers?.length ? cfg.dropBox.lockers : DEFAULT_SHIPPING_CONFIG.dropBox.lockers;
  return list.find((l) => l.size === size) ?? null;
}

const fitsBox = (dims, kg, box) => {
  if (!box) return false;
  const a = [...dims].map(Number).sort((x, y) => y - x), b = [box.lengthCm, box.widthCm, box.heightCm].map(Number).sort((x, y) => y - x);
  return a.every((n, i) => Number.isFinite(n) && n <= b[i]) && Number(kg) <= Number(box.maxKg);
};

/**
 * The box this order's ONE parcel is booked as: "M" | "L" | null (no locker takes it). Pure.
 * estimate: estimateParcel(lines) (null when the lines could not be read → M, the one-shoe box).
 */
export function lockerSizeFor(cfg, estimate) {
  const p = estimate?.parcels?.length === 1 ? estimate.parcels[0] : null;
  if (!p) return "M";
  const pairs = Number(p.pairs) || 0;
  const kg = Number(p.actualKg) || 0;
  const onTop = (Number(p.overflowBundles) || 0) > 0;
  let size = pairs >= 2 || (pairs === 1 && onTop) ? "L" : "M";
  if (size === "M" && !(kg <= Number(lockerBox(cfg, "M")?.maxKg ?? 10))) size = "L";
  if (size === "L") {
    const box = lockerBox(cfg, "L");
    // The whole order must fit the L box: its weight always, its size when it is a stack of shoeboxes (clothes squash).
    if (!(kg <= Number(box?.maxKg ?? 15))) return null;
    if (pairs >= 1 && box && !fitsBox([p.lengthCm, p.widthCm, p.heightCm], kg, box)) return null;
  }
  return size;
}

/**
 * The parcel each shipment declares. Pure.
 *   M: one shoe (cfg.locker.parcel, 34 × 23 × 13 cm), at the order's own weight when it is heavier than 1.5 kg;
 *   L: the order's own parcel when it fits the L box, else a two-shoebox parcel (34 × 23 × 26) at the order's weight;
 *   a person's split (count > 1): one shoe each, as before.
 * → { kind: "oneShoe" | "wholeOrder", size, lengthCm, widthCm, heightCm, actualKg } | { kind: "tooBig", size: null, … }
 */
export function declaredParcel(cfg, estimate, count = 1) {
  const shoe = oneShoe(cfg);
  if (count > 1) return { ...shoe, size: "M" };
  const p = estimate?.parcels?.length === 1 ? estimate.parcels[0] : null;
  const kg = Number(p?.actualKg) > shoe.actualKg ? Number(p.actualKg) : shoe.actualKg;
  let size = lockerSizeFor(cfg, estimate);
  // The declaration itself must fit its box too (a /config/shipping one-shoe override can be heavier or taller than M).
  if (size === "M" && !fitsBox([shoe.lengthCm, shoe.widthCm, shoe.heightCm], kg, lockerBox(cfg, "M"))) size = "L";
  if (size === "L" && !(kg <= Number(lockerBox(cfg, "L")?.maxKg ?? 15))) size = null;
  const dims = p ? [p.lengthCm, p.widthCm, p.heightCm].map(Number) : [];
  const own = dims.length === 3 && dims.every((n) => Number.isFinite(n) && n > 0);
  if (size === "M") return { ...shoe, actualKg: kg, size };
  if (size === "L") {
    return own && fitsBox(dims, kg, lockerBox(cfg, "L"))
      ? { kind: "wholeOrder", size, lengthCm: dims[0], widthCm: dims[1], heightCm: dims[2], actualKg: kg }
      : { kind: "wholeOrder", size, lengthCm: Math.min(shoe.lengthCm, 60), widthCm: Math.min(shoe.widthCm, 41), heightCm: Math.min(shoe.heightCm * 2, 41), actualKg: kg };
  }
  return { kind: "tooBig", size: null, ...(own ? { lengthCm: dims[0], widthCm: dims[1], heightCm: dims[2] } : { lengthCm: shoe.lengthCm, widthCm: shoe.widthCm, heightCm: shoe.heightCm }), actualKg: Number(p?.actualKg) || kg };
}

/** The size letter of a door-to-locker service code ("D2LM - ECO" → "M"), or null. Pure. */
export const serviceSize = (code) => {
  const m = String(code ?? "").match(/^D2L(XS|S|M|L)\b/i);
  return m ? m[1].toUpperCase() : null;
};

/**
 * The service booked: the cheapest quoted for a box AT LEAST the size chosen (Courier Guy quotes every box the declared
 * parcel fits; a smaller box than ours would only be re-rated up at the hub). Codes with no size letter stay in. Pure.
 */
export function chooseLockerRate(rates, size) {
  const min = BOX_RANK[size] ?? 0;
  const ok = (rates ?? []).filter((r) => { const s = serviceSize(r.code); return s == null || BOX_RANK[s] >= min; });
  return ok.reduce((best, r) => (!best || r.rate < best.rate ? r : best), null);
}

const townOf = (address) => str(address?.city) || str(address?.local_area) || "the customer's address";

async function rates(client, body) {
  try { return { rates: normalizeRates(await client.getRates(body)) }; }
  catch (err) { return { error: str(err?.message || err).slice(0, 300), rates: [] }; }
}

/**
 * Everything up to (not including) the shipment calls.
 * → { ok: true, payload, payloads, parcel, chosen, quoted, ref, liveBlockers, overCeiling: null, quotes, locker, doorQuote }
 *   | { ok: false, reason, attention?, junidLine?, transient?, parcel, noLockerKind?: "none_near" | "too_big" | "none_priced", withinKm? }
 *     (noLockerKind: there is no locker for this parcel — planShipment books door-to-door instead, Junid 24 Nov 2026)
 */
export async function planLockerDelivery({ order, key = "<orderKey>", cfg, client, estimate, address, contact, ref, liveBlockers, geocoder = placeAddress }) {
  const lk = cfg.locker ?? {};
  const count = lockerParcelCount(order);
  // `shoe` is the parcel EVERY shipment of this order declares (one shoe, or the whole order in one parcel).
  const shoe = declaredParcel(cfg, estimate, count);
  const parcel = {
    declaredAs: shoe.kind === "wholeOrder" ? "whole_order" : shoe.kind === "tooBig" ? "too_big" : "one_shoe",
    // The Courier Guy locker box it is booked as (lockerSizeFor), null when no locker takes it.
    lockerSize: shoe.size ?? null,
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

  if (!shoe.size) return refuse(`the parcel is bigger or heavier than the largest Courier Guy locker box (L: 60 × 41 × 41 cm, 15 kg)`, { noLockerKind: "too_big" });
  const maxParcels = pos(lk.maxParcels, 10);
  if (count > maxParcels) return refuse(`the order needs ${count} locker parcels, more than the ${maxParcels} booked automatically`);

  // The door-to-door price of the parcel the OLD rule would have declared — asked beside the map lookup (rates book nothing).
  const doorAsk = lk.doorQuote !== false && estimate?.parcels?.length
    ? quoteParcel(client, { collectionAddress: cfg.collectionAddress, deliveryAddress: address, parcels: estimate.parcels, dropBox: null })
        .then((q) => chooseRate({ door: q.door.rates, locker: [] }, estimate, cfg), () => null)
    : Promise.resolve(null);
  doorAsk.catch(() => {});

  // Shopify's point for this address, when there is one, goes to the geocoder first (placeAddress checks its province).
  const geo = shopifyGeo(order);
  const at = await geocoder(address, ...(geo ? [{ geo }] : []));
  // No line to Junid for this one: the map service being down looks the same, and the order's own attention says it.
  if (!at) return refuse(`no Courier Guy locker could be chosen for ${town}: the address could not be placed on the map`, { transient: true, junidLine: null });
  const size = shoe.size;
  const placedBy = at.by ?? (placedByStreet(address, at) ? "street" : "town");
  // Shopify's point is the customer's own address: as precise as a street.
  const byStreet = placedBy === "street" || placedBy === "shopify";
  const limit = byStreet ? pos(lk.maxKm, 30) : pos(lk.maxTownKm, 20);
  const chosenId = str(order?.shipping?.lockerChoice?.id);
  let lockers;
  // A locker a person named may be a little beyond the automatic limit: searched out to 50 km.
  try { lockers = await nearestLockers(client, at, size, { maxKm: chosenId ? Math.max(limit, 50) : limit }); }
  catch (err) { return { ok: false, transient: true, parcel, reason: `the locker list could not be read (${str(err?.message || err).slice(0, 200)})` }; }
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
        (byStreet ? "" : `; only the ${placedBy === "postcode" ? "postal code" : "town"} could be placed on the map`), { noLockerKind: "none_near", withinKm: limit });
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
    const usable = q.rates.filter((r) => !exclude.has(r.code) && (serviceSize(r.code) == null || BOX_RANK[serviceSize(r.code)] >= BOX_RANK[size]));
    if (usable.length) { found = { locker, rates: usable, used }; break; }
    lastError = q.error ?? lastError;
  }
  if (!found) {
    const tried = candidates.map((l) => l.name).join(", ");
    if (lastError) return { ok: false, transient: true, parcel, reason: `no door-to-locker rate (${lastError})` };
    // A locker a person named is theirs to fix: no kind, so never a door-to-door instead.
    return refuse(`Courier Guy quoted no door-to-locker service to the locker${candidates.length > 1 ? "s" : ""} near ${town} (${tried})`, chosenId ? {} : { noLockerKind: "none_priced" });
  }

  const rate = chooseLockerRate(found.rates, size);
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

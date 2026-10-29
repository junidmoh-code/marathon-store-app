// ── Quote one parcel both ways: door collection and locker drop-off ──────────
// Two POST /rates calls. Rates book nothing and charge nothing, so this runs
// whatever /config/shipping/live says. Used by the quote runner (the Shipping
// card's live quotes) and by bookShipment.
import { normalizeRates } from "../../src/shipping/chooseService.js";

export function tcgParcel(parcel, description = "Retail") {
  return {
    parcel_description: description,
    submitted_length_cm: Number(parcel.lengthCm),
    submitted_width_cm: Number(parcel.widthCm),
    submitted_height_cm: Number(parcel.heightCm),
    submitted_weight_kg: Number(parcel.actualKg),
  };
}

export function lockerCollection(dropBox) {
  return {
    collection_pickup_point_id: dropBox.pickupPointId,
    collection_pickup_point_provider: dropBox.pickupPointProvider,
  };
}

/** A shipment's parcels (estimateParcel(...).parcels, or one parcel) → TCG parcels. */
export function tcgParcels(parcelsOrOne) {
  const list = Array.isArray(parcelsOrOne) ? parcelsOrOne : [parcelsOrOne];
  return list.filter(Boolean).map((p) => tcgParcel(p));
}

/**
 * Quote a shipment (one or more parcels) door-to-door, and — only when it is a
 * single parcel and a drop box is given — from a locker too.
 * @returns {{door: {rates}|{error}, locker: {rates}|{error}}} rates normalised
 */
export async function quoteParcel(client, { collectionAddress, deliveryAddress, parcel, parcels, dropBox }) {
  const list = tcgParcels(parcels ?? parcel);
  const base = { collection_address: collectionAddress, delivery_address: deliveryAddress, parcels: list };
  const one = async (body) => {
    try { return { rates: normalizeRates(await client.getRates(body)) }; }
    catch (err) { return { error: String(err?.message || err).slice(0, 300), rates: [] }; }
  };
  const both = (b) => Promise.all([
    one(b),
    // Pickup-point shipments carry one parcel (TCG doc), so a locker is only asked for one.
    dropBox?.pickupPointId && list.length === 1 ? one({ ...b, ...lockerCollection(dropBox) }) : Promise.resolve({ rates: [] }),
  ]);
  let [door, locker] = await both(base);
  // TCG answers 200 with rates: null when it can't place the suburb (order
  // #1862: "Department of Transport" typed as the suburb of Mount Ayliff).
  // Ask once more with the town as the suburb; the street keeps what the
  // customer wrote. The address that priced is the one to book with.
  let usedAddress = deliveryAddress;
  const town = String(deliveryAddress?.city ?? "").trim();
  const empty = (q) => !q.error && !q.rates.length;
  if (empty(door) && empty(locker) && town && String(deliveryAddress?.local_area ?? "").trim() !== town) {
    const retryAddress = { ...deliveryAddress, local_area: town };
    const [door2, locker2] = await both({ ...base, delivery_address: retryAddress });
    if (door2.rates.length || locker2.rates.length) {
      [door, locker, usedAddress] = [door2, locker2, retryAddress];
    }
  }
  return { door, locker, deliveryAddress: usedAddress };
}

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

/**
 * @returns {{door: {rates}|{error}, locker: {rates}|{error}}} rates normalised
 */
export async function quoteParcel(client, { collectionAddress, deliveryAddress, parcel, dropBox }) {
  const base = { collection_address: collectionAddress, delivery_address: deliveryAddress, parcels: [tcgParcel(parcel)] };
  const one = async (body) => {
    try { return { rates: normalizeRates(await client.getRates(body)) }; }
    catch (err) { return { error: String(err?.message || err).slice(0, 300), rates: [] }; }
  };
  const [door, locker] = await Promise.all([
    one(base),
    dropBox?.pickupPointId ? one({ ...base, ...lockerCollection(dropBox) }) : Promise.resolve({ rates: [] }),
  ]);
  return { door, locker };
}

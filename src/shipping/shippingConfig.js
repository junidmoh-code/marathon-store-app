// ── /config/shipping — the defaults ──────────────────────────────────────────
// What the Shipping card shows and edits, and what bookShipment reads. The
// live node at /config/shipping overrides these (mergeShippingConfig). Every
// number Junid has not measured carries `measured: false`; the card shows the
// marker until he measures it and ticks it off.
//
// `live` is NOT in here and is never defaulted to anything but false: it is
// read on its own from /config/shipping/live, and only `=== true` books.
//
// Sources: docs/COURIER-GUY.md. Locker limits and divisors were MEASURED with
// live POST /rates calls on 2026-10-21; item and box numbers are seeds.

// The account default collection address (portal address book, "Is account
// default"). docs/COURIER-GUY.md lists the other one (Marathon club).
export const COLLECTION_ADDRESS = Object.freeze({
  type: "business",
  company: "Bhoola Centre Shop Nr 9",
  street_address: "72 Prince Edward Street",
  local_area: "Durban Central",
  city: "Durban",
  zone: "KZN",
  country: "ZA",
  code: "4001",
});

// "Any locker" — how staff book a drop-off today (read from their own
// shipments, e.g. LD-UGOLUS). TCG assigns the tracking reference.
export const DROP_BOX_PICKUP_POINT = Object.freeze({ id: "CG0000", provider: "tcg-locker" });

// The item kinds the estimator packs. Order = the order the card lists them.
export const ITEM_KINDS = Object.freeze([
  "sneakerAdult", "sneakerKids", "slides", "foldedTop", "foldedBottoms",
  "tracksuitSet", "cap", "bag", "perfume", "accessory",
]);

export const DEFAULT_SHIPPING_CONFIG = Object.freeze({
  collectionAddress: COLLECTION_ADDRESS,
  // Who TCG contacts at collection (needs a mobile and/or email). Left EMPTY on
  // purpose — this repo is public — and a live booking refuses until Junid
  // fills it in on the Shipping card. A dry run shows the gap.
  collectionContact: { name: "The Marathon", mobile_number: "", email: "" },

  // TCG's doc states no divisor. Measured: ECO + every locker service
  // ÷4000; PRI, SDX and the local LPx/LSx services ÷5000. The estimator
  // uses the default (the conservative one); bookShipment never relies on it
  // for price — the price is always TCG's own quote.
  volumetricDivisor: 4000,
  divisorByServiceGroup: { ECO: 4000, L2D: 4000, L2L: 4000, PRI: 5000, SDX: 5000, LPF: 5000, LPP: 5000, LSF: 5000, LSP: 5000 },

  // Packed size of ONE item as it goes into the parcel (cm) and its weight
  // (kg). Footwear is in its shoebox; soft goods folded — heightCm is the
  // folded thickness, which is what stacks. sneakerAdult's dims are the
  // "Marathon club" preset staff already use in the portal (33×20×11).
  items: {
    sneakerAdult: {
      label: "Sneaker (adult, boxed)", lengthCm: 33, widthCm: 20, heightCm: 11,
      // Weight stepped by UK size band; EU sizes (≥ 36) are converted first.
      bands: [
        { upToSize: 6.5, kg: 1.1 },
        { upToSize: 9.5, kg: 1.3 },
        { upToSize: 99, kg: 1.5 },
      ],
      measured: false,
    },
    sneakerKids: {
      label: "Sneaker (kids, boxed)", lengthCm: 28, widthCm: 18, heightCm: 10,
      bands: [{ upToSize: 99, kg: 0.7 }],
      measured: false,
    },
    slides: { label: "Slides / sandals", lengthCm: 31, widthCm: 13, heightCm: 9, kg: 0.6, measured: false },
    foldedTop: { label: "Folded top (tee, jersey, hoodie, jacket)", lengthCm: 30, widthCm: 25, heightCm: 4, kg: 0.4, measured: false },
    foldedBottoms: { label: "Folded bottoms (pants, jeans, shorts)", lengthCm: 32, widthCm: 26, heightCm: 4, kg: 0.5, measured: false },
    tracksuitSet: { label: "Tracksuit set", lengthCm: 35, widthCm: 28, heightCm: 8, kg: 1.0, measured: false },
    cap: { label: "Cap / hat", lengthCm: 26, widthCm: 19, heightCm: 12, kg: 0.15, measured: false },
    bag: { label: "Bag", lengthCm: 35, widthCm: 28, heightCm: 6, kg: 0.5, measured: false },
    perfume: { label: "Perfume (boxed)", lengthCm: 12, widthCm: 8, heightCm: 6, kg: 0.35, measured: false },
    accessory: { label: "Belt / accessory", lengthCm: 15, widthCm: 10, heightCm: 4, kg: 0.2, measured: false },
  },

  // The boxes Junid stocks — SEEDS until measured. Outer dims are what TCG
  // is told; they are also used as the fit test (cardboard walls ignored).
  // Sized so the small ones fit TCG's lockers: FLAT fits locker S, SHOE and
  // SMALL fit locker M, XL is exactly locker L.
  boxes: [
    { code: "FLAT", label: "Flat mailer", lengthCm: 40, widthCm: 30, heightCm: 8, tareKg: 0.15, measured: false },
    { code: "SHOE", label: "Single shoe box mailer", lengthCm: 35, widthCm: 23, heightCm: 14, tareKg: 0.2, measured: false },
    { code: "SMALL", label: "Small box", lengthCm: 40, widthCm: 30, heightCm: 18, tareKg: 0.3, measured: false },
    { code: "MEDIUM", label: "Medium box", lengthCm: 45, widthCm: 35, heightCm: 25, tareKg: 0.45, measured: false },
    { code: "LARGE", label: "Large box", lengthCm: 55, widthCm: 40, heightCm: 35, tareKg: 0.65, measured: false },
    { code: "XL", label: "XL box (locker L size)", lengthCm: 60, widthCm: 41, heightCm: 41, tareKg: 0.8, measured: false },
  ],

  // THE DROP-BOX RULE. A parcel at or under a locker's size AND weight
  // threshold goes into a TCG locker (collection "Any locker", CG0000) on
  // that locker's service; anything above every threshold is collected from
  // the door on the cheapest door service quoted. Thresholds are TCG's own
  // limits, measured from /rates (docs/COURIER-GUY.md); XS weight is a guess.
  dropBox: {
    enabled: true,
    pickupPointId: DROP_BOX_PICKUP_POINT.id,
    pickupPointProvider: DROP_BOX_PICKUP_POINT.provider,
    lockers: [
      { size: "XS", serviceCode: "L2DXS - ECO", lengthCm: 60, widthCm: 17, heightCm: 8, maxKg: 2, measured: false },
      { size: "S", serviceCode: "L2DS - ECO", lengthCm: 60, widthCm: 41, heightCm: 8, maxKg: 5, measured: true },
      { size: "M", serviceCode: "L2DM - ECO", lengthCm: 60, widthCm: 41, heightCm: 19, maxKg: 10, measured: true },
      { size: "L", serviceCode: "L2DL - ECO", lengthCm: 60, widthCm: 41, heightCm: 41, maxKg: 15, measured: true },
    ],
  },

  // The service the estimator NAMES for a door collection. bookShipment
  // books the cheapest door service actually quoted, excluding these.
  doorServiceCode: "ECO",
  excludeServiceCodes: ["SDX"],

  // A live booking refuses any order whose chosen quote is above this (rand,
  // incl. VAT); a person books it in the portal instead. The locker L is
  // R193.60 and a 3 kg Cape Town ECO R143.52 (21 Oct 2026).
  maxChargeRand: 300,
});

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/**
 * Overlay the live /config/shipping node on the defaults. Objects merge key by
 * key; arrays (bands, boxes, lockers) are replaced whole — a half-merged box
 * list would be a box nobody stocks. Pure; never returns `live`.
 */
export function mergeShippingConfig(live, base = DEFAULT_SHIPPING_CONFIG) {
  const merge = (b, o) => {
    if (!isObj(o)) return o === undefined ? b : o;
    const out = { ...b };
    for (const k of Object.keys(o)) out[k] = isObj(b?.[k]) ? merge(b[k], o[k]) : o[k];
    return out;
  };
  const out = merge(JSON.parse(JSON.stringify(base)), isObj(live) ? live : {});
  delete out.live;
  return out;
}

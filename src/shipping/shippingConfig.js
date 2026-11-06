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

  // TCG's doc states no divisor. Measured 21 Oct with /rates (ECO + every
  // locker service ÷4000; PRI, SDX and the local LPx/LSx ÷5000) and CONFIRMED
  // 6 Nov from TCG's own dimensioning of our parcels: TCG200369959T (ECO)
  // 59.1×37×26.7 → 15 kg = ÷4000; 9DBT3G (ECOR) 58.3×36.8×22.9 → 13 kg =
  // ÷4000; RG9SJJ (LPF) 37.8×29.9×26 → 6 kg = ÷5000. Not a safety margin: it
  // is TCG's divisor for the service we nearly always book. The price is
  // always TCG's own quote of the parcel we declare.
  volumetricDivisor: 4000,
  divisorByServiceGroup: { ECO: 4000, ECOR: 4000, L2D: 4000, L2L: 4000, PRI: 5000, SDX: 5000, LPF: 5000, LPP: 5000, LSF: 5000, LSP: 5000 },

  // ── THE PARCEL RULE (Junid, 2026-10-23: ONE parcel, never split) ─────────
  // The sneaker box is the unit of SIZE. Every pair (and, unless its item says
  // otherwise, each kids pair and each pair of slides) is one shoebox; the
  // order's shoeboxes are stacked / set side by side into ONE parcel (the
  // arrangement with the smallest longest side). Soft and small goods are
  // STUFFED inside — weight only, no size — up to fillBudgetKg per pair; what
  // overflows lies flat on top, adding each item's own flat thickness
  // (items.*.flatCm) — never a padded bundle.
  // No footwear: one flat courier bag (flatBag) — what the packers actually
  // use for clothing — or, when it will not hold the goods, the box list.
  //
  // MEASURED 6 Nov 2026 from TCG's own dimensioning of our 23 Oct–5 Nov
  // parcels (docs/courier-rate-audit.md): a lone shoebox measured 33.4–35.8 ×
  // 20.9–24.4 × 11.9–14.1 cm, median ≈ 34 × 23 × 13, 1.0–1.3 kg.
  shoebox: {
    label: "Sneaker box (outer)",
    lengthCm: 34, widthCm: 23, heightCm: 13,
    fillBudgetKg: 1.2,
    measured: true,
  },

  // The flat courier bag clothing ships in. TCG measured our clothing-only
  // parcels at 37.6–43.2 × 29.5–37 cm (median ≈ 41 × 34) and 4.7–13.3 cm
  // high: three tees came in at 5.7–8 cm, not the 18 cm box we declared.
  // Height = the goods' flat thicknesses (never below minHeightCm); above
  // maxHeightCm the goods go in a box from the box list instead.
  flatBag: {
    label: "Flat courier bag",
    lengthCm: 41, widthCm: 34, minHeightCm: 8, maxHeightCm: 18, tareKg: 0.05,
    measured: true,
  },

  // Per parcel class ("shoebox:1", "shoebox:2", "shoebox:3+", "flatBag",
  // "box"), a factor on the declared VOLUME learned from TCG's own
  // measurements by the reconciliation loop (scripts/shipping/reconcile.mjs):
  // written only when three or more recent parcels of that class were all
  // measured more than 5% the same way. Empty = declare the goods as they are.
  calibration: {},

  // Packed size of ONE item as it goes into a parcel (cm) and its weight (kg).
  // ownShoebox: ships as its own shoebox parcel. stuffable: rides inside a
  // shoebox (weight only). Neither: packed into a flat box. Footwear weights
  // are the shoebox WITH the pair.
  items: {
    sneakerAdult: {
      label: "Sneaker (adult, boxed)", lengthCm: 34, widthCm: 23, heightCm: 13,
      ownShoebox: true,
      // Shoebox with a pair, stepped by UK size band (EU ≥ 36 converted).
      // TCG weighed our single pairs at 1.02–1.3 kg (6 Nov 2026 audit);
      // Junid: "one shoebox ≈ 1.2 kg".
      bands: [
        { upToSize: 6.5, kg: 1.1 },
        { upToSize: 9.5, kg: 1.2 },
        { upToSize: 99, kg: 1.3 },
      ],
      measured: true,
    },
    sneakerKids: {
      label: "Sneaker (kids, boxed)", lengthCm: 28, widthCm: 18, heightCm: 10,
      ownShoebox: true,
      // Kids bands are on the EU scale: UK kids sizes run 10–13.5 then 1–6
      // (not monotonic), so a UK size is converted first (estimateParcel.js
      // toEuKidsSize). Toddler / little kids / grade school.
      sizeScale: "euKids",
      bands: [
        { upToSize: 26, kg: 0.45 },
        { upToSize: 33, kg: 0.6 },
        { upToSize: 99, kg: 0.75 },
      ],
      measured: false,
    },
    slides: {
      label: "Slides / sandals", lengthCm: 31, widthCm: 13, heightCm: 9,
      ownShoebox: true,
      bands: [
        { upToSize: 6.5, kg: 0.5 },
        { upToSize: 9.5, kg: 0.6 },
        { upToSize: 99, kg: 0.7 },
      ],
      measured: false,
    },
    // flatCm: the item's thickness lying flat in the courier bag (or on top of
    // a shoebox stack). Fitted 6 Nov 2026 to TCG's measured heights of our
    // bags (3 tees 5.7–8 cm, tracksuit + top 12.5, top + tracksuit + cap 12.4,
    // a bag + 6 caps 15.4). nestCm: each further cap nests into the first.
    foldedTop: { stuffable: true, label: "Folded top (tee, jersey, hoodie, jacket)", lengthCm: 30, widthCm: 25, heightCm: 4, flatCm: 2.2, kg: 0.4, measured: true },
    foldedBottoms: { stuffable: true, label: "Folded bottoms (pants, jeans, shorts)", lengthCm: 32, widthCm: 26, heightCm: 4, flatCm: 2.5, kg: 0.5, measured: true },
    tracksuitSet: { stuffable: true, label: "Tracksuit set", lengthCm: 35, widthCm: 28, heightCm: 8, flatCm: 5, kg: 1.0, measured: true },
    cap: { stuffable: true, label: "Cap / hat", lengthCm: 26, widthCm: 19, heightCm: 12, flatCm: 6, nestCm: 1, kg: 0.15, measured: true },
    bag: { label: "Bag", lengthCm: 35, widthCm: 28, heightCm: 6, flatCm: 3, kg: 0.5, measured: false },
    perfume: { stuffable: true, label: "Perfume (boxed)", lengthCm: 12, widthCm: 8, heightCm: 6, flatCm: 6, kg: 0.35, measured: false },
    accessory: { stuffable: true, label: "Belt / accessory", lengthCm: 15, widthCm: 10, heightCm: 4, flatCm: 2, kg: 0.2, measured: false },
  },

  // The boxes Junid stocks — SEEDS until measured. `id` is immutable (the
  // card keys rows by it); `code` is the editable name. Outer dims are what TCG
  // is told; they are also used as the fit test (cardboard walls ignored).
  // Sized so the small ones fit TCG's lockers: FLAT fits locker S, SHOE and
  // SMALL fit locker M, XL is exactly locker L.
  boxes: [
    { id: "box-flat", code: "FLAT", label: "Flat mailer", lengthCm: 40, widthCm: 30, heightCm: 8, tareKg: 0.15, measured: false },
    { id: "box-shoe", code: "SHOE", label: "Single shoe box mailer", lengthCm: 35, widthCm: 23, heightCm: 14, tareKg: 0.2, measured: false },
    { id: "box-small", code: "SMALL", label: "Small box", lengthCm: 40, widthCm: 30, heightCm: 18, tareKg: 0.3, measured: false },
    { id: "box-medium", code: "MEDIUM", label: "Medium box", lengthCm: 45, widthCm: 35, heightCm: 25, tareKg: 0.45, measured: false },
    { id: "box-large", code: "LARGE", label: "Large box", lengthCm: 55, widthCm: 40, heightCm: 35, tareKg: 0.65, measured: false },
    { id: "box-xl", code: "XL", label: "XL box (locker L size)", lengthCm: 60, widthCm: 41, heightCm: 41, tareKg: 0.8, measured: false },
  ],

  // THE DROP-BOX RULE. A parcel at or under a locker's size AND weight
  // threshold goes into a TCG locker (collection "Any locker", CG0000) on
  // that locker's service; anything above every threshold is collected from
  // the door on the cheapest door service quoted. Thresholds are TCG's own
  // limits, measured from /rates (docs/COURIER-GUY.md); XS weight is a guess.
  dropBox: {
    // OFF: door-to-door for every order until Junid sets locker costing rules.
    enabled: false,
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
  // incl. VAT); Junid gets ONE WhatsApp line with the cheaper option and a
  // person books it in the portal (Junid, 6 Nov 2026: "the R300-per-booking
  // ceiling stays"). 0 switches the ceiling off.
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

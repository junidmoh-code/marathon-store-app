// ── /config/shipping — the defaults ──────────────────────────────────────────
// What the Shipping card shows and edits, and what bookShipment reads. The
// live node at /config/shipping overrides these field by field (mergeConfig).
// Every number Junid has not measured carries `measured: false`; the card shows
// the marker until he measures it and ticks it off.
//
// `live` is NOT in here and never defaults to anything but false: it is read
// on its own from /config/shipping/live, and only `=== true` books.

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

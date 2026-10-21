// ── An /online_orders record → the parts of a Courier Guy shipment ───────────
// Pure. Shared by the Shipping card's "test an order" panel and by
// bookShipment, so the card shows exactly what booking would send.
//
// The /online_orders shape belongs to the website-order session (feat/online-
// orders) and was not final when this was written, so every reader here is
// TOLERANT: it accepts the Shopify order shape (line_items, shipping_address
// with address1/zip/province, customer) and a normalised one (lines, shipping
// .address with street/code/zone). A field it cannot find comes back empty and
// is listed in `missing` — bookShipment refuses an order with anything
// missing rather than send TCG a half address.

const str = (v) => (v == null ? "" : String(v).trim());
const first = (...vals) => vals.map(str).find(Boolean) ?? "";

// TCG zones as they appear on this account's own shipments (KZN, GP, WC …).
const ZONES = {
  "kwazulu-natal": "KZN", kwazulunatal: "KZN", kzn: "KZN", nl: "KZN",
  gauteng: "GP", gp: "GP", gt: "GP",
  "western cape": "WC", wc: "WC",
  "eastern cape": "EC", ec: "EC",
  "free state": "FS", fs: "FS",
  limpopo: "LP", lp: "LP",
  mpumalanga: "MP", mp: "MP",
  "north west": "NW", nw: "NW",
  "northern cape": "NC", nc: "NC",
};
export function tcgZone(province) {
  const p = str(province);
  return ZONES[p.toLowerCase()] ?? p;
}

/**
 * The order's KEY in /online_orders — where its shipping object lives. The
 * website-order ingester keys orders by the Shopify order's numeric id
 * (legacyResourceId) and carries `ref` (the code, "KQZ") as a field, so the ref is
 * NEVER a key: writing under it would mint a junk order. "" when unknown.
 */
export function orderKey(order) {
  const gidTail = str(order?.shopifyGid).match(/\/(\d+)$/)?.[1];
  return first(order?.key, order?.id, gidTail);
}

/** The order's reference — what TCG gets as customer_reference. */
export function orderRef(order) {
  // The Shopify order number ("#1768") — what the customer and Junid know the
  // order by (owner decision 2026-10-21); the old per-order code only as a
  // fallback for orders pulled in before it.
  const n = order?.orderNumber ?? order?.order_number;
  if (n != null && String(n) !== "") return `#${n}`;
  return first(order?.name, order?.ref, order?.orderRef, order?.id);
}

/**
 * Order lines → estimator lines. `products` (optional, the app's /products
 * map) supplies category/subcategory/name when the line only names a product.
 */
export function orderLines(order, products = null) {
  const raw = Array.isArray(order?.lines) ? order.lines
    : Array.isArray(order?.line_items) ? order.line_items
    : order?.lines && typeof order.lines === "object" ? Object.values(order.lines)
    : [];
  return raw.map((l) => {
    const pid = l?.productId ?? l?.pid ?? null;
    const p = (products && pid && products[pid]) || null;
    return {
      productId: pid,
      kind: l?.kind ?? undefined,
      category: first(l?.category, p?.category),
      subcategory: first(l?.subcategory, p?.subcategory),
      name: first(l?.name, l?.title, p?.name),
      size: first(l?.size, l?.variant_title, l?.variantTitle),
      qty: Number(l?.qty ?? l?.quantity ?? 1),
    };
  });
}

/** The delivery address in TCG's shape, plus what could not be found. */
export function deliveryAddress(order) {
  const a = order?.shipping?.address ?? order?.shippingAddress ?? order?.shipping_address ?? {};
  const street = [first(a.street_address, a.street, a.address1, a.line1), first(a.address2, a.line2)].filter(Boolean).join(", ");
  const address = {
    type: first(a.company) ? "business" : "residential",
    company: first(a.company),
    street_address: street,
    local_area: first(a.local_area, a.suburb, a.localArea, a.address2),
    city: first(a.city, a.town),
    zone: tcgZone(first(a.zone, a.province_code, a.province, a.provinceCode, a.state)),
    country: first(a.country_code, a.countryCode, a.country) || "ZA",
    code: first(a.code, a.zip, a.postal_code, a.postalCode, a.postcode),
  };
  if (address.country.toLowerCase() === "south africa") address.country = "ZA";
  if (a.lat != null && a.lng != null) { address.lat = Number(a.lat); address.lng = Number(a.lng); }
  const missing = ["street_address", "city", "code"].filter((k) => !address[k]);
  return { address, missing };
}

/** The recipient: name, mobile, email (TCG needs email and/or mobile). */
export function deliveryContact(order) {
  const a = order?.shipping?.address ?? order?.shippingAddress ?? order?.shipping_address ?? {};
  const c = order?.customer ?? {};
  const name = first(
    a.name, [str(a.first_name), str(a.last_name)].filter(Boolean).join(" "),
    c.name, [str(c.first_name), str(c.last_name)].filter(Boolean).join(" "), order?.customerName,
  );
  const contact = {
    name,
    mobile_number: first(a.phone, order?.phone, c.phone, order?.customerPhone, order?.shipping?.phone),
    email: first(order?.email, c.email, order?.customerEmail, order?.contact_email),
  };
  const missing = !contact.mobile_number && !contact.email ? ["mobile_or_email"] : [];
  return { contact, missing };
}

import { describe, it, expect } from "vitest";
import { orderRef, orderLines, deliveryAddress, deliveryContact, tcgZone } from "./orderShipment.js";

const SHOPIFY = {
  name: "#1042", email: "c@example.com",
  line_items: [{ title: "Runner", variant_title: "9", quantity: 2, productId: "p1" }],
  shipping_address: { first_name: "Ann", last_name: "Bee", address1: "5 Esplanade Road", address2: "Century City", city: "Cape Town", province: "Western Cape", zip: "7441", country_code: "ZA", phone: "+27820000000" },
};
const NORMAL = {
  ref: "W1001",
  lines: { a: { name: "Tee", size: "M", qty: 1, category: "Clothing", subcategory: "T-Shirts" } },
  shipping: { address: { street: "81 West Road", suburb: "Overport", city: "Durban", zone: "KZN", code: "4067", company: "Acme" } },
  customer: { name: "C Dee", phone: "0820000000" },
};

describe("orderShipment", () => {
  it("ref", () => {
    expect(orderRef(SHOPIFY)).toBe("#1042");
    expect(orderRef(NORMAL)).toBe("W1001");
  });
  it("lines from Shopify shape, enriched from /products", () => {
    expect(orderLines(SHOPIFY, { p1: { category: "Footwear", subcategory: "Sneakers" } })).toEqual([
      { productId: "p1", kind: undefined, category: "Footwear", subcategory: "Sneakers", name: "Runner", size: "9", qty: 2 },
    ]);
  });
  it("lines from a keyed object", () => {
    expect(orderLines(NORMAL)[0]).toMatchObject({ name: "Tee", category: "Clothing", qty: 1 });
  });
  it("address — Shopify shape, province name → TCG zone", () => {
    expect(deliveryAddress(SHOPIFY)).toEqual({
      address: { type: "residential", company: "", street_address: "5 Esplanade Road, Century City", local_area: "Century City", city: "Cape Town", zone: "WC", country: "ZA", code: "7441" },
      missing: [],
    });
  });
  it("address — normalised shape, company → business", () => {
    expect(deliveryAddress(NORMAL).address).toMatchObject({ type: "business", street_address: "81 West Road", local_area: "Overport", zone: "KZN", code: "4067" });
  });
  it("missing fields are listed, never invented", () => {
    expect(deliveryAddress({}).missing).toEqual(["street_address", "city", "code"]);
    expect(deliveryContact({}).missing).toEqual(["mobile_or_email"]);
  });
  it("contact", () => {
    expect(deliveryContact(SHOPIFY).contact).toEqual({ name: "Ann Bee", mobile_number: "+27820000000", email: "c@example.com" });
    expect(deliveryContact(NORMAL).contact).toEqual({ name: "C Dee", mobile_number: "0820000000", email: "" });
  });
  it("zones", () => {
    expect(tcgZone("KwaZulu-Natal")).toBe("KZN");
    expect(tcgZone("GP")).toBe("GP");
    expect(tcgZone("Somewhere")).toBe("Somewhere");
  });
});

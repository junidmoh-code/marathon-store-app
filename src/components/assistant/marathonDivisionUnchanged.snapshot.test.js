// ─── MARATHON PE AND TROPHY: BYTE-FOR-BYTE WHAT THEY WERE ────────────────────
//
// Junid, 9 Nov 2026: Hub 3 goes live and Pine / Concrete read it. Marathon PE
// and Trophy read Hub 1 + Hub 2 "as today, byte-for-byte unchanged".
//
// THE SNAPSHOT BESIDE THIS FILE WAS WRITTEN ON main (bff76632), BEFORE any of
// that work — the order-screen world below ran against the code as it stood.
// It must never be regenerated to make a change pass: a diff here IS a change
// to what a Marathon assistant sees. It holds, for both shops, under the seed
// registry and under every Hub 3 switch position:
//   the catalogue, each size's hub and ✕, the clothing grey-out, the cart
//   allocation, where each line is placed, and the alternatives sheet.
// Hub 3 is given stock in every product on purpose: none of it may show.
import { describe, it, expect, afterEach } from "vitest";
import { __resetNetworkForTests } from "../../utils/networkStore";
import { orderScreenWorld } from "./__fixtures__/orderScreenWorld";

const shoe = (id, hubs, extra = {}) => ({
  id, name: `Shoe ${id}`, category: "Footwear", productType: "sneaker", categoryKey: "sneakers",
  brand: "Nike", sizes: ["6", "7", "8", "9"], retailPrice: 1200, photoUrl: `https://x/${id}.jpg`,
  ...(hubs ? { hubs } : {}), ...extra,
});
const PRODUCTS = [
  shoe("h1", ["hub1"]),
  shoe("h2", ["hub2"]),
  shoe("both", ["hub1", "hub2"]),
  shoe("untagged", null),
  shoe("legacy", null, { hub: "hub2" }),
  shoe("h3only", ["hub3"]),
  shoe("h1h3", ["hub1", "hub3"]),
  shoe("moved", ["hub1"]),                 // tagged Hub 1, stock at Hub 2
  shoe("dead", ["hub1"], { deactivated: true }),
  shoe("nophoto", ["hub1"], { photoUrl: "" }),
  { id: "tee", name: "Tee", category: "Clothing", productType: "clothing", categoryKey: "tshirts", sizes: ["S", "M", "L"], retailPrice: 300, photoUrl: "https://x/tee.jpg" },
  { id: "bag", name: "Bag", category: "Bags", sizes: ["Free Size"], retailPrice: 500, photoUrl: "https://x/bag.jpg", hubs: ["hub2"] },
];
const q = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { qty: v }]));
const STOCK = {
  hub1: { h1: q({ 6: 2, 7: 0, 8: 1 }), both: q({ 6: 1, 8: 0 }), untagged: q({ 7: 3 }), h1h3: q({ 6: 0 }), dead: q({ 6: 4 }), nophoto: q({ 8: 2 }) },
  hub2: { h2: q({ 6: 0, 7: 5, 9: 1 }), both: q({ 8: 2, 9: -1 }), legacy: q({ 6: 1 }), moved: q({ 6: 2, 7: 2 }), tee: q({ S: 0, M: 3 }), bag: q({ _: 2 }) },
  // Hub 3 holds EVERYTHING, in every size. None of it is Marathon's.
  hub3: Object.fromEntries(PRODUCTS.map((p) => [p.id, q(Object.fromEntries((p.sizes[0] === "Free Size" ? ["_"] : p.sizes).map((s) => [s, 9])))])),
};
const byId = (id) => PRODUCTS.find((p) => p.id === id);
const CART = [
  { product: byId("h1"), size: "8" },
  { product: byId("both"), size: "6" },
  { product: byId("both"), size: "6" },
  { product: byId("moved"), size: "6" },
  { product: byId("tee"), size: "M", productType: "clothing" },
];

// Every position Hub 3's switches can be left in, and Section 1's shops too.
const NETWORKS = {
  seed: null,
  "hub3 live": { locations: { hub3: { solve: true, autoRefill: "all" } } },
  "hub3 solved": { locations: { hub3: { solve: true, autoRefill: "solved" } } },
  "hub3 off": { locations: { hub3: { solve: false, autoRefill: "off" } } },
  "section 1 all live": { locations: { hub3: { live: true }, concrete: { live: true }, "marathon-pine": { live: true } } },
};

function picture(rawNetwork, shop, cart) {
  const w = orderScreenWorld({ rawNetwork, shop, products: PRODUCTS, stock: STOCK, cart });
  const sneakers = w.catalogue(false);
  const clothing = w.catalogue(true);
  const sizes = {};
  for (const p of sneakers) {
    for (const s of w.sizesOf(p)) {
      const { hub, available } = w.sourcing(p, s);
      sizes[`${p.id}/${s}`] = `${hub}:${available === null ? "-" : available}${w.sneakerOut(p, s) ? " OUT" : ""}`;
    }
  }
  const alternatives = {};
  for (const p of sneakers) {
    for (const s of w.sizesOf(p)) {
      if (!w.sneakerOut(p, s)) continue;
      const a = w.alternatives(p, s);
      alternatives[`${p.id}/${s}`] = a === null ? null : a.rows.map((r) => `${r.product.id}@${r.hub}/${r.matchedSize}`);
    }
  }
  return {
    subscribed: w.subscribed, servingHub: w.servingHub, sectionHubIds: w.sectionHubIds,
    sneakers: sneakers.map((p) => p.id), clothing: clothing.map((p) => p.id),
    sizes,
    clothingQty: Object.fromEntries(clothing.flatMap((p) => p.sizes.map((s) => [`${p.id}/${s}`, `${w.clothingHubOf(p)}:${w.hubQty(p, s)}`]))),
    cart: cart.filter((l) => l.productType !== "clothing").map((l) => `${l.product.id}/${l.size} -> ${w.placedHub(l)}`),
    alternatives,
  };
}

afterEach(() => __resetNetworkForTests());

describe("Marathon division order screen — unchanged by Hub 3 going live", () => {
  for (const shop of ["marathon-pe", "trophy"]) {
    for (const [name, raw] of Object.entries(NETWORKS)) {
      it(`${shop}, ${name}: empty cart`, () => {
        expect(picture(raw, shop, [])).toMatchSnapshot();
      });
      it(`${shop}, ${name}: with a cart`, () => {
        expect(picture(raw, shop, CART)).toMatchSnapshot();
      });
    }
  }

  it("is the same picture whatever Hub 3's switches say, and the same for both shops", () => {
    const base = JSON.stringify(picture(null, "marathon-pe", CART));
    for (const shop of ["marathon-pe", "trophy"]) {
      for (const raw of Object.values(NETWORKS)) expect(JSON.stringify(picture(raw, shop, CART))).toBe(base);
    }
  });

  it("never names Hub 3 anywhere a Marathon assistant can see", () => {
    for (const shop of ["marathon-pe", "trophy"]) {
      for (const raw of Object.values(NETWORKS)) {
        const pic = picture(raw, shop, CART);
        expect(pic.subscribed).toEqual(["hub1", "hub2"]);
        expect(pic.sneakers).not.toContain("h3only");
        expect(JSON.stringify({ ...pic, sneakers: null })).not.toContain("hub3");
      }
    }
  });
});

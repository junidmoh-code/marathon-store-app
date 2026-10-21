import { describe, it, expect } from "vitest";
import { findAlternatives, offerStillAvailable } from "./alternatives.mjs";

const P = (n) => `gid://shopify/Product/${n}`;
const prod = (n, price, avail = true, title = `Item ${n}`) => ({ id: P(n), handle: `item-${n}`, title, variants: { nodes: [{ id: `v${n}`, title: "M", availableForSale: avail, price: String(price) }] } });
const data = {
  1: { pid: "A1", price: 240 }, 2: { pid: "A2", price: 260 }, 3: { pid: "A3", price: 200 }, 4: { pid: "A4", price: 250 }, 5: { pid: "A5", price: 100 }, 6: { pid: "A6", price: 245 },
};
const graphql = async (q) => {
  if (/productType/.test(q)) return { product: { id: P(9), productType: "Tees" } };
  return { products: { nodes: [prod(9, 250), ...Object.entries(data).map(([n, d]) => prod(n, d.price)), prod(7, 249, false)] } };
};
const db = { "shopify_sync/_claims/1": "A1", "shopify_sync/_claims/2": "A2", "shopify_sync/_claims/3": "A3", "shopify_sync/_claims/4": "A4", "shopify_sync/_claims/5": "A5", "shopify_sync/_claims/6": "A6" };
for (const d of Object.values(data)) { db[`products/${d.pid}`] = { sizes: ["M"] }; db[`stock/hub2/${d.pid}/M/qty`] = 1; }
db["stock/hub2/A6/M/qty"] = 0; // no app stock → never offered
const get = async (p) => db[p] ?? null;
const line = { productGid: P(9), size: "M", qty: 1, unitPriceCents: 25000, isFootwear: false };

describe("findAlternatives", () => {
  it("nearest price, never dearer than paid, never the same product, never out of app stock, ≤ 4", async () => {
    const out = await findAlternatives({ graphql, get, line, orderId: "9001" });
    expect(out.map((o) => o.pid)).toEqual(["A4", "A1", "A3", "A5"]);
    expect(out.every((o) => o.priceCents <= 25000)).toBe(true);
    expect(out[0]).toMatchObject({ url: "https://marathonclub.co.za/products/item-4", locationId: "hub2", status: "pick" });
  });
  it("a swapped line's ceiling is its original price", async () => {
    const out = await findAlternatives({ graphql, get, line: { ...line, unitPriceCents: 10000, originalUnitPriceCents: 25000 }, orderId: "9001" });
    expect(out.map((o) => o.pid)).toContain("A4");
  });
  it("offerStillAvailable re-reads the cell and the holds", async () => {
    const offer = { pid: "A1", sizeKey: "M", locationId: "hub2" };
    expect(await offerStillAvailable({ get, offer, line, orderId: "9001" })).toBe(true);
    const held = async (p) => (p === "online_reservations/A1/M" ? { other: { qty: 1, locs: { hub2: 1 } } } : get(p));
    expect(await offerStillAvailable({ get: held, offer, line, orderId: "9001" })).toBe(false);
  });
});

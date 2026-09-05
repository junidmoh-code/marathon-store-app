// ─── BUG 1 + BUG 1b — A DEACTIVATED PRODUCT IS GONE FROM THE ASSISTANT VIEW ──
// Proven live 2026-09-05: "Dolce & Gabbana Sneakers Navy" rendered in the
// assistant view with a DEACTIVATED badge AND a live SELECT SIZE / Quantity
// block. The assistant searched, found the zero-size deactivated duplicate,
// told the customer there was no stock — and the sizes sat under the other
// copy. The sale was lost.
//
// The gate is on the POOL (`base` in AssistantView == assistantCatalogue here),
// which is what makes "not findable by search either" structurally true: the
// browse grid, the Fuse index, the barcode/SKU branch, the 1-char branch, the
// desktop overlay and the tongue-label finder all derive from it. So these
// tests drive the REAL search implementations over the REAL pool.

import { describe, it, expect } from "vitest";
import Fuse from "fuse.js";
import { assistantCatalogue } from "./assistantCatalogue.js";
import { browsableProducts, isDeactivated, orderSizeOut } from "../../utils/deactivation.js";
import { searchProducts } from "../../utils/productSearch.js";
import {
  DEFAULT_DEACTIVATED_SHOPS, readDeactivatedShops, showsDeactivated,
} from "../../config/assistantVisibility.js";

const LIVE = {
  id: "pLive", name: "Dolce & Gabbana Sneakers Navy", productType: "sneaker",
  hubs: ["hub1", "hub3"], barcode: "6009800011", sizes: [7, 8, 9],
};
const DEAD = {
  id: "pDead", name: "Dolce & Gabbana Sneakers Navy", productType: "sneaker",
  hubs: ["hub1", "hub3"], barcode: "6009800022", sizes: [],
  deactivated: { at: 1757000000000, by: "u1", byName: "gunidmoh" },
};
const PRODUCTS = [LIVE, DEAD];

// The three search paths AssistantView runs, each over the pool it is given —
// copied in shape from App.jsx so a change there that widened the pool would
// have to change here too.
const fuzzy = (pool, q) => new Fuse(pool, {
  keys: [{ name: "name", weight: 0.85 }, { name: "category", weight: 0.15 }],
  threshold: 0.4, ignoreLocation: true, minMatchCharLength: 2,
}).search(q).map((r) => r.item);
const byCode = (pool, q) => pool.filter((p) => {
  const codes = [];
  if (p.barcode != null) codes.push(String(p.barcode));
  if (p.sku != null) codes.push(String(p.sku));
  if (p.barcodes && typeof p.barcodes === "object") for (const c of Object.values(p.barcodes)) if (c != null) codes.push(String(c));
  return codes.some((c) => c === q || (q.length >= 3 && c.includes(q)));
});
const oneChar = (pool, q) => pool.filter((p) =>
  p.name.toLowerCase().includes(q.toLowerCase()) || (p.category || "").toLowerCase().includes(q.toLowerCase()));

const poolFor = (shopId, shopMap = DEFAULT_DEACTIVATED_SHOPS) => {
  const showDeactivated = showsDeactivated(shopMap, shopId);
  const base = assistantCatalogue({
    products: PRODUCTS, wantsClothing: false,
    storeMode: shopId === "marathon-pine" ? "pine" : "central",
    showDeactivated, isDeactivated,
  });
  return { base, showDeactivated, browse: showDeactivated ? base : browsableProducts(base) };
};

describe("a NON-PINE store: gone, and not findable by search either", () => {
  const { base, browse } = poolFor("marathon-pe");

  it("has no card in the browse grid", () => {
    expect(browse.map((p) => p.id)).toEqual(["pLive"]);
  });
  it("is not returned by the fuzzy name search — the exact query that lost the sale", () => {
    expect(fuzzy(base, "dolce gabbana sneakers navy").map((p) => p.id)).toEqual(["pLive"]);
  });
  it("is not returned by a typo'd query either", () => {
    expect(fuzzy(base, "dolce gabana snekers").every((p) => p.id !== "pDead")).toBe(true);
  });
  it("is not returned by SCANNING its own barcode", () => {
    expect(byCode(base, "6009800022")).toEqual([]);
    expect(byCode(base, "6009800011").map((p) => p.id)).toEqual(["pLive"]);
  });
  it("is not returned by a 1-character query", () => {
    expect(oneChar(base, "d").map((p) => p.id)).toEqual(["pLive"]);
  });
  it("is not returned by the tongue-label finder's name search (same pool)", () => {
    expect(searchProducts(base, "dolce", { limit: 20 }).map((p) => p.id)).toEqual(["pLive"]);
  });
  it("and its sizes stay un-orderable if a stale cart line ever reaches them", () => {
    expect(orderSizeOut(DEAD, { clothingOrder: false, hubQty: 99, deactivated: true })).toBe(true);
  });
});

describe("MARATHON PINE is exempt — Hub 3 is uncounted, the shelf is real", () => {
  const { base, browse, showDeactivated } = poolFor("marathon-pine");

  it("shows it in the browse grid", () => {
    expect(showDeactivated).toBe(true);
    expect(browse.map((p) => p.id).sort()).toEqual(["pDead", "pLive"]);
  });
  it("finds it by search and by scan", () => {
    expect(fuzzy(base, "dolce gabbana sneakers navy").map((p) => p.id).sort()).toEqual(["pDead", "pLive"]);
    expect(byCode(base, "6009800022").map((p) => p.id)).toEqual(["pDead"]);
  });
  it("and lets Pine actually ORDER it — an exemption that only shows it is worthless", () => {
    expect(orderSizeOut(DEAD, { clothingOrder: false, hubQty: 0, deactivated: false })).toBe(false);
  });
});

describe("the config switch — off without a deploy", () => {
  it("the shipped default exempts Pine and nobody else", () => {
    expect(showsDeactivated(DEFAULT_DEACTIVATED_SHOPS, "marathon-pine")).toBe(true);
    expect(showsDeactivated(DEFAULT_DEACTIVATED_SHOPS, "marathon-pe")).toBe(false);
    expect(showsDeactivated(DEFAULT_DEACTIVATED_SHOPS, "trophy")).toBe(false);
  });
  it("setting the console value to FALSE restores strict hiding for Pine", () => {
    const off = readDeactivatedShops({ showDeactivatedShops: { "marathon-pine": false } });
    const { browse, base } = poolFor("marathon-pine", off);
    expect(showsDeactivated(off, "marathon-pine")).toBe(false);
    expect(browse.map((p) => p.id)).toEqual(["pLive"]);
    expect(fuzzy(base, "dolce gabbana sneakers navy").map((p) => p.id)).toEqual(["pLive"]);
  });
  it("DELETING the key does the same (RTDB has no empty containers)", () => {
    const gone = readDeactivatedShops({ showDeactivatedShops: {} });
    expect(showsDeactivated(gone, "marathon-pine")).toBe(false);
  });
  it("an array form typed into the console works too", () => {
    expect(showsDeactivated(readDeactivatedShops({ showDeactivatedShops: ["marathon-pine"] }), "marathon-pine")).toBe(true);
  });
  it("an ABSENT node, a null, or junk falls back to the shipped default — never to 'nobody sees anything'", () => {
    for (const v of [null, undefined, {}, { showDeactivatedShops: "yes" }, 7]) {
      expect(readDeactivatedShops(v)).toBe(DEFAULT_DEACTIVATED_SHOPS);
    }
  });
});

describe("a user with NO store assigned", () => {
  // AssistantView blocks the whole order flow on `noStoreAccess` before any of
  // this runs; this pins what happens if a shop id is nonetheless missing or
  // unrecognised — STRICT hiding, the safe direction.
  it("gets strict hiding for a null / empty / unknown shop", () => {
    for (const shop of [null, undefined, "", "some-new-shop"]) {
      expect(showsDeactivated(DEFAULT_DEACTIVATED_SHOPS, shop)).toBe(false);
      expect(poolFor(shop).browse.map((p) => p.id)).toEqual(["pLive"]);
    }
  });
  it("is never exempted by the ROUTING UNIVERSE — the key is the shop id", () => {
    // "pine" the universe and "marathon-pine" the shop are different
    // vocabularies (src/utils/stores.js). Keying on the universe would exempt
    // a future Pine-universe shop nobody decided about.
    expect(showsDeactivated(DEFAULT_DEACTIVATED_SHOPS, "pine")).toBe(false);
  });
});

describe("the mode and hub rules this gate composes with are untouched", () => {
  const clothing = { id: "pC", name: "Tee", productType: "clothing" };
  const hub2Only = { id: "pH2", name: "Hub two shoe", productType: "sneaker", hubs: ["hub2"] };
  const all = [LIVE, DEAD, clothing, hub2Only];
  const run = (opts) => assistantCatalogue({ products: all, isDeactivated, ...opts }).map((p) => p.id);

  it("clothing mode returns clothing only", () => {
    expect(run({ wantsClothing: true, storeMode: "central" })).toEqual(["pC"]);
  });
  it("central sneakers see hub1/hub2; pine sees hub3", () => {
    expect(run({ wantsClothing: false, storeMode: "central" })).toEqual(["pLive", "pH2"]);
    expect(run({ wantsClothing: false, storeMode: "pine" })).toEqual(["pLive"]);
  });
  it("a legacy `hub` string still resolves", () => {
    expect(assistantCatalogue({
      products: [{ id: "pL", name: "Legacy", hub: "hub3" }], wantsClothing: false,
      storeMode: "pine", isDeactivated,
    }).map((p) => p.id)).toEqual(["pL"]);
  });
  it("nulls in the list never throw", () => {
    expect(assistantCatalogue({ products: [null, undefined, LIVE], wantsClothing: false, storeMode: "central", isDeactivated }))
      .toHaveLength(1);
  });
});

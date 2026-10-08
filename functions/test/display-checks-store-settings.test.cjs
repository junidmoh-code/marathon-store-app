// ─── DISPLAY CHECKS — per-store switch and scope; sales that wrote no movement
// Owner, 8 Oct 2026: Concrete and Trophy run the display check for everything
// except sneakers; Marathon PE stays exactly as it is (no settings → the live
// rule and the clothing scope, today's behaviour).
"use strict";
process.env.FIREBASE_DATABASE_EMULATOR_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || "127.0.0.1:9";
const test = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../displayChecks/lib.cjs");
const reg = require("../lib/network-registry.cjs");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { __resetNetworkCacheForTests } = require("../lib/network-load.cjs");
const { __resetDisplaySettingsCacheForTests } = require("../displayChecks/settings.cjs");
const { handleDisplaySale } = require("../displayChecks/onDisplaySale.js");

const SEED = reg.SEED_REGISTRY;
const ON_ALL = { enabled: true, scope: "all_but_sneakers" };

const P = {
  tee: { id: "tee", name: "Tee", productType: "clothing", category: "Clothing", subcategory: "T-Shirts", sizes: ["M"] },
  cap: { id: "cap", name: "Cap", productType: "clothing", category: "Accessories", subcategory: "Caps", sizes: ["_"] },
  perfume: { id: "perfume", name: "Scent", category: "Perfume", sizes: ["_"] },
  belt: { id: "belt", name: "Belt", category: "Accessories", sizes: ["_"] },             // no productType: an accessory
  untyped: { id: "untyped", name: "Thing", sizes: ["4XL"] },                            // legacy, no type, odd size
  sneaker: { id: "sneaker", name: "Shoe", productType: "sneaker", category: "Footwear", subcategory: "Sneakers", sizes: ["9"] },
  slide: { id: "slide", name: "Slide", category: "Footwear", subcategory: "Slides", sizes: ["9"] },
  price: { id: "price", name: "Classic 700 Range", category: "Price Products", priceProduct: true },
};

test("MARATHON PE UNCHANGED: no settings → the live rule and today's clothing scope, answer for answer", () => {
  for (const s of [undefined, null, {}, { roster: { locked: true } }]) {
    assert.equal(lib.isTriggerStoreEnabled("marathon-pe", SEED, s), true);
    assert.equal(lib.isTriggerStoreEnabled("concrete", SEED, s), false);   // not fully live: dark, as today
    for (const [id, p] of Object.entries(P)) for (const size of ["M", "_", "9", "4XL", null]) {
      assert.equal(lib.isDisplaySale(p, size, lib.normStoreSettings(s).scope, id), lib.isClothingSale(p, size), `${id} ${size}`);
    }
  }
  assert.deepEqual(lib.triggerStores(SEED), lib.triggerStores(SEED, { "marathon-pe": {}, trophy: {} }));
});

test("the switch: an explicit enabled decides for a registry STORE; hubs and unknown ids stay off", () => {
  assert.equal(lib.isTriggerStoreEnabled("concrete", SEED, ON_ALL), true);
  assert.equal(lib.isTriggerStoreEnabled("trophy", SEED, { enabled: false }), false);
  assert.equal(lib.isTriggerStoreEnabled("hub3", SEED, ON_ALL), false);
  assert.equal(lib.isTriggerStoreEnabled("nowhere", SEED, ON_ALL), false);
  assert.equal(lib.isTriggerStoreEnabled("concrete", SEED, { enabled: "yes" }), false);   // junk → the live rule
  assert.deepEqual(lib.triggerStores(SEED, { concrete: ON_ALL, trophy: ON_ALL }), ["concrete", "marathon-pe", "trophy"]);
});

test("SCOPE all_but_sneakers: caps, t-shirts, clothing, accessories, perfume, untyped — never a sneaker, a slide, a price product or a charge line", () => {
  const yes = (id, size) => assert.equal(lib.isDisplaySale(P[id], size, "all_but_sneakers", id), true, id);
  const no = (id, size) => assert.equal(lib.isDisplaySale(P[id], size, "all_but_sneakers", id), false, id);
  yes("tee", "M"); yes("cap", null); yes("perfume", null); yes("belt", null); yes("untyped", "4XL");
  no("sneaker", "9"); no("slide", "9"); no("price", null);
  assert.equal(lib.isDisplaySale(null, null, "all_but_sneakers", "SYNTH_SHOEBOX"), false);
  // the clothing scope (today) does NOT take a belt or a legacy 4XL — the difference is the setting
  assert.equal(lib.isDisplaySale(P.belt, null, "clothing", "belt"), false);
});

const sale = (over = {}) => ({
  type: "sale", status: "completed", storeId: "concrete", createdAt: 1790000000000,
  lineItems: {
    L1: { productId: "tee", size: "M", qty: 1 },
    L2: { productId: "cap", size: null, qty: 2 },
    L3: { productId: "sneaker", size: "9", qty: 1 },
    L4: { productId: "price", qty: 1, priceProduct: true },
    L5: { productId: "perfume", size: null, qty: 1, trustedAtShop: "concrete" },   // trusted → deducted → movement trigger's
    L6: { productId: "belt", size: null, qty: 1, sourceType: "return" },
    L7: { productId: "SYNTH_SHOEBOX", qty: 1 },
    ...over.lines,
  },
  ...over.sale,
});

test("saleLinesForDisplay: only lines that wrote NO movement, at a store that does not deduct", () => {
  const ids = (s) => lib.saleLinesForDisplay({ sale: s, network: SEED }).map((l) => l.lineId);
  assert.deepEqual(ids(sale()), ["L1", "L2", "L3"]);                                 // scope is the caller's
  assert.deepEqual(ids(sale({ sale: { storeId: "pe" } })), []);                      // Marathon PE: every line has a movement
  assert.deepEqual(ids(sale({ sale: { storeId: "trophy" } })), []);                  // Trophy is fully live: movements too
  assert.deepEqual(ids(sale({ sale: { type: "refund" } })), []);
  assert.deepEqual(ids(sale({ sale: { type: "layby", status: "open" } })), []);
  // Pine resolves through its POS id; the line trusted at CONCRETE is not trusted at Pine
  assert.deepEqual(ids(sale({ sale: { storeId: "pine" } })), ["L1", "L2", "L3", "L5"]);
  assert.equal(lib.saleLineLeaseId("-Oab.c", "L1"), "sale_-Oab_c_L1");
});

function world(settings) {
  __resetNetworkCacheForTests(); __resetDisplaySettingsCacheForTests();
  return makeFakeDb({
    products: P,
    stock: { concrete: { tee: { M: { qty: 2 } }, cap: { _: { qty: 0 } } } },
    displayChecks_settings: settings ? { concrete: settings } : {},
  });
}
const active = (db) => db.state.root.displayChecks_active?.concrete || {};

test("onDisplaySale: Concrete ON + all_but_sneakers → checks for the tee and the cap; nothing for the sneaker, the price line, the trusted line or the return", async () => {
  const db = world(ON_ALL);
  const r = await handleDisplaySale({ db, saleId: "S1", sale: sale(), nowMs: 1790000000000 });
  assert.equal(r.checked, 2);
  assert.deepEqual(Object.keys(active(db)).sort(), ["cap___", "tee__M"]);
  assert.equal(active(db)["tee__M"].status, "open");     // Concrete holds 2 of it
  assert.equal(active(db)["cap___"].status, "held");     // Concrete holds none: held until stock lands
  assert.equal(active(db)["tee__M"].triggerMovementId, "sale_S1_L1");
  assert.equal(active(db)["tee__M"].triggerSaleId, "S1");
});

test("onDisplaySale: idempotent — a re-fire of the same sale adds nothing", async () => {
  const db = world(ON_ALL);
  await handleDisplaySale({ db, saleId: "S1", sale: sale(), nowMs: 1790000000000 });
  const before = JSON.stringify(db.state.root.displayChecks_active);
  await handleDisplaySale({ db, saleId: "S1", sale: sale(), nowMs: 1790000000500 });
  assert.equal(JSON.stringify(db.state.root.displayChecks_active), before);
});

test("onDisplaySale: switched off, or no setting at a store that is not live → nothing", async () => {
  for (const s of [null, { enabled: false, scope: "all_but_sneakers" }]) {
    const db = world(s);
    const r = await handleDisplaySale({ db, saleId: "S1", sale: sale(), nowMs: 1790000000000 });
    assert.equal(r.checked, 0);
    assert.equal(db.state.root.displayChecks_active, undefined);
  }
});

test("onDisplaySale: the clothing scope takes the tee and the cap but not a belt", async () => {
  const db = world({ enabled: true });
  const r = await handleDisplaySale({ db, saleId: "S2", sale: sale({ lines: { L8: { productId: "belt", size: null, qty: 1 } } }), nowMs: 1790000000000 });
  assert.equal(r.checked, 2);
  assert.equal(active(db)["belt___"], undefined);
});

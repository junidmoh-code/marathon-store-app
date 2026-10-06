#!/usr/bin/env node
// ─── THE SECTIONS ROUTING FIXTURE — ENTIRELY SYNTHETIC ───────────────────────
//
//   node functions/test/fixtures/make-sections-routing-fixture.cjs [--pos <pos repo>]
//
// Writes functions/test/fixtures/sections-routing-fixture.json (and, with
// --pos, the quantities-only copy the POS snapshot reads). Deterministic: a
// seeded generator, no clock, no network, no production data. Every product,
// quantity, target and policy number here is INVENTED. This repo is public;
// nothing real belongs in a fixture.
//
// What it is built to exercise (the Section 2 routing snapshots run over it):
//   • the engine's four lanes: central→hub1, central→hub2, hub2→marathon-pe,
//     hub2→trophy, incl. pass-through, explicit rows, target 0, size runs,
//     subcategory runs, uniform / per-size / carried-only category policies,
//     and the armed footwear group;
//   • Solve and first batch: products stranded in Central, stranded in Hub 2,
//     carried by one shop only, one-size ("_") products, legacy products with
//     no category key;
//   • sneaker sourcing and POS sale / return routing: shoes at one hub, both
//     hubs (clear majority and exact ties), neither, with and without shop
//     cells, half sizes (5.5 ↔ "5_5");
//   • Section 1 presence (Hub 3, Pine) beside Section 2 stock, so "Section 1
//     being there changes nothing" is a real test;
//   • RTDB's array-coerced rows (dense integer size keys come back as arrays
//     with null holes).
"use strict";
const fs = require("node:fs");
const path = require("node:path");

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261006);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const LETTERS = ["S", "M", "L", "XL", "XXL", "XXXL"];
const SHOE_FULL = ["3", "4", "5", "5.5", "6", "7", "8", "9", "10", "11"];
const SHOE_MENS = ["6", "7", "8", "9", "10", "11"];
const BRANDS = ["Nike", "Adidas", "Puma", "New Balance", "Lacoste", "Diesel", "Northwind", "Kestrel", "Halden", ""];
const encodeSizeKey = (s) => String(s).replace(/\./g, "_");

// [count, category, subcategory, categoryKey | null, productType | undefined, size choices]
const CATALOGUE = [
  [22, "Footwear", "Sneakers", "sneakers", ["sneaker", undefined], [SHOE_FULL, SHOE_MENS, ["3", "4", "5", "5.5", "6"]]],
  [1, "Footwear", "Sneakers", null, ["sneaker"], [["3", "4", "5", "5.5", "6"]]],
  [3, "Footwear", "Sandals & Slides", "slides", [undefined], [SHOE_MENS]],
  [3, "Footwear", "Soccer Boots", "soccer-boots", ["sneaker"], [SHOE_MENS]],
  [14, "Clothing", "T-Shirts", "t-shirts", ["clothing"], [["S", "M", "L", "XL", "XXL"], LETTERS, ["M", "L", "XL"]]],
  [10, "Clothing", "Cargos & Pants", "pants", ["clothing"], [["S", "M", "L", "XL", "XXL"]]],
  [10, "Clothing", "Tracksuits & Sets", "tracksuits", ["clothing"], [["S", "M", "L", "XL", "XXL"], ["M", "L", "XL", "XXL"]]],
  [8, "Clothing", "Hoodies & Sweatshirts", "hoodies", ["clothing"], [["S", "M", "L", "XL", "XXL"], LETTERS]],
  [6, "Clothing", "Shorts & Vests", "shorts", ["clothing"], [["S", "M", "L", "XL"]]],
  [4, "Clothing", "Jackets & Coats", "jackets", ["clothing"], [LETTERS, ["L", "XL"]]],
  [6, "Clothing", "Clothing — Uncategorized", "suits", ["clothing"], [["M"], ["XL"], ["M", "L"]]],
  [5, "Clothing", "Jerseys", "soccer-jerseys", ["clothing"], [LETTERS, ["S", "M", "L", "XL", "XXL"]]],
  [3, "Clothing", "Polos", "golf-t-shirts", ["clothing"], [["M", "L", "XL", "XXL"]]],
  [3, "Clothing", "Tracksuits & Sets", "ladies-tracksuits", ["clothing"], [["S", "M", "L", "XL", "XXL"]]],
  [2, "Clothing", "Jerseys", "baseball-shirts", ["clothing"], [["S", "M", "L", "XL", "XXL"]]],
  [3, "Clothing", "Underwear & Socks", "underwear", ["clothing"], [LETTERS]],
  [5, "Clothing", "Clothing — Uncategorized", null, ["clothing"], [["M", "L", "XL"], [...LETTERS, "4XL"]]],
  [4, "Clothing", "Caps & Hats", "caps-beanies", ["clothing"], [["_"], ["M"]]],
  [6, "Accessories", "Bags", "bags", ["clothing"], [["_"], ["L"]]],
  [2, "Accessories", "Belts", "belts", ["clothing"], [["S", "M", "L", "XL"]]],
  [5, "Perfume", "Perfume", "perfumes", [undefined], [["_"]]],
  [2, "Accessories", "Watches", "watches", ["clothing"], [["_"]]],
  [2, "Accessories", "Sunglasses", "sunglasses", ["clothing"], [["_"]]],
  [1, "Accessories", "Gloves", "gloves", ["clothing"], [["M", "L"]]],
];

const products = {};
let n = 0;
for (const [count, category, subcategory, categoryKey, types, sizeChoices] of CATALOGUE) {
  for (let i = 0; i < count; i++) {
    n += 1;
    const id = `fx${String(n).padStart(3, "0")}`;
    const p = { id, name: `${categoryKey || subcategory} ${id}`, category, subcategory };
    if (categoryKey) p.categoryKey = categoryKey;
    const type = pick(types);
    if (type) p.productType = type;
    p.hubs = pick([["hub2"], ["hub1"], ["hub1", "hub2"], ["hub3", "hub2"], ["hub3", "hub1"], ["hub3"], ["hub2", "hub3"]]);
    if (chance(0.1)) p.hub = pick(["hub1", "hub2", "hub3"]);
    p.sizes = [...pick(sizeChoices)];
    p.hasShoeBoxOption = category === "Footwear" && chance(0.3);
    const brand = pick(BRANDS);
    if (brand) p.brand = brand;
    if (n === 37 || n === 91) p.deactivated = { at: 1 };
    products[id] = p;
  }
}

const QTY = [0, 0, 0, 1, 1, 2, 2, 3, 4, 6, 9];
const STAMP = "2026-01-15T08:00:00.000Z";
const cell = (qty) => {
  const c = { qty, v: int(1, 30), lastType: pick(["received", "transfer_out", "transfer_in", "sold", "adjustment", "return"]), updatedAt: STAMP };
  if (chance(0.4)) c.state = "live";
  return c;
};
const stock = { central: {}, hub1: {}, hub2: {}, hub3: {}, "marathon-pe": {}, trophy: {}, "marathon-pine": {} };
const put = (loc, p, mode) => {
  const row = {};
  for (const s of p.sizes) {
    if (mode !== "all" && chance(0.25)) continue;                 // a size never carried here
    row[encodeSizeKey(s)] = cell(mode === "zeros" ? 0 : mode === "deep" ? int(3, 12) : pick(QTY));
  }
  if (Object.keys(row).length) stock[loc][p.id] = row;
};

// The scenario decides WHERE a product sits; quantities are drawn per cell.
const CLOTHING_SCENARIOS = [
  ["chain", 34], ["central_only", 14], ["hub2_only", 10], ["shops_only", 8], ["hub2_pe", 10],
  ["hub2_trophy", 8], ["central_hub2", 8], ["pe_sold_out", 4], ["nowhere", 4],
];
const FOOTWEAR_SCENARIOS = [
  ["hub1", 22], ["hub2", 18], ["both_hubs", 22], ["tie", 8], ["central_only", 8], ["hub1_central", 10], ["shop_cell", 6], ["nowhere", 6],
];
const weighted = (table) => {
  let r = rnd() * table.reduce((t, [, w]) => t + w, 0);
  for (const [name, w] of table) { if ((r -= w) < 0) return name; }
  return table[0][0];
};
for (const p of Object.values(products)) {
  if (p.category === "Footwear") {
    const sc = weighted(FOOTWEAR_SCENARIOS);
    if (sc === "hub1" || sc === "both_hubs" || sc === "hub1_central") put("hub1", p);
    if (sc === "hub2" || sc === "both_hubs") put("hub2", p);
    if (sc === "tie") {                                            // the same count at both hubs, size by size
      const row = {};
      for (const s of p.sizes) row[encodeSizeKey(s)] = cell(int(1, 3));
      stock.hub1[p.id] = JSON.parse(JSON.stringify(row));
      stock.hub2[p.id] = JSON.parse(JSON.stringify(row));
    }
    if (sc === "central_only" || sc === "hub1_central" || chance(0.3)) put("central", p, "deep");
    if (sc === "shop_cell") { put(pick(["marathon-pe", "trophy"]), p); put("hub2", p, "zeros"); }
    if (chance(0.3)) put("hub3", p);
    if (chance(0.25)) put("marathon-pine", p);
  } else {
    const sc = weighted(CLOTHING_SCENARIOS);
    if (["chain", "central_only", "central_hub2"].includes(sc)) put("central", p, "deep");
    if (["chain", "hub2_only", "hub2_pe", "hub2_trophy", "central_hub2"].includes(sc)) put("hub2", p);
    if (["chain", "shops_only", "hub2_pe"].includes(sc)) put("marathon-pe", p);
    if (["chain", "shops_only", "hub2_trophy"].includes(sc)) put("trophy", p);
    if (sc === "pe_sold_out") { put("marathon-pe", p, "zeros"); put("hub2", p, "deep"); }
    if (chance(0.2)) put("hub3", p);
    if (chance(0.25)) put("marathon-pine", p);
  }
}
// RTDB hands a row with dense integer keys back as an ARRAY with null holes.
let coerced = 0;
for (const loc of ["hub1", "hub2"]) {
  for (const pid of Object.keys(stock[loc])) {
    const keys = Object.keys(stock[loc][pid]);
    if (coerced < 4 && keys.length >= 4 && keys.every((k) => /^\d+$/.test(k))) {
      const arr = [];
      for (const k of keys) arr[Number(k)] = stock[loc][pid][k];
      for (let i = 0; i < arr.length; i++) if (arr[i] === undefined) arr[i] = null;
      stock[loc][pid] = arr;
      coerced += 1;
    }
  }
}

// Explicit /stock_targets rows — the engine's first-priority source.
const targets = { hub1: {}, hub2: {}, "marathon-pe": {}, trophy: {} };
const SOURCES = ["policy", "policy", "policy", "manual", "migration"];
const row = (p, lo, hi) => {
  const out = {};
  for (const s of p.sizes) {
    if (chance(0.2)) continue;
    const off = chance(0.07);
    const target = off ? 0 : int(lo, hi);
    out[encodeSizeKey(s)] = { target, minQty: off ? 0 : Math.min(target, int(1, 2)), source: off ? "excluded" : pick(SOURCES), approvedAt: STAMP };
  }
  return Object.keys(out).length ? out : null;
};
for (const p of Object.values(products)) {
  const set = (loc, r) => { if (r) targets[loc][p.id] = r; };
  if (p.category === "Footwear") {
    if (stock.hub1[p.id] && chance(0.35)) set("hub1", row(p, 1, 3));
    if (stock.hub2[p.id] && chance(0.2)) set("hub2", row(p, 1, 3));
    continue;
  }
  if (stock.hub2[p.id] && chance(0.7)) set("hub2", row(p, 2, 5));
  if (stock["marathon-pe"][p.id] && chance(0.75)) set("marathon-pe", row(p, 1, 3));
  if (stock.trophy[p.id] && chance(0.75)) set("trophy", row(p, 1, 3));
  if (!stock["marathon-pe"][p.id] && chance(0.12)) set("marathon-pe", row(p, 1, 2));   // seated, never stocked
}

const uniform = (target, minQty, reorderPoint = 0) => ({ target, minQty, reorderPoint });
const perSize = (sizes, f) => ({ sizes: Object.fromEntries(sizes.map((s, i) => [encodeSizeKey(s), f(s, i)])) });
const SHOE_POLICY_SIZES = [...SHOE_FULL, "12"];
const config = {
  enabled: true,
  ruleBasedTargets: true,
  productTypes: { clothing: true },
  autoAdoptTargets: { hub2: true },
  routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
  mode: { hub1: "live", hub2: "live", "marathon-pe": "live", trophy: "live" },
  defaultRunByStore: {
    hub2: { S: 2, M: 4, L: 4, XL: 3, XXL: 1, XXXL: 1 },
    "marathon-pe": { S: 1, M: 3, L: 2, XL: 2, XXL: 1, XXXL: 1 },
    trophy: { S: 1, M: 2, L: 3, XL: 1, XXL: 1, XXXL: 1 },
  },
  footwearRunByLocation: {
    hub1: Object.fromEntries(SHOE_FULL.map((s, i) => [encodeSizeKey(s), 1 + (i % 3 === 1 ? 1 : 0)])),
    hub2: Object.fromEntries(SHOE_FULL.map((s, i) => [encodeSizeKey(s), 1 + (i % 2)])),
  },
  footwearReorderPoint: { hub1: 0, hub2: 0 },
  subcategoryRunByLocation: { hub2: { Watches: 3 }, "marathon-pe": { Watches: 1 }, trophy: { Watches: 1 } },
  categoryPolicy: {
    bags: { hub2: uniform(6, 3), trophy: uniform(3, 1) },
    belts: { perSize: true, hub2: uniform(4, 2), trophy: uniform(2, 1) },
    "caps-beanies": { hub2: uniform(8, 4, 1), "marathon-pe": uniform(4, 2, 1) },
    "fitted-caps": { perSize: true, hub2: uniform(3, 1), "marathon-pe": uniform(2, 1) },
    gloves: { hub2: uniform(5, 2), "marathon-pe": uniform(2, 1) },
    perfumes: { hub2: uniform(7, 3), "marathon-pe": uniform(3, 1) },
    "soccer-jerseys": {
      perSize: true,
      hub2: perSize(LETTERS, (s, i) => uniform(4 - (i > 3 ? 2 : 0), 2 - (i > 3 ? 1 : 0))),
      "marathon-pe": perSize(LETTERS, (s, i) => uniform(i > 3 ? 1 : 2, 1)),
    },
    sunglasses: { hub2: uniform(5, 2), trophy: uniform(2, 1) },
    underwear: {
      perSize: true,
      hub2: perSize(LETTERS, (s, i) => uniform(i < 4 ? 5 : 2, i < 4 ? 2 : 1)),
      "marathon-pe": perSize(LETTERS, () => uniform(2, 1)),
    },
  },
  policyGroups: {
    "footwear-all": {
      armed: true,
      label: "Footwear",
      memberCategoryKeys: ["boots", "designer-shoes", "kids-shoes", "loafers", "running-shoes", "slides", "sneakers", "soccer-boots"],
      policy: {
        perSize: true,
        // Hub 1 and Hub 2 carry the SAME leg (the one-footwear-policy rule).
        hub1: { carriedOnly: true, ...perSize(SHOE_POLICY_SIZES, (s, i) => uniform(i % 4 === 0 ? 3 : 2, 1, 1)) },
        hub2: { carriedOnly: true, ...perSize(SHOE_POLICY_SIZES, (s, i) => uniform(i % 4 === 0 ? 3 : 2, 1, 1)) },
      },
    },
  },
  carriedOnlyEngineDeployedAt: "2026-01-10T08:00:00.000Z",
  maxIntentsPerRun: 400,
  maxFootwearIntentsPerRun: 120,
  maxUnitsPerIntent: 12,
  rejectStreakLimit: 3,
  recheckCooldownMinutes: 720,
  staleIntentHours: 96,
  scanIntervalMinutes: 30,
  defaultRunRecentSaleDays: 10,
  updatedAt: 1767254400000,
};

const fixture = {
  _about: "ENTIRELY SYNTHETIC. Generated by functions/test/fixtures/make-sections-routing-fixture.cjs from a seeded generator. No product, quantity, target or policy number here comes from production.",
  generator: "make-sections-routing-fixture.cjs seed 20261006",
  config, products, stock, targets,
};
const outPath = path.join(__dirname, "sections-routing-fixture.json");
fs.writeFileSync(outPath, JSON.stringify(fixture, null, 1) + "\n");

const posArg = process.argv.indexOf("--pos");
if (posArg > -1) {
  const qtyOnly = {};
  for (const loc of Object.keys(stock)) {
    qtyOnly[loc] = {};
    for (const pid of Object.keys(stock[loc])) {
      const r = stock[loc][pid];
      const entries = Array.isArray(r) ? r.map((c, i) => [String(i), c]).filter(([, c]) => c) : Object.entries(r);
      qtyOnly[loc][pid] = Object.fromEntries(entries.map(([k, c]) => [k, { qty: c.qty }]));
    }
  }
  const posPath = path.join(process.argv[posArg + 1], "src/stock/__tests__/fixtures/sections-routing-fixture.json");
  fs.writeFileSync(posPath, JSON.stringify({ _about: fixture._about, generator: fixture.generator, products, stock: qtyOnly }, null, 1) + "\n");
}
console.log(JSON.stringify({ products: Object.keys(products).length, stock: Object.fromEntries(Object.keys(stock).map((l) => [l, Object.keys(stock[l]).length])), targets: Object.fromEntries(Object.keys(targets).map((l) => [l, Object.keys(targets[l]).length])), arrayRows: coerced }));

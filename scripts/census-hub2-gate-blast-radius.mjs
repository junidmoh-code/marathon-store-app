// ─── WHAT THE HUB 2 GATE ACTUALLY DOES ON DAY ONE — read-only ────────────────
//
// The Hub 1 build (2026-08-25) measured its own blast radius before shipping:
// "45 promised units across 43 cells of 2,807". The Hub 2 work shipped a
// negative-cell count and nothing else, which review called out as the biggest
// operational gap in the change. Two numbers decide whether this is safe to
// deploy, and neither was taken:
//
//   (A) HOW MANY SIZE CHIPS FLIP TO ✕. The grid renders a chip per DECLARED
//       size (App.jsx sizesOf reads p.sizes, not stock), and the resolver
//       answers 0 for a declared size with no /stock/hub2 cell at all. So the
//       denominator is (hub2-routed footwear product × declared size), not the
//       2,476 cells that happen to exist. If coverage is sparse the way the
//       headwear "one-size row-less" census found, a large slice of the grid
//       goes ✕ the moment this deploys.
//
//       The sharp special case inside it: a footwear product with an EMPTY or
//       MISSING sizes array renders exactly one chip, "Free Size", which
//       resolves to the "_" cell. If its real stock sits in "8"/"9"/… cells,
//       that single chip reads 0 and the product becomes COMPLETELY
//       unorderable at Hub 2 — it was orderable yesterday.
//
//   (B) WHETHER CENTRAL ACTUALLY HOLDS HUB 2 SNEAKERS. tomorrowGate.js asserts
//       "Hub 2 draws the same Central replenishment Hub 1 does" as a bare
//       domain claim. If Central's sneaker stock is hub1-oriented, every Hub 2
//       Tomorrow row renders the red "Out of stock" button, and one tap
//       auto-sends that outcome to a customer — by the module's own words,
//       "the one failure this feature must never produce".
//
//   (C) DUAL-HUB FOOTWEAR. computeHubForItem takes the FIRST of hub1/hub2 in
//       the product's `hubs` array, which is built by append-on-toggle and
//       never canonicalised. A shoe stored ["hub2","hub1"] gates on Hub 2; the
//       same shoe stored ["hub1","hub2"] gates on Hub 1. Counted here because
//       a Hub 2 ✕ can now refuse a sale for stock the company holds at Hub 1.
//
// Reads: /products, /stock/hub2, /stock/central (subtree reads, one-off, in a
// report script — the app itself never reads a whole node). /orders bounded by
// key range, the kiosk's own pattern.
import { createRequire } from "module";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

// The app's own predicates, MIRRORED EXACTLY — not approximated. Review caught
// the first cut diverging in three places (a broad `_`→`.` decode, a loose
// "One Size" fold, and a sizesOf that did not drop blanks and the "_" sentinel),
// and these numbers are the evidence the change is safe to deploy, so an
// approximation is not good enough. Each function below is a transcription of
// the named source; check them against it, not against intuition.
//
// src/utils/sizeKey.js
const ILLEGAL_RTDB_CHARS = /[.#$[\]/\s]/g;
const encodeSizeKey = (size) => {
  if (typeof size === "number") size = String(size);
  if (typeof size !== "string") return size;
  return size.replace(ILLEGAL_RTDB_CHARS, "_");
};
const decodeSizeKey = (key) =>
  typeof key !== "string" ? key : key.replace(/(\d)_(\d)/g, "$1.$2");   // digit_digit ONLY
const stockSizeKey = (size) =>
  (size == null || size === "" || size === "Free Size") ? "_" : encodeSizeKey(size);
const decodedCellKey = (size) => decodeSizeKey(stockSizeKey(size));
// src/components/stock/missingFootwearCore.js + availabilityCore.gatedSneakerHub
const isFootwearProduct = (p) => p?.category === "Footwear";
const isGatedSneaker = (p) => isFootwearProduct(p) && (p?.productType || "sneaker") !== "clothing";
// src/App.jsx getProductHubs + computeHubForItem (central universe)
const getProductHubs = (p) => p?.hubs || (p?.hub ? [p.hub] : []);
const routedHub = (p) => getProductHubs(p).find((h) => h === "hub1" || h === "hub2") || "hub1";
// src/App.jsx sizesOf — drops blanks, whitespace-only entries and the "_"
// sentinel before falling back to the single "Free Size" chip.
const sizesOf = (p) => {
  const s = (Array.isArray(p?.sizes) ? p.sizes : []).filter((x) => x && String(x).trim() && x !== "_");
  return s.length ? s : ["Free Size"];
};

// HUB 1 IS THE CONTROL, and it is the only thing that makes these numbers
// readable. Hub 1 has run this exact gate since 2026-08-25 with the owner
// watching it, so "what fraction of Hub 1's chips are ✕ today" is the number
// Hub 2's has to be compared against. A rate in Hub 1's neighbourhood means
// the gate is behaving as it already does in production; a rate far above it
// means Hub 2 is a different animal and this should not ship on Hub 1's
// evidence. Measuring Hub 2 alone would have produced a big scary percentage
// with nothing to judge it by.
const [prodSnap, hub2Snap, hub1Snap, centralSnap] = await Promise.all([
  db.ref("products").once("value"),
  db.ref("stock/hub2").once("value"),
  db.ref("stock/hub1").once("value"),
  db.ref("stock/central").once("value"),
]);
const products = prodSnap.val() || {};
const hub2 = hub2Snap.val() || {};
const hub1 = hub1Snap.val() || {};
const central = centralSnap.val() || {};

// EXACTLY what the client does: useStock.decodeByProduct decodes every stored
// key on the way in, and the resolver then indexes that decoded map by
// decodedCellKey(size). Anything else measures a lookup the app never performs.
const decodedCache = new Map();
const decodedRows = (stock, pid) => {
  const key = `${stock === undefined ? "?" : ""}${pid}`;
  let per = decodedCache.get(stock);
  if (!per) { per = new Map(); decodedCache.set(stock, per); }
  if (per.has(key)) return per.get(key);
  const raw = stock[pid];
  let dec = null;
  if (raw) {
    dec = {};
    for (const k of Object.keys(raw)) dec[decodeSizeKey(k)] = raw[k];
  }
  per.set(key, dec);
  return dec;
};
const cellQty = (stock, pid, rawSize) => {
  const rows = decodedRows(stock, pid);
  if (!rows) return null;                         // no row at all for this product
  const cell = rows[decodedCellKey(rawSize)];
  if (cell === undefined) return null;            // row exists, this size does not
  const q = Number(cell?.qty);
  return Number.isFinite(q) ? q : 0;
};

// ── (A) chips that flip to ✕ ────────────────────────────────────────────────
let hub2Products = 0, hub1Products = 0;
let chips = 0, chipsX = 0, chipsNoCell = 0, chipsZeroOrNeg = 0;
const fullyBlocked = [];       // every declared size ✕ — the product is unorderable
const freeSizeTrap = [];       // no declared sizes, but real stock in numeric cells
for (const [pid, p] of Object.entries(products)) {
  if (!p || typeof p !== "object" || !isGatedSneaker(p)) continue;
  if (p.mergedInto) continue;
  const hub = routedHub(p);
  if (hub === "hub1") { hub1Products++; continue; }
  hub2Products++;
  const sizes = sizesOf(p);
  let blocked = 0;
  for (const sz of sizes) {
    chips++;
    const q = cellQty(hub2, pid, sz);
    if (q === null) { chipsNoCell++; chipsX++; blocked++; continue; }
    if (q <= 0) { chipsZeroOrNeg++; chipsX++; blocked++; }
  }
  if (blocked === sizes.length) {
    fullyBlocked.push({ pid, name: p.name, sizes: sizes.length,
      units: Object.values(hub2[pid] || {}).reduce((n, c) => n + Math.max(Number(c?.qty) || 0, 0), 0) });
  }
  // The one-size trap: a single "Free Size" chip in front of numeric stock.
  if (!(Array.isArray(p.sizes) && p.sizes.length)) {
    const rows = hub2[pid] || {};
    const numericUnits = Object.entries(rows)
      .filter(([k]) => k !== "_")
      .reduce((n, [, c]) => n + Math.max(Number(c?.qty) || 0, 0), 0);
    if (numericUnits > 0) freeSizeTrap.push({ pid, name: p.name, numericUnits, hasFreeSizeCell: rows._ != null });
  }
}

// ── (B) does Central hold what Hub 2 sells? ─────────────────────────────────
const ordersSnap = await db.ref("orders").orderByKey().startAt("0").endAt("9").once("value");
const orders = Object.entries(ordersSnap.val() || {});
let h2FootwearRows = 0, centralHas = 0, centralZero = 0, centralNoCell = 0;
for (const [, o] of orders) {
  if (!o || typeof o !== "object") continue;
  if (o.placedAtHub === "hub3" || o.placedAtHub === "hubC") continue;
  if ((o.hub || "hub1") !== "hub2") continue;
  const p = products[o.productId];
  if (!isGatedSneaker(p)) continue;               // the gate's own predicate
  const size = o.sentSize ?? o.size ?? null;
  if (!size) continue;
  h2FootwearRows++;
  const q = cellQty(central, o.productId, size);
  if (q === null) centralNoCell++;
  else if (q > 0) centralHas++;
  else centralZero++;
}

// A wider, order-independent read of the same question: for every hub2 sneaker
// cell holding units, does Central hold that size at all?
let pairs = 0, pairsCentralHas = 0;
for (const [pid, p] of Object.entries(products)) {
  if (!isGatedSneaker(p) || p?.mergedInto || routedHub(p) !== "hub2") continue;
  for (const sz of sizesOf(p)) {
    pairs++;
    const q = cellQty(central, pid, sz);
    if (q !== null && q > 0) pairsCentralHas++;
  }
}

// ── (C) dual-hub footwear, and which way the array points ───────────────────
let dual = 0, dualHub2First = 0, dualHub1First = 0;
const dualHub2FirstWithHub1Stock = [];
for (const [pid, p] of Object.entries(products)) {
  if (!isGatedSneaker(p) || p?.mergedInto) continue;
  const hubs = getProductHubs(p);
  if (!(hubs.includes("hub1") && hubs.includes("hub2"))) continue;
  dual++;
  if (routedHub(p) === "hub2") {
    dualHub2First++;
    dualHub2FirstWithHub1Stock.push({ pid, name: p.name });
  } else dualHub1First++;
}

// The same two measurements run over HUB 1 — the control. Same predicates,
// same chip rule, same Central question, only the hub differs.
function gridAndCentralFor(hubId, stock) {
  let prods = 0, ch = 0, chX = 0, noCell = 0, zeroNeg = 0, blocked = 0, blockedHolding = 0;
  let cPairs = 0, cHas = 0;
  for (const [pid, p] of Object.entries(products)) {
    if (!p || typeof p !== "object" || !isGatedSneaker(p) || p.mergedInto) continue;
    if (routedHub(p) !== hubId) continue;
    prods++;
    const sizes = sizesOf(p);
    let b = 0;
    for (const sz of sizes) {
      ch++; cPairs++;
      const cq = cellQty(central, pid, sz);
      if (cq !== null && cq > 0) cHas++;
      const q = cellQty(stock, pid, sz);
      if (q === null) { noCell++; chX++; b++; continue; }
      if (q <= 0) { zeroNeg++; chX++; b++; }
    }
    if (b === sizes.length) {
      blocked++;
      const units = Object.values(stock[pid] || {}).reduce((n, c) => n + Math.max(Number(c?.qty) || 0, 0), 0);
      if (units > 0) blockedHolding++;
    }
  }
  return { products: prods, chips: ch, chipsX: chX, noCell, zeroNeg, blocked, blockedHolding, cPairs, cHas };
}
const CONTROL_HUB1 = gridAndCentralFor("hub1", hub1);
const MEASURED_HUB2 = gridAndCentralFor("hub2", hub2);

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "n/a");
console.log(JSON.stringify({
  A_grid: {
    hub2RoutedSneakerProducts: hub2Products,
    hub1RoutedSneakerProducts: hub1Products,
    declaredSizeChips: chips,
    chipsThatRenderX: chipsX,
    chipsXPercent: pct(chipsX, chips),
    ofWhich_noCellAtAll: chipsNoCell,
    ofWhich_zeroOrNegative: chipsZeroOrNeg,
    productsFullyBlocked: fullyBlocked.length,
    productsFullyBlockedButHoldingUnits: fullyBlocked.filter((f) => f.units > 0).length,
    freeSizeTrapProducts: freeSizeTrap.length,
  },
  B_central: {
    hub2FootwearOrderRowsInWindow: h2FootwearRows,
    centralHoldsTheSize: centralHas,
    centralHoldsNone: centralZero,
    centralHasNoCell: centralNoCell,
    wouldOfferOutOfStock: centralZero + centralNoCell,
    wouldOfferOutOfStockPercent: pct(centralZero + centralNoCell, h2FootwearRows),
    catalogueWide_hub2SizePairs: pairs,
    catalogueWide_centralHoldsIt: pairsCentralHas,
    catalogueWide_centralCoverage: pct(pairsCentralHas, pairs),
  },
  C_dualHub: { dualHubSneakerProducts: dual, routedToHub2: dualHub2First, routedToHub1: dualHub1First },
  // THE CONTROL — Hub 1 under the gate that has been live since 2026-08-25.
  D_control: {
    hub1: {
      products: CONTROL_HUB1.products, chips: CONTROL_HUB1.chips,
      chipsX: CONTROL_HUB1.chipsX, chipsXPercent: pct(CONTROL_HUB1.chipsX, CONTROL_HUB1.chips),
      noCell: CONTROL_HUB1.noCell, zeroOrNegative: CONTROL_HUB1.zeroNeg,
      fullyBlockedProducts: CONTROL_HUB1.blocked, fullyBlockedHoldingUnits: CONTROL_HUB1.blockedHolding,
      centralCoverage: pct(CONTROL_HUB1.cHas, CONTROL_HUB1.cPairs),
    },
    hub2: {
      products: MEASURED_HUB2.products, chips: MEASURED_HUB2.chips,
      chipsX: MEASURED_HUB2.chipsX, chipsXPercent: pct(MEASURED_HUB2.chipsX, MEASURED_HUB2.chips),
      noCell: MEASURED_HUB2.noCell, zeroOrNegative: MEASURED_HUB2.zeroNeg,
      fullyBlockedProducts: MEASURED_HUB2.blocked, fullyBlockedHoldingUnits: MEASURED_HUB2.blockedHolding,
      centralCoverage: pct(MEASURED_HUB2.cHas, MEASURED_HUB2.cPairs),
    },
  },
  samples: {
    fullyBlockedHoldingUnits: fullyBlocked.filter((f) => f.units > 0).slice(0, 10),
    freeSizeTrap: freeSizeTrap.slice(0, 10),
    dualHubRoutedToHub2: dualHub2FirstWithHub1Stock.slice(0, 10),
  },
}, null, 2));
process.exit(0);

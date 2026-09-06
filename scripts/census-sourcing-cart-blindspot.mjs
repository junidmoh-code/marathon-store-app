// ── HOW MANY CELLS CAN THE CART FALSELY REFUSE? ──────────────────────────────
// READ-ONLY. Drives the SHIPPED resolver over live /stock, so this is the
// screen's own code path rather than a re-implementation of it.
//
//   node --import ./scripts/lib/appModuleLoader.mjs scripts/census-sourcing-cart-blindspot.mjs
//
// THE FAULT. resolveSneakerSourcingHub decides which hub serves a size from
// cellAvailability alone — booked minus ready-promises — and does NOT subtract
// what the DEVICE'S OWN CART has already committed. sneakerOut subtracts the
// cart afterwards, against whichever hub the resolver already chose. So when
// the tagged hub holds exactly as many units as the cart already has:
//
//   resolver:   avail(tag) > 0        -> "the tag can supply", tag wins
//   sneakerOut: avail(tag) <= inCart  -> ✕
//
// ...and the alternate hub is never consulted, however much it holds. The chip
// refuses a pair that physically exists at the other hub.
//
// With an EMPTY cart the resolver is correct — verified, and that is why the
// #568 before/after report showed nothing. The cart is the only path in.
//
// This counts the cells sitting on that edge, by cart depth.
import { adminRequire } from "./adminRequire.mjs";
const require = adminRequire(import.meta.url);
const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const { cellAvailability, readyPromisedByCell, gatedSneakerHub, GATED_SNEAKER_HUBS } =
  await import("../src/components/stock/availabilityCore.js");
const { decodeSizeKey } = await import("../src/utils/sizeKey.js");
const { readMapPaged } = await import("./lib/rtdbPaged.mjs");

const products = await readMapPaged(db, "products", { pageSize: 500 });
// ── READ ALL OF /orders, PAGED ───────────────────────────────────────────────
// The obvious copy of the TV's ranged read is WRONG here and was: an
// orderByKey range of ["0","9"] returns EIGHT of the 565 customer orders on
// live data (measured 2026-09-06 — RTDB sorts integer-like keys ahead of
// string keys and the bounds do not bracket what they look like they bracket).
// 194 of the ones it drops are status "ready", so the promised map came out
// nearly empty and every availability figure was overstated.
// This is an offline census; paged is bounded and correct. See
// TV_ORDER_KEY_END, which has the same defect on a LIVE screen.
const orders = Object.values(await readMapPaged(db, "orders", { pageSize: 500 }));

const decode = (raw) => {
  const out = {};
  for (const pid of Object.keys(raw || {})) {
    out[pid] = {};
    for (const k of Object.keys(raw[pid] || {})) if (raw[pid][k] != null) out[pid][decodeSizeKey(k)] = raw[pid][k];
  }
  return out;
};
const cells = {};
for (const h of GATED_SNEAKER_HUBS) {
  cells[h] = decode((await db.ref(`stock/${h}`).once("value")).val());
}
const promised = {};
for (const h of GATED_SNEAKER_HUBS) promised[h] = readyPromisedByCell(orders, h, products);

// The app's own routing tag: hubs[] (or hub) narrowed to a gated hub.
const taggedHubOf = (p) => {
  const tags = Array.isArray(p?.hubs) ? p.hubs : (p?.hub ? [p.hub] : []);
  return tags.find((h) => GATED_SNEAKER_HUBS.includes(h)) || null;
};

const byDepth = new Map([[1, []], [2, []], [3, []]]);
let cellsSeen = 0, gatedProducts = 0;
for (const [pid, p] of Object.entries(products)) {
  if (!p?.id || p.mergedInto) continue;
  const tag = taggedHubOf(p);
  if (!tag || !gatedSneakerHub(p, tag)) continue;
  gatedProducts += 1;
  const alt = GATED_SNEAKER_HUBS.find((h) => h !== tag);
  const sizes = (Array.isArray(p.sizes) ? p.sizes : []).filter((x) => x && String(x).trim() && x !== "_");
  for (const size of sizes) {
    cellsSeen += 1;
    const here = cellAvailability({ cells: cells[tag], promised: promised[tag], productId: pid, size });
    const there = cellAvailability({ cells: cells[alt], promised: promised[alt], productId: pid, size });
    if (here <= 0 || there <= 0) continue;          // no cart depth can expose this cell
    for (const depth of [1, 2, 3]) {
      // The fault: the cart exhausts the TAGGED hub, the resolver still picks
      // it because it looked before the cart, and the alternate is never asked.
      if (here <= depth) byDepth.get(depth).push({ pid, name: p.name, size, tag, alt, here, there });
    }
  }
}

console.log(`gated sneaker products: ${gatedProducts} · product/size cells examined: ${cellsSeen}\n`);
console.log("cart depth   cells the cart would FALSELY refuse   units strandable at the other hub");
console.log("──────────   ──────────────────────────────────   ─────────────────────────────────");
for (const [depth, rows] of byDepth) {
  const units = rows.reduce((t, r) => t + r.there, 0);
  console.log(`${String(depth).padEnd(12)} ${String(rows.length).padEnd(36)} ${units}`);
}
const one = byDepth.get(1);
console.log(`\nA cart holding ONE pair is the common case. Worst-affected products:`);
const byProduct = new Map();
for (const r of one) byProduct.set(r.pid, [...(byProduct.get(r.pid) || []), r]);
for (const [pid, rows] of [...byProduct.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
  console.log(`  ${pid}  ${JSON.stringify(rows[0].name).padEnd(46)} ${rows.length} size(s): ` +
    rows.map((r) => `${r.size}(${r.tag}:${r.here}→${r.alt}:${r.there})`).join(" "));
}
console.log(`\n${byProduct.size} distinct product(s) affected at cart depth 1.`);
process.exit(0);

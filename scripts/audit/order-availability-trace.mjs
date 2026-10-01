// ─── ORDER-SCREEN AVAILABILITY TRACE — READ ONLY ─────────────────────────────
//
// WRITES NOTHING. Reproduces, with the SHIPPED modules, what the product order
// sheet's SELECT SIZE grid decides for a sneaker size — selectable or dashed —
// and shows, size by size, where the units the screen does not read are
// actually sitting. Then it generalises across the catalogue.
//
// ── THE CHAIN, AS IT IS IN SOURCE (2026-09-15) ───────────────────────────────
//   src/App.jsx  selectedSizes        = product.sizes minus blank/"_" (declared
//                                       catalogue sizes, NEVER the stock cells;
//                                       a sizeless product gets ["Free Size"])
//   src/App.jsx  computeHubForItem    = Pine device → hub3; else the product's
//                                       `hubs` tag: first of hub1/hub2, default
//                                       hub1 (the tag is an INTENTION — #568)
//   availabilityCore.gatedSneakerHub  = null unless product.category ===
//                                       "Footwear" AND productType !== "clothing"
//                                       AND routed hub ∈ {hub1, hub2}. Null =
//                                       NO GATE: every size is selectable.
//   availabilityCore.resolveSneakerSourcing
//                                     = tagged hub's cell first (booked qty,
//                                       clamped ≥0, minus READY-order promises
//                                       <20 min old, minus this cart); if 0 and
//                                       the other gated hub has settled, that
//                                       hub's cell; else ✕ at the tag.
//   src/App.jsx  sneakerOut           = gate ready && Number.isFinite(available)
//                                       && available <= 0  → dashed tile
//
// PATHS READ BY THE SCREEN: /stock/hub1 and /stock/hub2 (whole-hub streams,
// decoded through decodeSizeKey on the way in — useStock.js decodeByProduct),
// /orders (this device's shop slice; ready promises), /products (live onValue
// subscription — NOT a Hosting artefact), /settings/displaySlots (marker only,
// nets nothing). CENTRAL IS NEVER READ. hub3, the shops and in_transit are
// never read. Pending refill REQUESTS are not subtracted; only ready-order
// promises are. Size keys: the cell map is decoded (stored "5_5" → "5.5") and
// looked up by decodedCellKey(declared size) = decodeSizeKey(stockSizeKey(size)),
// so "5.5" ↔ "5_5" match; a declared " 8" (padded) looks up "_8".
//
// A CLOTHING-typed record takes the other lane (orderSizeOut against the
// serving hub's cell, hub2 for Central-universe shops) and is reported as such.
//
// ── USAGE ────────────────────────────────────────────────────────────────────
//   node --import ./scripts/lib/appModuleLoader.mjs scripts/audit/order-availability-trace.mjs <pid> [<pid>…]
//   node --import ./scripts/lib/appModuleLoader.mjs scripts/audit/order-availability-trace.mjs --all
//   … --from-dump var/policy-coverage-snapshot-<stamp>.json   (replay the census snapshot; /orders is still read live)
//
// Reads are paged (readMapPaged) — never a whole-node /stock or /products read.
// --all reads every /stock location because "holds stock SOMEWHERE" has to
// include Central, hub3, the shops and in_transit to mean anything.

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { adminRequire } from "../adminRequire.mjs";
import { readMapPaged } from "../lib/rtdbPaged.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
// An option that takes a value REFUSES a missing or option-shaped value —
// "--trace --from-dump" must not silently start a live census (CodeRabbit).
const opt = (n) => {
  const i = argv.indexOf(n);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) { console.error(`${n} needs a value`); process.exit(2); }
  return v;
};
const PIDS = argv.filter((a) => /^p\d+$/.test(a));
const DB_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const GATED = ["hub1", "hub2"];

// THE SHIPPED MODULES — driven, not re-implemented.
const { resolveSneakerSourcing, gatedSneakerHub, readyPromisedByCell, cellBlockInfo, promisedKey } =
  await import("../../src/components/stock/availabilityCore.js");
const { decodeSizeKey, decodedCellKey, encodeSizeKey } = await import("../../src/utils/sizeKey.js");

const require = adminRequire(import.meta.url);
const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: DB_URL });
const db = admin.database();

// App.jsx getProductHubs + computeHubForItem, non-Pine device.
const productHubs = (p) => p?.hubs || (p?.hub ? [p.hub] : []);
const routedHub = (p) => productHubs(p).find((h) => h === "hub1" || h === "hub2") || "hub1";
// App.jsx selectedSizes.
// String() on the way out: App.jsx renders whatever the record holds, and a
// numeric size (a record hand-edited in the console) would break padEnd below.
const selectedSizes = (p) => { const real = (p?.sizes || []).filter((s) => s && String(s).trim() && s !== "_").map(String); return real.length ? real : ["Free Size"]; };
// useStock.js decodeByProduct — stored keys decoded on the way in, null holes
// (RTDB array coercion of dense integer keys) dropped.
const decodeRow = (row) => { const out = {}; for (const k of Object.keys(row || {})) if (row[k] != null) out[decodeSizeKey(k)] = row[k]; return out; };
const decodeLoc = (byPid) => Object.fromEntries(Object.entries(byPid || {}).map(([pid, row]) => [pid, decodeRow(row)]));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const cellEntries = (row) => Object.entries(row || {}).filter(([, c]) => c && typeof c === "object");
const createdMs = (pid, p) => (typeof p?.createdBy?.at === "number" ? p.createdBy.at : (/^p(\d{13})$/.exec(pid) ? Number(RegExp.$1) : null));
const isoWeek = (ms) => { if (ms == null) return "unknown"; const d = new Date(ms); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

async function load() {
  const fromDump = opt("--from-dump");
  let products, stock;
  if (fromDump) {
    const snap = JSON.parse(readFileSync(fromDump, "utf8"));
    products = snap.products; stock = snap.stock;
    console.log(`replaying ${fromDump} (read ${snap.readAt}); /orders read live`);
  } else {
    let bytes = 0; const meter = (v) => { bytes += JSON.stringify(v ?? null).length; };
    products = await readMapPaged(db, "products", { pageSize: 400, meter });
    const locations = (await db.ref("locations").once("value")).val() || {};
    const locs = flag("--all") ? [...new Set([...Object.keys(locations), "in_transit"])].sort() : ["central", ...GATED];
    stock = {};
    for (const loc of locs) stock[loc] = await readMapPaged(db, `stock/${loc}`, { pageSize: 400, meter });
    console.log(`live read ${(bytes / 1024 / 1024).toFixed(2)} MB paged (${locs.join(", ")})`);
  }
  // The same /orders slice the verifier script uses: ids are recycled daily and
  // sort as integers (reference_orders_ids_are_recycled) — an admin device sees
  // every shop's slice, so this is the WIDEST promised map any device could have.
  const orders = Object.values((await db.ref("orders").orderByKey().startAt("0").endAt("9").once("value")).val() || {});
  return { products, stock, orders };
}

function hubDataFor(decodedStock, promised) {
  return Object.fromEntries(GATED.map((h) => [h, { cells: decodedStock[h] || {}, promised: promised[h], ready: true }]));
}

// One product, size by size, exactly as the sheet decides it.
function decide(ctx, pid) {
  const { products, stock, decodedStock, hubData } = ctx;
  const p = products[pid];
  const tag = routedHub(p);
  const gate = gatedSneakerHub(p, tag);
  const clothingLane = (p?.productType || "sneaker") === "clothing";
  const sizes = selectedSizes(p);
  const rows = sizes.map((size) => {
    const r = gate ? resolveSneakerSourcing({ product: p, taggedHub: tag, size, hubData }) : { hub: tag, available: null };
    const dashed = !!gate && Number.isFinite(r.available) && r.available <= 0;
    // A clothing-typed record never reaches this resolver: its tile is decided
    // by the clothing lane (hubQty at the serving hub), which this trace does
    // not reproduce — so it must not be reported as "selectable" (CodeRabbit).
    const lane = clothingLane ? "clothing" : gate ? "gated" : "ungated";
    const elsewhere = {};
    for (const loc of Object.keys(stock)) {
      const cell = stock[loc]?.[pid]?.[encodeSizeKey(size === "Free Size" ? "" : size) || "_"];
      const q = cell ? num(cell.qty) : 0;
      if (q > 0 && !GATED.includes(loc)) elsewhere[loc] = q;
    }
    return { size, key: encodeSizeKey(size === "Free Size" ? "" : size) || "_", lookupKey: decodedCellKey(size), hub: r.hub, available: r.available, dashed, lane,
      hub1: cellBlockInfo({ cells: decodedStock.hub1 || {}, promised: ctx.promised.hub1, productId: pid, size }),
      hub2: cellBlockInfo({ cells: decodedStock.hub2 || {}, promised: ctx.promised.hub2, productId: pid, size }),
      elsewhere };
  });
  return { pid, name: p?.name, tag, gate, clothingLane, deactivated: !!p?.deactivated, rows };
}

function trace(ctx, pid) {
  const { products, stock } = ctx;
  const p = products[pid];
  if (!p) { console.log(`\n${pid}: no such product`); return; }
  const d = decide(ctx, pid);
  console.log(`\n══ ${pid} ${JSON.stringify(p.name)}`);
  console.log(`   category=${JSON.stringify(p.category)} categoryKey=${JSON.stringify(p.categoryKey)} productType=${JSON.stringify(p.productType)} hubs=${JSON.stringify(p.hubs ?? p.hub ?? null)} deactivated=${!!p.deactivated} mergedInto=${JSON.stringify(p.mergedInto ?? null)}`);
  console.log(`   declared sizes ${JSON.stringify(p.sizes)} → grid renders ${JSON.stringify(d.rows.map((r) => r.size))}`);
  console.log(`   created ${createdMs(pid, p) ? new Date(createdMs(pid, p)).toISOString() : "unknown"}`);
  console.log(`   routed hub (tag) = ${d.tag}; gate = ${d.gate || "NONE — every size selectable regardless of stock"}${d.clothingLane ? "; CLOTHING LANE (productType clothing) — hubQty against the serving hub, not this resolver" : ""}`);
  // Twins: byte-identical and whitespace/case-normalised names.
  const exact = Object.entries(products).filter(([id, q]) => id !== pid && q?.name === p.name).map(([id]) => id);
  const loose = Object.entries(products).filter(([id, q]) => id !== pid && q?.name !== p.name && norm(q?.name) === norm(p.name)).map(([id, q]) => `${id} ${JSON.stringify(q.name)}`);
  console.log(`   name twins: byte-identical ${exact.length ? exact.join(" ") : "none"}; normalised-only ${loose.length ? loose.join(", ") : "none"}`);
  for (const loc of Object.keys(stock).sort()) {
    const row = stock[loc][pid];
    if (!row) continue;
    console.log(`   stock/${loc}${Array.isArray(row) ? " [array-coerced]" : ""}: ${cellEntries(row).map(([k, c]) => `"${k}"→${num(c.qty)}`).join(", ") || "(row, no cells)"}`);
  }
  console.log(`   ${"size".padEnd(10)}${"stored".padEnd(8)}${"lookup".padEnd(8)}${"hub1 b/p/a".padEnd(13)}${"hub2 b/p/a".padEnd(13)}${"→ hub".padEnd(7)}${"avail".padEnd(7)}tile      units the screen does not read`);
  for (const r of d.rows) {
    const b = (x) => `${x.booked}/${x.promised}/${x.available}`;
    console.log(`   ${r.size.padEnd(10)}${r.key.padEnd(8)}${r.lookupKey.padEnd(8)}${b(r.hub1).padEnd(13)}${b(r.hub2).padEnd(13)}${String(r.hub).padEnd(7)}${String(r.available).padEnd(7)}${r.lane === "clothing" ? "clothing lane — not this resolver" : r.dashed ? "✕ DASHED " : "selectable"} ${Object.entries(r.elsewhere).map(([l, q]) => `${l}:${q}`).join(" ") || "—"}`);
  }
  const dashedWithUnits = d.rows.filter((r) => r.dashed && Object.keys(r.elsewhere).length);
  if (dashedWithUnits.length) console.log(`   ⇒ ${dashedWithUnits.length} dashed size(s) have physical units OUTSIDE hub1/hub2: ${dashedWithUnits.map((r) => `${r.size}@${Object.keys(r.elsewhere).join("+")}`).join(", ")} — by design, the grid reads the two hubs only.`);
  else if (d.rows.some((r) => r.dashed)) console.log(`   ⇒ every dashed size is genuinely at zero across the whole network read.`);
}

async function main() {
  const { products, stock, orders } = await load();
  const decodedStock = Object.fromEntries(GATED.map((h) => [h, decodeLoc(stock[h])]));
  const promised = Object.fromEntries(GATED.map((h) => [h, readyPromisedByCell(orders, h, products)]));
  const ctx = { products, stock, decodedStock, promised, hubData: hubDataFor(decodedStock, promised) };
  console.log(`orders slice: ${orders.length} records; ready promises hub1=${Object.keys(promised.hub1).length} hub2=${Object.keys(promised.hub2).length}`);

  for (const pid of PIDS) trace(ctx, pid);
  if (!flag("--all")) { await admin.app().delete(); return; }

  // ── GENERALISE: gated products that hold stock somewhere and render ZERO selectable sizes ──
  const locs = Object.keys(stock);
  const out = [];
  const lanes = { gated: 0, noGate: 0, clothingLane: 0, deactivated: 0 };
  for (const [pid, p] of Object.entries(products)) {
    if (!p || p.mergedInto) continue;
    if (p.category !== "Footwear" && p.productType !== "sneaker" && !/^(sneakers|slides|boots|loafers|kids-shoes|running-shoes|soccer-boots|designer-shoes)$/.test(String(p.categoryKey || ""))) continue;
    const d = decide(ctx, pid);
    if (d.deactivated) { lanes.deactivated++; continue; }
    if (d.clothingLane) { lanes.clothingLane++; continue; }
    if (!d.gate) { lanes.noGate++; continue; }
    lanes.gated++;
    const holds = {};
    for (const loc of locs) { const u = cellEntries(stock[loc]?.[pid]).reduce((n, [, c]) => n + Math.max(num(c.qty), 0), 0); if (u > 0) holds[loc] = u; }
    if (!Object.keys(holds).length) continue;
    if (!d.rows.every((r) => r.dashed)) continue;
    const hubCell = GATED.some((h) => !!stock[h]?.[pid]);
    out.push({ pid, name: p.name, tag: d.tag, categoryKey: p.categoryKey ?? null, week: isoWeek(createdMs(pid, p)), holds, hubCell, sizes: d.rows.length });
  }
  const where = {};
  for (const r of out) { const k = Object.keys(r.holds).sort().join("+"); where[k] = (where[k] || 0) + 1; }
  const byWeek = {};
  for (const r of out) byWeek[r.week] = (byWeek[r.week] || 0) + 1;
  console.log(`\nGENERALISATION — lanes: gated ${lanes.gated}, no gate (category ≠ "Footwear") ${lanes.noGate}, clothing lane ${lanes.clothingLane}, deactivated ${lanes.deactivated}`);
  console.log(`gated products holding units SOMEWHERE (${locs.join(", ")}) that render ZERO selectable sizes: ${out.length} (${out.reduce((n, r) => n + Object.values(r.holds).reduce((a, b) => a + b, 0), 0)} units)`);
  console.log(`  where the units sit:        ${Object.entries(where).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ") || "—"}`);
  console.log(`  with NO cell at either hub: ${out.filter((r) => !r.hubCell).length} (un-armable by a carriedOnly policy — seated nowhere)`);
  console.log(`  by tag:                     ${["hub1", "hub2"].map((h) => `${h} ${out.filter((r) => r.tag === h).length}`).join(" · ")} (untagged default to hub1: ${out.filter((r) => !productHubs(products[r.pid]).some((h) => h === "hub1" || h === "hub2")).length})`);
  console.log(`  no categoryKey:             ${out.filter((r) => !r.categoryKey).length}`);
  console.log(`  by creation week:           ${Object.entries(byWeek).sort().map(([w, n]) => `${w} ${n}`).join(" · ")}`);
  console.log(`  sample: ${out.slice(0, 12).map((r) => `${r.pid} ${JSON.stringify(r.name)} @${Object.entries(r.holds).map(([l, u]) => `${l}:${u}`).join("+")}`).join("\n          ")}`);
  mkdirSync(join(ROOT, "var"), { recursive: true });
  const f = join(ROOT, "var", `order-availability-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(f, JSON.stringify({ lanes, zeroSelectable: out, where, byWeek }, null, 1));
  console.log(`JSON → ${f}`);
  await admin.app().delete();
}

main().catch((e) => { console.error(e); process.exit(1); });

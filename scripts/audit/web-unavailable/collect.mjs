// ─── WEBSITE UNAVAILABLE LINES — the collector (READ ONLY) ───────────────────
//
//   node scripts/audit/web-unavailable/collect.mjs <cacheDir> [--from 2026-10-18]
//
// WRITES NOTHING to the database or to Shopify. Downloads, once, what the
// analysis needs and keeps it in <cacheDir> so the analysis can be re-run
// without touching the database again. A file already in the cache is not
// read again (delete it to refresh).
//
// HOW IT READS (Junid: no whole-node reads, keep the bandwidth small):
//   online_orders            key-ordered pages of 60 (the subject itself)
//   online_order_refs        key-ordered pages (code → order:line:unit:gen)
//   orders/{code}            exact reads, only the website hub orders
//   displayChecks/{shop}/{day}   one shop-day at a time (no index on kind),
//                            keeping the website-pick records only
//   online_order_agent/log/{day}  one small day node at a time
//   stock_movements          its `ts` index, one day per query, filtered to
//                            the products that appear on website orders
//   search_index             key-ordered pages (names only are kept)
//   stock/{loc}/{pid}, products/{pid}, online_reservations/{pid}
//                            exact reads, only products with a failed line
// The bytes downloaded are printed and stored in meta.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { adminRequire } from "../../adminRequire.mjs";
import { readMapPaged, shallowKeys } from "../../lib/rtdbPaged.mjs";
import { linesOf, pidsOnOrders, failedPids } from "./model.mjs";

const DIR = process.argv[2];
if (!DIR) { console.error("usage: collect.mjs <cacheDir> [--from YYYY-MM-DD]"); process.exit(2); }
const fromArg = process.argv.indexOf("--from");
const FROM_DAY = fromArg > 0 ? process.argv[fromArg + 1] : "2026-10-18";
mkdirSync(DIR, { recursive: true });

const admin = adminRequire(import.meta.url)("firebase-admin");
const app = admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const bytes = {};
const meter = (label) => (v) => { bytes[label] = (bytes[label] || 0) + Buffer.byteLength(JSON.stringify(v ?? null)); };
const get = async (label, path, q = (r) => r) => { const v = (await q(db.ref(path)).get()).val(); meter(label)(v); return v; };
const file = (name) => join(DIR, name);
const cached = async (name, build) => {
  if (existsSync(file(name))) return JSON.parse(readFileSync(file(name), "utf8"));
  const v = await build();
  writeFileSync(file(name), JSON.stringify(v));
  console.log(`  wrote ${name}`);
  return v;
};
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); }
  }));
  return out;
}
const dayList = (from, to) => { const out = []; for (let t = Date.parse(`${from}T00:00:00Z`); t <= to; t += 864e5) out.push(new Date(t).toISOString().slice(0, 10)); return out; };
const DAYS = dayList(FROM_DAY, Date.now() + 864e5);

const orders = await cached("online_orders.json", () => readMapPaged(db, "online_orders", { pageSize: 60, meter: meter("online_orders") }));
console.log(`orders: ${Object.keys(orders).length}`);

const refs = await cached("online_order_refs.json", () => readMapPaged(db, "online_order_refs", { pageSize: 300, meter: meter("online_order_refs") }));
const hubOrders = await cached("hub_orders.json", async () => {
  const codes = new Set(Object.keys(refs));
  for (const o of Object.values(orders)) for (const l of linesOf(o)) {
    for (const k of [...(l.source?.orderKeys || []), ...(l.swappedFrom?.hubOrders || [])]) codes.add(typeof k === "string" ? k : k?.key);
  }
  const list = [...codes].filter(Boolean);
  const rows = await pool(list, 12, (c) => get("orders/{code}", `orders/${c}`));
  return Object.fromEntries(list.map((c, i) => [c, rows[i]]).filter(([, r]) => r && r.channel === "online"));
});
console.log(`hub orders (website): ${Object.keys(hubOrders).length} of ${Object.keys(refs).length} codes`);

const SHOPS = ["marathon-pe", "trophy", "concrete", "marathon-pine"];
const checks = await cached("display_checks.json", async () => {
  // The archive is keyed by push id, and "kind" carries no index, so a day's
  // website picks cannot be asked for by themselves: each shop's day node is
  // read once (about 90 KB) and only the website records are kept.
  const out = {};
  const jobs = SHOPS.flatMap((s) => DAYS.filter((d) => d >= "2026-10-21").map((d) => [s, d]));
  await pool(jobs, 6, async ([shop, day]) => {
    const rows = await get("displayChecks/{shop}/{day}", `displayChecks/${shop}/${day}`) || {};
    for (const [k, r] of Object.entries(rows)) {
      if (r && (r.kind === "online_pick" || r.kind === "online_return")) { const { photoUrl, ...keep } = r; out[`${shop}/${day}/${k}`] = keep; }
    }
  });
  return out;
});
console.log(`display-check website records: ${Object.keys(checks).length}`);

const agentLog = await cached("agent_log.json", async () => {
  const days = await shallowKeys(app, "online_order_agent/log");
  const out = {};
  for (const d of days.sort()) out[d] = await get("online_order_agent/log", `online_order_agent/log/${d}`);
  return out;
});
console.log(`order-agent log days: ${Object.keys(agentLog).length}`);

// Every product a website line ever named: on the order now, before a swap, or
// on a hub order / strip record of a line that has since been swapped again.
const allPids = pidsOnOrders(orders);
for (const h of Object.values(hubOrders)) if (h?.productId) allPids.add(h.productId);
for (const c of Object.values(checks)) if (c?.productId) allPids.add(c.productId);
for (const o of Object.values(orders)) for (const r of Object.values(o.unavailableRequests || {})) if (r?.pid) allPids.add(r.pid);
const movements = await cached("movements.json", async () => {
  const keep = {};
  let total = 0;
  for (const d of DAYS) {
    const rows = await get("stock_movements (ts index, by day)", "stock_movements", (r) => r.orderByChild("ts").startAt(`${d}T00:00:00.000Z`).endAt(`${d}T23:59:59.999Z`)) || {};
    for (const [k, m] of Object.entries(rows)) { total += 1; if (allPids.has(m.productId)) keep[k] = m; }
  }
  console.log(`  movements read ${total}, kept ${Object.keys(keep).length} (products on website orders)`);
  return keep;
});
console.log(`movements kept: ${Object.keys(movements).length}`);

const failed = [...failedPids(orders, hubOrders, checks)];
console.log(`products with a failed line: ${failed.length}`);
const LOCS = ["central", "hub1", "hub2", "hub3", "marathon-pe", "trophy", "concrete", "marathon-pine", "in_transit"];
await cached("stock_now.json", async () => {
  const out = { at: Date.now(), stock: {} };
  await pool(failed, 10, async (pid) => {
    out.stock[pid] = {};
    for (const loc of LOCS) { const v = await get("stock/{loc}/{pid}", `stock/${loc}/${pid}`); if (v) out.stock[pid][loc] = v; }
  });
  return out;
});
await cached("products.json", async () => {
  const out = {};
  await pool(failed, 10, async (pid) => {
    const p = await get("products/{pid}", `products/${pid}`);
    if (!p) return;
    // Keep the identity fields only — photos and long text are not needed.
    out[pid] = Object.fromEntries(Object.entries(p).filter(([k, v]) => typeof v !== "object" || ["sizes", "hubs"].includes(k)).filter(([k]) => !/photo|image|description|thumb/i.test(k)));
  });
  return out;
});
await cached("reservations_now.json", async () => {
  const out = {};
  await pool(failed, 10, async (pid) => { const v = await get("online_reservations/{pid}", `online_reservations/${pid}`); if (v) out[pid] = v; });
  return out;
});

// The live catalogue's names (for "twin or near-identical product names"):
// /search_index/docs holds one small document per listed product. Paged, and only
// the identity fields are kept.
await cached("catalogue_names.json", async () => {
  const idx = await readMapPaged(db, "search_index/docs", { pageSize: 200, meter: meter("search_index (paged)") });
  const out = {};
  for (const [pid, d] of Object.entries(idx)) if (d && typeof d === "object") out[pid] = { name: d.name ?? null, title: d.title ?? null, category: d.category ?? null, colour: d.colour ?? null };
  return out;
});

const totalBytes = Object.values(bytes).reduce((a, b) => a + b, 0);
if (totalBytes) {
  const prev = existsSync(file("meta.json")) ? JSON.parse(readFileSync(file("meta.json"), "utf8")) : { runs: [] };
  prev.runs.push({ at: new Date().toISOString(), fromDay: FROM_DAY, bytes, totalBytes });
  writeFileSync(file("meta.json"), JSON.stringify(prev, null, 1));
}
console.log("bytes downloaded this run:", JSON.stringify(bytes), "total", totalBytes);
process.exit(0);

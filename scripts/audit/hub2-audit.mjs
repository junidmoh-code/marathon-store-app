// ─── HUB 2 AUDIT — REQUESTS, SECTIONS, STUCK-OPEN (READ ONLY, OFFLINE) ───────
//
// WRITES NOTHING. Replays a snapshot saved by scripts/audit/hub2-audit-dump.mjs
// and answers three questions for Junid (1 Nov 2026):
//
//   1. Every Central → Hub 2 request created since the sale-row fix (#787,
//      merged 24 Oct 14:00 SAST): product, size, qty, what sold at Hub 2 and
//      at the shops Hub 2 feeds (Marathon PE, Trophy) in the 30 days before,
//      and whether policy (resolveTarget, the engine's own resolver) asks for
//      it. Flags a request with NO sales basis.
//   2. Section wall: any movement, request or hub order whose two ends sit in
//      different sections (Marathon PE / Trophy / Hub 1 / Hub 2 vs Hub 3 /
//      Concrete / Pine). A person's manual transfer (manual: true) is allowed
//      since #825; anything else crossing is a defect.
//   3. Requests still OPEN although the stock they asked for already arrived.
//
//   node scripts/audit/hub2-audit.mjs --from-dir DIR [--json OUT] [--md OUT] [--since ISO]

import { createRequire } from "module";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const engine = require(join(ROOT, "functions/lib/refill-engine.cjs"));
const net = require(join(ROOT, "functions/lib/network-registry.cjs"));
const { stockCellKey } = require(join(ROOT, "functions/lib/admin-movement.cjs"));

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1]; };
const dir = opt("--from-dir");
if (!dir) { console.error("usage: --from-dir DIR [--json OUT] [--md OUT] [--since ISO]"); process.exit(2); }
const read = (name, fb = {}) => { const f = join(dir, `${name}.json`); return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) ?? fb) : fb; };

const meta = read("_meta", {});
const nowMs = meta.nowMs || Date.now();
const SINCE_MS = Date.parse(opt("--since") || "2026-10-24T12:00:23Z");   // #787 6e5bdd22 merged
const SALES_LOOKBACK_MS = 30 * 864e5;
const config = read("config_refillEngine", {});
const products = read("products");
const targets = read("stock_targets");
const refillRequests = read("refill_requests");
const orders = read("orders");
const network = net.normalizeNetwork ? net.normalizeNetwork(read("network", null)) : net.SEED_REGISTRY;
const movements = Object.values(read("stock_movements")).filter((m) => m && m.productId);
const LOCS = ["central", "hub1", "hub2", "hub3", "marathon-pe", "trophy", "marathon-pine", "concrete"];
const stock = Object.fromEntries(LOCS.map((l) => [l, read(`stock_${l}`)]));
const msOf = (v) => (typeof v === "number" ? v : Date.parse(v || "") || 0);
const name = (pid) => products[pid]?.name || pid;
const LABEL = { central: "Central", hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3", "marathon-pe": "Marathon PE", trophy: "Trophy", "marathon-pine": "Marathon Pine", concrete: "Concrete" };
const L = (l) => LABEL[l] || l;
const cellKey = (s) => stockCellKey(s);
const isFootwear = (p) => /sneak|shoe|slide|boot|sandal|footwear/i.test(`${p?.productType || ""} ${p?.categoryKey || ""} ${p?.category || ""}`);

// Ledger indexes.
const byCell = new Map();   // `${loc}|${pid}|${ck}` → movements touching it, by ts
const push = (k, m) => { if (!byCell.has(k)) byCell.set(k, []); byCell.get(k).push(m); };
for (const m of movements) {
  const ck = cellKey(m.size);
  for (const l of new Set([m.from, m.to].filter(Boolean))) push(`${l}|${m.productId}|${ck}`, m);
}
for (const a of byCell.values()) a.sort((x, y) => msOf(x.ts) - msOf(y.ts));
const cellQtyAt = (loc, pid, ck, atMs) => {
  // `after` of the last movement before atMs; else `before` of the first after; else today's count.
  const rows = byCell.get(`${loc}|${pid}|${ck}`) || [];
  let last = null, next = null;
  for (const m of rows) { if (msOf(m.ts) <= atMs) last = m; else { next = m; break; } }
  if (last && typeof last.after?.[loc] === "number") return last.after[loc];
  if (next && typeof next.before?.[loc] === "number") return next.before[loc];
  const c = stock[loc]?.[pid]?.[ck];
  return typeof c?.qty === "number" ? c.qty : 0;
};
const soldIn = (loc, pid, ck, fromMs, toMs) => (byCell.get(`${loc}|${pid}|${ck}`) || [])
  .filter((m) => m.type === "sold" && m.from === loc && msOf(m.ts) >= fromMs && msOf(m.ts) < toMs)
  .reduce((t, m) => t + (Number(m.qty) || 0), 0);
const soldProductAnySize = (loc, pid, fromMs, toMs) => movements
  .filter((m) => m.type === "sold" && m.from === loc && m.productId === pid && msOf(m.ts) >= fromMs && msOf(m.ts) < toMs)
  .reduce((t, m) => t + (Number(m.qty) || 0), 0);

// ── 1. Central → Hub 2 requests since the fix ────────────────────────────────
const policyCtx = { targets, config, products, stock, network };
const hub2Reqs = [];
for (const [id, rr] of Object.entries(refillRequests)) {
  if (!rr || rr.requestingLocation !== "hub2") continue;
  const src = rr.createdFrom?.source || rr.source || config.routes?.hub2;
  if (src !== "central") continue;
  const at = msOf(rr.createdAt);
  if (at < SINCE_MS) continue;
  if (rr.shadow === true || String(id).startsWith("SHDWrr-")) continue;
  const pid = rr.productId, ck = cellKey(rr.size), from = at - SALES_LOOKBACK_MS;
  let pol = null;
  try { pol = engine.resolveTarget(policyCtx, "hub2", pid, rr.size); } catch { pol = null; }
  const onHand = cellQtyAt("hub2", pid, ck, at);
  const sales = {
    hub2: soldIn("hub2", pid, ck, from, at), pe: soldIn("marathon-pe", pid, ck, from, at), trophy: soldIn("trophy", pid, ck, from, at),
  };
  const salesAnySize = soldProductAnySize("hub2", pid, from, at) + soldProductAnySize("marathon-pe", pid, from, at) + soldProductAnySize("trophy", pid, from, at);
  const sizeSales = sales.hub2 + sales.pe + sales.trophy;
  const target = pol ? pol.target : null;
  // ON HAND BELOW TARGET — a policy basis, NOT a replay of the scan's decision
  // (the scan also nets inbound stock and honours reorderPoint; CodeRabbit #831).
  const policyJustified = !!pol && target > 0 && onHand < target;
  hub2Reqs.push({
    id, at: new Date(at).toISOString(), pid, product: name(pid), size: rr.size, qty: Number(rr.qty) || 0, status: rr.status,
    engine: rr.createdFrom?.engine === true, manual: rr.createdFrom?.engine !== true, createdFrom: rr.createdFrom || null,
    footwear: isFootwear(products[pid]), category: products[pid]?.categoryKey || products[pid]?.category || null,
    onHandAtCreate: onHand, target, policySource: pol ? (targets?.hub2?.[pid]?.[engine.encodeSizeKey(rr.size)] ? "explicit row" : "category policy") : null,
    policyJustified, sales, sizeSales, salesAnySize,
    noSalesBasis: sizeSales === 0,
  });
}
hub2Reqs.sort((a, b) => a.at.localeCompare(b.at));

// ── 2. Section wall ──────────────────────────────────────────────────────────
const sec = (l) => net.sectionOf(network, l);
const crosses = (a, b) => {
  if (!a || !b || a === b) return false;
  const c = net.wallCheck(network, a, b);
  return !c.ok && c.reason === "cross_section";
};
// A held leg goes source → in_transit carrying its real destination
// (transitTo / link.holdDest); the receive leg in_transit → dest carries no
// origin and is judged on its outbound twin (CodeRabbit #831).
const realTo = (m) => (m.to === "in_transit" ? (m.transitTo || m.link?.holdDest || null) : m.to);
const wallMovements = movements.filter((m) => m.from && m.from !== "in_transit" && realTo(m) && crosses(m.from, realTo(m)))
  .map((m) => ({ ts: m.ts, type: m.type, from: m.from, to: realTo(m), viaTransit: m.to === "in_transit", product: name(m.productId), size: m.size, qty: m.qty, manual: m.manual === true, by: m.by?.personName || m.actor || null }));
const wallRequests = Object.entries(refillRequests).filter(([, r]) => r && r.requestingLocation && crosses(r.createdFrom?.source || r.source || config.routes?.[r.requestingLocation], r.requestingLocation))
  .map(([id, r]) => ({ id, at: r.createdAt, from: r.createdFrom?.source || r.source, to: r.requestingLocation, product: name(r.productId), size: r.size, qty: r.qty, status: r.status, engine: r.createdFrom?.engine === true, manual: r.createdFrom?.manual === true || r.manual === true }));
const orderEnds = (o) => {
  const to = o.destShop || o.store || o.placedStore;
  const from = o.hub || o.placedAtHub || o.source;
  return [from, to];
};
const wallOrders = Object.entries(orders).filter(([, o]) => o && typeof o === "object" && (() => { const [a, b] = orderEnds(o); return crosses(a, b); })())
  .map(([id, o]) => { const [a, b] = orderEnds(o); return { id, at: o.createdAt, from: a, to: b, product: o.productName || name(o.productId), size: o.size, status: o.status || null }; });
// Stock of a product held in BOTH sections' hubs/stores is normal (Central feeds both); what is
// reported is stock sitting in a section-1 location that only ever arrived from a section-2 one.
const misplacedStock = [];
for (const loc of ["hub3", "concrete", "marathon-pine", "hub1", "hub2", "marathon-pe", "trophy"]) {
  for (const [pid, row] of Object.entries(stock[loc] || {})) {
    if (!row || typeof row !== "object") continue;
    for (const [ck, c] of Object.entries(row)) {
      if (!c || typeof c !== "object" || !(Number(c.qty) > 0)) continue;
      const ins = (byCell.get(`${loc}|${pid}|${ck}`) || []).filter((m) => m.to === loc && m.from);
      if (!ins.length) continue;
      const lastIn = ins[ins.length - 1];
      if (crosses(lastIn.from, loc) && lastIn.manual !== true) {
        misplacedStock.push({ loc, product: name(pid), size: ck, qty: c.qty, lastArrivalFrom: lastIn.from, at: lastIn.ts, type: lastIn.type });
      }
    }
  }
}

// ── 3. Open requests whose stock already arrived ─────────────────────────────
const stuck = [];
for (const [id, rr] of Object.entries(refillRequests)) {
  if (!rr || rr.status !== "open" || !rr.requestingLocation || !rr.productId) continue;
  const dest = rr.requestingLocation, src = rr.createdFrom?.source || rr.source || config.routes?.[dest];
  const at = msOf(rr.createdAt), ck = cellKey(rr.size);
  const arrivals = (byCell.get(`${dest}|${rr.productId}|${ck}`) || [])
    .filter((m) => m.to === dest && msOf(m.ts) > at && ["transfer_out", "transfer_in", "received"].includes(m.type));
  const arrived = arrivals.reduce((t, m) => t + (Number(m.qty) || 0), 0);
  const linkedTo = (m) => m.link?.refillId === id || String(m.id || "").startsWith(`rrf_${id}`);
  // A receive from in_transit linked to this request came from its source.
  const fromSource = arrivals.filter((m) => m.from === src || (m.from === "in_transit" && linkedTo(m))).reduce((t, m) => t + (Number(m.qty) || 0), 0);
  const sentQty = Number(rr.sentQty) || 0;
  if (arrived <= 0) continue;   // dispatched but not landed is not "arrived" (CodeRabbit #831)
  const linked = arrivals.some(linkedTo);
  let pol = null;
  try { pol = engine.resolveTarget(policyCtx, dest, rr.productId, rr.size); } catch { pol = null; }
  const onHandNow = Number(stock[dest]?.[rr.productId]?.[ck]?.qty) || 0;
  stuck.push({
    id, dest, src, at: rr.createdAt, ageDays: Math.round((nowMs - at) / 864e5 * 10) / 10, product: name(rr.productId), size: rr.size,
    qty: Number(rr.qty) || 0, sentQty, arrived, fromSource, linkedMovement: linked, engine: rr.createdFrom?.engine === true,
    onHandNow, target: pol ? pol.target : null,
    // THE stuck test: the destination already holds its policy target and the
    // request is still open. qty is the REMAINDER after a partial send.
    needMet: !!pol && pol.target > 0 && onHandNow >= pol.target,
  });
}
stuck.sort((a, b) => (b.needMet - a.needMet) || a.at.localeCompare(b.at));

const summary = {
  snapshotAt: new Date(nowMs).toISOString(), since: new Date(SINCE_MS).toISOString(),
  hub2Requests: {
    total: hub2Reqs.length, units: hub2Reqs.reduce((t, r) => t + r.qty, 0),
    engine: hub2Reqs.filter((r) => r.engine).length, nonEngine: hub2Reqs.filter((r) => !r.engine).length,
    belowTargetAtCreate: hub2Reqs.filter((r) => r.policyJustified).length,
    noPolicy: hub2Reqs.filter((r) => !r.target).length,
    noSalesBasis: hub2Reqs.filter((r) => r.noSalesBasis).length,
    noSalesBasisUnits: hub2Reqs.filter((r) => r.noSalesBasis).reduce((t, r) => t + r.qty, 0),
    noSalesAnySize: hub2Reqs.filter((r) => r.salesAnySize === 0).length,
    byStatus: hub2Reqs.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {}),
    footwear: hub2Reqs.filter((r) => r.footwear).length,
  },
  wall: { movements: wallMovements.length, movementsNotManual: wallMovements.filter((m) => !m.manual).length, requests: wallRequests.length, orders: wallOrders.length, misplacedStock: misplacedStock.length },
  stuckOpen: { openWithArrivals: stuck.length, needAlreadyMet: stuck.filter((s) => s.needMet).length },
};
console.log(JSON.stringify(summary, null, 2));
if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify({ summary, hub2Reqs, wallMovements, wallRequests, wallOrders, misplacedStock, stuck }, null, 2));
if (opt("--md")) {
  const esc = (s) => String(s ?? "").replace(/\|/g, "/");
  const md = [];
  md.push("### Central → Hub 2 requests flagged: no sale of that size at Hub 2 / PE / Trophy in the 30 days before", "",
    "| Created (UTC) | Product | Size | Qty | Status | Hub 2 had | Policy target | Policy from | Sold any size (30d) |", "|---|---|---|---|---|---|---|---|---|");
  for (const r of hub2Reqs.filter((x) => x.noSalesBasis)) md.push(`| ${r.at.slice(0, 16)} | ${esc(r.product)} | ${r.size} | ${r.qty} | ${r.status} | ${r.onHandAtCreate} | ${r.target ?? "none"} | ${r.policySource || "—"} | ${r.salesAnySize} |`);
  md.push("", "### Section-wall crossings in the ledger window", "", "| When | Type | From | To | Product | Size | Qty | Manual | By |", "|---|---|---|---|---|---|---|---|---|");
  for (const m of wallMovements) md.push(`| ${String(m.ts).slice(0, 16)} | ${m.type}${m.viaTransit ? " (held)" : ""} | ${L(m.from)} | ${L(m.to)} | ${esc(m.product)} | ${m.size} | ${m.qty} | ${m.manual ? "yes" : "NO"} | ${esc(m.by)} |`);
  md.push("", "### Open requests with stock that arrived after they were raised", "", "| Request | For | From | Created | Product | Size | Still asked | Sent | Arrived | From source | On hand now | Target | Need already met |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of stuck) md.push(`| ${s.id} | ${L(s.dest)} | ${L(s.src)} | ${String(s.at).slice(0, 16)} | ${esc(s.product)} | ${s.size} | ${s.qty} | ${s.sentQty} | ${s.arrived} | ${s.fromSource} | ${s.onHandNow} | ${s.target ?? "none"} | ${s.needMet ? "YES — stuck" : "no"} |`);
  writeFileSync(opt("--md"), md.join("\n") + "\n");
}

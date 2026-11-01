// ─── SOLVE LEGS — where did each shop's batch go? (READ ONLY, OFFLINE) ───────
//
// Junid, 1 Nov 2026: perfumes solved from Central in the last ~10 days show at
// Hub 2 but not at Marathon PE. For every product SOLVED in the window (a
// first-batch request row, or a Solve's seed cell at a shop: mv "seed") this
// lists Central's count and each shop's leg — created / fulfilled / arrived —
// and names why a missing leg is missing:
//   never_created        no request toward the shop at all
//   created_not_fulfilled a request (and its Hub 2 card) is open
//   fulfilled_elsewhere  a send for the shop landed somewhere else
//   arrived              the shop holds it / a send landed
//
//   node scripts/audit/solve-legs-audit.mjs --from-dir DIR [--days 10] [--json OUT] [--md OUT]
// DIR = a snapshot from scripts/audit/hub2-audit-dump.mjs.

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
const dir = opt("--from-dir");
if (!dir) { console.error("usage: --from-dir DIR [--days 10] [--json OUT] [--md OUT]"); process.exit(2); }
const read = (n, fb = {}) => { const f = join(dir, `${n}.json`); return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) ?? fb) : fb; };
const meta = read("_meta", {});
const nowMs = meta.nowMs || Date.now();
const sinceIso = new Date(nowMs - Number(opt("--days", 10)) * 864e5).toISOString();
const products = read("products"), rr = read("refill_requests"), orders = read("orders");
const movements = Object.values(read("stock_movements")).filter((m) => m && m.productId);
const SHOPS = ["marathon-pe", "trophy"];
const stock = Object.fromEntries(["central", "hub2", ...SHOPS].map((l) => [l, read(`stock_${l}`)]));
const qtyAt = (loc, pid) => {
  const row = stock[loc]?.[pid];
  if (!row || typeof row !== "object") return null;
  return Object.values(row).reduce((t, c) => t + (c && typeof c === "object" ? Math.max(0, Number(c.qty) || 0) : 0), 0);
};
const cat = (pid) => products[pid]?.categoryKey || products[pid]?.category || "?";

// Solved products in the window, per shop.
const solved = new Map();   // pid → { at, shops:Set, how:Set }
const note = (pid, at, shop, how) => {
  if (!solved.has(pid)) solved.set(pid, { at, shops: new Set(), how: new Set() });
  const s = solved.get(pid); if (at < s.at) s.at = at; if (shop) s.shops.add(shop); s.how.add(how);
};
for (const r of Object.values(rr)) {
  if (!r || !r.productId || !(r.createdAt >= sinceIso)) continue;
  if (r.createdFrom?.firstBatch === true && SHOPS.includes(r.requestingLocation)) note(r.productId, r.createdAt, r.requestingLocation, "first_batch");
}
for (const shop of SHOPS) {
  for (const [pid, row] of Object.entries(stock[shop] || {})) {
    if (!row || typeof row !== "object") continue;
    for (const c of Object.values(row)) if (c && typeof c === "object" && c.mv === "seed" && (c.updatedAt || "") >= sinceIso) note(pid, c.updatedAt, shop, "seed");
  }
}

const rows = [];
for (const [pid, s] of solved) {
  const hubReqs = Object.entries(rr).filter(([, r]) => r && r.productId === pid && r.requestingLocation === "hub2" && (r.createdAt || "") >= sinceIso);
  const hubIn = movements.filter((m) => m.productId === pid && m.to === "hub2" && m.ts >= sinceIso).reduce((t, m) => t + (Number(m.qty) || 0), 0);
  for (const shop of s.shops) {
    const legs = Object.entries(rr).filter(([, r]) => r && r.productId === pid && r.requestingLocation === shop && (r.createdAt || "") >= sinceIso);
    const open = legs.filter(([, r]) => r.status === "open");
    const fulfilled = legs.filter(([, r]) => r.status === "fulfilled");
    const arrived = movements.filter((m) => m.productId === pid && m.to === shop && m.ts >= sinceIso).reduce((t, m) => t + (Number(m.qty) || 0), 0);
    const cards = Object.values(orders).filter((o) => o && o.productId === pid && o.destShop === shop && o.customerName === "Shop Refill" && o.status === "incoming" && o.clothingRefillStatus == null);
    const why = arrived > 0 ? "arrived"
      : open.length ? "created_not_fulfilled"
      : fulfilled.length ? "fulfilled_elsewhere"
      : legs.length ? "created_then_cancelled"
      : "never_created";
    rows.push({
      pid, product: products[pid]?.name || pid, category: cat(pid), perfume: cat(pid) === "perfumes", shop, solvedAt: s.at, how: [...s.how].join("+"),
      central: qtyAt("central", pid), hub2: qtyAt("hub2", pid), shopQty: qtyAt(shop, pid),
      hub2Leg: { created: hubReqs.length, fulfilled: hubReqs.filter(([, r]) => r.status === "fulfilled").length, arrivedUnits: hubIn },
      shopLeg: {
        created: legs.length, open: open.length, fulfilled: fulfilled.length, arrivedUnits: arrived,
        source: [...new Set(legs.map(([, r]) => r.createdFrom?.source || "?"))].join("/"),
        openSince: open.map(([, r]) => r.createdAt).sort()[0] || null, openQty: open.reduce((t, [, r]) => t + (Number(r.qty) || 0), 0),
        cards: cards.map((o) => o.id),
        cancelReasons: [...new Set(legs.filter(([, r]) => r.status === "cancelled").map(([, r]) => r.cancelReason || "refused"))],
      },
      why,
    });
  }
}
rows.sort((a, b) => (b.perfume - a.perfume) || a.product.localeCompare(b.product) || a.shop.localeCompare(b.shop));
const tally = (list) => list.reduce((a, r) => ((a[r.why] = (a[r.why] || 0) + 1), a), {});
const summary = {
  snapshotAt: new Date(nowMs).toISOString(), since: sinceIso,
  perfume: { solvedShopLegs: rows.filter((r) => r.perfume).length, byWhy: tally(rows.filter((r) => r.perfume)) },
  nonPerfume: { solvedShopLegs: rows.filter((r) => !r.perfume).length, byWhy: tally(rows.filter((r) => !r.perfume)) },
};
console.log(JSON.stringify(summary, null, 2));
if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify({ summary, rows }, null, 2));
if (opt("--md")) {
  const L = { "marathon-pe": "Marathon PE", trophy: "Trophy" };
  const md = ["| Product | Shop | Solved (UTC) | Central | Hub 2 (leg: created/fulfilled/units in) | Shop leg (created/open/fulfilled/units in) | Open since | Hub 2 card(s) | Why |", "|---|---|---|---|---|---|---|---|---|"];
  for (const r of rows.filter((x) => x.perfume)) {
    md.push(`| ${r.product.replace(/\|/g, "/")} | ${L[r.shop] || r.shop} | ${r.solvedAt.slice(0, 16)} | ${r.central ?? "—"} | ${r.hub2 ?? "—"} (${r.hub2Leg.created}/${r.hub2Leg.fulfilled}/${r.hub2Leg.arrivedUnits}) | ${r.shopQty ?? "—"} (${r.shopLeg.created}/${r.shopLeg.open}/${r.shopLeg.fulfilled}/${r.shopLeg.arrivedUnits}) from ${r.shopLeg.source || "—"} | ${r.shopLeg.openSince ? r.shopLeg.openSince.slice(0, 16) : "—"} | ${r.shopLeg.cards.join(", ") || "—"} | ${r.why} |`);
  }
  writeFileSync(opt("--md"), md.join("\n") + "\n");
}

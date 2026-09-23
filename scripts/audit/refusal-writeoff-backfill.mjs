// ─── REFUSAL WRITE-OFF — BACKFILL LIST + BEFORE/AFTER (READ ONLY) ─────────────
//
// WRITES NOTHING. The backfill itself is not a separate writer: the rule in
// functions/lib/refusal-writeoff.cjs reads the FULL refusal history in
// /refill_requests on every scan, so the first refillHealthScan after deploy
// applies it — once, through applyMovementAdmin, with the per-cell cursor
// guaranteeing no run is ever written off twice — to everything that meets the
// four-distinct-days rule today: the sizes on Recount Needed, the sizes Central
// refused, and any older Hub 2 run whose Recount Needed row had already gone
// stale. No new read is needed for it (every input is one the scan already
// makes), so there is no whole-node read to add.
//
// This script replays EXACTLY that first pass against a saved snapshot of the
// scan's own reads, and prints what it will do and what the dashboard will look
// like afterwards:
//
//   • the full list — product, size, location, units, refusal dates and who
//     refused (the Central queue records the account; Hub 2's refusals of shop
//     orders never recorded a person, only the hub — said so, not guessed)
//   • totals per location
//   • Recount Needed before → after, with what is left and why
//   • Short but not requested before → after
//
//   node scripts/audit/refusal-writeoff-backfill.mjs --from-dir DIR [--json OUT] [--md OUT]
//
// DIR is the census layout (scripts/audit/short-not-requested-census.mjs):
// one JSON per scan read, "/" → "_", plus an optional users.json
// ({uid: displayName}) for the refusers' names. The ledger window is the
// scan's (45 days before --now, default: now).

import { createRequire } from "module";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const engine = require(join(ROOT, "functions/lib/refill-engine.cjs"));
const wo = require(join(ROOT, "functions/lib/refusal-writeoff.cjs"));
const { stockCellKey } = require(join(ROOT, "functions/lib/admin-movement.cjs"));

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1]; };
const dir = opt("--from-dir");
if (!dir) { console.error("usage: --from-dir DIR [--json OUT] [--md OUT] [--now ISO]"); process.exit(2); }
const nowMs = opt("--now") ? Date.parse(opt("--now")) : Date.now();
const WINDOW_DAYS = 45;   // functions/refill-scan.cjs MOVEMENTS_WINDOW_DAYS

const read = (name, fallback = {}) => {
  const f = join(dir, `${name}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) ?? fallback) : fallback;
};
const config = read("config_refillEngine", null);
if (!config) { console.error("config_refillEngine.json missing"); process.exit(2); }
const locs = [...new Set([...Object.keys(config.routes || {}), ...Object.values(config.routes || {})])];
const stock = Object.fromEntries(locs.map((l) => [l, read(`stock_${l}`)]));
const products = read("products");
const refillRequests = read("refill_requests");
const movements = Object.values(read("stock_movements"));
const rejectStreak = read("refill_engine_rejectStreak");
const users = read("users");
const base = {
  nowMs, config, targets: read("stock_targets"), products, openIndex: read("refill_engine_open"),
  orders: read("orders"), targetDecisions: read("stock_targets_decisions"), retryState: read("refill_engine_retryState"),
  heldLines: read("settings_stockHold_held"), uncapped: true,
};

const before = engine.computeRefillPlan({ ...base, stock, refillRequests, movements, rejectStreak });

// ── the first scan's pass, replayed in memory ────────────────────────────────
const snap = {
  nowMs, config, products, refillRequests, rejectStreak: structuredClone(rejectStreak),
  stock: structuredClone(stock), movements: [...movements],
  cursors: read("refill_engine_refusalWriteoffCursor"), windowStartMs: nowMs - WINDOW_DAYS * 864e5,
};
const plan = wo.planRefusalWriteoffs(snap);
const routes = config.routes || {};
for (const w of plan.writeoffs) {
  const row = snap.stock[w.loc][w.pid];
  row[w.cellKey] = { ...row[w.cellKey], qty: row[w.cellKey].qty - w.qty, mv: w.id, lastType: "adjustment" };
  snap.movements.push({ type: "refusal_writeoff", productId: w.pid, size: w.size, qty: w.qty, from: w.loc, ts: new Date(nowMs).toISOString(), before: { [w.loc]: w.paperQty }, after: { [w.loc]: w.paperQty - w.qty } });
  const sk = engine.encodeSizeKey(w.size);
  for (const dest of Object.keys(snap.rejectStreak)) {
    const s = snap.rejectStreak[dest]?.[w.pid]?.[sk];
    if (s && (s.by || routes[dest]) === w.loc) delete snap.rejectStreak[dest][w.pid][sk];
  }
}
const after = engine.computeRefillPlan({ ...base, stock: snap.stock, refillRequests, movements: snap.movements, rejectStreak: snap.rejectStreak });

// ── report ───────────────────────────────────────────────────────────────────
const LABEL = { hub1: "Hub 1", hub2: "Hub 2", central: "Central", "marathon-pe": "Marathon PE", trophy: "Trophy" };
const L = (l) => LABEL[l] || l;
const name = (pid) => products[pid]?.name || pid;
const who = (r) => {
  if (r.byUid) return users[r.byUid] || `account ${r.byUid.slice(0, 6)}…`;
  if (r.byRole) return `${r.byRole} account (no name recorded)`;
  return "no name recorded";
};
const onRecountBefore = new Set(before.exceptions.recountNeeded.items.map((r) => `${r.source}|${r.pid}|${stockCellKey(r.size)}`));
const rows = plan.writeoffs.map((w) => ({
  product: name(w.pid), size: w.size, location: L(w.loc), units: w.qty, paper: w.paperQty, kept: w.paperQty - w.qty,
  days: w.days, refusals: w.refusals.map((r) => ({ day: r.day, forShop: L(r.dest), by: who(r) })),
  wasOnRecountNeeded: onRecountBefore.has(`${w.loc}|${w.pid}|${w.cellKey}`),
  footwear: engine.passThroughExcluded(products[w.pid]) || /shoe|sneak|slide|boot/i.test(String(products[w.pid]?.categoryKey || products[w.pid]?.category || "")),
  pid: w.pid, loc: w.loc,
})).sort((a, b) => a.location.localeCompare(b.location) || a.product.localeCompare(b.product) || String(a.size).localeCompare(String(b.size)));

const perLoc = {};
for (const r of rows) { const p = (perLoc[r.location] ||= { sizes: 0, units: 0 }); p.sizes++; p.units += r.units; }
const why = (items) => items.reduce((a, r) => {
  const k = r.countDisputed ? "count disputed (routed round)" : r.rejections == null ? "refused at both levels, still counted" : `refused ${r.rejections}× — fewer than 4 different days, or deferred`;
  a[k] = (a[k] || 0) + 1; return a;
}, {});
const summary = {
  at: new Date(nowMs).toISOString(),
  writtenOff: { sizes: rows.length, units: rows.reduce((t, r) => t + r.units, 0), perLocation: perLoc },
  deferred: plan.deferred.reduce((a, d) => ((a[d.reason] = (a[d.reason] || 0) + 1), a), {}),
  recountNeeded: { before: before.exceptions.recountNeeded.count, after: after.exceptions.recountNeeded.count, remainingWhy: why(after.exceptions.recountNeeded.items) },
  shortNotRequested: { before: before.exceptions.shortNotRequested.count, after: after.exceptions.shortNotRequested.count,
    byReasonBefore: before.exceptions.shortNotRequested.byReason, byReasonAfter: after.exceptions.shortNotRequested.byReason },
};
console.log(JSON.stringify(summary, null, 2));

// What is still on Recount Needed, one line each, with the reason in words.
const remaining = after.exceptions.recountNeeded.items.map((r) => {
  const src = r.source, sk = stockCellKey(r.size);
  const d = plan.deferred.find((x) => x.loc === src && x.pid === r.pid && x.cellKey === sk);
  const refusedDays = new Set(Object.values(refillRequests).filter((q) => q && q.productId === r.pid && stockCellKey(q.size) === sk
    && wo.refusingLocation(q, routes) === src && q.status === "cancelled" && !q.cancelReason).map((q) => wo.sastDay(Date.parse(q.resolvedAt))));
  const reason = d ? (d.reason === "request_open" ? "a request to that location is open right now — it is written off the scan after it is refused again (or kept if it is fulfilled)" : "its refusals are older than the 45-day ledger and the cell has been written since — cannot prove what arrived")
    : r.countDisputed ? "Central already sent stock round the disputed count; clears on a count, an adjust, or a write-off"
    : refusedDays.size < 4 ? `refused on only ${refusedDays.size} different day${refusedDays.size === 1 ? "" : "s"} (needs 4)`
    : "a fulfilment of the size came after some of the refusals, restarting the count";
  return { product: name(r.pid), size: r.size, for: L(r.loc), at: L(src), showing: r.showing, reason };
});

if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify({ summary, rows, remaining }, null, 2));
if (opt("--md")) {
  const md = [];
  md.push(`| # | Product | Size | Location | Units written off | Left on paper | Refusal dates (SAST) | Refused by |`);
  md.push(`|---|---|---|---|---|---|---|---|`);
  rows.forEach((r, i) => {
    const byWho = [...new Set(r.refusals.map((x) => x.by))].join("; ");
    md.push(`| ${i + 1} | ${r.product.replace(/\|/g, "/")} | ${r.size || "one size"} | ${r.location} | ${r.units} | ${r.kept} | ${r.days.join(", ")} | ${byWho} |`);
  });
  md.push("", "**Still on Recount Needed after the pass**", "", "| Product | Size | For | Counted at | Showing | Why it stays |", "|---|---|---|---|---|---|");
  for (const r of remaining) md.push(`| ${r.product.replace(/\|/g, "/")} | ${r.size || "one size"} | ${r.for} | ${r.at} | ${r.showing} | ${r.reason} |`);
  writeFileSync(opt("--md"), md.join("\n") + "\n");
}

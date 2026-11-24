// ─── WEBSITE UNAVAILABLE LINES — single pieces by time untouched (READ ONLY) ──
//
//   node scripts/audit/web-unavailable/stale-age.mjs <cacheDir> <outDir> [olderMovements.json]
//
// Junid, 24 Nov 2026 (second brief, Commit 6): the failure rate of a website
// pick sent to a shelf showing exactly ONE free piece, by how long that shelf
// had sat untouched when the order came in — 14, 30, 60 and 90 days — per place.
// Works on the cache collect.mjs left (no database read). The optional third
// file is older ledger rows for the cells whose age the five-week cache cannot
// say (stale-age-collect.mjs writes it and lists what it needs).
//
// HOW AN AGE IS KNOWN. (1) a movement on the cell before the order, in the
// ledger rows held; else (2) the cell's own `updatedAt` stamp when it is older
// than the order (nothing has touched it since: the stamp IS the last touch);
// else (3) UNKNOWN beyond "at least since the ledger rows start". Unknowns are
// counted in a threshold only when that lower bound already passes it, and are
// reported beside every figure.
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseRefOwner, parseCheckKey } from "./model.mjs";

const [CACHE, OUT, OLDER] = process.argv.slice(2);
if (!CACHE || !OUT) { console.error("usage: stale-age.mjs <cacheDir> <outDir> [olderMovements.json]"); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const R = (f, d = {}) => { try { return JSON.parse(readFileSync(f.startsWith("/") ? f : join(CACHE, f), "utf8")); } catch { return d; } };
const orders = R("online_orders.json"), refs = R("online_order_refs.json"), hubOrders = R("hub_orders.json"), checks = R("display_checks.json");
const stockNow = R("stock_now.json", { stock: {} });
const movementsRaw = { ...(OLDER ? R(OLDER) : {}), ...R("movements.json") };
const FIRST_ORDER = 1768;
const sk = (s) => { const v = String(s ?? "").trim(); return v === "" ? "_" : v.replace(/\./g, "_"); };
const ms = (v) => (typeof v === "number" ? v : v ? Date.parse(v) : null);
const LOC_NAME = { hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3", "marathon-pe": "Marathon PE", trophy: "Trophy", concrete: "Concrete", "marathon-pine": "Pine" };
export const THRESHOLDS = [14, 30, 60, 90];

const mvBy = new Map();
for (const [id, m] of Object.entries(movementsRaw)) {
  const key = `${m.productId}|${sk(m.size)}`;
  if (!mvBy.has(key)) mvBy.set(key, []);
  mvBy.get(key).push({ id, ...m, t: ms(m.ts) });
}
for (const list of mvBy.values()) list.sort((a, b) => a.t - b.t);
const WINDOW_START = Math.min(...Object.values(movementsRaw).map((m) => ms(m.ts)));
const cellNow = (pid, size, loc) => stockNow.stock?.[pid]?.[loc]?.[sk(size)] ?? null;
const qtyOf = (c) => (c == null ? 0 : typeof c === "object" ? Number(c.qty) || 0 : Number(c) || 0);
const touches = (m, loc) => m.from === loc || m.to === loc || (m.after && m.after[loc] != null);
function stockAt(pid, size, loc, T) {
  const list = mvBy.get(`${pid}|${sk(size)}`) || [];
  let last = null;
  for (const m of list) { if (m.t > T) break; if (m.after && m.after[loc] != null) last = m; }
  if (last) return Math.max(0, Number(last.after[loc]) || 0);
  const next = list.find((m) => m.t > T && m.before && m.before[loc] != null);
  if (next) return Math.max(0, Number(next.before[loc]) || 0);
  if (!stockNow.stock?.[pid]) return null;
  return Math.max(0, qtyOf(cellNow(pid, size, loc)));
}
const scope = new Set(Object.entries(orders).filter(([, o]) => Number(o.orderNumber) >= FIRST_ORDER).map(([id]) => id));
const orderAt = (id) => ms(orders[id]?.createdAt);
// Other website orders' pieces at the place when this order came in (first-route lines only: what routing saw).
const linesOf = (o) => (Array.isArray(o?.lines) ? o.lines.map((l, i) => [i, l]) : Object.entries(o?.lines || {}).map(([k, l]) => [Number(k), l])).filter(([, l]) => l);
const endOf = (o) => ms(o.pack?.at) || ms(o.shopifyCancelledAt) || (["packed", "cancelled", "closed", "fulfilled_elsewhere"].includes(o.status) ? ms(o.updatedAt) : Infinity);
function heldByOthers(pid, size, loc, T, self) {
  let n = 0;
  for (const id of scope) {
    if (id === self) continue; const o = orders[id]; const at = ms(o.createdAt);
    if (!(at <= T) || endOf(o) <= T) continue;
    for (const [, l] of linesOf(o)) if (l.pid === pid && sk(l.sizeKey ?? l.size) === sk(size) && (l.source?.locationId === loc || l.firstSource?.locationId === loc)) n += Number(l.qty) || 1;
  }
  return n;
}

const attempts = [];
for (const [code, h] of Object.entries(hubOrders)) {
  const owner = parseRefOwner(refs[code]?.orderId);
  const base = { orderId: String(h.onlineOrderId), line: Number(h.onlineLineIndex), gen: owner.gen, pid: h.productId, size: sk(h.size), loc: h.hub };
  if (h.status === "out_of_stock") attempts.push({ ...base, ok: false });
  else if (h.status === "ready" || h.status === "collected") attempts.push({ ...base, ok: true });
}
for (const [path, c] of Object.entries(checks)) {
  if (c.kind !== "online_pick") continue;
  const key = parseCheckKey(c.dedupeKey) || {};
  const base = { orderId: String(c.orderId), line: Number(c.lineIndex), gen: key.gen || 0, pid: c.productId, size: sk(c.sizeKey ?? c.size), loc: path.split("/")[0] };
  if (c.result === "not_found") attempts.push({ ...base, ok: false });
  else if (c.result === "handed") attempts.push({ ...base, ok: true });
}

const singles = []; // one per first-route pick sent to a shelf showing one free piece
const need = [];    // cells whose age the rows held cannot say
for (const a of attempts) {
  if (!scope.has(a.orderId) || a.gen > 0) continue;
  const T = orderAt(a.orderId);
  const q = stockAt(a.pid, a.size, a.loc, T);
  if (q == null || Math.max(0, q - heldByOthers(a.pid, a.size, a.loc, T, a.orderId)) !== 1) continue;
  const list = mvBy.get(`${a.pid}|${a.size}`) || [];
  let touch = null;
  for (const m of list) { if (m.t > T) break; if (touches(m, a.loc)) touch = m.t; }
  const stamp = ms(cellNow(a.pid, a.size, a.loc)?.updatedAt);
  if (touch == null && stamp != null && stamp < T) touch = stamp;
  const days = touch != null ? (T - touch) / 864e5 : null;
  const atLeast = (T - WINDOW_START) / 864e5;
  singles.push({ ...a, T, days, atLeast });
  if (days == null) need.push({ pid: a.pid, size: a.size, loc: a.loc, T });
}

const row = () => ({ picked: 0, rejected: 0, unknown: 0 });
const table = {};
const add = (k, s, x) => { const b = ((table[k] ||= {})[x] ||= row()); if (s.ok) b.picked += 1; else b.rejected += 1; };
for (const s of singles) {
  for (const who of ["All places", LOC_NAME[s.loc] || s.loc]) {
    add(who, s, "any age");
    for (const d of THRESHOLDS) {
      const known = s.days != null ? s.days >= d : s.atLeast >= d ? true : null;
      if (known === true) add(who, s, `${d}+ days`);
      else if (known === null) ((table[who] ||= {})[`${d}+ days`] ||= row()).unknown += 1;
    }
    // Exclusive bands, known ages only.
    if (s.days != null) add(who, s, s.days < 14 ? "under 14" : s.days < 30 ? "14 to 29" : s.days < 60 ? "30 to 59" : s.days < 90 ? "60 to 89" : "90 and over");
  }
}
const pct = (b) => (b.picked + b.rejected ? Math.round((1000 * b.rejected) / (b.picked + b.rejected)) / 10 : null);
const out = { windowStart: new Date(WINDOW_START).toISOString(), singles: singles.length, ageUnknown: need.length, table: Object.fromEntries(Object.entries(table).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([x, b]) => [x, { ...b, lines: b.picked + b.rejected, failedPct: pct(b) }]))])) };
writeFileSync(join(OUT, "stale-age.json"), JSON.stringify(out, null, 1));
writeFileSync(join(OUT, "stale-age-need.json"), JSON.stringify(need));
const cols = ["any age", ...THRESHOLDS.map((d) => `${d}+ days`), "under 14", "14 to 29", "30 to 59", "60 to 89", "90 and over"];
const md = [`| Place | ${cols.join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`];
for (const [who, v] of Object.entries(out.table).sort((a, b) => (a[0] === "All places" ? -1 : b[0] === "All places" ? 1 : b[1]["any age"].lines - a[1]["any age"].lines))) {
  md.push(`| ${who} | ${cols.map((c) => { const b = v[c]; return b ? `${b.rejected} of ${b.lines}${b.lines ? ` (${b.failedPct}%)` : ""}${b.unknown ? ` +${b.unknown}?` : ""}` : "0"; }).join(" | ")} |`);
}
writeFileSync(join(OUT, "stale-age.md"), md.join("\n") + "\n");
console.log(`single-piece picks: ${singles.length}; age unknown: ${need.length}; rows start ${out.windowStart}`);
console.log(md.join("\n"));

// ─── WEBSITE UNAVAILABLE LINES — the new routing, replayed over the five weeks ─
//
//   node scripts/audit/web-unavailable/replay-routing.mjs <cacheDir> <outDir> [olderMovements.json] [--fetch]
//
// Junid's question (24 Nov 2026): how many lines would "the most trustworthy
// place first" have sent to a different place, and how many failures would
// that have avoided? For every first pick of a website line since #1768 this
// rebuilds what each place on its chain showed when the order came in (the
// ledger's own before/after), scores each shelf with the SAME function the
// poller uses (routing.mjs shelfRisk / chainOrder, default settings), and
// compares the place the new order picks with the place the line really went.
//
// READ ONLY. Works on the cache; --fetch reads the handful of stock cells the
// cache lacks (exact paths: products that never failed but were picked from a
// doubtful shelf) and says how many bytes that was.
//
// WHAT IT CANNOT KNOW: whether the other place would really have had the piece.
// "Avoided" is therefore given two ways — every failure that would have gone to
// a trusted shelf instead, and that number scaled by how often trusted shelves
// delivered in the same five weeks.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseRefOwner, parseCheckKey } from "./model.mjs";
import { shelfRisk, chainOrder, routingRulesFrom, routeFor } from "../../shopify/onlineOrders/routing.mjs";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [CACHE, OUT, OLDER] = args;
const FETCH = process.argv.includes("--fetch");
if (!CACHE || !OUT) { console.error("usage: replay-routing.mjs <cacheDir> <outDir> [olderMovements.json] [--fetch]"); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const R = (f, d = {}) => { try { return JSON.parse(readFileSync(f.startsWith("/") ? f : join(CACHE, f), "utf8")); } catch { return d; } };
const orders = R("online_orders.json"), refs = R("online_order_refs.json"), hubOrders = R("hub_orders.json"), checks = R("display_checks.json");
const stockNow = R("stock_now.json", { stock: {} });
const extraFile = join(CACHE, "stock_extra.json");
const stockExtra = R("stock_extra.json", { stock: {} });
const movementsRaw = { ...(OLDER ? R(OLDER) : {}), ...R("movements.json") };
const FIRST_ORDER = 1768;
const sk = (s) => { const v = String(s ?? "").trim(); return v === "" ? "_" : v.replace(/\./g, "_"); };
const ms = (v) => (typeof v === "number" ? v : v ? Date.parse(v) : null);
const NAME = { hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3", "marathon-pe": "Marathon PE", trophy: "Trophy", concrete: "Concrete", "marathon-pine": "Pine", central: "Central" };
const rules = routingRulesFrom(null);

const mvBy = new Map();
for (const [id, m] of Object.entries(movementsRaw)) { const key = `${m.productId}|${sk(m.size)}`; if (!mvBy.has(key)) mvBy.set(key, []); mvBy.get(key).push({ id, ...m, t: ms(m.ts) }); }
for (const list of mvBy.values()) list.sort((a, b) => a.t - b.t);
const WINDOW_START = Math.min(...Object.values(R("movements.json")).map((m) => ms(m.ts)));
const cellsOf = (pid) => stockNow.stock?.[pid] || stockExtra.stock?.[pid] || null;
const cellNow = (pid, size, loc) => cellsOf(pid)?.[loc]?.[sk(size)] ?? null;
const qtyOf = (c) => (c == null ? 0 : typeof c === "object" ? Number(c.qty) || 0 : Number(c) || 0);
const touches = (m, loc) => m.from === loc || m.to === loc || (m.after && m.after[loc] != null);
function stockAt(pid, size, loc, T) {
  const list = mvBy.get(`${pid}|${sk(size)}`) || [];
  let last = null;
  for (const m of list) { if (m.t > T) break; if (m.after && m.after[loc] != null) last = m; }
  if (last) return Math.max(0, Number(last.after[loc]) || 0);
  const next = list.find((m) => m.t > T && m.before && m.before[loc] != null);
  if (next) return Math.max(0, Number(next.before[loc]) || 0);
  if (!cellsOf(pid)) return null;
  return Math.max(0, qtyOf(cellNow(pid, size, loc)));
}
function stampAt(pid, size, loc, T) {
  let touch = null;
  for (const m of mvBy.get(`${pid}|${sk(size)}`) || []) { if (m.t > T) break; if (touches(m, loc)) touch = m.t; }
  const stamp = ms(cellNow(pid, size, loc)?.updatedAt);
  if (touch == null && stamp != null && stamp < T) touch = stamp;
  // Nothing in the rows held: untouched at least since they start (25 Jul with the older rows) — stale by any setting.
  return touch ?? Math.min(WINDOW_START, T - 91 * 864e5);
}
const scope = new Set(Object.entries(orders).filter(([, o]) => Number(o.orderNumber) >= FIRST_ORDER).map(([id]) => id));
const orderAt = (id) => ms(orders[id]?.createdAt);
const linesOf = (o) => (Array.isArray(o?.lines) ? o.lines.map((l, i) => [i, l]) : Object.entries(o?.lines || {}).map(([k, l]) => [Number(k), l])).filter(([, l]) => l);
const endOf = (o) => ms(o.pack?.at) || ms(o.shopifyCancelledAt) || (["packed", "cancelled", "closed", "fulfilled_elsewhere"].includes(o.status) ? ms(o.updatedAt) : Infinity);

const attempts = [];
for (const [code, h] of Object.entries(hubOrders)) {
  const owner = parseRefOwner(refs[code]?.orderId);
  const base = { orderId: String(h.onlineOrderId), line: Number(h.onlineLineIndex), gen: owner.gen, pid: h.productId, size: sk(h.size), loc: h.hub, name: h.productName };
  if (h.status === "out_of_stock") attempts.push({ ...base, ok: false, at: ms(h.outOfStockAt) });
  else if (h.status === "ready" || h.status === "collected") attempts.push({ ...base, ok: true, at: ms(h.readyAt) || ms(h.collectedAt) || ms(h.updatedAt) });
}
for (const [path, c] of Object.entries(checks)) {
  if (c.kind !== "online_pick") continue;
  const key = parseCheckKey(c.dedupeKey) || {};
  const base = { orderId: String(c.orderId), line: Number(c.lineIndex), gen: key.gen || 0, pid: c.productId, size: sk(c.sizeKey ?? c.size), loc: path.split("/")[0], name: c.productName };
  if (c.result === "not_found") attempts.push({ ...base, ok: false, at: c.completedAt });
  else if (c.result === "handed") attempts.push({ ...base, ok: true, at: c.completedAt });
}
const first = attempts.filter((a) => scope.has(a.orderId) && a.gen === 0);
// Pieces other website orders held at a place when this order came in: their first pick there, still open.
const firstAt = new Map(first.map((a) => [`${a.orderId}:${a.line}`, a]));
function heldByOthers(pid, size, loc, T, self) {
  let n = 0;
  for (const a of first) {
    if (a.orderId === self || a.pid !== pid || a.size !== size || a.loc !== loc) continue;
    const o = orders[a.orderId];
    if (orderAt(a.orderId) <= T && Math.min(endOf(o), a.ok ? Infinity : a.at ?? Infinity) > T) n += 1;
  }
  return n;
}
const lastRejection = (pid, size, loc, T) => { let t = null; for (const a of attempts) if (!a.ok && a.pid === pid && a.size === size && a.loc === loc && a.at && a.at < T && (t == null || a.at > t)) t = a.at; return t; };

// The cells the cache lacks, for lines whose own shelf was doubtful (the only lines the new order can move).
const need = new Set();
const scoreOwn = (a) => {
  const T = orderAt(a.orderId);
  const q = stockAt(a.pid, a.size, a.loc, T);
  if (q == null) return null;
  const free = Math.max(0, q - heldByOthers(a.pid, a.size, a.loc, T, a.orderId));
  return shelfRisk({ free: Math.max(free, 1), stampMs: stampAt(a.pid, a.size, a.loc, T), rejectedAt: lastRejection(a.pid, a.size, a.loc, T), nowMs: T, rules });
};
for (const a of first) { const r = scoreOwn(a); if (r?.risky && !cellsOf(a.pid)) need.add(a.pid); }
if (need.size && FETCH) {
  const { adminRequire } = await import("../../adminRequire.mjs");
  const admin = adminRequire(import.meta.url)("firebase-admin");
  admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
  let bytes = 0;
  for (const pid of need) {
    stockExtra.stock[pid] = {};
    for (const loc of Object.keys(NAME)) { const v = (await admin.database().ref(`stock/${loc}/${pid}`).get()).val(); bytes += JSON.stringify(v ?? null).length; if (v) stockExtra.stock[pid][loc] = v; }
  }
  writeFileSync(extraFile, JSON.stringify(stockExtra));
  console.log(`fetched the stock cells of ${need.size} product(s): ${bytes} bytes`);
} else if (need.size) console.log(`${need.size} product(s) picked from a doubtful shelf have no cells in the cache (run with --fetch): their lines are counted as "elsewhere unknown"`);

const out = { lines: 0, sameRisky: 0, moved: [], unknownElsewhere: 0, riskyOnlyPlace: { picked: 0, rejected: 0 }, trusted: { picked: 0, rejected: 0 }, risky: { picked: 0, rejected: 0 } };
for (const a of first) {
  const T = orderAt(a.orderId);
  const own = scoreOwn(a);
  if (!own) continue;
  out.lines += 1;
  const bucket = own.risky ? out.risky : out.trusted;
  if (a.ok) bucket.picked += 1; else bucket.rejected += 1;
  if (!own.risky) continue; // the old order took the first place with stock; if that shelf is trusted the new order takes it too
  if (!cellsOf(a.pid) && !(mvBy.get(`${a.pid}|${a.size}`) || []).length) { out.unknownElsewhere += 1; continue; }
  // Footwear or not: the order line's own flag (what routing used); the place it went decides when the flag is missing.
  const flag = linesOf(orders[a.orderId]).find(([i]) => i === a.line)?.[1]?.isFootwear;
  const isFootwear = typeof flag === "boolean" ? flag : ["hub1", "hub3"].includes(a.loc);
  const risk = {}, free = {};
  for (const step of routeFor(isFootwear)) {
    const loc = step.locationId;
    const q = loc === a.loc ? Math.max(1, stockAt(a.pid, a.size, loc, T) ?? 1) : stockAt(a.pid, a.size, loc, T) ?? 0;
    free[loc] = Math.max(0, q - heldByOthers(a.pid, a.size, loc, T, a.orderId));
    if (loc === a.loc) free[loc] = Math.max(1, free[loc]);
    if (free[loc] > 0) risk[loc] = shelfRisk({ free: free[loc], stampMs: stampAt(a.pid, a.size, loc, T), rejectedAt: lastRejection(a.pid, a.size, loc, T), nowMs: T, rules });
  }
  const to = chainOrder(isFootwear, risk).find((s) => free[s.locationId] > 0);
  if (!to || to.locationId === a.loc) {
    out.sameRisky += 1;
    const others = routeFor(isFootwear).some((s) => s.locationId !== a.loc && free[s.locationId] > 0);
    if (!others) { if (a.ok) out.riskyOnlyPlace.picked += 1; else out.riskyOnlyPlace.rejected += 1; }
    continue;
  }
  out.moved.push({ order: orders[a.orderId]?.orderNumber, product: a.name, size: a.size, from: NAME[a.loc] || a.loc, to: NAME[to.locationId] || to.locationId, why: own.why.join(", "), was: a.ok ? "picked" : "rejected" });
}
const pct = (b) => (b.picked + b.rejected ? Math.round((1000 * b.rejected) / (b.picked + b.rejected)) / 10 : null);
const movedFailed = out.moved.filter((m) => m.was === "rejected");
const movedOk = out.moved.filter((m) => m.was === "picked");
const trustedOk = 1 - (pct(out.trusted) ?? 0) / 100;
const byRoute = {};
for (const m of out.moved) { const k = `${m.from} → ${m.to}`; (byRoute[k] ||= { lines: 0, wereRejected: 0 }); byRoute[k].lines += 1; if (m.was === "rejected") byRoute[k].wereRejected += 1; }
const summary = {
  firstPicksReplayed: out.lines,
  trustedShelves: { ...out.trusted, failedPct: pct(out.trusted) },
  riskyShelves: { ...out.risky, failedPct: pct(out.risky) },
  wouldGoElsewhere: out.moved.length,
  ofThoseWereRejected: movedFailed.length,
  ofThoseWerePicked: movedOk.length,
  failuresAvoidedAtBest: movedFailed.length,
  failuresAvoidedExpected: Math.round((movedFailed.length * trustedOk - movedOk.length * (1 - trustedOk)) * 10) / 10,
  riskyButStayed: out.sameRisky, riskyAndTheOnlyPlace: { ...out.riskyOnlyPlace, failedPct: pct(out.riskyOnlyPlace) },
  elsewhereUnknown: out.unknownElsewhere, byRoute,
  settings: { riskyAt: rules.riskyAt, staleDays: rules.staleDays, rejectedDays: rules.rejectedDays },
};
writeFileSync(join(OUT, "replay-routing.json"), JSON.stringify({ summary, moved: out.moved }, null, 1));
console.log(JSON.stringify(summary, null, 1));

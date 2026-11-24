// ─── WEBSITE UNAVAILABLE LINES — the analysis (NO IO but the cache) ──────────
//
//   node scripts/audit/web-unavailable/analyse.mjs <cacheDir> <outDir>
//
// Reads ONLY the files collect.mjs left in <cacheDir>; touches neither the
// database nor Shopify. Writes <outDir>/unavailable-lines.csv (one row per
// website order line and product that was ever rejected, not found, damaged or
// unavailable), <outDir>/stats.json (every number the report quotes) and
// <outDir>/episodes.json (the rows with their proof lists).
//
// WHAT A ROW IS. A line can fail with the product the customer ordered, be
// swapped to an alternative, and fail again with that one. Each (order, line,
// product, size) that failed is one row ("episode"), with every rejection of
// it listed in order.
//
// WHERE A FAILURE IS RECORDED (all of them are read):
//   hub "Out of Stock"        orders/{code}.status out_of_stock (+ who, when)
//   shop "Not found"          displayChecks/{shop}/{day} result not_found
//   packer Not here / Damaged online_orders/{id}/unavailableRequests
//   routing found nowhere     the line's no_stock state and its traces
//   walk-in sale over a hold  online_orders/{id}/overrides
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { linesOf, parseRefOwner, parseCheckKey, FAILED_STATUSES } from "./model.mjs";

const [CACHE, OUT] = process.argv.slice(2);
if (!CACHE || !OUT) { console.error("usage: analyse.mjs <cacheDir> <outDir>"); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const R = (f, d = {}) => { try { return JSON.parse(readFileSync(join(CACHE, f), "utf8")); } catch { return d; } };
const orders = R("online_orders.json");
const refs = R("online_order_refs.json");
const hubOrders = R("hub_orders.json");
const checks = R("display_checks.json");
const agentLog = R("agent_log.json");
const movementsRaw = R("movements.json");
const stockNow = R("stock_now.json", { stock: {} });
const products = R("products.json");
const catalogue = R("catalogue_names.json");
const jamie = R("jamie_offers.json", null); // optional: built by jamie-offers.mjs
const shopify = R("shopify_orders.json", null); // optional: built by shopify-orders.mjs

const FIRST_ORDER = 1768;
const SAST = 2 * 3600e3;
const sk = (s) => { const v = String(s ?? "").trim(); return v === "" ? "_" : v.replace(/\./g, "_"); };
const ms = (v) => (typeof v === "number" ? v : v ? Date.parse(v) : null);
const iso = (t) => (t ? new Date(t + SAST).toISOString().slice(0, 16).replace("T", " ") : "");
const cnt = (arr) => arr.reduce((m, x) => { m[x] = (m[x] || 0) + 1; return m; }, {});
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : 0);
const median = (a) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const LOC_NAME = { hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3", "marathon-pe": "Marathon PE", trophy: "Trophy", concrete: "Concrete", "marathon-pine": "Pine", central: "Central", in_transit: "In Transit" };
const PICKABLE = ["hub1", "hub2", "hub3", "marathon-pe", "trophy", "concrete", "marathon-pine"];
const routeFor = (isFootwear) => (isFootwear ? ["hub1", "hub2", "hub3"] : ["marathon-pe", "trophy", "hub2", "concrete", "marathon-pine"]);
// What the website is told it may sell (scripts/shopify/inventory.mjs networkTotals).
// Every stock location but In Transit (ONLINE_EXCLUDED_LOCATIONS).
const ONLINE_POOL = ["central", ...PICKABLE];

// ── Movements, per product and size, in time order ───────────────────────────
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

/** What the system's count for one cell was at time T (the movement ledger's own before/after). */
function stockAt(pid, size, loc, T) {
  const list = mvBy.get(`${pid}|${sk(size)}`) || [];
  let last = null;
  for (const m of list) { if (m.t > T) break; if (m.after && m.after[loc] != null) last = m; }
  if (last) return Math.max(0, Number(last.after[loc]) || 0);
  const next = list.find((m) => m.t > T && m.before && m.before[loc] != null);
  if (next) return Math.max(0, Number(next.before[loc]) || 0);
  if (!stockNow.stock?.[pid]) return null; // a product whose cells were not read and that never moved: unknown
  return Math.max(0, qtyOf(cellNow(pid, size, loc)));
}
/** When the cell last changed before T (movement in the window, else the cell's own stamp). */
function lastTouch(pid, size, loc, T, only = () => true) {
  const list = mvBy.get(`${pid}|${sk(size)}`) || [];
  let last = null;
  for (const m of list) { if (m.t > T) break; if ((m.from === loc || m.to === loc || (m.after && m.after[loc] != null)) && only(m)) last = m; }
  return last;
}
const isCount = (m) => m.type === "adjustment" && /recount|count/i.test(m.reason || "");

// ── Orders in scope ──────────────────────────────────────────────────────────
const scope = Object.entries(orders).filter(([, o]) => Number(o.orderNumber) >= FIRST_ORDER);
const onlineSaleIds = new Map(); // pack saleId → order number
for (const [, o] of scope) if (o.pack?.saleId) onlineSaleIds.set(o.pack.saleId, o.orderNumber);
const orderEnd = (o) => ms(o.pack?.at) || ms(o.shopifyCancelledAt) || (["packed", "cancelled", "closed", "fulfilled_elsewhere"].includes(o.status) ? ms(o.updatedAt) : Infinity);

// ── Pick attempts (success and failure), from the hub orders and the strip ───
const attempts = []; // { orderId, line, pid, size, loc, at, ok, kind, who, ref }
for (const [code, h] of Object.entries(hubOrders)) {
  const owner = parseRefOwner(refs[code]?.orderId);
  const who = Object.values(h.stamps || {}).sort((a, b) => a.atMs - b.atMs);
  const base = { orderId: String(h.onlineOrderId), line: Number(h.onlineLineIndex), gen: owner.gen, pid: h.productId, size: sk(h.size), loc: h.hub, ref: `orders/${code}`, name: h.productName, checkProperly: !!h.checkProperly };
  if (h.status === "out_of_stock") attempts.push({ ...base, ok: false, kind: "hub_out_of_stock", at: ms(h.outOfStockAt), who: who.filter((s) => s.action === "out_of_stock").pop()?.personName || h.outOfStockByUid || "" });
  else if (h.status === "ready" || h.status === "collected") attempts.push({ ...base, ok: true, kind: "hub_sent", at: ms(h.readyAt) || ms(h.collectedAt) || ms(h.updatedAt), who: who.filter((s) => /ready|sent/.test(s.action)).pop()?.personName || "" });
}
for (const [path, c] of Object.entries(checks)) {
  if (c.kind !== "online_pick") continue;
  const [shop] = path.split("/");
  const key = parseCheckKey(c.dedupeKey) || {};
  const base = { orderId: String(c.orderId), line: Number(c.lineIndex), gen: key.gen || 0, pid: c.productId, size: sk(c.sizeKey ?? c.size), loc: shop, ref: `displayChecks/${path}`, name: c.productName, checkProperly: !!c.checkProperly };
  if (c.result === "not_found") attempts.push({ ...base, ok: false, kind: "shop_not_found", at: c.completedAt, who: c.completedBy?.name || "" });
  else if (c.result === "handed") attempts.push({ ...base, ok: true, kind: "shop_handed", at: c.completedAt, who: c.completedBy?.name || "" });
}
const inScope = new Set(scope.map(([id]) => id));
const scopedAttempts = attempts.filter((a) => inScope.has(a.orderId));

// ── Episodes ─────────────────────────────────────────────────────────────────
const episodes = new Map();
const ep = (orderId, line, pid, size) => {
  const key = `${orderId}:${line}:${pid}:${sk(size)}`;
  if (!episodes.has(key)) episodes.set(key, { key, orderId, line, pid, size: sk(size), fails: [], tries: [] });
  return episodes.get(key);
};
for (const a of scopedAttempts) if (!a.ok) ep(a.orderId, a.line, a.pid, a.size).fails.push(a);

for (const [orderId, o] of scope) {
  // The packer's Not here / Damaged, after the item was handed over.
  for (const r of Object.values(o.unavailableRequests || {})) {
    if (r.state !== "committed") continue;
    ep(orderId, Number(r.lineIndex), r.pid, r.sizeKey ?? r.size).fails.push({ ok: false, kind: r.reason === "damaged" ? "packer_damaged" : "packer_not_here", loc: r.fromLoc, at: r.at, who: r.by?.name || "", ref: `online_orders/${orderId}/unavailableRequests/${r.rid}`, afterHandover: r.fromStatus === "handed" });
  }
  // A walk-in sale let through over the hold (manager PIN).
  for (const [oid, ov] of Object.entries(o.overrides || {})) {
    const l = linesOf(o).find((x) => (x.pid === ov.productId || x.swappedFrom?.pid === ov.productId) && sk(x.sizeKey ?? x.size) === sk(ov.size));
    if (l) ep(orderId, l._i, ov.productId, ov.size).fails.push({ ok: false, kind: "walkin_sale_over_hold", loc: ov.loc, at: ov.at, who: ov.byName || "", ref: `online_orders/${orderId}/overrides/${oid}` });
  }
  for (const l of linesOf(o)) {
    const st = l.source?.status;
    const routedNowhere = (pid, size, at, ref) => {
      const e = ep(orderId, l._i, pid, size);
      if (!e.fails.some((f) => f.kind === "routed_nowhere")) e.fails.push({ ok: false, kind: "routed_nowhere", loc: null, at, who: "system (routing)", ref });
    };
    // Routing found nowhere — now, before a swap, or at the start of an escalation.
    if (st === "no_stock" && !l.source?.locationId) routedNowhere(l.pid, l.sizeKey, ms(l.source?.at) || ms(o.ingestedAt), `online_orders/${orderId}/lines/${l._i}/source`);
    if (l.swappedFrom && l.swappedFrom.status === "no_stock" && !l.swappedFrom.locationId) routedNowhere(l.swappedFrom.pid, l.swappedFrom.sizeKey, ms(o.ingestedAt), `online_orders/${orderId}/lines/${l._i}/swappedFrom`);
    const first = l.escalation?.attempts?.[0];
    if (first && first.action === "routed" && first.result === "no_stock" && !first.location) routedNowhere(l.swappedFrom?.pid && l.swappedFrom.at > first.at ? l.swappedFrom.pid : l.pid, l.swappedFrom?.pid && l.swappedFrom.at > first.at ? l.swappedFrom.sizeKey : l.sizeKey, first.at, `online_orders/${orderId}/lines/${l._i}/escalation`);
    // A line that is failed now, or was failed when it was swapped, with no record above.
    if (FAILED_STATUSES.includes(st) && st !== "resolved") ep(orderId, l._i, l.pid, l.sizeKey);
    if (st === "resolved" && (l.resolution?.outcome?.kind !== "swap")) ep(orderId, l._i, l.pid, l.sizeKey);
    if (l.swappedFrom?.pid && FAILED_STATUSES.includes(l.swappedFrom.status)) ep(orderId, l._i, l.swappedFrom.pid, l.swappedFrom.sizeKey);
  }
}
// The order agent's evidence names lines routed nowhere whose trace a later re-route erased.
for (const day of Object.values(agentLog)) for (const row of Object.values(day || {})) {
  if (row.kind !== "alternatives_now" || !inScope.has(String(row.id))) continue;
  const o = orders[row.id];
  const l = linesOf(o).find((x) => x._i === Number(row.line));
  if (!l) continue;
  const f = row.evidence?.failed;
  if (f?.status === "no_stock" && !f.at) {
    const useOld = l.swappedFrom?.pid && ms(l.swappedFrom.at) > row.at;
    const e = ep(String(row.id), l._i, useOld ? l.swappedFrom.pid : l.pid, useOld ? l.swappedFrom.sizeKey : l.sizeKey);
    if (!e.fails.some((x) => x.kind === "routed_nowhere")) e.fails.push({ ok: false, kind: "routed_nowhere", loc: null, at: ms(o.ingestedAt), who: "system (routing)", ref: `online_order_agent/log (${row.run})` });
  }
}

// ── Catalogue twins (near-identical names) ───────────────────────────────────
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const tokens = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 1));
const catTokens = Object.entries(catalogue).map(([pid, d]) => ({ pid, name: d.name || "", tk: tokens(d.name) })).filter((d) => d.tk.size >= 2);
const twinCache = new Map();
function twinsOf(pid, name) {
  if (twinCache.has(pid)) return twinCache.get(pid);
  const me = tokens(name);
  const out = [];
  if (me.size >= 2) for (const d of catTokens) {
    if (d.pid === pid) continue;
    let inter = 0;
    for (const w of me) if (d.tk.has(w)) inter += 1;
    const jac = inter / (me.size + d.tk.size - inter);
    // Near-identical: same words but one (a colour, a code), or one name inside the other.
    if (jac >= 0.75 || (inter === Math.min(me.size, d.tk.size) && Math.abs(me.size - d.tk.size) <= 1 && inter >= 2)) out.push({ pid: d.pid, name: d.name });
  }
  twinCache.set(pid, out);
  return out;
}

// ── Fill each episode ────────────────────────────────────────────────────────
const holdsAt = (pid, size, loc, T, exceptOrder) => {
  // Units other website orders held at that place at T (their line was routed there and not yet packed).
  let n = 0;
  for (const [oid, o] of scope) {
    if (oid === exceptOrder) continue;
    const t0 = ms(o.ingestedAt) || ms(o.createdAt);
    if (!(t0 <= T && orderEnd(o) > T)) continue;
    for (const l of linesOf(o)) if (l.pid === pid && sk(l.sizeKey) === sk(size) && l.source?.locationId === loc) n += Number(l.qty) || 1;
  }
  return n;
};

const rows = [];
for (const e of episodes.values()) {
  const o = orders[e.orderId];
  const l = linesOf(o).find((x) => x._i === e.line) || {};
  const isCurrent = l.pid === e.pid && sk(l.sizeKey) === e.size;
  const wasSwappedFrom = l.swappedFrom?.pid === e.pid && sk(l.swappedFrom.sizeKey) === e.size;
  const p = products[e.pid] || {};
  e.fails.sort((a, b) => (a.at || 0) - (b.at || 0));
  e.tries = scopedAttempts.filter((a) => a.orderId === e.orderId && a.line === e.line && a.pid === e.pid && a.size === e.size).sort((a, b) => a.at - b.at);
  const name = p.name || e.tries[0]?.name || (isCurrent ? l.title : wasSwappedFrom ? l.swappedFrom.title : "") || catalogue[e.pid]?.name || e.pid;
  const isFootwear = (p.category || l.category) === "Footwear" && p.productType !== "clothing";
  const orderAt = ms(o.createdAt);
  const firstTry = e.tries[0];
  const routedTo = firstTry ? firstTry.loc : e.fails.find((f) => f.loc)?.loc ?? (isCurrent ? l.source?.locationId ?? null : wasSwappedFrom ? l.swappedFrom.locationId ?? null : null);
  const firstFail = e.fails[0] || null;
  const lastFail = e.fails[e.fails.length - 1] || null;
  const priceCents = isCurrent ? (l.swappedFrom ? l.unitPriceCents : l.originalUnitPriceCents ?? l.unitPriceCents) : wasSwappedFrom ? l.swappedFrom.unitPriceCents ?? l.originalUnitPriceCents : null;

  // (3) What the system showed when the order was placed.
  const at0 = {};
  for (const loc of [...PICKABLE, "central", "in_transit"]) at0[loc] = stockAt(e.pid, e.size, loc, orderAt) ?? 0;
  const route = routeFor(isFootwear);
  const onRoute0 = route.reduce((n, loc) => n + at0[loc], 0);
  const pool0 = ONLINE_POOL.reduce((n, loc) => n + at0[loc], 0);
  const elsewhere0 = Object.entries(at0).filter(([loc, q]) => q > 0 && loc !== routedTo).map(([loc, q]) => `${LOC_NAME[loc]} ${q}`).join(", ");
  const heldByOthers0 = routedTo ? holdsAt(e.pid, e.size, routedTo, orderAt, e.orderId) : 0;

  // (4) After the rejection.
  const proof = [];
  let verdict = "unproven";
  const list = mvBy.get(`${e.pid}|${e.size}`) || [];
  const rejAt = firstFail?.at || null;
  const rejLoc = firstFail?.loc || null;
  const atRej = {};
  // Fifteen minutes BEFORE the rejection: staff often correct the count in the same minute they press Not found.
  if (rejAt) for (const loc of [...PICKABLE, "central"]) atRej[loc] = stockAt(e.pid, e.size, loc, rejAt - 15 * 60e3) ?? 0;
  const elsewhereAtRej = Object.entries(atRej).filter(([loc, q]) => q > 0 && loc !== rejLoc);
  const laterOk = lastFail ? e.tries.find((a) => a.ok && a.at > lastFail.at) : null;
  let inboundSinceRej = false;
  let falseHere = false;
  let goneHere = false;
  if (rejAt && rejLoc) {
    for (const m of list) {
      // A count to zero at that place in the half hour before the rejection is the same act.
      if (m.t <= rejAt && m.t > rejAt - 30 * 60e3 && isCount(m) && m.after && Number(m.after[rejLoc]) === 0) { proof.push(`${iso(m.t)} counted at ${LOC_NAME[rejLoc]}: 0, as it was rejected (movement ${m.id})`); goneHere = true; }
      if (m.t <= rejAt) continue;
      const leaves = m.from === rejLoc && ["sold", "transfer_out"].includes(m.type);
      const arrives = m.to === rejLoc && ["received", "transfer_in", "return", "transfer_out"].includes(m.type);
      const ownPack = m.type === "sold" && m.link?.saleId && onlineSaleIds.get(m.link.saleId) === o.orderNumber;
      if (leaves && !ownPack) {
        const web = m.type === "sold" && onlineSaleIds.has(m.link?.saleId) ? ` for website order #${onlineSaleIds.get(m.link.saleId)}` : "";
        const what = m.type === "sold" ? (web ? `picked and packed${web}` : "sold at a till") : `transferred to ${LOC_NAME[m.to] || m.to}`;
        proof.push(`${iso(m.t)} ${what} from ${LOC_NAME[rejLoc]} (movement ${m.id})${inboundSinceRej ? " — after new stock arrived there" : ""}`);
        if (!inboundSinceRej) falseHere = true;
      }
      if (isCount(m) && m.after && m.after[rejLoc] != null) {
        const q = Number(m.after[rejLoc]);
        proof.push(`${iso(m.t)} counted at ${LOC_NAME[rejLoc]}: ${q} (movement ${m.id})`);
        if (q > 0 && !inboundSinceRej) falseHere = true;
        if (q === 0 && !inboundSinceRej) goneHere = true;
      }
      if ((m.type === "refusal_writeoff" || /online pick not found|damaged \(online pick/.test(m.reason || "")) && (m.from === rejLoc || (m.after && m.after[rejLoc] != null))) {
        proof.push(`${iso(m.t)} written off at ${LOC_NAME[rejLoc]}: ${m.reason} (movement ${m.id})`);
        if (!inboundSinceRej) goneHere = true;
      }
      if (arrives && !(m.type === "transfer_out" && m.from === rejLoc)) inboundSinceRej = true;
    }
    // Another website order picked the same product and size from the same place afterwards.
    for (const a of scopedAttempts) {
      if (a.ok && a.loc === rejLoc && a.pid === e.pid && a.size === e.size && a.at > rejAt && !(a.orderId === e.orderId && a.line === e.line)) {
        proof.push(`${iso(a.at)} picked at ${LOC_NAME[rejLoc]} for website order #${orders[a.orderId]?.orderNumber} (${a.ref})`);
      }
    }
  }
  if (laterOk) proof.unshift(`${iso(laterOk.at)} found: ${laterOk.kind === "hub_sent" ? "sent by" : "handed over at"} ${LOC_NAME[laterOk.loc]}${laterOk.loc === rejLoc ? " — the SAME place that rejected it" : ""} (${laterOk.ref})`);
  const damaged = e.fails.some((f) => f.kind === "packer_damaged");
  if (damaged) verdict = "damaged";
  else if (laterOk && laterOk.loc === rejLoc) verdict = "false: found later at the same place";
  else if (falseHere) verdict = "false: left the same place afterwards";
  else if (laterOk) verdict = "found elsewhere later";
  else if (firstFail?.kind === "routed_nowhere") verdict = at0.central > 0 && onRoute0 === 0 ? "central only: never routable" : pool0 === 0 ? "oversold: website showed a size the app did not hold" : "routed nowhere";
  else if (elsewhereAtRej.some(([loc]) => route.includes(loc))) verdict = "stock shown at another pickable place when rejected";
  else if (goneHere) verdict = "genuine: counted or written off as not there";

  // Outcome.
  let outcome = "open";
  let outcomeDetail = "";
  const st = l.source?.status;
  if (laterOk) { outcome = "found_later"; outcomeDetail = `at ${LOC_NAME[laterOk.loc]}`; }
  else if (!isCurrent) {
    const steps = Object.values(l.resolution?.log || {}).filter((g) => g.action === "swapped").sort((a, b) => a.at - b.at);
    const step = steps.find((g) => norm(g.note || "").startsWith(norm(name))) || (wasSwappedFrom ? steps[steps.length - 1] : null);
    const via = (wasSwappedFrom ? l.swappedFrom.via : step?.via) || step?.via || "";
    outcome = "alternative_accepted";
    outcomeDetail = `${via === "pos" ? "replaced at the till" : "customer picked"}: ${step?.note?.split("→")[1]?.trim() || l.title || ""}`;
    e.swapAt = step?.at || ms(l.swappedFrom?.at) || null;
  } else if (o.status === "cancelled" || st === "cancelled") outcome = "cancelled";
  else if (st === "resolved") {
    const k = l.resolution?.outcome?.kind;
    outcome = k === "refund" ? "refund" : k === "store_credit" ? "store_credit" : k === "refund_requested" ? "refund_requested" : "resolved_by_hand";
    outcomeDetail = l.escalationOverride?.why || "";
  } else if (st === "handed") { outcome = "found_later"; outcomeDetail = `at ${LOC_NAME[l.source.locationId] || "?"} (no pick record)`; }
  else if (st === "pick" || st === "display") { outcome = "open_being_picked"; outcomeDetail = `at ${LOC_NAME[l.source.locationId]}`; }
  else if (l.awaitingCustomer) { outcome = "open_waiting_for_customer"; outcomeDetail = l.awaitingCustomer.what || ""; }

  // (5) Factors.
  const soldBetween = rejAt && routedTo ? list.filter((m) => m.t > orderAt && m.t <= rejAt && m.from === routedTo && m.type === "sold" && onlineSaleIds.get(m.link?.saleId) !== o.orderNumber) : [];
  const touch = routedTo ? lastTouch(e.pid, e.size, routedTo, orderAt) : null;
  const cell = routedTo ? cellNow(e.pid, e.size, routedTo) : null;
  const touchAt = touch ? touch.t : (cell && ms(cell.updatedAt) < orderAt ? ms(cell.updatedAt) : null);
  const countM = routedTo ? lastTouch(e.pid, e.size, routedTo, orderAt, isCount) : null;
  const twins = twinsOf(e.pid, catalogue[e.pid]?.name || name);
  const displayReg = routedTo ? list.some((m) => m.reason === "display_registration" && m.to === routedTo && m.t <= (rejAt || orderAt)) : false;
  const row = {
    order: `#${o.orderNumber}`, record: /^exchange-/.test(e.orderId) ? "exchange" : /r\d+$|f\d+$/.test(e.orderId) && o.followUpOf ? "second parcel" : "order",
    orderId: e.orderId, line: e.line, product: name, pid: e.pid, size: e.size === "_" ? "one size" : e.size.replace(/_/g, "."),
    category: p.category || l.category || "", subcategory: p.subcategory || p.categoryKey || "", brand: p.brand || "", priceRand: priceCents != null ? priceCents / 100 : p.retailPrice ?? "",
    orderedAt: iso(orderAt), routedTo: routedTo ? LOC_NAME[routedTo] : "nowhere (no stock on the route)",
    reason: [...new Set(e.fails.map((f) => f.kind))].join(" + ") || (isCurrent ? `line is ${st}` : `line was ${l.swappedFrom?.status}`),
    rejections: e.fails.map((f) => `${iso(f.at)} ${f.kind}${f.loc ? ` at ${LOC_NAME[f.loc]}` : ""}${f.who ? ` by ${f.who}` : ""}`).join(" | "),
    rejectedBy: firstFail?.who || "", rejectedAtPlace: firstFail?.loc ? LOC_NAME[firstFail.loc] : "", firstRejectedAt: iso(firstFail?.at),
    hoursOrderToRejection: firstFail?.at ? Math.round(((firstFail.at - orderAt) / 3600e3) * 10) / 10 : "",
    timesRejected: e.fails.length,
    outcome, outcomeDetail,
    onHandRoutedAtOrder: routedTo ? at0[routedTo] : "", heldByOtherWebOrdersAtOrder: heldByOthers0, onHandElsewhereAtOrder: elsewhere0,
    centralAtOrder: at0.central, pickableOnRouteAtOrder: onRoute0, websitePoolAtOrder: pool0,
    centralOnlyAtOrder: onRoute0 === 0 && at0.central > 0 ? "yes" : "no",
    lastSinglePiece: routedTo && at0[routedTo] - heldByOthers0 <= 1 ? "yes" : "no",
    systemShowedAtRejectingPlace: rejLoc ? atRej[rejLoc] : "", shownElsewhereWhenRejected: elsewhereAtRej.map(([loc, q]) => `${LOC_NAME[loc]} ${q}`).join(", "),
    verdict, proof: proof.join(" | "),
    systemShowsAtRejectingPlaceToday: rejLoc ? qtyOf(cellNow(e.pid, e.size, rejLoc)) : "",
    soldBetweenOrderAndRejection: soldBetween.length ? soldBetween.map((m) => `${iso(m.t)} ${onlineSaleIds.has(m.link?.saleId) ? `web #${onlineSaleIds.get(m.link.saleId)}` : "till sale"}`).join(" | ") : "",
    daysSinceCellLastMoved: touchAt ? Math.round(((orderAt - touchAt) / 864e5) * 10) / 10 : "",
    daysSinceCellLastCounted: countM ? Math.round(((orderAt - countM.t) / 864e5) * 10) / 10 : `none since ${iso(WINDOW_START).slice(0, 10)}`,
    twinNames: twins.slice(0, 4).map((t) => t.name).join(" ; "), twinCount: twins.length,
    displayPieceRegistered: displayReg ? "yes" : "no",
    checkProperlyAsked: e.tries.some((a) => a.checkProperly) ? "yes" : "no",
  };
  e.row = row; e.isFootwear = isFootwear; e.at0 = at0; e.routedToKey = routedTo; e.firstFail = firstFail; e.orderAt = orderAt; e.priceCents = priceCents ?? (p.retailPrice ? p.retailPrice * 100 : null);
  rows.push(row);
}
rows.sort((a, b) => Number(a.order.slice(1)) - Number(b.order.slice(1)) || a.line - b.line);

// ── Jamie's offers, joined on (order, line, product) when the file is there ──
// The line itself is the truth about how an offer ended (Jamie's own row can
// read "expired" for a line the customer's pick was applied to by another
// path); Jamie's row says whether the customer answered at all.
let jamieStats = null;
if (jamie) {
  const epBy = new Map([...episodes.values()].map((e) => [`${e.orderId}:${e.line}:${e.pid}`, e]));
  const offers = jamie.offers.map((j) => {
    const e = epBy.get(`${j.orderKey}:${j.line}:${j.pid}`);
    const replied = (j.customerSaid || []).length > 0;
    let result = j.result;
    if (e) {
      const oc = e.row.outcome;
      if (oc === "alternative_accepted") result = "accepted";
      else if (oc === "found_later" || oc === "open_being_picked") result = "item_found";
      else if (["store_credit", "refund", "refund_requested", "cancelled", "resolved_by_hand"].includes(oc)) result = replied ? "declined" : "no_reply";
      else result = j.firstOfferAt && jamie.at - j.firstOfferAt < 48 * 3600e3 ? "pending" : replied ? "declined" : "no_reply";
      e.row.jamieOffer = result; e.row.jamieFirstOfferAt = iso(j.firstOfferAt); e.row.jamieChannel = j.channel; e.row.jamieOptions = j.optionsFirst;
      e.row.hoursRejectionToOffer = e.firstFail?.at && j.firstOfferAt ? Math.round(((j.firstOfferAt - e.firstFail.at) / 3600e3) * 10) / 10 : "";
      e.row.customerSaid = (j.customerSaid || []).join(" / ");
    }
    return { ...j, result, hoursToOffer: e?.firstFail?.at && j.firstOfferAt ? (j.firstOfferAt - e.firstFail.at) / 3600e3 : null, category: e?.row.category || "", outcome: e?.row.outcome || "" };
  });
  const decided = offers.filter((o) => ["accepted", "declined", "no_reply"].includes(o.result));
  const rate = (list) => ({ offers: list.length, accepted: list.filter((o) => o.result === "accepted").length, declined: list.filter((o) => o.result === "declined").length, noReply: list.filter((o) => o.result === "no_reply").length, acceptedPct: pct(list.filter((o) => o.result === "accepted").length, list.length) });
  const by = (fn) => { const g = {}; for (const o of decided) { const k = fn(o); if (k == null) continue; (g[k] ||= []).push(o); } return Object.fromEntries(Object.entries(g).sort().map(([k, v]) => [k, rate(v)])); };
  const groupSummary = (name) => {
    const g = decided.filter((o) => o.result === name);
    const h = g.map((o) => o.hoursToOffer).filter((x) => x != null && x >= 0);
    const wa = g.filter((o) => o.channel === "whatsapp");
    return {
      n: g.length, medianHoursRejectionToOffer: h.length ? Math.round(median(h) * 10) / 10 : null, offeredWithin1hPct: pct(h.filter((x) => x <= 1).length, h.length),
      whatsappPct: pct(wa.length, g.length), emailPct: pct(g.filter((o) => o.channel === "email").length, g.length),
      meanOptions: g.length ? Math.round((g.reduce((n, o) => n + o.optionsFirst, 0) / g.length) * 10) / 10 : null,
      anySameBrandPct: pct(g.filter((o) => o.brandKnown && o.sameBrandOptions > 0).length, g.filter((o) => o.brandKnown).length),
      allSamePricePct: pct(g.filter((o) => o.allSamePrice === true).length, g.filter((o) => o.allSamePrice != null).length),
      anyDearerPct: pct(g.filter((o) => o.anyDearer).length, g.length),
      whatsappWithPhotosPct: pct(wa.filter((o) => o.photos > 0).length, wa.length),
      whatsappReadPct: pct(wa.filter((o) => o.read).length, wa.filter((o) => o.read != null).length),
      meanRounds: g.length ? Math.round((g.reduce((n, o) => n + o.rounds, 0) / g.length) * 10) / 10 : null,
      medianHoursOfferToFirstReply: (() => { const r = g.filter((o) => o.firstReplyAt && o.firstOfferAt).map((o) => (o.firstReplyAt - o.firstOfferAt) / 3600e3); return r.length ? Math.round(median(r) * 10) / 10 : null; })(),
    };
  };
  const bucketDelay = (h) => (h == null || h < 0 ? null : h <= 1 ? "a) within 1 h" : h <= 6 ? "b) 1-6 h" : h <= 24 ? "c) 6-24 h" : h <= 72 ? "d) 1-3 days" : "e) over 3 days");
  const bucketHour = (h) => (h == null ? null : h < 9 ? "a) before 09:00" : h < 12 ? "b) 09-12" : h < 15 ? "c) 12-15" : h < 18 ? "d) 15-18" : "e) 18:00 on");
  jamieStats = {
    offersInFile: offers.length, results: cnt(offers.map((o) => o.result)), decided: rate(decided),
    groups: { accepted: groupSummary("accepted"), declined: groupSummary("declined"), no_reply: groupSummary("no_reply") },
    byDelay: by((o) => bucketDelay(o.hoursToOffer)), byChannel: by((o) => o.channel || "(none)"),
    byOptions: by((o) => `${o.optionsFirst} option(s)`), byRounds: by((o) => (o.rounds >= 3 ? "3+ rounds" : `${o.rounds} round(s)`)),
    bySameBrand: by((o) => (!o.brandKnown ? null : o.sameBrandOptions === 0 ? "no same-brand option" : o.sameBrandOptions >= o.optionsFirst ? "all same brand" : "some same brand")),
    byPrice: by((o) => (o.allSamePrice == null ? null : o.allSamePrice ? "all the same price" : o.anyDearer && !o.anyCheaper ? "dearer options only" : o.anyCheaper && !o.anyDearer ? "same or cheaper" : "mixed dearer and cheaper")),
    byPhotos: by((o) => (o.channel === "whatsapp" ? (o.photos > 0 ? "WhatsApp, photos sent" : "WhatsApp, no photos logged") : o.channel === "email" ? (o.photos === -1 ? "email, photos attached" : "email, no photos") : null)),
    byModel: by((o) => o.model || "(not recorded)"), byHour: by((o) => bucketHour(o.hourSast)), byWeekday: by((o) => (o.weekday == null ? null : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][o.weekday])),
    byCategory: by((o) => o.category || null), byKind: by((o) => o.kind),
    byRead: by((o) => (o.channel !== "whatsapp" || o.read == null ? null : o.read ? "WhatsApp read" : "WhatsApp not read")),
    pickedSameBrandPct: pct(offers.filter((o) => o.result === "accepted" && o.pickedSameBrand === true).length, offers.filter((o) => o.result === "accepted" && o.pickedSameBrand != null).length),
    pickedPrice: cnt(offers.filter((o) => o.result === "accepted" && o.pickedDiffCents != null).map((o) => (o.pickedDiffCents === 0 ? "same price" : o.pickedDiffCents > 0 ? "dearer" : "cheaper"))),
    pickedNumber: cnt(offers.filter((o) => o.result === "accepted" && o.pickedNumber).map((o) => (o.pickedNumber <= 3 ? `option ${o.pickedNumber}` : "option 4+ (a later round)"))),
    declinedWords: offers.filter((o) => o.result === "declined").map((o) => ({ order: `#${o.orderNumber}`, item: o.item, channel: o.channel, outcome: o.outcome, said: o.customerSaid })),
    noReply: offers.filter((o) => o.result === "no_reply").map((o) => ({ order: `#${o.orderNumber}`, item: o.item, channel: o.channel, delivered: o.delivered, read: o.read, rounds: o.rounds, followUps: o.followUps })),
  };
  writeFileSync(join(OUT, "jamie-offers.csv"), [["order", "line", "item", "size", "result", "channel", "firstOfferAt", "hoursRejectionToOffer", "optionsFirst", "optionsTotal", "rounds", "sameBrandOptions", "allSamePrice", "anyDearer", "photos", "model", "hourSast", "delivered", "read", "pickedDiffRand", "customerSaid"].join(","),
    ...offers.map((o) => [`#${o.orderNumber}`, o.line, o.item, o.size, o.result, o.channel, iso(o.firstOfferAt), o.hoursToOffer != null ? Math.round(o.hoursToOffer * 10) / 10 : "", o.optionsFirst, o.optionsTotal, o.rounds, o.brandKnown ? o.sameBrandOptions : "", o.allSamePrice ?? "", o.anyDearer, o.photos === -1 ? "attached (email)" : o.photos, o.model || "", o.hourSast ?? "", o.delivered ?? "", o.read ?? "", o.pickedDiffCents != null ? o.pickedDiffCents / 100 : "", (o.customerSaid || []).join(" / ")].map((v) => { const t = String(v ?? ""); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }).join(","))].join("\n") + "\n");
}

// ── Shopify's own record of the order: cancelled, and refunds per line item ──
let shopifyStats = null;
if (shopify) {
  for (const e of episodes.values()) {
    const o = orders[e.orderId];
    const so = shopify[o.shopifyGid];
    if (!so) continue;
    const l = linesOf(o).find((x) => x._i === e.line) || {};
    const hit = (so.refunds || []).find((r) => (r.refundLineItems?.nodes || []).some((n) => n.lineItem?.id === l.shopifyLineItemId));
    e.row.shopifyOrderCancelled = so.cancelledAt ? "yes" : "no";
    e.row.shopifyRefundOnLine = hit ? iso(ms(hit.createdAt)) : "";
    e.row.shopifyNote = String(so.note || "").replace(/\s+/g, " ").slice(0, 160);
  }
  const all = Object.values(shopify);
  shopifyStats = { ordersRead: all.length, cancelled: all.filter((o) => o.cancelledAt).length, withARefundRecord: all.filter((o) => (o.refunds || []).length).length, withANote: all.filter((o) => o.note).length,
    failedLinesWithAShopifyRefund: rows.filter((r) => r.shopifyRefundOnLine).length };
}

// ── Lines sold while only Central held the size (every line, not only failed ones) ──
const centralOnly = { lines: 0, failed: 0, waitedHours: [] };
for (const { id, o, l } of scope.flatMap(([id, o]) => linesOf(o).map((l) => ({ id, o, l })))) {
  const pid = l.originalPid && !l.swappedFrom ? l.pid : l.swappedFrom?.pid && !Object.values(l.resolution?.log || {}).length ? l.swappedFrom.pid : l.swappedFrom ? null : l.pid;
  if (!pid) continue;
  const T = ms(o.createdAt);
  const shoe = !!l.isFootwear;
  const qs = routeFor(shoe).map((loc) => stockAt(pid, l.sizeKey, loc, T));
  const c = stockAt(pid, l.sizeKey, "central", T);
  if (qs.some((q) => q == null) || c == null) continue;
  if (qs.reduce((a, b) => a + b, 0) === 0 && c > 0) {
    centralOnly.lines += 1;
    if (failedLineKeys_has(id, l._i)) centralOnly.failed += 1;
    if (l.source?.handedAt) centralOnly.waitedHours.push((l.source.handedAt - T) / 3600e3);
  }
}
function failedLineKeys_has(id, i) { return [...episodes.values()].some((e) => e.orderId === id && e.line === i); }

// ── Stats ────────────────────────────────────────────────────────────────────
const allLines = scope.flatMap(([id, o]) => linesOf(o).map((l) => ({ id, o, l })));
const failedLineKeys = new Set([...episodes.values()].map((e) => `${e.orderId}:${e.line}`));
const share = (pred) => { const n = rows.filter(pred).length; return { n, pct: pct(n, rows.length) }; };
const byLoc = {};
for (const a of scopedAttempts) { const b = (byLoc[a.loc] ||= { picked: 0, rejected: 0, afterHandover: 0 }); if (a.ok) b.picked += 1; else b.rejected += 1; }
for (const e of episodes.values()) for (const f of e.fails) if (f.kind.startsWith("packer_") && f.loc) (byLoc[f.loc] ||= { picked: 0, rejected: 0, afterHandover: 0 }).afterHandover += 1;
const locationTable = [...PICKABLE].map((loc) => { const b = byLoc[loc] || { picked: 0, rejected: 0, afterHandover: 0 }; const bad = b.rejected + b.afterHandover; return { location: LOC_NAME[loc], rejected: b.rejected, failedAfterHandover: b.afterHandover, picked: b.picked, ratePct: pct(bad, b.picked + b.rejected) }; });
const byStaff = {};
for (const a of scopedAttempts) { const k = `${LOC_NAME[a.loc]} · ${a.who || "?"}`; const b = (byStaff[k] ||= { picked: 0, rejected: 0 }); if (a.ok) b.picked += 1; else b.rejected += 1; }
const staffTable = Object.entries(byStaff).map(([who, b]) => ({ who, ...b, ratePct: pct(b.rejected, b.picked + b.rejected) })).filter((x) => x.picked + x.rejected >= 5).sort((a, b) => b.rejected - a.rejected);
const group = (field, min = 1) => Object.entries(cnt(rows.map((r) => r[field] || "(none)"))).filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ [field]: k, n, pct: pct(n, rows.length) }));
// Category / brand as a RATE against every website line of that kind.
const lineCat = cnt(allLines.map((x) => x.l.category || "(none)"));
const failCat = cnt([...failedLineKeys].map((k) => { const [id, i] = k.split(":"); return linesOf(orders[id]).find((x) => x._i === Number(i))?.category || "(none)"; }));
const categoryRate = Object.entries(lineCat).map(([c, n]) => ({ category: c, lines: n, failed: failCat[c] || 0, ratePct: pct(failCat[c] || 0, n) })).sort((a, b) => b.failed - a.failed);
const repeat = {};
for (const r of rows) { const k = `${r.pid}|${r.size}`; (repeat[k] ||= { pid: r.pid, product: r.product, size: r.size, brand: r.brand, category: r.category, orders: [], outcomes: [] }); repeat[k].orders.push(r.order); repeat[k].outcomes.push(r.outcome); }
const repeatByPid = {};
for (const r of rows) { (repeatByPid[r.pid] ||= { pid: r.pid, product: r.product, brand: r.brand, category: r.category, sizes: new Set(), orders: new Set(), n: 0 }); const x = repeatByPid[r.pid]; x.n += 1; x.sizes.add(r.size); x.orders.add(r.order); }
// Success since: was the same product and size picked successfully after its last failure?
const lastFailAt = {}; for (const e of episodes.values()) { const k = `${e.pid}|${e.size}`; const t = Math.max(0, ...e.fails.map((f) => f.at || 0)); lastFailAt[k] = Math.max(lastFailAt[k] || 0, t); }
const okSince = (pid, size) => scopedAttempts.some((a) => a.ok && a.pid === pid && a.size === sk(size === "one size" ? "_" : size) && a.at > (lastFailAt[`${pid}|${sk(size === "one size" ? "_" : size)}`] || 0));
const repeats = Object.values(repeat).filter((x) => x.orders.length >= 2).map((x) => ({ ...x, timesFailed: x.orders.length, fulfilledSince: okSince(x.pid, x.size) })).sort((a, b) => b.timesFailed - a.timesFailed);
const reasonKinds = cnt([...episodes.values()].flatMap((e) => [...new Set(e.fails.map((f) => f.kind))]));
const hours = rows.map((r) => Number(r.hoursOrderToRejection)).filter((x) => Number.isFinite(x) && x >= 0);
const stale = (d) => rows.filter((r) => Number(r.daysSinceCellLastMoved) >= d).length;

// Did a pick succeed, by how many pieces the system showed at that place when the order came in?
const orderAtOf = (id) => ms(orders[id]?.createdAt);
const margin = {};
for (const a of scopedAttempts) {
  if (a.gen > 0) continue; // the first place a line was sent only: a re-pick is not the website's promise
  const q = stockAt(a.pid, a.size, a.loc, orderAtOf(a.orderId));
  if (q == null) continue;
  const held = holdsAt(a.pid, a.size, a.loc, orderAtOf(a.orderId), a.orderId);
  const free = Math.max(0, q - held);
  const bucket = free <= 0 ? "0 (system showed none free)" : free === 1 ? "1 (last piece)" : free === 2 ? "2" : free <= 4 ? "3-4" : "5+";
  const kind = ["hub1", "hub2", "hub3"].includes(a.loc) ? "hubs" : "shops";
  for (const k of [`all · ${bucket}`, `${kind} · ${bucket}`]) { const b = (margin[k] ||= { picked: 0, rejected: 0 }); if (a.ok) b.picked += 1; else b.rejected += 1; }
}
// The last piece, by how long its cell had sat untouched when the order came in.
const staleSingles = {};
const classes = {};
// The line as the customer sees it: did the FIRST place deliver, by how many pieces the whole route showed?
const network = {};
for (const a of scopedAttempts) {
  if (a.gen > 0) continue;
  const T = orderAtOf(a.orderId);
  const q = stockAt(a.pid, a.size, a.loc, T);
  if (q == null) continue;
  const free = Math.max(0, q - holdsAt(a.pid, a.size, a.loc, T, a.orderId));
  const isShoe = ["hub1", "hub2", "hub3"].includes(a.loc);
  const onRoute = routeFor(isShoe).reduce((n, loc) => n + (stockAt(a.pid, a.size, loc, T) ?? 0), 0);
  const nb = onRoute <= 1 ? "1 on the whole route" : onRoute === 2 ? "2 on the whole route" : "3+ on the whole route";
  const nrow = (network[nb] ||= { picked: 0, rejected: 0 }); if (a.ok) nrow.picked += 1; else nrow.rejected += 1;
  if (free !== 1) continue;
  const touch = lastTouch(a.pid, a.size, a.loc, T);
  const cell = cellNow(a.pid, a.size, a.loc);
  const touchAt = touch ? touch.t : cell && ms(cell.updatedAt) < T ? ms(cell.updatedAt) : null;
  const days = touchAt ? (T - touchAt) / 864e5 : (T - WINDOW_START) / 864e5; // no movement since the window opened: at least this long
  const known = !!touchAt;
  const bucket = days <= 3 ? "a) moved in the last 3 days" : days <= 7 ? "b) 3-7 days" : days <= 14 ? "c) 7-14 days" : known || days > 14 ? "d) untouched over 14 days" : "c) 7-14 days";
  const b = (staleSingles[bucket] ||= { picked: 0, rejected: 0 }); if (a.ok) b.picked += 1; else b.rejected += 1;
  // Classes for the "at least 10 lines, at least half unavailable" bar.
  const stale = bucket.startsWith("d)");
  const price = (Number(linesOf(orders[a.orderId]).find((x) => x._i === a.line)?.unitPriceCents) || 0) / 100;
  for (const k of [
    `${LOC_NAME[a.loc]} · last piece · ${stale ? "untouched over 14 days" : "moved within 14 days"}`,
    `${isShoe ? "hubs" : "shops"} · last piece · ${stale ? "untouched over 14 days" : "moved within 14 days"}`,
    `${stale ? "last piece untouched over 14 days" : "last piece moved within 14 days"} · ${onRoute <= 1 ? "and the only one on the route" : "more elsewhere on the route"}`,
  ]) { const c = (classes[k] ||= { picked: 0, rejected: 0, pickedRand: 0, rejectedRand: 0 }); if (a.ok) { c.picked += 1; c.pickedRand += price; } else { c.rejected += 1; c.rejectedRand += price; } }
}
const tbl = (o) => Object.entries(o).sort().map(([k, b]) => ({ group: k, ...b, ratePct: pct(b.rejected, b.picked + b.rejected) }));
// A size that had ALREADY been rejected at a place and was sold on the website again.
let repeatOfKnownBad = 0;
{
  const seen = new Map();
  for (const e of [...episodes.values()].sort((x, y) => (x.firstFail?.at || 0) - (y.firstFail?.at || 0))) {
    for (const f of e.fails) {
      if (!f.loc || !f.at) continue;
      const k = `${e.pid}|${e.size}|${f.loc}`;
      const prev = seen.get(k);
      if (prev && prev.order !== e.orderId) {
        // Only when nothing arrived at, or was counted at, that cell in between.
        const between = (mvBy.get(`${e.pid}|${e.size}`) || []).some((m) => m.t > prev.at && m.t < f.at && (m.to === f.loc || isCount(m)) && m.type !== "sold");
        if (!between) { repeatOfKnownBad += 1; e.row.repeatOfKnownBadCell = "yes"; }
      }
      seen.set(k, { at: f.at, order: e.orderId });
    }
  }
}
for (const r of rows) r.repeatOfKnownBadCell ||= "no";
const marginTable = Object.entries(margin).map(([k, b]) => ({ shownFree: k, ...b, ratePct: pct(b.rejected, b.picked + b.rejected) })).sort((a, b) => a.shownFree.localeCompare(b.shownFree));
const notGot = rows.filter((r) => r.outcome !== "found_later" && r.outcome !== "open_being_picked");

const stats = {
  generatedAt: new Date().toISOString(), firstOrder: FIRST_ORDER,
  ordersInScope: scope.length, linesInScope: allLines.length, failedLines: failedLineKeys.size, failedLinePct: pct(failedLineKeys.size, allLines.length),
  episodes: rows.length, ordersWithAFailedLine: new Set(rows.map((r) => r.order)).size,
  pickAttempts: { total: scopedAttempts.length, rejected: scopedAttempts.filter((a) => !a.ok).length },
  customerDidNotGetWhatTheyOrdered: notGot.length, marginTable, staleSingles: tbl(staleSingles), networkTable: tbl(network), classTable: tbl(classes),
  repeatOfKnownBadCell: { n: rows.filter((r) => r.repeatOfKnownBadCell === "yes").length, pct: pct(rows.filter((r) => r.repeatOfKnownBadCell === "yes").length, rows.length) },
  rejectedWhereSystemShowed2Plus: (() => { const g = rows.filter((r) => Number(r.systemShowedAtRejectingPlace) >= 2); return { n: g.length, pct: pct(g.length, rows.length), provenFalse: g.filter((r) => r.verdict.startsWith("false")).length }; })(),
  stillShownTodayAtTheRejectingPlace: share((r) => r.outcome !== "found_later" && Number(r.systemShowsAtRejectingPlaceToday) > 0),
  reasonKinds, outcome: group("outcome"), verdict: group("verdict"), routedTo: group("routedTo"),
  locationTable, staffTable, categoryRate, brand: group("brand", 3), subcategory: group("subcategory", 3),
  hoursOrderToRejection: { median: median(hours), p90: hours.sort((a, b) => a - b)[Math.floor(hours.length * 0.9)] },
  factors: {
    lastSinglePiece: share((r) => r.lastSinglePiece === "yes" && r.routedTo !== "nowhere (no stock on the route)"),
    centralOnlyAtOrder: share((r) => r.centralOnlyAtOrder === "yes"),
    websitePoolZeroAtOrder: share((r) => r.websitePoolAtOrder === 0),
    routedPlaceShowedZeroAtOrder: share((r) => r.onHandRoutedAtOrder === 0),
    takenBetweenOrderAndRejection: share((r) => r.soldBetweenOrderAndRejection !== ""),
    rejectedAfterHandover: share((r) => /packer_/.test(r.reason)),
    damaged: share((r) => /packer_damaged/.test(r.reason)),
    twinNames: share((r) => r.twinCount > 0),
    displayPieceRegistered: share((r) => r.displayPieceRegistered === "yes"),
    cellNotMoved14Days: { n: stale(14), pct: pct(stale(14), rows.length) }, cellNotMoved30Days: { n: stale(30), pct: pct(stale(30), rows.length) },
    neverCountedInWindow: share((r) => String(r.daysSinceCellLastCounted).startsWith("none")),
    falseUnavailable: share((r) => r.verdict.startsWith("false")),
    stockShownElsewhere: share((r) => r.verdict.startsWith("stock shown")),
    rejectedTwiceOrMore: share((r) => r.timesRejected >= 2),
  },
  repeats, repeatProducts: Object.values(repeatByPid).filter((x) => x.n >= 2).map((x) => ({ ...x, sizes: [...x.sizes], orders: [...x.orders] })).sort((a, b) => b.n - a.n),
  windowStart: iso(WINDOW_START), jamie: jamieStats, shopify: shopifyStats,
  centralOnlyLines: { lines: centralOnly.lines, failed: centralOnly.failed, medianHoursOrderToHanded: centralOnly.waitedHours.length ? Math.round(median(centralOnly.waitedHours)) : null },
  byWeek: (() => { const wk = (t) => { const d = new Date(t + SAST).toISOString().slice(0, 10); return d < "2026-11-01" ? "21-31 Oct" : d < "2026-11-08" ? "1-7 Nov" : d < "2026-11-15" ? "8-14 Nov" : d < "2026-11-22" ? "15-21 Nov" : "22-24 Nov"; }; const L = cnt(allLines.map((x) => wk(ms(x.o.createdAt)))); const F = cnt([...episodes.values()].map((e) => wk(e.orderAt))); const K = cnt([...episodes.values()].filter((e) => e.row.repeatOfKnownBadCell === "yes").map((e) => wk(e.orderAt))); return Object.keys(L).map((k) => ({ week: k, lines: L[k], failed: F[k] || 0, ratePct: pct(F[k] || 0, L[k]), repeatsOfAKnownBadShelf: K[k] || 0 })); })(),
};

const cols = Object.keys(rows[0]).concat(["repeatOfKnownBadCell"], shopify ? ["shopifyOrderCancelled", "shopifyRefundOnLine", "shopifyNote"] : [], jamie ? ["jamieOffer", "jamieFirstOfferAt", "jamieChannel", "jamieOptions", "hoursRejectionToOffer", "customerSaid"] : []).filter((c, i, a) => a.indexOf(c) === i);
const csvCell = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
writeFileSync(join(OUT, "unavailable-lines.csv"), [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n");
const md = (head, list) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...list.map((r) => `| ${r.map((v) => String(v ?? "").replace(/\|/g, "/")).join(" | ")} |`)].join("\n");
const tables = [
  "## Appendix A: every unavailable line and its reason\n",
  md(["Order", "Product", "Size", "Sent to", "What happened", "Shown there then", "Outcome"], rows.map((r) => [r.order, r.product, r.size, r.routedTo, r.rejections || r.reason, r.onHandRoutedAtOrder, `${r.outcome.replace(/_/g, " ")}${r.outcomeDetail ? `: ${r.outcomeDetail}` : ""}`])),
  "\n## Appendix B: false unavailables, with the proof\n",
  md(["Order", "Product", "Size", "Rejected", "Proof it was there"], rows.filter((r) => r.verdict.startsWith("false")).map((r) => [r.order, r.product, r.size, r.rejections, r.proof])),
  "\n## Appendix C: stock the system showed at another pickable place when the line was rejected\n",
  md(["Order", "Product", "Size", "Rejected", "Shown elsewhere", "Outcome"], rows.filter((r) => r.verdict.startsWith("stock shown")).map((r) => [r.order, r.product, r.size, r.rejections, r.shownElsewhereWhenRejected, r.outcome.replace(/_/g, " ")])),
  "\n## Appendix D: sizes that failed two or more times\n",
  md(["Times", "Product", "Size", "Orders", "Picked successfully since?"], repeats.map((r) => [r.timesFailed, r.product, r.size, r.orders.join(" "), r.fulfilledSince ? "yes" : "no"])),
].join("\n");
writeFileSync(join(OUT, "tables.md"), tables + "\n");
writeFileSync(join(OUT, "stats.json"), JSON.stringify(stats, null, 1));
writeFileSync(join(OUT, "episodes.json"), JSON.stringify([...episodes.values()].map((e) => ({ key: e.key, isFootwear: e.isFootwear, routedTo: e.routedToKey, orderAt: e.orderAt, priceCents: e.priceCents, firstFailAt: e.firstFail?.at ?? null, swapAt: e.swapAt ?? null, fails: e.fails, row: e.row })), null, 0));
console.log(JSON.stringify({ ...stats, repeats: stats.repeats.length, repeatProducts: stats.repeatProducts.length, jamie: jamieStats ? { ...jamieStats, declinedWords: jamieStats.declinedWords.length, noReply: jamieStats.noReply.length } : null }, null, 1));

// ─── BF CANDIDATES — stock that isn't moving, and the in-store Black Friday sale (pure) ──
// Junid, 23 Nov 2026.
//
//   • CANDIDATE  = on hand > 0 (every location added together) AND zero units sold in the
//                  last N days (N = 30, adjustable on the card). The nightly finder on the
//                  Mac mini writes candidates/items/{pid}; nothing here reads the catalogue.
//   • SALE       = ONE price per product, from Junid's tap until Monday 30 Nov 2026 23:59
//                  Africa/Johannesburg (extendable). Stored on its OWN node, sales/{pid}; the
//                  product's stock and retail prices are NEVER changed. The till reads the
//                  additive mirror products/{pid}/bfSale = { price, start, end } and checks
//                  the dates itself, so a sale stops at its end even if no job has run.
//   • IN-STORE ONLY (Junid's amendment): nothing here touches Shopify.
//   • NOT FOR SALE = removed/{pid}: off the list for good; the nightly finder skips it.
//
// Server-only node (no database rule): the Admin SDK behind the super-admin gate.
"use strict";

const ROOT = "bf_sales_2026";
const WINDOWS = Object.freeze([14, 30, 60, 90]);
const DEFAULT_WINDOW = 30;
const DEFAULT_END_DAY = "2026-11-30";
const TABS = Object.freeze(["clothing", "sneakers"]);
const DAY_MS = 86400_000;
const TZ = "Africa/Johannesburg";
const PAGE = 200;
const MAX_PIDS = 200;
const PID_RE = /^[A-Za-z0-9_-]{1,80}$/;

// ── time (SAST has no daylight saving: +02:00 is exact) ──────────────────────
const sastDay = (ms) => new Date(ms + 2 * 3600_000).toISOString().slice(0, 10);
/** The last millisecond of a SAST day: a sale "until Mon 30 Nov" runs to 23:59:59.999 that day. */
function endOfDayMs(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return null;
  const ms = Date.parse(`${day}T23:59:59.999+02:00`);
  return Number.isFinite(ms) ? ms : null;
}
/** "Mon 30 Nov" (the card, the alerts and the WhatsApp caption all say it this way). */
function endLabel(endMs) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" }).formatToParts(new Date(endMs)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}`;
}
const priceLabel = (p) => (Number.isInteger(Number(p)) ? `R${Number(p)}` : `R${Number(p).toFixed(2)}`);

// ── candidates ───────────────────────────────────────────────────────────────
const windowOf = (w) => (WINDOWS.includes(Number(w)) ? Number(w) : DEFAULT_WINDOW);
const tabOf = (row) => (row && row.kind === "sneakers" ? "sneakers" : "clothing");
/** On hand and nothing sold inside the window (never sold counts). */
function isCandidate(row, windowDays, nowMs) {
  if (!row || !(Number(row.qty) > 0)) return false;
  const last = Number(row.lastSold) || 0;
  return !last || last < nowMs - windowOf(windowDays) * DAY_MS;
}
/** "never sold" | "42 days" (whole days since the last unit sold). */
function sinceLabel(lastSold, nowMs) {
  const last = Number(lastSold) || 0;
  if (!last) return "never sold";
  const d = Math.max(0, Math.floor((nowMs - last) / DAY_MS));
  return d === 1 ? "1 day" : `${d} days`;
}
const saleVersion = (s) => Number(s && (s.extendedAt || s.setAt)) || 0;
/** Is this sale charging now? Strict: anything malformed is NOT a sale (normal prices). */
function saleActive(s, nowMs) {
  return !!s && Number.isFinite(Number(s.salePrice)) && Number(s.salePrice) > 0
    && Number.isFinite(Number(s.start)) && Number.isFinite(Number(s.end)) && Number(s.start) <= nowMs && nowMs < Number(s.end);
}
/** The photo that posts for a row: the one Junid chose on the card, else the product's own. */
const photoOf = (row, chosen) => (chosen && typeof chosen.url === "string" && /^https:\/\//.test(chosen.url) ? chosen.url : (row && row.photo) || null);

/** One row as the card shows it. */
function viewRow(pid, row, { sale = null, chosen = null, posted = null, nowMs }) {
  const on = saleActive(sale, nowMs);
  return {
    pid, name: row.name || pid, tab: tabOf(row), cat: row.cat || null, qty: Number(row.qty) || 0,
    since: sinceLabel(row.lastSold, nowMs), lastSold: Number(row.lastSold) || null,
    stockPrice: Number(row.stockPrice) > 0 ? Number(row.stockPrice) : null,
    retailPrice: Number(row.retailPrice) > 0 ? Number(row.retailPrice) : null,
    locs: row.locs || {}, sizes: row.sizes || "", photo: photoOf(row, chosen), ownPhoto: row.photo || null,
    photoChoice: chosen ? { use: chosen.use || "current", at: chosen.at || null } : null,
    sale: on ? { price: Number(sale.salePrice), start: sale.start, end: sale.end, until: endLabel(sale.end), setAt: sale.setAt, extendedAt: sale.extendedAt || null } : null,
    posted: on && posted && Number(posted.version) === saleVersion(sale) ? { at: posted.at, groups: posted.groups || 0 } : null,
  };
}
/**
 * The card's list. items: candidates/items; removed: removed; sales: sales; photos: photos; posted: posted.
 * → { rows (this tab's page), counts: { clothing, sneakers, onSale, removed }, total, from, more }
 * Sorted by quantity, highest first. A product on sale stays listed (with its sale) even after it sells.
 */
function viewList({ items = {}, removed = {}, sales = {}, photos = {}, posted = {} }, { tab = "clothing", windowDays = DEFAULT_WINDOW, from = 0, n = PAGE, nowMs }) {
  const t = TABS.includes(tab) ? tab : "clothing";
  const counts = { clothing: 0, sneakers: 0, onSale: 0, removed: Object.keys(removed || {}).length };
  const mine = [];
  const seen = new Set();
  for (const [pid, row] of Object.entries(items || {})) {
    if (!row || (removed && removed[pid])) continue;
    const on = saleActive(sales && sales[pid], nowMs);
    if (!on && !isCandidate(row, windowDays, nowMs)) continue;
    seen.add(pid);
    counts[tabOf(row)] += 1;
    if (on) counts.onSale += 1;
    if (tabOf(row) === t) mine.push([pid, row]);
  }
  // On sale but no longer in the finder's list (sold through, or the list was rebuilt): still shown, from the sale itself.
  for (const [pid, s] of Object.entries(sales || {})) {
    if (seen.has(pid) || !saleActive(s, nowMs) || (removed && removed[pid])) continue;
    const row = { name: s.name, kind: s.kind, cat: s.cat || null, qty: 0, lastSold: null, stockPrice: s.baseStock, retailPrice: s.baseRetail, photo: s.photo || null, locs: {}, sizes: "" };
    counts[tabOf(row)] += 1; counts.onSale += 1;
    if (tabOf(row) === t) mine.push([pid, row]);
  }
  mine.sort((a, b) => (Number(b[1].qty) || 0) - (Number(a[1].qty) || 0) || String(a[1].name || "").localeCompare(String(b[1].name || "")) || a[0].localeCompare(b[0]));
  const start = Math.max(0, Number(from) || 0);
  const page = mine.slice(start, start + Math.max(1, Math.min(PAGE, Number(n) || PAGE)));
  return {
    rows: page.map(([pid, row]) => viewRow(pid, row, { sale: sales && sales[pid], chosen: photos && photos[pid], posted: posted && posted[pid], nowMs })),
    counts, total: mine.length, from: start, more: start + page.length < mine.length,
  };
}

// ── the sale ─────────────────────────────────────────────────────────────────
/** A sale price Junid typed: rands, more than 0, at most 2 decimals. → number | null */
function parsePrice(v) {
  const n = typeof v === "string" ? Number(v.replace(/^\s*R\s*/i, "").replace(/\s+/g, "").replace(",", ".")) : Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return null;
  return Math.round(n * 100) / 100;
}
/** The products a sale price would NOT be a saving for resellers: sale price ≥ their current stock price. */
function aboveStock(rows, price) {
  return rows.filter((r) => Number(r.stockPrice) > 0 && Number(price) >= Number(r.stockPrice))
    .map((r) => ({ pid: r.pid, name: r.name, stockPrice: Number(r.stockPrice) }));
}
/** The end of a sale from the card's date ("YYYY-MM-DD", default Mon 30 Nov 2026): the last ms of that SAST day. */
function saleEnd(day, nowMs) {
  const end = endOfDayMs(day || DEFAULT_END_DAY);
  return end && end > nowMs ? end : null;
}
/** sales/{pid}. base* are a record of the prices when the sale was set: nothing reads them to charge. */
function saleRecord({ row, price, start, end, uid, photo }) {
  return {
    salePrice: price, start, end, setBy: uid || null, setAt: start,
    name: String(row.name || "").slice(0, 200), kind: tabOf(row), cat: row.cat || null,
    ...(photo ? { photo } : {}),
    baseStock: Number(row.stockPrice) > 0 ? Number(row.stockPrice) : null,
    baseRetail: Number(row.retailPrice) > 0 ? Number(row.retailPrice) : null,
  };
}
/** The till's mirror on the product record (additive; removed when the sale ends). */
const tillMirror = (s) => ({ price: Number(s.salePrice), start: Number(s.start), end: Number(s.end) });

// ── the alerts and the staff list ────────────────────────────────────────────
/** The words of a store alert. type: start | extend | end. */
function alertText(type, name, sale) {
  const n = String(name || "A product").trim();
  if (type === "end") return { title: "Black Friday sale ended", body: `${n} is back to its normal price, re-tag` };
  if (type === "extend") return { title: "Black Friday sale extended", body: `${n} stays ${priceLabel(sale.salePrice)} until ${endLabel(sale.end)}` };
  return { title: "Black Friday sale", body: `Black Friday sale: ${n} now ${priceLabel(sale.salePrice)}, re-tag` };
}
/** Several products in one tap: one notification per store, naming the first. */
function alertBurst(type, names, sale) {
  if (names.length <= 1) return alertText(type, names[0], sale);
  const first = alertText(type, names[0], sale);
  const rest = names.length - 1;
  if (type === "end") return { title: first.title, body: `${names[0]} and ${rest} more are back to normal price, re-tag` };
  if (type === "extend") return { title: first.title, body: `${names[0]} and ${rest} more stay on sale until ${endLabel(sale.end)}` };
  return { title: first.title, body: `Black Friday sale: ${names[0]} and ${rest} more now ${priceLabel(sale.salePrice)}, re-tag` };
}
/** Locations holding a product now (qty > 0), from { loc: qty }. Stock in transit is on no shelf. */
const holders = (locs) => Object.entries(locs || {}).filter(([loc, q]) => Number(q) > 0 && loc !== "in_transit").map(([loc]) => loc);
/**
 * The re-tag list, per store: every product on sale that the store holds.
 * sales: sales node; stock: { pid: { loc: qty } }; names: { loc: display name }.
 * → [{ loc, name, items: [{ pid, name, price, until, qty, photo }] }] (stores by name, items by name)
 */
function storeList(sales, stock, names = {}, nowMs) {
  const by = {};
  for (const [pid, s] of Object.entries(sales || {})) {
    if (!saleActive(s, nowMs)) continue;
    for (const loc of holders(stock && stock[pid])) {
      (by[loc] ||= []).push({ pid, name: s.name || pid, price: Number(s.salePrice), until: endLabel(s.end), qty: Number(stock[pid][loc]) || 0, photo: s.photo || null });
    }
  }
  return Object.entries(by).map(([loc, items]) => ({ loc, name: names[loc] || loc, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── the WhatsApp caption, as it will post (the poster builds the same words) ─
const AT = Object.freeze({ both: "Marathon Club & Concrete", marathon: "Marathon Club only", concrete: "Concrete only" });
const saleText = (price) => `🔥 BLACK FRIDAY SALE: ${priceLabel(price)}`;
function salePhotoCaption(sizes, at, endMs) {
  const list = (Array.isArray(sizes) ? sizes : String(sizes || "").split(",")).map((s) => String(s).trim()).filter(Boolean);
  return [`Sizes: ${list.length ? list.join(", ") : "One size"}`, `📍 Sale available at ${AT[at] || AT.both}`, `Ends ${endLabel(endMs)}`].join("\n");
}

module.exports = {
  ROOT, WINDOWS, DEFAULT_WINDOW, DEFAULT_END_DAY, TABS, DAY_MS, PAGE, MAX_PIDS, PID_RE, AT,
  sastDay, endOfDayMs, endLabel, priceLabel, windowOf, tabOf, isCandidate, sinceLabel, saleVersion, saleActive, photoOf,
  viewRow, viewList, parsePrice, aboveStock, saleEnd, saleRecord, tillMirror,
  alertText, alertBurst, holders, storeList, saleText, salePhotoCaption,
};

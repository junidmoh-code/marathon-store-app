// ─── BF CANDIDATES — stock that isn't moving, and the in-store Black Friday sale (pure) ──
// Junid, 23 Nov 2026.
//
//   • CANDIDATE  = (Junid, 15:44: "new stock is not dead stock") the product FIRST ARRIVED
//                  anywhere in the network on or before the cut-off (31 Jul 2026; May, June,
//                  July or August on the card), it still has stock on hand, AND the units sold
//                  since it arrived are UNDER 10% of the units received (zero sold counts).
//                  The finder on the Mac mini reads the stock ledger and writes
//                  candidates/items/{pid} = { arrived, received, sold, qty, … }; nothing here
//                  reads the catalogue or the ledger.
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
// "In store since": arrived on or before the END of that month (SAST), 2026. The finder's own table
// (marathon-group-poster src/bf/candidates.mjs CUTOFFS).
const CUTOFFS = Object.freeze({ may: "2026-05-31", june: "2026-06-30", july: "2026-07-31", august: "2026-08-31" });
const CUTOFF_LABEL = Object.freeze({ may: "May", june: "June", july: "July", august: "August" });
const DEFAULT_CUTOFF = "july";
const SOLD_SHARE = 0.10; // sold must be UNDER this share of what was received
const DEFAULT_END_DAY = "2026-11-30";
const TABS = Object.freeze(["clothing", "sneakers"]);       // the candidate tabs
const VIEWS = Object.freeze(["clothing", "sneakers", "onsale"]); // + everything on sale now
const DAY_MS = 86400_000;
const TZ = "Africa/Johannesburg";
const PAGE = 200;
const MAX_PIDS = 500; // one tap = one call: the warning is decided for the whole selection before anything is saved
const BACK_MS = 2 * 86400_000; // an ended sale stays on the staff's "back to normal price" list for two days
const PID_RE = /^[A-Za-z0-9_-]{1,80}$/;

// ── time (SAST has no daylight saving: +02:00 is exact) ──────────────────────
const sastDay = (ms) => new Date(ms + 2 * 3600_000).toISOString().slice(0, 10);
/** The last millisecond of a SAST day: a sale "until Mon 30 Nov" runs to 23:59:59.999 that day. */
function endOfDayMs(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return null;
  const ms = Date.parse(`${day}T23:59:59.999+02:00`);
  // A date that is not on the calendar (31 Nov) rolls into the next month when parsed: refused, not moved.
  return Number.isFinite(ms) && sastDay(ms) === String(day) ? ms : null;
}
/** "Mon 30 Nov" (the card, the alerts and the WhatsApp caption all say it this way). */
function endLabel(endMs) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" }).formatToParts(new Date(endMs)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}`;
}
const priceLabel = (p) => (Number.isInteger(Number(p)) ? `R${Number(p)}` : `R${Number(p).toFixed(2)}`);

// ── candidates ───────────────────────────────────────────────────────────────
const cutoffOf = (k) => (Object.prototype.hasOwnProperty.call(CUTOFFS, String(k)) ? String(k) : DEFAULT_CUTOFF);
const cutoffMs = (k) => endOfDayMs(CUTOFFS[cutoffOf(k)]);
const tabOf = (row) => (row && row.kind === "sneakers" ? "sneakers" : "clothing");
// The finder's own rule (marathon-group-poster src/bf/core.mjs FOOTWEAR_KEYS), for a product whose finder row is gone.
const FOOTWEAR_KEYS = Object.freeze(["sneakers", "running-shoes", "boots", "soccer-boots", "slides", "loafers", "kids-shoes", "designer-shoes", "sandals"]);
const kindOfCat = (categoryKey) => (FOOTWEAR_KEYS.includes(String(categoryKey || "")) ? "sneakers" : "clothing");
/** Old stock that isn't selling: on hand, arrived by the cut-off, sold under 10% of what was received. */
function isCandidate(row, cutoff) {
  if (!row || !(Number(row.qty) > 0)) return false;
  const arrived = Number(row.arrived) || 0, received = Number(row.received) || 0;
  if (!arrived || !(received > 0)) return false; // no arrival on record: never guessed
  return arrived <= cutoffMs(cutoff) && (Number(row.sold) || 0) < SOLD_SHARE * received;
}
/** "12 Jul 2026" (SAST). */
function dayLabel(ms) {
  if (!(Number(ms) > 0)) return null;
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" }).format(new Date(Number(ms)));
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
    pid, name: row.name || pid, tab: tabOf(row), cat: row.cat || null, qty: row.qty === null || row.qty === undefined ? null : Number(row.qty) || 0, // null: not on the finder's list any more (not counted here)
    arrived: Number(row.arrived) || null, arrivedOn: dayLabel(row.arrived), received: Number(row.received) || 0, sold: Number(row.sold) || 0,
    stockPrice: Number(row.stockPrice) > 0 ? Number(row.stockPrice) : null,
    retailPrice: Number(row.retailPrice) > 0 ? Number(row.retailPrice) : null,
    locs: row.locs || {}, sizes: row.sizes || "", photo: photoOf(row, chosen), ownPhoto: row.photo || null,
    photoChoice: chosen ? { use: chosen.use || "current", at: chosen.at || null } : null,
    sale: on ? { price: Number(sale.salePrice), start: sale.start, end: sale.end, until: endLabel(sale.end), setAt: sale.setAt, extendedAt: sale.extendedAt || null } : null,
    posted: on && posted && Number(posted.version) === saleVersion(sale) ? { at: posted.at, groups: posted.groups || 0 } : null,
  };
}
/**
 * By QUANTITY on hand, the most first (Junid, 18:15: "the highest amount goes on top; only one left goes all the way
 * down"); the same quantity: the oldest arrival first, then by name.
 */
function byQuantity(a, b) {
  return (Number(b[1].qty) || 0) - (Number(a[1].qty) || 0) || (Number(a[1].arrived) || Infinity) - (Number(b[1].arrived) || Infinity)
    || String(a[1].name || "").localeCompare(String(b[1].name || "")) || a[0].localeCompare(b[0]);
}
/**
 * The card's list. items: candidates/items; removed: removed; sales: sales; photos: photos; posted: posted.
 * tab: "clothing" | "sneakers" (the candidates; one still on sale shows its sale) | "onsale" (EVERYTHING on sale now,
 * candidate or not, built from the sale itself when the finder no longer lists the product).
 * → { rows (this tab's page), counts: { clothing, sneakers, onSale, removed }, total, from, more, saleEnds }
 */
function viewList({ items = {}, removed = {}, sales = {}, photos = {}, posted = {} }, { tab = "clothing", cutoff = DEFAULT_CUTOFF, from = 0, n = PAGE, nowMs }) {
  const t = VIEWS.includes(tab) ? tab : "clothing";
  const counts = { clothing: 0, sneakers: 0, onSale: 0, removed: Object.keys(removed || {}).length };
  const mine = [];
  for (const [pid, row] of Object.entries(items || {})) {
    if (!row || (removed && removed[pid]) || !isCandidate(row, cutoff)) continue;
    counts[tabOf(row)] += 1;
    if (tabOf(row) === t) mine.push([pid, row]);
  }
  let first = null, last = null;
  for (const [pid, s] of Object.entries(sales || {})) {
    if (!saleActive(s, nowMs)) continue;
    counts.onSale += 1;
    if (first === null || Number(s.end) < first) first = Number(s.end);
    if (last === null || Number(s.end) > last) last = Number(s.end);
    if (t !== "onsale") continue;
    // The finder's row when it still has one (stock, arrival); else the sale's own record.
    const it = items && items[pid];
    mine.push([pid, it ? { ...it } : { name: s.name, kind: s.kind, cat: s.cat || null, qty: null, stockPrice: s.baseStock, retailPrice: s.baseRetail, photo: s.photo || null, locs: {}, sizes: "" }]);
  }
  if (t === "onsale") mine.sort((a, b) => String(a[1].name || "").localeCompare(String(b[1].name || "")) || a[0].localeCompare(b[0]));
  else mine.sort(byQuantity);
  const start = Math.max(0, Number(from) || 0);
  const page = mine.slice(start, start + Math.max(1, Math.min(PAGE, Number(n) || PAGE)));
  return {
    rows: page.map(([pid, row]) => viewRow(pid, row, { sale: sales && sales[pid], chosen: photos && photos[pid], posted: posted && posted[pid], nowMs })),
    counts, total: mine.length, from: start, more: start + page.length < mine.length,
    // When the sales running now end: one date when they all end together.
    saleEnds: first === null ? null : { first, last, firstLabel: endLabel(first), lastLabel: endLabel(last), same: first === last },
  };
}

// ── the sale ─────────────────────────────────────────────────────────────────
/** "R 1 249,50" → "1249.50"; "1,500" → "1500" (a comma before exactly three digits is a thousands comma, never R1.50). */
function plainNumber(text) {
  const t = String(text || "").replace(/^\s*R\s*/i, "").replace(/\s+/g, "");
  return /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t) ? t.replace(/,/g, "") : t.replace(",", ".");
}
/** A sale price Junid typed: rands, more than 0, at most 2 decimals. → number | null */
function parsePrice(v) {
  const n = typeof v === "string" ? Number(plainNumber(v)) : Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return null;
  const cents = Math.round(n * 100);
  return cents >= 1 ? cents / 100 : null; // a price that rounds to nothing is not a price
}
/**
 * The products a sale price would NOT be a saving for: sale price ≥ their current stock price. A product with no
 * stock price set is checked against its retail price instead (a typo is never charged without a warning).
 */
function aboveStock(rows, price) {
  const out = [];
  for (const r of rows) {
    const stock = Number(r.stockPrice) > 0 ? Number(r.stockPrice) : null, retail = Number(r.retailPrice) > 0 ? Number(r.retailPrice) : null;
    const ref = stock !== null ? stock : retail;
    if (ref !== null && Number(price) >= ref) out.push({ pid: r.pid, name: r.name, stockPrice: stock, ...(stock === null ? { retailPrice: retail } : {}) });
  }
  return out;
}
/** The end of a sale from the card's date ("YYYY-MM-DD", default Mon 30 Nov 2026): the last ms of that SAST day. */
function saleEnd(day, nowMs) {
  const end = endOfDayMs(day || DEFAULT_END_DAY);
  return end && end > nowMs ? end : null;
}
/**
 * The end a NEW sale gets when the card names no date: Mon 30 Nov — or, once Junid has extended EVERY running sale
 * past it, the earliest of their ends (a product put on sale after "Extend" ends with the rest). One product
 * extended on its own never moves the date for the others.
 */
function defaultEnd(sales, nowMs) {
  const base = endOfDayMs(DEFAULT_END_DAY);
  const ends = Object.values(sales || {}).filter((s) => saleActive(s, nowMs)).map((s) => Number(s.end));
  return ends.length ? Math.max(base, Math.min(...ends)) : base;
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
/** Several products in one tap: one notification per store, naming up to three (staff must know WHAT to re-tag). */
function alertBurst(type, names, sale, { arriving = false } = {}) {
  // A store that holds none of it yet but has it on request: the same news, and the tag goes on when it arrives.
  if (arriving && type !== "end") {
    const shown = names.slice(0, 3).map((n) => String(n || "A product").trim());
    const rest = names.length - shown.length;
    const list = rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : shown[0];
    return type === "extend"
      ? { title: "Black Friday sale extended", body: `${list}, on ${names.length > 1 ? "their" : "its"} way to you, ${names.length > 1 ? "stay" : "stays"} on sale until ${endLabel(sale.end)}` }
      : { title: "Black Friday sale", body: `Black Friday sale: ${list} now ${priceLabel(sale.salePrice)}. On ${names.length > 1 ? "their" : "its"} way to you: tag at the sale price on arrival` };
  }
  if (names.length <= 1) return alertText(type, names[0], sale);
  const first = alertText(type, names[0], sale);
  const shown = names.slice(0, 3).map((n) => String(n || "A product").trim());
  const rest = names.length - shown.length;
  const list = rest > 0 ? `${shown.join(", ")} and ${rest} more` : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  if (type === "end") return { title: first.title, body: `${list} are back to normal price, re-tag` };
  if (type === "extend") return { title: first.title, body: `${list} stay on sale until ${endLabel(sale.end)}` };
  return { title: first.title, body: `Black Friday sale: ${list} now ${priceLabel(sale.salePrice)}, re-tag` };
}
/**
 * The locations RECEIVING a product, from its request rows ({ id: { status, requestingLocation, qty } }): only OPEN
 * requests count. → { loc: units asked for }. Pure, read only.
 */
function receivers(rows) {
  const out = {};
  for (const r of Object.values(rows || {})) {
    if (!r || r.status !== "open" || typeof r.requestingLocation !== "string" || !r.requestingLocation) continue;
    out[r.requestingLocation] = (out[r.requestingLocation] || 0) + (Number(r.qty) > 0 ? Number(r.qty) : 1);
  }
  return out;
}
/** Locations holding a product now (qty > 0), from { loc: qty }. Stock in transit is on no shelf. */
const holders = (locs) => Object.entries(locs || {}).filter(([loc, q]) => Number(q) > 0 && loc !== "in_transit").map(([loc]) => loc);
/**
 * The re-tag list, per store: every product on sale that the store holds, and (back) every product whose sale ended
 * in the last two days that it holds — the tags to put BACK to the normal price (what the END alert opens).
 * sales: sales node; stock: { pid: { loc: qty } }; names: { loc: display name }; back: { pid: { at, name, was, photo } }.
 * coming: { pid: { loc: units on open request } } (a store receiving it is listed with qty 0 and `arriving`).
 * → [{ loc, name, items: [{ pid, name, price, until, qty, arriving?, photo }], back: [{ pid, name, was, qty, photo, endedAt }] }]
 */
function storeList(sales, stock, names = {}, nowMs, { back = {}, coming = {} } = {}) {
  const by = {};
  const at = (loc) => (by[loc] ||= { items: [], back: [] });
  for (const [pid, s] of Object.entries(sales || {})) {
    if (!saleActive(s, nowMs)) continue;
    for (const loc of holders(stock && stock[pid])) {
      at(loc).items.push({ pid, name: s.name || pid, price: Number(s.salePrice), until: endLabel(s.end), qty: Number(stock[pid][loc]) || 0, photo: s.photo || null });
    }
    // coming: { pid: { loc: units on request } } — a store that holds none yet but has it on request (only stores
    // the names table knows: a request row naming anything else is not a place to tag).
    const here = holders(stock && stock[pid]);
    for (const [loc, n] of Object.entries((coming && coming[pid]) || {})) {
      if (here.includes(loc) || !Object.prototype.hasOwnProperty.call(names, loc)) continue;
      at(loc).items.push({ pid, name: s.name || pid, price: Number(s.salePrice), until: endLabel(s.end), qty: 0, arriving: Number(n) || 1, photo: s.photo || null });
    }
  }
  for (const [pid, b] of Object.entries(back || {})) {
    if (!b || saleActive(sales && sales[pid], nowMs)) continue;
    for (const loc of holders(stock && stock[pid])) at(loc).back.push({ pid, name: b.name || pid, was: Number(b.was) || null, qty: Number(stock[pid][loc]) || 0, photo: b.photo || null, endedAt: Number(b.at) || null });
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  return Object.entries(by).map(([loc, v]) => ({ loc, name: names[loc] || loc, items: v.items.sort(byName), back: v.back.sort(byName) }))
    .sort(byName);
}

// ── the WhatsApp caption, as it will post (the poster builds the same words) ─
const AT = Object.freeze({ both: "Marathon Club & Concrete", marathon: "Marathon Club only", concrete: "Concrete only" });
const saleText = (price) => `🔥 BLACK FRIDAY SALE: ${priceLabel(price)}`;
function salePhotoCaption(sizes, at, endMs) {
  const list = (Array.isArray(sizes) ? sizes : String(sizes || "").split(",")).map((s) => String(s).trim()).filter(Boolean);
  return [`Sizes: ${list.length ? list.join(", ") : "One size"}`, `📍 Sale available at ${AT[at] || AT.both}`, `Ends ${endLabel(endMs)}`].join("\n");
}

module.exports = {
  ROOT, CUTOFFS, CUTOFF_LABEL, DEFAULT_CUTOFF, SOLD_SHARE, DEFAULT_END_DAY, TABS, VIEWS, DAY_MS, PAGE, MAX_PIDS, PID_RE, BACK_MS, AT,
  sastDay, endOfDayMs, endLabel, priceLabel, cutoffOf, cutoffMs, dayLabel, defaultEnd, tabOf, kindOfCat, FOOTWEAR_KEYS, isCandidate, saleVersion, saleActive, photoOf,
  viewRow, viewList, plainNumber, parsePrice, aboveStock, saleEnd, saleRecord, tillMirror,
  alertText, alertBurst, holders, receivers, storeList, saleText, salePhotoCaption,
};

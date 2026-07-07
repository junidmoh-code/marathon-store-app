// ─── CLOTHING-SOLD REFILL HELPERS (pure, shared) ──────────────────────────────
// Pure helpers behind the Clothing-Sold refill tabs. Firebase-free so they have a
// single definition AND are unit-testable without importing the firebase-bound
// monolith — same shape as utils/insights.js.
//
// DATA SOURCE — /stock_movements (native ledger), NOT insights_log. insights_log
// misses walk-in sales; the ledger records EVERY sale (POS writes a `sold`
// movement per (sale, product, size) cell) so the refill worklist is complete
// from day one — verified ~97% against /pos/sales.
//
// A `sold` movement body (see marathon-pos-app src/stock/stockMovement.js):
//   { type:"sold", productId, size /*RAW, e.g. "M"/"5.5"*/, qty /*+magnitude*/,
//     from /*shop id — the store that sold it*/, ts /*ISO*/, link:{ saleId } }
// A `return`/void mirrors it with type:"return", to = the shop it came back to,
// and link.saleId = the REFUND record id (NOT the original sale). So returns
// can't be netted by saleId — we net by (store, productId, size) across the
// window instead, which drops refunded/voided units.
//
// CARD MODEL: ONE card per (store, product) with a per-size qty breakdown
// ("Nike Tee — M×7, L×5, S×5 = 17"), aggregated across the scope's days. NOT one
// card per (sale,size) cell (which fragmented a popular item into dozens).
//
// REFILL MODEL (ledger-derived): refilling a size fires a REAL `transfer_out`
// (hub→store) tagged reason=CLOTHING_REFILL_REASON. A size's outstanding demand is
//   outstanding = netSold − refilledQty   (both from the windowed ledger)
// so a card clears only when every sold size has been transferred (or skipped),
// and RE-APPEARS automatically when more sells. The `clothing_sold_refills` node
// is NOT the completion source anymore — it only records explicit SKIPs (a size
// the crew acknowledges it can't/won't refill, so it stops reappearing).

import { inferProductType } from "./insights";

// Marker on the refill transfer_out movement's `reason`, so refill replenishments
// are distinguishable from any other transfer to a store (e.g. the sneaker
// refill-request fulfilment, which sets link.refillId but no such reason).
export const CLOTHING_REFILL_REASON = "clothing_refill";

// Read window (days) for the bounded /stock_movements query. The App builds a
// ts-windowed query [saStartIso(getSAPastDateString(N)) … now) so the read is
// bounded — NEVER an unbounded subscription over the whole ledger. Requires the
// stock_movements `.indexOn:["ts"]` rule, else the query silently reads it all.
export const CLOTHING_SOLD_BACKLOG_DAYS = 14;

// The stores the clothing-sold tabs cover. Each gets a per-store daily tab;
// Sold Backlog merges these. Pine is a one-line add: append "marathon-pine".
export const CLOTHING_SOLD_STORES = ["marathon-pe", "trophy"];

// Hard cap on how far back the Backlog date picker may reach — bounds the
// ts-windowed query so a big pick can't pull the whole ledger.
export const CLOTHING_SOLD_MAX_RANGE_DAYS = 90;

// SA-timezone (UTC+2) date slice "YYYY-MM-DD" of an ISO timestamp. Identical
// convention to insights.js / DayCollapsible (+2h shift before slicing).
export const saDateOf = (iso) => {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return ""; // malformed ts → skip, don't throw on toISOString
  return new Date(t + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
};

// UTC ISO instant of 00:00 SA-time on a given SA-date "YYYY-MM-DD". Midnight SA
// (UTC+2) is 22:00 UTC the previous day, so we subtract 2h. This is the `startAt`
// bound for the ts-windowed query — everything sold on-or-after that SA-date.
export const saStartIso = (saDate) => {
  if (!saDate) return "";
  const t = new Date(`${saDate}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(t)) return ""; // malformed date → don't throw
  return new Date(t - 2 * 60 * 60 * 1000).toISOString();
};

// The single cutoff constant dividing "today's per-store sales" from the merged
// "Sold Backlog". cutoff = TODAY's SA-date:
//   • per-store tabs → sale saDate >= cutoff  (today; nothing is in the future)
//   • Sold Backlog   → sale saDate <  cutoff  (yesterday … 14 days back)
// The daily per-store list is the actionable "sold today, refill it" worklist;
// backlog is the aging pile. (cutoff=tomorrow would leave per-store tabs empty.)
export const clothingSoldCutoff = () =>
  new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);

// Tally refilled UNITS per (store, productId, size) from the windowed ledger:
// sum the qty of every refill-tagged `transfer_out` whose destination is a store.
// (The +to leg of a transfer credits the store cell — that's the replenishment.)
export function tallyRefills(movements) {
  const byPss = new Map();
  for (const m of (movements || [])) {
    if (!m || m.type !== "transfer_out") continue;
    if (m.reason !== CLOTHING_REFILL_REASON) continue;
    if (!m.to) continue;
    const q = Number(m.qty);
    if (!(q > 0)) continue;
    const k = pssKey(m.to, m.productId, m.size);
    byPss.set(k, (byPss.get(k) || 0) + q);
  }
  return byPss;
}

// Is this (store, product, size) marked skipped in clothing_sold_refills? A skip
// is the crew acknowledging a size it won't refill, so it stops reappearing.
export function isSizeSkipped(skips, store, productId, size) {
  const leaf = skips && skips[store] && skips[store][productId] && skips[store][productId][String(size)];
  return !!(leaf && leaf.skipped);
}

// Is this movement a clothing item? Join productId → product, prefer explicit
// productType, fall back to the size-letter heuristic on the RAW movement size.
function isClothingMovement(m, productsById) {
  const p = (productsById || {})[m.productId];
  return inferProductType({ productType: p && p.productType, size: m.size }) === "clothing";
}

const soldQtyOf = (m) => {
  const q = Number(m.qty);
  return Number.isFinite(q) && q > 0 ? q : 1; // POS always sets qty; default 1 defensively
};
const returnQtyOf = (m) => {
  const q = Number(m.qty);
  return Number.isFinite(q) && q > 0 ? q : 0; // missing return qty → don't over-subtract
};

// (store, productId, size) net-key. Spaces can't appear in ids/sizes here, so
// this is a collision-free join. size is RAW (sold and returns carry the same).
const pssKey = (store, pid, size) => `${store} ${pid} ${String(size)}`;

// A product's photos for the lightbox: primary photoUrl first, then extra angles
// (products/{id}.gallery), deduped. Mirrors App.jsx productPhotos() but pure.
function productPhotoList(p) {
  const out = [];
  if (p && p.photoUrl) out.push(p.photoUrl);
  if (p && Array.isArray(p.gallery)) for (const u of p.gallery) if (u && !out.includes(u)) out.push(u);
  return out;
}

// The section header a card sits under: subcategory (T-Shirts, Jackets…) preferred,
// then category, then a catch-all so nothing is dropped.
export function clothingSectionLabel(group) {
  return (group && (group.subcategory || group.category)) || "Other";
}

// Clothing size display order: XS<S<M<L<XL<XXL…; numeric waist sizes sort after
// letters by value; anything else sorts last.
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL", "5XL", "6XL"];
export function sizeSortKey(s) {
  const i = SIZE_ORDER.indexOf(String(s).toUpperCase());
  if (i >= 0) return i;
  const n = Number(s);
  return Number.isFinite(n) ? 100 + n : 999;
}

// Clothing sold UNITS surviving return-netting, across the whole read window.
//   1. Keep clothing sold/return movements (optionally within the read window).
//   2. NET returns per (store, productId, size) — cancel units most-recent-sold
//      first (a returned item was most likely a recent buy). Refunds/voids drop.
// Returns per-movement rows (qty reduced by netting; qty<=0 dropped) so the
// caller can scope-filter then group. Exported for unit tests.
export function nettedSoldRows({ movements, productsById, windowStartSaDate = null }) {
  const soldRows = [];         // { store, pid, size, saDate, ts, qty }
  const retByPss = new Map();  // (store,pid,size) → returned qty

  for (const m of (movements || [])) {
    if (!m || !m.productId) continue;
    if (m.type !== "sold" && m.type !== "return") continue;
    if (!isClothingMovement(m, productsById)) continue;

    if (m.type === "return") {
      const k = pssKey(m.to || null, m.productId, m.size);
      retByPss.set(k, (retByPss.get(k) || 0) + returnQtyOf(m));
      continue;
    }
    const saDate = saDateOf(m.ts);
    if (windowStartSaDate && saDate < windowStartSaDate) continue;
    soldRows.push({ store: m.from || null, pid: m.productId, size: m.size, saDate, ts: m.ts || "", qty: soldQtyOf(m) });
  }

  const byPss = new Map();
  for (const r of soldRows) {
    const k = pssKey(r.store, r.pid, r.size);
    if (!byPss.has(k)) byPss.set(k, []);
    byPss.get(k).push(r);
  }
  for (const [k, rows] of byPss) {
    let ret = retByPss.get(k) || 0;
    if (ret <= 0) continue;
    rows.sort((a, b) => (b.ts || "").localeCompare(a.ts || "")); // most recent first
    for (const row of rows) {
      if (ret <= 0) break;
      const take = Math.min(row.qty, ret);
      row.qty -= take;
      ret -= take;
    }
  }
  return soldRows.filter((r) => r.qty > 0);
}

// Group surviving sold rows into ONE card per (store, product). For each sold
// size we compute outstanding = max(0, sold − refilled), where refilled comes from
// the ledger tally and a skipped size is forced to 0. `total` is the sum of
// outstanding (pending units); `done` is total === 0 (all refilled or skipped).
// `sizes` carries the full breakdown { size, sold, refilled, outstanding, skipped }
// so the card can show progress and the refill sheet can seed defaults.
function groupByStoreProduct(rows, productsById, refilledByPss, skips) {
  const refilled = refilledByPss || new Map();
  const groups = new Map();
  for (const r of rows) {
    const gk = `${r.store}__${r.pid}`;
    let g = groups.get(gk);
    if (!g) {
      const p = (productsById || {})[r.pid] || {};
      g = {
        key: gk, productId: r.pid, store: r.store,
        productName: p.name || "Unknown", photo: p.photo || null, photoUrl: p.photoUrl || null,
        photos: productPhotoList(p),           // primary + gallery angles, for the lightbox
        category: p.category || null,          // section-grouping headers
        subcategory: p.subcategory || null,
        _sizes: {}, latestTs: r.ts, earliestTs: r.ts,
      };
      groups.set(gk, g);
    }
    g._sizes[r.size] = (g._sizes[r.size] || 0) + r.qty;
    if (r.ts > g.latestTs) g.latestTs = r.ts;
    if (r.ts && (!g.earliestTs || r.ts < g.earliestTs)) g.earliestTs = r.ts;
  }
  return Array.from(groups.values()).map(({ _sizes, ...g }) => {
    let total = 0, soldTotal = 0;
    const sizes = Object.entries(_sizes)
      .sort((a, b) => sizeSortKey(a[0]) - sizeSortKey(b[0]) || String(a[0]).localeCompare(String(b[0])))
      .map(([size, sold]) => {
        const ref = refilled.get(pssKey(g.store, g.productId, size)) || 0;
        const skipped = isSizeSkipped(skips, g.store, g.productId, size);
        const outstanding = skipped ? 0 : Math.max(0, sold - ref);
        total += outstanding;
        soldTotal += sold;
        return { size, sold, refilled: ref, outstanding, skipped };
      });
    return { ...g, ts: g.latestTs, sizes, total, soldTotal, done: total === 0 };
  });
}

// The tab query. Returns per-(store, product) refill cards for one scope:
//   • store set  → per-store DAILY tab: sales with saDate >= cutoff at that store
//   • store null → Sold Backlog:        sales with saDate <  cutoff (merged `stores`),
//                  further bounded to the picked [fromSaDate, toSaDate] window.
// Netting runs across the queried window first (so a refund is cancelled wherever
// its unit sold); rows are then scope-filtered and grouped by product, with each
// size's outstanding = sold − refilled (from the ledger) and skips applied.
export function clothingSoldEventsForPeriod({ movements, productsById, cutoff, store = null, stores = null, fromSaDate = null, toSaDate = null, skips = null }) {
  const rows = nettedSoldRows({ movements, productsById, windowStartSaDate: fromSaDate });
  const scoped = rows.filter((r) => {
    if (store) return r.saDate >= cutoff && r.store === store;
    if (r.saDate >= cutoff) return false;                    // backlog is strictly older than today
    if (fromSaDate && r.saDate < fromSaDate) return false;   // picked window lower bound
    if (toSaDate && r.saDate > toSaDate) return false;       // picked window upper bound
    if (stores && !stores.includes(r.store)) return false;   // merge only the covered stores
    return true;
  });
  const refilledByPss = tallyRefills(movements); // refills tagged in the same window
  return groupByStoreProduct(scoped, productsById, refilledByPss, skips);
}

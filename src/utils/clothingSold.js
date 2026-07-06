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
// REFILL MODEL: a refill is a timestamp per (store, product) — refilledAt. A card
// is "done" iff refilledAt >= its latest sale ts, so a restock clears all current
// demand AND the card correctly RE-APPEARS when the product sells again later.

import { inferProductType } from "./insights";

// Read window (days) for the bounded /stock_movements query. The App builds a
// ts-windowed query [saStartIso(getSAPastDateString(N)) … now) so the read is
// bounded — NEVER an unbounded subscription over the whole ledger. Requires the
// stock_movements `.indexOn:["ts"]` rule, else the query silently reads it all.
export const CLOTHING_SOLD_BACKLOG_DAYS = 14;

// The stores the clothing-sold tabs cover. Each gets a per-store daily tab;
// Sold Backlog merges these. Pine is a one-line add: append "marathon-pine".
export const CLOTHING_SOLD_STORES = ["marathon-pe", "trophy"];

// SA-timezone (UTC+2) date slice "YYYY-MM-DD" of an ISO timestamp. Identical
// convention to insights.js / DayCollapsible (+2h shift before slicing).
export const saDateOf = (iso) => {
  if (!iso) return "";
  return new Date(new Date(iso).getTime() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
};

// UTC ISO instant of 00:00 SA-time on a given SA-date "YYYY-MM-DD". Midnight SA
// (UTC+2) is 22:00 UTC the previous day, so we subtract 2h. This is the `startAt`
// bound for the ts-windowed query — everything sold on-or-after that SA-date.
export const saStartIso = (saDate) => {
  if (!saDate) return "";
  return new Date(new Date(`${saDate}T00:00:00.000Z`).getTime() - 2 * 60 * 60 * 1000).toISOString();
};

// The single cutoff constant dividing "today's per-store sales" from the merged
// "Sold Backlog". cutoff = TODAY's SA-date:
//   • per-store tabs → sale saDate >= cutoff  (today; nothing is in the future)
//   • Sold Backlog   → sale saDate <  cutoff  (yesterday … 14 days back)
// The daily per-store list is the actionable "sold today, refill it" worklist;
// backlog is the aging pile. (cutoff=tomorrow would leave per-store tabs empty.)
export const clothingSoldCutoff = () =>
  new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);

// A card is refilled iff a refilledAt exists for its (store, product) AND it is
// at-or-after the card's latest sale — so a later sale re-opens the card. Shared
// by the panel (pending/done split) and the pill badge so they can't diverge.
export function isGroupRefilled(group, refills) {
  const r = (refills || {})[group.store] && refills[group.store][group.productId];
  return !!(r && r.refilledAt && r.refilledAt >= group.latestTs);
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

// Group surviving sold rows into ONE card per (store, product): per-size qty
// breakdown + total + latestTs (newest sale — drives refill state, recency, and
// day bucket). refillKey/{store,productId} address the refill leaf.
function groupByStoreProduct(rows, productsById) {
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
        _sizes: {}, total: 0, latestTs: r.ts, earliestTs: r.ts,
      };
      groups.set(gk, g);
    }
    g._sizes[r.size] = (g._sizes[r.size] || 0) + r.qty;
    g.total += r.qty;
    if (r.ts > g.latestTs) g.latestTs = r.ts;
    if (r.ts && (!g.earliestTs || r.ts < g.earliestTs)) g.earliestTs = r.ts;
  }
  return Array.from(groups.values()).map(({ _sizes, ...g }) => ({
    ...g,
    ts: g.latestTs, // DayCollapsible + relative-time key on the most-recent sale
    sizes: Object.entries(_sizes)
      .sort((a, b) => sizeSortKey(a[0]) - sizeSortKey(b[0]) || String(a[0]).localeCompare(String(b[0])))
      .map(([size, qty]) => ({ size, qty })),
  }));
}

// The tab query. Returns per-(store, product) refill cards for one scope:
//   • store set  → per-store DAILY tab: sales with saDate >= cutoff at that store
//   • store null → Sold Backlog:        sales with saDate <  cutoff (merged `stores`)
// Netting runs across the whole window first (so a refund is cancelled wherever
// its unit sold); rows are then scope-filtered and grouped by product.
export function clothingSoldEventsForPeriod({ movements, productsById, cutoff, store = null, stores = null, windowStartSaDate = null }) {
  const rows = nettedSoldRows({ movements, productsById, windowStartSaDate });
  const scoped = rows.filter((r) => {
    if (store) return r.saDate >= cutoff && r.store === store;
    if (r.saDate >= cutoff) return false;                 // backlog is strictly older than today
    if (stores && !stores.includes(r.store)) return false; // merge only the covered stores
    return true;
  });
  return groupByStoreProduct(scoped, productsById);
}

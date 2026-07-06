// ─── CLOTHING-SOLD REFILL HELPERS (pure, shared) ──────────────────────────────
// Pure helpers behind the Clothing-Sold refill tabs. Firebase-free so they have a
// single definition AND are unit-testable without importing the firebase-bound
// monolith — same shape as utils/insights.js.
//
// DATA SOURCE — /stock_movements (native ledger), NOT insights_log. insights_log
// misses walk-in sales; the ledger records EVERY sale (POS writes a `sold`
// movement per (sale, product, size) cell) so the refill worklist is complete
// from day one — the ledger self-populates with pre-deploy history, no backfill.
//
// A `sold` movement body (see marathon-pos-app src/stock/stockMovement.js):
//   { type:"sold", productId, size /*RAW, e.g. "M"/"5.5"*/, qty /*+magnitude*/,
//     from /*shop id — the store that sold it*/, ts /*ISO*/, link:{ saleId } }
// A `return`/void movement mirrors it with type:"return" and link.saleId = the
// ORIGINAL sale id (voids/cancels) — those units aren't real sales, so we NET
// them out per (saleId, productId, sizeKey) cell.
//
// CLOTHING ONLY: join productId → /products and keep entries whose product is
// clothing (explicit productType, size-letter fallback via inferProductType).

import { inferProductType } from "./insights";
import { encodeSizeKey } from "./sizeKey";

// Read window (days) for the bounded /stock_movements query. The App builds a
// ts-windowed query [saStartIso(getSAPastDateString(N)) … now) so the read is
// bounded — NEVER an unbounded subscription over the whole ledger. Requires the
// stock_movements `.indexOn:["ts"]` rule, else the query silently reads it all.
export const CLOTHING_SOLD_BACKLOG_DAYS = 14;

// The two stores the clothing-sold tabs cover today. Backlog merges these; each
// also gets its own per-store tab. Pine is a one-line add: append "marathon-pine".
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

// Cell identity — one (sale, product, size) unit group. sizeKey is dot-free
// (encodeSizeKey) so the cellId is safe as a Firebase key at
// clothing_sold_refills/{SA-date}/{store}/{cellId}.
export const cellId = (saleId, productId, size) =>
  `${saleId}__${productId}__${encodeSizeKey(size == null ? "_" : String(size))}`;

// The single cutoff constant dividing "today's fresh per-store sales" from the
// merged "Sold Backlog". cutoff = TODAY's SA-date:
//   • per-store tabs → saDate >= cutoff  (today; nothing is in the future)
//   • Sold Backlog   → saDate <  cutoff  (yesterday … 14 days back)
// An unrefilled unit "ages" from its store tab into the backlog once its sale
// day closes. (NB: the boundary is today, not tomorrow — cutoff=tomorrow would
// make saDate>=cutoff match nothing and leave every per-store tab empty.)
export const clothingSoldCutoff = () =>
  new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);

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

// Collapse the raw ledger into netted clothing-sold CELLS. One cell per
// (saleId, productId, sizeKey): sold units summed, matching return/void units
// subtracted, cells with net <= 0 dropped. Each cell carries the join fields the
// card needs (name/photo) + ts (earliest sold) + saDate + store (movement.from).
export function clothingSoldCells({ movements, productsById }) {
  const sold = new Map();     // cellId → cell accumulator
  const returned = new Map(); // cellId → summed return qty

  for (const m of (movements || [])) {
    if (!m || !m.productId) continue;
    if (m.type !== "sold" && m.type !== "return") continue;
    if (!isClothingMovement(m, productsById)) continue;
    const saleId = (m.link && m.link.saleId != null) ? m.link.saleId : null;
    const id = cellId(saleId, m.productId, m.size);

    if (m.type === "return") {
      returned.set(id, (returned.get(id) || 0) + returnQtyOf(m));
      continue;
    }
    // type === "sold"
    const p = (productsById || {})[m.productId] || {};
    const ex = sold.get(id);
    if (ex) {
      ex.qty += soldQtyOf(m);
      if ((m.ts || "") && (!ex.ts || m.ts < ex.ts)) ex.ts = m.ts; // earliest sold ts
    } else {
      sold.set(id, {
        cellId: id,
        saleId,
        productId: m.productId,
        size: m.size,               // RAW size for display (SizeTag)
        qty: soldQtyOf(m),
        store: m.from || null,      // the shop that sold it
        ts: m.ts || "",
        productName: p.name || "Unknown",
        photo: p.photo || null,
        photoUrl: p.photoUrl || null,
      });
    }
  }

  const cells = [];
  for (const cell of sold.values()) {
    const net = cell.qty - (returned.get(cell.cellId) || 0);
    if (net <= 0) continue; // fully refunded/voided — not a real sale
    cells.push({ ...cell, qty: net, saDate: saDateOf(cell.ts) });
  }
  return cells;
}

// The tab query. Returns netted clothing-sold cells for one scope:
//   • store set        → per-store tab: saDate >= cutoff AND cell.store === store
//   • store null       → Sold Backlog:  saDate <  cutoff (merged across `stores`)
// `stores` (backlog only) restricts the merge to a store allowlist so Pine can
// be added in one line. `windowStartSaDate` (optional) drops anything older than
// the read window as a belt-and-braces guard on top of the query bound.
export function clothingSoldEventsForPeriod({ movements, productsById, cutoff, store = null, stores = null, windowStartSaDate = null }) {
  const cells = clothingSoldCells({ movements, productsById });
  return cells.filter((c) => {
    if (windowStartSaDate && c.saDate < windowStartSaDate) return false;
    if (store) return c.saDate >= cutoff && c.store === store;
    if (c.saDate >= cutoff) return false;                 // backlog is strictly older than today
    if (stores && !stores.includes(c.store)) return false; // merge only the covered stores
    return true;
  });
}

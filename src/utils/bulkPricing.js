// ─── BULK PRICING — PURE PLANS ───────────────────────────────────────────────
// The brains of the two bulk price tools. Each builds a PLAN — exactly which
// products change, from what, to what, and which selected products are NOT
// changed and why — that the preview modal shows verbatim and the operator
// confirms before anything is written. The confirmed plan's lines go to
// priceStore.applyPriceBatch unchanged, so what was previewed IS what is
// written: same objects, same count, nothing recomputed after the confirm.
//
//   buildBulkFillPlan   — Missing Prices: ONE stock price and/or ONE retail
//                         price applied to the whole selection. Products that
//                         already hold a value for an entered field keep it
//                         unless the operator explicitly chooses overwrite
//                         (skip is the default).
//   buildBulkChangePlan — repricing products that already have prices: an
//                         absolute value or a percentage change (a sale is
//                         usually a percentage). Percentages round to the
//                         nearest whole rand (floor R1) — ZAR shelf prices are
//                         whole; the preview shows the rounded number.
//
// Plans never throw — they return { ok:false, error } for bad input so the UI
// can show the message inline.

import { asStoredPrice } from "./priceBatch";

const parseDraft = (draft) => {
  const t = String(draft ?? "").trim();
  if (t === "") return { value: null };
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return { error: `"${t}" is not a valid price — enter a number greater than 0.` };
  return { value: n };
};

/** Nearest whole rand, never below R1 — the shelf-price convention. */
export const roundPrice = (v) => Math.max(1, Math.round(v));

/**
 * Plan: apply one stock and/or one retail price to every selected product.
 * Returns { ok, error?, lines, rows, skippedAlready, noop, count }:
 *   rows           — the products that WILL change, with per-field from/to
 *                    (to === null on a field means "left as is")
 *   skippedAlready — selected products untouched because every entered field
 *                    already holds a price (and overwrite is off)
 *   noop           — selected products already holding exactly the entered
 *                    values (nothing to write even with overwrite on)
 */
export function buildBulkFillPlan({ products = [], selectedIds = [], stockDraft = "", retailDraft = "", overwrite = false }) {
  const stock = parseDraft(stockDraft);
  if (stock.error) return { ok: false, error: `Stock price: ${stock.error}` };
  const retail = parseDraft(retailDraft);
  if (retail.error) return { ok: false, error: `Retail price: ${retail.error}` };
  if (stock.value === null && retail.value === null) {
    return { ok: false, error: "Enter a stock price, a retail price, or both." };
  }
  if (stock.value !== null && retail.value !== null && retail.value < stock.value) {
    return { ok: false, error: `Retail (R${retail.value}) is below stock (R${stock.value}) — swap them or adjust.`, needsConfirm: false };
  }

  const byId = new Map(products.filter((p) => p && p.id).map((p) => [p.id, p]));
  const lines = {};
  const rows = [];
  const skippedAlready = [];
  const noop = [];
  for (const pid of selectedIds) {
    const p = byId.get(pid);
    if (!p) continue;
    const from = {};
    const to = {};
    let hadPricedField = false;
    for (const [field, entered] of [["stockPrice", stock.value], ["retailPrice", retail.value]]) {
      if (entered === null) continue;
      const cur = asStoredPrice(p[field]);
      if (cur !== null && !overwrite) { hadPricedField = true; continue; }
      if (cur === entered) continue; // already exactly this — nothing to write
      from[field] = cur;
      to[field] = entered;
      if (cur !== null) hadPricedField = true;
    }
    if (Object.keys(to).length === 0) {
      (hadPricedField ? skippedAlready : noop).push({ pid, name: p.name || pid });
      continue;
    }
    lines[pid] = { name: p.name || "", from, to };
    rows.push({
      pid, name: p.name || pid, photoUrl: p.photoUrl || "",
      fromStock: asStoredPrice(p.stockPrice), toStock: "stockPrice" in to ? to.stockPrice : undefined,
      fromRetail: asStoredPrice(p.retailPrice), toRetail: "retailPrice" in to ? to.retailPrice : undefined,
      overwrites: hadPricedField,
    });
  }
  return { ok: true, lines, rows, skippedAlready, noop, count: rows.length };
}

/**
 * Plan: reprice the selection by absolute value or percentage.
 *   mode  — "absolute": entered values replace current ones (a field left
 *           blank is untouched).
 *         — "percent":  ONE signed percentage (e.g. -20 for a 20% sale)
 *           applied to the chosen fields; products missing that price are
 *           reported, not invented.
 * Returns { ok, error?, lines, rows, missingPrice, noop, count }.
 */
export function buildBulkChangePlan({ products = [], selectedIds = [], mode = "absolute",
                                      stockDraft = "", retailDraft = "",
                                      percentDraft = "", applyToStock = false, applyToRetail = true }) {
  const byId = new Map(products.filter((p) => p && p.id).map((p) => [p.id, p]));
  let stockTo = null, retailTo = null, pct = null;
  if (mode === "absolute") {
    const stock = parseDraft(stockDraft);
    if (stock.error) return { ok: false, error: `Stock price: ${stock.error}` };
    const retail = parseDraft(retailDraft);
    if (retail.error) return { ok: false, error: `Retail price: ${retail.error}` };
    if (stock.value === null && retail.value === null) return { ok: false, error: "Enter a stock price, a retail price, or both." };
    if (stock.value !== null && retail.value !== null && retail.value < stock.value) {
      return { ok: false, error: `Retail (R${retail.value}) is below stock (R${stock.value}) — swap them or adjust.` };
    }
    stockTo = stock.value; retailTo = retail.value;
  } else if (mode === "percent") {
    const t = String(percentDraft ?? "").trim();
    const n = Number(t);
    if (t === "" || !Number.isFinite(n) || n === 0) return { ok: false, error: "Enter a non-zero percentage (e.g. -20 for a 20% sale)." };
    if (n <= -100) return { ok: false, error: "A change of -100% or more would make prices free or negative." };
    if (!applyToStock && !applyToRetail) return { ok: false, error: "Choose at least one of stock / retail to change." };
    pct = n;
  } else {
    return { ok: false, error: `Unknown mode "${mode}".` };
  }

  const lines = {};
  const rows = [];
  const missingPrice = [];
  const noop = [];
  for (const pid of selectedIds) {
    const p = byId.get(pid);
    if (!p) continue;
    const curStock = asStoredPrice(p.stockPrice);
    const curRetail = asStoredPrice(p.retailPrice);
    const from = {};
    const to = {};
    let lacked = false;
    const fields = mode === "absolute"
      ? [["stockPrice", curStock, stockTo], ["retailPrice", curRetail, retailTo]]
      : [
          ...(applyToStock ? [["stockPrice", curStock, curStock === null ? null : roundPrice(curStock * (1 + pct / 100))]] : []),
          ...(applyToRetail ? [["retailPrice", curRetail, curRetail === null ? null : roundPrice(curRetail * (1 + pct / 100))]] : []),
        ];
    for (const [field, cur, next] of fields) {
      if (next === null) { if (mode === "percent") lacked = true; continue; }
      if (cur === next) continue;
      from[field] = cur;
      to[field] = next;
    }
    if (lacked && Object.keys(to).length === 0) { missingPrice.push({ pid, name: p.name || pid }); continue; }
    if (Object.keys(to).length === 0) { noop.push({ pid, name: p.name || pid }); continue; }
    if (lacked) missingPrice.push({ pid, name: p.name || pid, partial: true });
    lines[pid] = { name: p.name || "", from, to };
    // Flag (not refuse) a new retail that lands under the product's stock
    // price — the preview must say so before the operator confirms.
    const newRetail = "retailPrice" in to ? to.retailPrice : curRetail;
    const newStock = "stockPrice" in to ? to.stockPrice : curStock;
    const under = newRetail !== null && newStock !== null && newRetail < newStock;
    rows.push({
      pid, name: p.name || pid, photoUrl: p.photoUrl || "",
      fromStock: curStock, toStock: "stockPrice" in to ? to.stockPrice : undefined,
      fromRetail: curRetail, toRetail: "retailPrice" in to ? to.retailPrice : undefined,
      ...(under ? { badge: "below stock price" } : {}),
    });
  }
  return { ok: true, lines, rows, missingPrice, noop, count: rows.length };
}

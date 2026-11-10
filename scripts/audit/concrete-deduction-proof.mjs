// ─── CONCRETE / PINE DEDUCTION PROOF (Junid, 10 Nov 2026) ────────────────────
// READ-ONLY. Every POS sale line at Concrete (since 30 Oct 2026) and Pine (since
// 6 Nov 2026), and every refund / exchange line: is there a matching movement,
// from the right location, counted ONCE? Built on marathon-pos-app's own audit
// lib (scripts/lib/concreteDeduction*.mjs), so the sale-side classification is
// exactly the till's rule: a sneaker off Hub 3, anything else off the selling
// shop. This adds what that audit does not check:
//   duplicates   a record's sold rows for one cell exceed the units its lines
//                sold there (a line deducted twice — canonical + replay, say)
//   clamped      a sold row that found the cell empty (shortfall/clampedShort)
//   returns      each return line of a refund or exchange has a `return` row
//                (link.saleId = the refund), from the right location, once
// All reads are the POS audit's own: bounded by date through .indexOn, plus one
// keyed /products/{id} per product.
//   node --dns-result-order=ipv4first scripts/audit/concrete-deduction-proof.mjs \
//     --pos=<marathon-pos-app checkout> --token-file=<path> [--json=out.json]
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";

const arg = (n, d = null) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const POS = arg("pos");
if (!POS) throw new Error("--pos=<marathon-pos-app checkout> is required");
const lib = (p) => import(pathToFileURL(join(POS, p)).href);
const { loadAudit, SINCE } = await lib("scripts/lib/concreteDeductionData.mjs");
const { OK, WRONG, MISSED, HUB3, SHOP_LOC, deductionRecordIds, soldRowsBySale, expectedLocation } = await lib("scripts/lib/concreteDeduction.mjs");
const { stockSizeKey } = await lib("src/stock/saleStockMovements.js");

const token = readFileSync(arg("token-file"), "utf8").trim();
const { rows, leaks, movements, sales, get } = await loadAudit(token);
const soldBySale = soldRowsBySale(movements);

// ── SALE SIDE ────────────────────────────────────────────────────────────────
const DEDUCTING = new Set([OK, WRONG, MISSED, "x_reversed_for_count"]);
const saleRows = rows.filter((r) => r.category !== "x_return_side");
const byStore = {};
const bump = (store, k, n = 1) => { (byStore[store] ||= {}); byStore[store][k] = (byStore[store][k] || 0) + n; };
for (const r of saleRows) {
  bump(r.store, "linesChecked");
  if (DEDUCTING.has(r.category)) bump(r.store, "linesThatDeduct");
  if (r.category === OK) bump(r.store, "deducted");
  if (r.category === WRONG) bump(r.store, "wrongLocation");
  if (r.category === MISSED) bump(r.store, "missing");
  if (r.category === "x_reversed_for_count") bump(r.store, "reversedForCount");
}

// Duplicates and clamps, per deduction record and cell.
const duplicates = [];
const clamped = [];
const recLines = new Map();   // recordId → { store, cells: Map(cell → units sold by lines) }
for (const r of saleRows) {
  if (!DEDUCTING.has(r.category) || r.category === MISSED) continue;
  const recId = r.saleId.endsWith("~C") ? r.saleId.slice(0, -2) : r.saleId;
  if (!recLines.has(recId)) recLines.set(recId, { store: r.store, receipt: r.receipt, cells: new Map() });
  const cell = `${r.productId}|${r.sizeKey}`;
  const e = recLines.get(recId);
  e.cells.set(cell, (e.cells.get(cell) || 0) + r.qty);
}
for (const [recId, e] of recLines) {
  const sold = deductionRecordIds(recId).flatMap((id) => soldBySale.get(id) ?? []);
  const soldByCell = new Map();
  for (const { mvId, m } of sold) {
    const cell = `${m.productId}|${stockSizeKey(m.size)}`;
    (soldByCell.get(cell) || soldByCell.set(cell, []).get(cell)).push({ mvId, m });
    const short = Number(m.shortfall) || Number(m.clampedShort) || 0;
    if (short > 0) clamped.push({ store: e.store, receipt: e.receipt, saleId: recId, mvId, from: m.from, productId: m.productId, size: m.size, qty: Number(m.qty) || 0, short });
  }
  for (const [cell, units] of e.cells) {
    const rowsHere = soldByCell.get(cell) || [];
    const soldUnits = rowsHere.reduce((n, { m }) => n + (Number(m.qty) || 0), 0);
    if (soldUnits > units) duplicates.push({ store: e.store, receipt: e.receipt, saleId: recId, cell, lineUnits: units, soldUnits, rows: rowsHere.map(({ mvId, m }) => ({ mvId, from: m.from, qty: m.qty, reason: m.reason || null })) });
  }
}
for (const c of clamped) { bump(c.store, "clampedRows"); bump(c.store, "clampedUnits", c.short); }
for (const d of duplicates) bump(d.store, "duplicates");

// ── RETURN SIDE (refunds and exchanges) ──────────────────────────────────────
const returnRowsByRefund = new Map();
for (const [mvId, m] of Object.entries(movements ?? {})) {
  if (m?.type !== "return" || !m.link?.saleId) continue;
  (returnRowsByRefund.get(m.link.saleId) || returnRowsByRefund.set(m.link.saleId, []).get(m.link.saleId)).push({ mvId, m });
}
const returnsProblems = [];
const products = {};
const productOf = async (id) => (id in products ? products[id] : (products[id] = await get(`products/${id}`)));
for (const r of rows.filter((x) => x.category === "x_return_side")) {
  const rec = sales[r.saleId];
  const l = rec?.lineItems?.[r.lineId];
  const store = r.store;
  bump(store, "returnLinesChecked");
  if (!l || !l.productId || l.priceProduct === true || l.isShoebox === true || l.chargeType != null) { bump(store, "returnLinesNotStocked"); continue; }
  const shop = SHOP_LOC[store];
  const exp = expectedLocation({ size: l.size }, await productOf(l.productId), l.sourceStoreId && SHOP_LOC[l.sourceStoreId] ? SHOP_LOC[l.sourceStoreId] : shop);
  const cell = `${l.productId}|${stockSizeKey(l.size)}`;
  const here = (returnRowsByRefund.get(r.saleId) || []).filter(({ m }) => `${m.productId}|${stockSizeKey(m.size)}` === cell);
  const units = here.reduce((n, { m }) => n + (Number(m.qty) || 0), 0);
  const qty = Number(l.qty) || 0;
  if (units === 0) { bump(store, "returnMissing"); returnsProblems.push({ kind: "missing", store, receipt: rec.receiptNumber, saleId: r.saleId, lineId: r.lineId, name: l.name, size: l.size, qty, expected: exp.loc ?? null }); continue; }
  if (units > qty) { bump(store, "returnDuplicates"); returnsProblems.push({ kind: "duplicate", store, receipt: rec.receiptNumber, saleId: r.saleId, lineId: r.lineId, units, qty }); continue; }
  const wrong = here.filter(({ m }) => exp.loc && m.to !== exp.loc);
  if (wrong.length) { bump(store, "returnWrongLocation"); returnsProblems.push({ kind: "wrong_location", store, receipt: rec.receiptNumber, saleId: r.saleId, lineId: r.lineId, to: wrong.map(({ m }) => m.to), expected: exp.loc }); continue; }
  bump(store, "returnsBooked");
}

const report = {
  since: { concrete: new Date(SINCE.concrete).toISOString(), pine: new Date(SINCE.pine).toISOString() },
  byStore, crossDivisionLeaks: leaks.length,
  missing: saleRows.filter((r) => r.category === MISSED).map((r) => ({ store: r.store, receipt: r.receipt, saleId: r.saleId, lineId: r.lineId, name: r.name, size: r.size, qty: r.outstanding, loc: r.loc })),
  wrongLocation: saleRows.filter((r) => r.category === WRONG).map((r) => ({ store: r.store, receipt: r.receipt, lineId: r.lineId, name: r.name, size: r.size, from: r.loc, belongs: r.expected })),
  duplicates, clamped, returnsProblems,
};
console.log(JSON.stringify({ since: report.since, byStore, crossDivisionLeaks: report.crossDivisionLeaks, missing: report.missing.length, wrongLocation: report.wrongLocation.length, duplicates: duplicates.length, clampedRows: clamped.length, returnsProblems: returnsProblems.length }, null, 1));
if (arg("json")) writeFileSync(arg("json"), JSON.stringify(report, null, 1));
void HUB3;

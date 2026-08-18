// ─── THE STARVED LIST — WHERE THE NOTEBOOK IS WRONG ──────────────────────────
//
// WHAT THIS IS FOR
// Since PR #376 a shop is refused a refill when `/stock_provenance` has no trace of
// it trading the line. That is the right default, and its failure mode is SILENT: a
// wrong refusal produces no error, no request and no card — the shelf simply runs dry
// and nobody learns why until stocktake.
//
// This is the detector. For every refill destination it lists the (shop, product)
// pairs the index refuses WHILE THE SHOP SHOWS EVIDENCE OF TRADING THEM:
//
//   HOLDS    units on the shelf right now
//   SOLD     a `sold` movement out of that shop inside the ledger window
//   ASKED    an open refill line for that pair
//
// Any one of those contradicts "this shop does not stock this line". The list is the
// contradiction, made visible within a day instead of at stocktake.
//
// ── WHY SALES ARE READ FROM THE LEDGER AND NOT FROM THE INDEX ────────────────
// This is the load-bearing decision in the file. `s > 0` in the index MEANS carried,
// so asking the index whether a refused pair has sold can only ever answer "no" —
// the question would be circular and the card would always be empty.
//
// It also has a known real cause. applyMovement maintains `s` for sales that flow
// through THIS app, but the POS is a separate repo with its own writer and does not
// touch the index. A shop selling a line only through the till therefore accumulates
// no `s` at all. If that shop also has no stocking movement on record — a hand
// adjustment, an opening balance, a delivery booked elsewhere — the index refuses a
// line the shop demonstrably sells, forever, silently. That pair appears here.
//
// ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
// A destination whose index is NOT READY is skipped entirely. With no sentinel
// `storeCarries()` is false for EVERY product, so the list would be thousands of rows
// long and mean nothing — "the backfill has not run" is one fact, not six thousand,
// and refill-scan already says it once, loudly, in its own red card.
//
// An explicit `target: 0` row is NOT filtered out, but it is FLAGGED. A zero row is a
// deliberate "we do not stock this here", so it explains the refusal — but a shop
// deliberately excluded from a line it is actively selling is worth a human look, not
// a silent drop. Flagged and sorted last: visible, not nagging.

"use strict";

const { carriesByIndex, indexReady, provenanceEntry } = require("./provenance-index.cjs");

/** Evidence codes, in the order a reader should weigh them. */
const HOLDS = "holds";
const SOLD = "sold";
const ASKED = "asked";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const avail = (q) => Math.max(0, num(q));

/**
 * Units a location currently holds of a product, across every size.
 * Negatives clamp to 0 per cell — a count error is not evidence of trade.
 */
function unitsHeld(stock, loc, pid) {
  const cells = stock?.[loc]?.[pid];
  if (!cells || typeof cells !== "object") return 0;
  let n = 0;
  for (const k of Object.keys(cells)) n += avail(cells[k]?.qty);
  return n;
}

/**
 * (loc, pid) → units sold out of that location inside the movement window.
 *
 * Built ONCE for the whole run rather than probed per pair: the window holds ~50k
 * records and the candidate set is every managed pair, so a per-pair scan would be
 * quadratic on the hot path of a function that already reads 31 MB.
 *
 * `type === "sold"` with `from` naming the shop is the same shape provenanceClass
 * classifies as SALE. It is restated here rather than imported because this file
 * must see sales the INDEX may have missed — including POS sales that never
 * incremented `s` — so it deliberately does not go through the index's classifier.
 */
function soldWindow(movements) {
  const out = new Map();
  for (const m of movements || []) {
    if (!m || m.type !== "sold") continue;
    const loc = m.from;
    const pid = m.productId;
    if (typeof loc !== "string" || !loc || typeof pid !== "string" || !pid) continue;
    const key = `${loc}|${pid}`;
    out.set(key, (out.get(key) || 0) + Math.abs(num(m.qty)));
  }
  return out;
}

/** Open refill demand per (dest, pid), from the engine's own open-lock index. */
function openWindow(openIndex) {
  const out = new Map();
  for (const dest of Object.keys(openIndex || {})) {
    const byPid = openIndex[dest];
    if (!byPid || typeof byPid !== "object") continue;
    for (const pid of Object.keys(byPid)) {
      const sizes = byPid[pid];
      const n = sizes && typeof sizes === "object" ? Object.keys(sizes).length : 0;
      if (n > 0) out.set(`${dest}|${pid}`, n);
    }
  }
  return out;
}

/**
 * THE LIST.
 *
 * `carries` is injected rather than recomputed so this cannot drift from the engine's
 * own answer: the caller passes the SAME storeCarries closure resolveTarget uses. A
 * second implementation of the predicate here would be a second thing to keep in step,
 * and the whole point of the card is to be trustworthy about what the engine did.
 */
function computeStarved({ dests, stock, products, provenance, provenanceMeta, movements, openIndex, targets, carries }) {
  const sold = soldWindow(movements);
  const open = openWindow(openIndex);
  const rows = [];

  for (const dest of dests || []) {
    // No sentinel → every pair reads as not-carried → the list would be noise.
    if (!indexReady(provenanceMeta, dest)) continue;

    // The candidate set is every product with ANY evidence at this destination.
    // Built from the three evidence sources rather than from the catalogue, so the
    // cost is proportional to what is actually happening, not to 8,000 products.
    const candidates = new Set();
    for (const pid of Object.keys(stock?.[dest] || {})) candidates.add(pid);
    for (const key of sold.keys()) { const [l, p] = key.split("|"); if (l === dest) candidates.add(p); }
    for (const key of open.keys()) { const [l, p] = key.split("|"); if (l === dest) candidates.add(p); }

    for (const pid of candidates) {
      if (carries(dest, pid)) continue;              // the engine is happy — nothing to see

      const held = unitsHeld(stock, dest, pid);
      const soldQty = sold.get(`${dest}|${pid}`) || 0;
      const openLines = open.get(`${dest}|${pid}`) || 0;
      const why = [];
      if (held > 0) why.push(HOLDS);
      if (soldQty > 0) why.push(SOLD);
      if (openLines > 0) why.push(ASKED);
      if (!why.length) continue;                     // refused, but nothing contradicts it

      // A zero row EXPLAINS the refusal — it is a standing decision, not a gap in
      // the record. Flagged so the reader can tell the two apart at a glance.
      const rowsForPid = targets?.[dest]?.[pid];
      const excluded = !!rowsForPid && typeof rowsForPid === "object"
        && Object.keys(rowsForPid).some((k) => rowsForPid[k]?.target === 0);

      const e = provenanceEntry(provenance, dest, pid) || {};
      rows.push({
        loc: dest, pid,
        name: products?.[pid]?.name ?? null,
        category: products?.[pid]?.categoryKey ?? null,
        held, sold: soldQty, openLines,
        why, excluded,
        // The index's own numbers, so a reader can see WHY it answered no: `k − u`
        // netting to zero reads very differently from no record at all.
        s: num(e.s), k: num(e.k), u: num(e.u),
        hasRecord: !!provenanceEntry(provenance, dest, pid),
      });
    }
  }

  // Worst first: selling it beats holding it beats merely asking, and a deliberate
  // exclusion sorts last whatever its evidence, because it is already explained.
  const weight = (r) => (r.excluded ? 0 : (r.sold > 0 ? 3 : 0) + (r.held > 0 ? 2 : 0) + (r.openLines > 0 ? 1 : 0));
  rows.sort((a, b) => weight(b) - weight(a) || b.sold - a.sold || b.held - a.held
    || String(a.loc).localeCompare(String(b.loc)) || String(a.pid).localeCompare(String(b.pid)));
  return rows;
}

module.exports = { computeStarved, soldWindow, openWindow, unitsHeld, HOLDS, SOLD, ASKED };
